import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { Clock } from "../runtime.js";
import { m15Authorized } from "./actorResourceRepo.js";
import {
  MAGIC_ITEM_ATTUNEMENT_LIMIT,
  attuneItem,
  dropAttunement,
  type MagicAttunementState,
  type MagicItemDefinition,
  type MagicRestKind,
} from "./encounter/magicItem/index.js";

/**
 * Durable per-actor magic-item attunement. The pure encounter magic-item engine
 * enforces the SRD maximum of three attunements and prerequisite/conflict rules;
 * this repository only resolves pinned item definitions, authorizes the actor,
 * and persists the resulting bounded set.
 */

export interface AttunementDependencies {
  clock: Clock;
  resolveMagicItem(campaignId: string, definitionId: string): MagicItemDefinition | null;
}

export interface AttunementEntryView {
  key: string;
  definition: { packId: string; packVersion: string; definitionId: string };
  attunedAt: string;
}

export interface ActorAttunementSnapshot {
  campaignId: string;
  actorId: string;
  limit: number;
  attunements: AttunementEntryView[];
}

export type AttunementOutcome =
  | { ok: true; snapshot: ActorAttunementSnapshot }
  | { ok: false; code: string; snapshot: ActorAttunementSnapshot };

interface AttunementRow {
  item_key: string;
  pack_id: string;
  pack_version: string;
  definition_id: string;
  attuned_at: string;
}

const SELECT_COLUMNS = "item_key,pack_id,pack_version,definition_id,attuned_at FROM actor_item_attunements_v65";
const ORDER = " ORDER BY attuned_at COLLATE BINARY, item_key COLLATE BINARY";

function entryView(row: AttunementRow): AttunementEntryView {
  return { key: row.item_key, definition: { packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id }, attunedAt: row.attuned_at };
}

export function createAttunementRepository(db: DatabaseDriver.Database, dependencies: AttunementDependencies) {
  const actorCampaign = (actorId: string): string | null => {
    const row = db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as { campaign_id: string } | undefined;
    return row?.campaign_id ?? null;
  };
  const readRows = (campaignId: string, actorId: string, order: boolean): AttunementRow[] =>
    db.prepare(`SELECT ${SELECT_COLUMNS} WHERE campaign_id=? AND actor_id=?${order ? ORDER : ""}`).all(campaignId, actorId) as AttunementRow[];
  const snapshot = (principal: string, actorId: string): ActorAttunementSnapshot | null => {
    const campaignId = actorCampaign(actorId);
    if (campaignId === null || !m15Authorized(db, principal, campaignId, actorId)) return null;
    return { campaignId, actorId, limit: MAGIC_ITEM_ATTUNEMENT_LIMIT, attunements: readRows(campaignId, actorId, true).map(entryView) };
  };
  const currentState = (campaignId: string, actorId: string): MagicAttunementState => ({
    actorId, entries: readRows(campaignId, actorId, false).map((row) => ({ key: row.item_key, definition: { packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id }, attunedAt: row.attuned_at })),
  });
  const persist = (campaignId: string, actorId: string, state: MagicAttunementState): void => {
    db.prepare("DELETE FROM actor_item_attunements_v65 WHERE campaign_id=? AND actor_id=?").run(campaignId, actorId);
    const insert = db.prepare("INSERT INTO actor_item_attunements_v65(campaign_id,actor_id,item_key,pack_id,pack_version,definition_id,attuned_at) VALUES(?,?,?,?,?,?,?)");
    for (const entry of state.entries) insert.run(campaignId, actorId, entry.key, entry.definition.packId, entry.definition.packVersion, entry.definition.definitionId, entry.attunedAt);
  };
  const authorize = (principal: string, actorIdValue: string): { actorId: string; campaignId: string } | null => {
    const actorId = resourceIdSchema.parse(actorIdValue);
    const campaignId = actorCampaign(actorId);
    if (campaignId === null || !m15Authorized(db, principal, campaignId, actorId)) return null;
    return { actorId, campaignId };
  };

  return Object.freeze({
    listActorAttunements(principal: string, actorId: string): ActorAttunementSnapshot | null {
      return snapshot(principal, resourceIdSchema.parse(actorId));
    },
    attuneActorItem(principal: string, actorId: string, input: { definitionId: string; key: string; satisfiedRest: MagicRestKind | null }): AttunementOutcome | null {
      const access = authorize(principal, actorId);
      if (access === null) return null;
      const definition = dependencies.resolveMagicItem(access.campaignId, input.definitionId);
      if (definition === null) return { ok: false, code: "definition-unavailable", snapshot: snapshot(principal, access.actorId)! };
      const result = attuneItem({
        state: currentState(access.campaignId, access.actorId), key: input.key, definition,
        prerequisite: { satisfiedRest: input.satisfiedRest }, occurredAt: dependencies.clock.now().toISOString(),
      });
      if (result.ok) db.transaction(() => persist(access.campaignId, access.actorId, result.state))();
      const current = snapshot(principal, access.actorId)!;
      return result.ok ? { ok: true, snapshot: current } : { ok: false, code: result.code, snapshot: current };
    },
    dropActorAttunement(principal: string, actorId: string, key: string): AttunementOutcome | null {
      const access = authorize(principal, actorId);
      if (access === null) return null;
      const result = dropAttunement({ state: currentState(access.campaignId, access.actorId), key, occurredAt: dependencies.clock.now().toISOString() });
      if (result.ok) db.transaction(() => persist(access.campaignId, access.actorId, result.state))();
      const current = snapshot(principal, access.actorId)!;
      return result.ok ? { ok: true, snapshot: current } : { ok: false, code: result.code, snapshot: current };
    },
  });
}

export type AttunementRepository = ReturnType<typeof createAttunementRepository>;
