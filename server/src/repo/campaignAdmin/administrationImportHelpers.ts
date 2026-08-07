// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";

/** Computes the SHA-256 digest for a JSON-serializable transfer value. */
const packageHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reports whether a transfer value contains excluded fields or excessive nesting. */
export function forbidden(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((entry) => forbidden(entry, depth + 1));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /api.?key|credential|password|access.?token|local.?path|usage|price/i.test(key)
    || forbidden(child, depth + 1));
}

/** Produces a deterministic, JSON-safe representation with sorted object keys. */
export function canonicalizeJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
      throw new TypeError("unsupported JSON value");
    return value;
  }
  if (seen.has(value)) throw new TypeError("cyclic JSON value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry, seen));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalizeJson((value as Record<string, unknown>)[key], seen);
    return output;
  } finally { seen.delete(value); }
}

/** Serializes a transfer value canonically and returns its deterministic digest. */
export function serializeForImport(value: unknown): { json: string | null; hash: string } {
  try {
    const json = JSON.stringify(canonicalizeJson(value));
    if (json === undefined) return { json: null, hash: createHash("sha256").update("invalid:undefined").digest("hex") };
    return { json, hash: createHash("sha256").update(json).digest("hex") };
  } catch {
    return { json: null, hash: createHash("sha256").update("invalid:unserializable").digest("hex") };
  }
}

/** Maps a normalized native timeline event into its portable event payload. */
function transferEventData(db: DatabaseDriver.Database, event: any): Record<string, unknown> {
  if (event.type === "actor_attribute_set") return { attributeId: event.attribute_id,
    valueBefore: event.value_before, valueAfter: event.value_after };
  if (event.type === "actor_resource_initialized") return { name: event.resource_name,
    current: event.resource_current, max: event.resource_max };
  const roll = db.prepare("SELECT * FROM rpg_dice_rolls WHERE event_id=?").get(event.event_id) as any;
  const terms = db.prepare("SELECT value,kept FROM rpg_dice_terms WHERE event_id=? ORDER BY position").all(event.event_id) as any[];
  if (!roll) throw new Error("dice event has no normalized roll");
  const selection = roll.selection_type === "keep_highest" || roll.selection_type === "keep_lowest"
    ? { type: roll.selection_type, count: roll.selection_count } : { type: roll.selection_type };
  return { expression: roll.expression, normalized: { count: roll.dice_count, sides: roll.dice_sides,
    selection, modifier: roll.modifier }, terms: terms.map((term) => ({ value: term.value, kept: term.kept === 1 })),
    modifier: roll.modifier, total: roll.total };
}

/** Collects native and imported timeline events in revision order for transfer. */
export function timelineTransferEvents(db: DatabaseDriver.Database, campaignId: string, timelineId: string): any[] {
  const native = (db.prepare(`SELECT link.revision,event.* FROM campaign_timeline_events link
    JOIN campaign_events event ON event.event_id=link.event_id WHERE link.campaign_id=? AND link.timeline_id=?
    ORDER BY link.revision`).all(campaignId, timelineId) as any[]).map((event) => ({ sourceEventId: event.event_id,
      sourceCommandId: event.command_id, actorId: event.actor_id, sourceTurnId: event.source_turn_id,
      revision: event.revision, type: event.type, occurredAt: event.occurred_at, data: transferEventData(db, event) }));
  const imported = (db.prepare(`SELECT * FROM campaign_imported_timeline_events WHERE campaign_id=? AND timeline_id=?
    ORDER BY revision`).all(campaignId, timelineId) as any[]).map((event) => ({ sourceEventId: event.source_event_id,
      sourceCommandId: event.source_command_id, actorId: event.actor_id, sourceTurnId: event.source_turn_id,
      revision: event.revision, type: event.type, occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
  return [...native, ...imported].sort((left, right) => left.revision - right.revision);
}
