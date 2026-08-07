// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { commandReceiptSchema, resourceIdSchema, revisionSchema, rpgEventSchema } from "@velvet/contracts";
import type { CommandReceipt, RpgEvent } from "../../types.js";
import type { CampaignDiceEvent } from "../diceRepo.js";
import {
  getCampaignTimelineSync as getCampaignTimelineReadSync,
  VALID_AUDIT_COMMAND,
  VALID_AUDIT_EVENT,
  VALID_DICE_ROLL,
} from "./campaignTimelineReadRepo.js";

/** Database-scoped reads for validated campaign events and command receipts. */
export interface CampaignEventReadRepository {
  /** Lists the complete, validated event history visible to a campaign member. */
  listCampaignEvents(actorPrincipalId: string, campaignId: string, timelineId: string): RpgEvent[];
  /** Lists up to 20 validated dice events, newest first. */
  listRecentCampaignDiceEvents(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignDiceEvent[];
  /** Returns a validated command receipt when it is visible to the member. */
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CommandReceipt | null;
}

/**
 * Creates the event audit read boundary for one SQLite connection.
 *
 * The returned methods validate the complete command/event/receipt audit graph
 * before projecting public events, so callers must retain this database scope.
 */
export function createCampaignEventReadRepository(db: DatabaseDriver.Database): CampaignEventReadRepository {
interface CampaignEventReadRow {
  audit_command_id: string | null;
  command_presence: string | null;
  event_presence: string | null;
  receipt_presence: string | null;
  requested_timeline_presence: string | null;
  event_timeline_presence: string | null;
  event_timeline_revision: unknown;
  event_timeline_event_count: unknown;
  event_actor_presence: string | null;
  attributable_term_count: unknown;
  event_id: string | null;
  command_id: string | null;
  campaign_id: string | null;
  timeline_id: string | null;
  actor_id: string | null;
  source_turn_id: string | null;
  type: string | null;
  revision: number | null;
  occurred_at: string | null;
  attribute_id: string | null;
  value_before: number | null;
  value_after: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
}

interface DiceCampaignEventReadRow extends CampaignEventReadRow {
  requested_timeline_revision: unknown;
  requested_timeline_event_count: unknown;
  requested_timeline_min_revision: unknown;
  requested_timeline_max_revision: unknown;
  attributable_roll_count: unknown;
  roll_event_id: string | null;
  roll_campaign_id: string | null;
  roll_command_id: string | null;
  roll_expression: string | null;
  roll_dice_count: unknown;
  roll_dice_sides: unknown;
  roll_selection_type: string | null;
  roll_selection_count: unknown;
  roll_modifier: unknown;
  roll_total: unknown;
  term_event_id: string | null;
  term_position: unknown;
  term_value: unknown;
  term_kept: unknown;
  invalid_audit_count?: unknown;
}

interface CommandReceiptReadRow extends DiceCampaignEventReadRow {
  revision_before: number | null;
  revision_after: number | null;
}

function eventFromReadRow(row: CampaignEventReadRow): RpgEvent {
  // Dice rows require grouped term reconstruction and must never fall through
  // either legacy single-row event path.
  if (row.type === "actor_dice_rolled" && row.event_id !== null) {
    throw new Error("dice event projection is not implemented");
  }
  if (
    row.command_presence === null || row.event_presence === null || row.receipt_presence === null
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
    || row.event_actor_presence === null || row.event_id === null || row.command_id === null
    || row.campaign_id === null || row.timeline_id === null || row.actor_id === null
    || row.type === null || row.revision === null || row.occurred_at === null
  ) {
    throw new Error("campaign event audit record is incomplete");
  }
  const common = {
    eventId: row.event_id,
    commandId: row.command_id,
    campaignId: row.campaign_id,
    timelineId: row.timeline_id,
    actorId: row.actor_id,
    sourceTurnId: row.source_turn_id,
    type: row.type,
    revision: row.revision,
    occurredAt: row.occurred_at,
  };
  if (row.type !== "actor_attribute_set" && row.type !== "actor_resource_initialized") {
    throw new Error("campaign event audit record is incomplete");
  }
  if (row.attributable_term_count !== 0) {
    throw new Error("campaign event audit record is incomplete");
  }
  const event = row.type === "actor_attribute_set"
    ? rpgEventSchema.parse({
        ...common,
        data: { attributeId: row.attribute_id, valueBefore: row.value_before, valueAfter: row.value_after },
      })
    : rpgEventSchema.parse({
        ...common,
        data: { name: row.resource_name, current: row.resource_current, max: row.resource_max },
      });
  const timelineRevision = revisionSchema.parse(row.event_timeline_revision);
  const timelineEventCount = revisionSchema.parse(row.event_timeline_event_count);
  if (timelineRevision < event.revision || timelineEventCount !== timelineRevision) {
    throw new Error("campaign event audit record is incomplete");
  }
  return event;
}

function diceEventFromReadRows(rows: DiceCampaignEventReadRow[]): RpgEvent {
  const row = rows[0]!;
  if (
    row.command_presence === null || row.event_presence === null || row.receipt_presence === null
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
    || row.event_actor_presence === null || row.event_id === null || row.command_id === null
    || row.campaign_id === null || row.timeline_id === null || row.actor_id === null
    || row.type !== "actor_dice_rolled" || row.revision === null || row.occurred_at === null
    || row.attribute_id !== null || row.value_before !== null || row.value_after !== null
    || row.resource_name !== null || row.resource_current !== null || row.resource_max !== null
    || row.roll_event_id === null || row.roll_campaign_id === null || row.roll_command_id === null
    || row.roll_expression === null || row.roll_selection_type === null
    || row.roll_dice_count === null || row.roll_dice_sides === null || row.roll_modifier === null
    || row.roll_total === null || row.attributable_roll_count !== 1
    || row.attributable_term_count !== rows.length
  ) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (rows.some((candidate) => candidate.event_id !== row.event_id
      || candidate.roll_event_id !== row.roll_event_id
      || candidate.roll_campaign_id !== row.roll_campaign_id
      || candidate.roll_command_id !== row.roll_command_id
      || candidate.roll_expression !== row.roll_expression
      || candidate.roll_dice_count !== row.roll_dice_count
      || candidate.roll_dice_sides !== row.roll_dice_sides
      || candidate.roll_selection_type !== row.roll_selection_type
      || candidate.roll_selection_count !== row.roll_selection_count
      || candidate.roll_modifier !== row.roll_modifier || candidate.roll_total !== row.roll_total)) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (row.roll_event_id !== row.event_id || row.roll_campaign_id !== row.campaign_id
      || row.roll_command_id !== row.command_id) {
    throw new Error("campaign event audit record is incomplete");
  }

  let selection: Record<string, unknown>;
  if (row.roll_selection_type === "keep_highest" || row.roll_selection_type === "keep_lowest") {
    selection = { type: row.roll_selection_type, count: row.roll_selection_count };
  } else {
    if (row.roll_selection_count !== null) throw new Error("campaign event audit record is incomplete");
    selection = { type: row.roll_selection_type };
  }
  const physicalCount = row.roll_selection_type === "advantage" || row.roll_selection_type === "disadvantage"
    ? 2 : row.roll_dice_count;
  if (typeof physicalCount !== "number" || !Number.isInteger(physicalCount)
      || rows.length !== physicalCount) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (rows.some((term, position) => term.term_event_id !== row.roll_event_id
      || term.term_position !== position
      || typeof term.term_kept !== "number" || !Number.isInteger(term.term_kept)
      || (term.term_kept !== 0 && term.term_kept !== 1))) {
    throw new Error("campaign event audit record is incomplete");
  }
  const terms = rows.map((term) => ({ value: term.term_value, kept: term.term_kept === 1 }));
  const normalized = {
    count: row.roll_dice_count,
    sides: row.roll_dice_sides,
    selection,
    modifier: row.roll_modifier,
  };
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.command_id,
    campaignId: row.campaign_id,
    timelineId: row.timeline_id,
    actorId: row.actor_id,
    sourceTurnId: row.source_turn_id,
    type: row.type,
    revision: row.revision,
    occurredAt: row.occurred_at,
    data: {
      expression: row.roll_expression,
      normalized,
      terms,
      modifier: row.roll_modifier,
      total: row.roll_total,
    },
  });
  if (event.type !== "actor_dice_rolled") throw new Error("campaign event audit record is incomplete");

  // The shared schema permits either equal-valued tied term to be retained.
  // Persistence requires the evaluator's stable earlier-physical-index choice.
  const keepCount = event.data.normalized.selection.type === "keep_highest"
    || event.data.normalized.selection.type === "keep_lowest"
    ? event.data.normalized.selection.count
    : event.data.normalized.selection.type === "all" ? event.data.normalized.count : 1;
  const keepHigh = event.data.normalized.selection.type === "keep_highest"
    || event.data.normalized.selection.type === "advantage";
  const expectedKept = new Set(event.data.terms.map((_, index) => index).sort((left, right) => {
    if (event.data.normalized.selection.type === "all") return left - right;
    const difference = keepHigh
      ? event.data.terms[right]!.value - event.data.terms[left]!.value
      : event.data.terms[left]!.value - event.data.terms[right]!.value;
    return difference === 0 ? left - right : difference;
  }).slice(0, keepCount));
  if (event.data.terms.some((term, index) => term.kept !== expectedKept.has(index))) {
    throw new Error("campaign event audit record is incomplete");
  }
  return event;
}

function listCampaignEvents(
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
  recentDiceOnly = false,
): RpgEvent[] {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedTimelineId = resourceIdSchema.parse(timelineId);
  const derived = db.prepare(`SELECT h.parent_timeline_id,
      (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
        WHERE imported.campaign_id=h.campaign_id AND imported.timeline_id=h.timeline_id) AS imported_count
    FROM campaign_timeline_history h WHERE h.campaign_id=? AND h.timeline_id=?`)
    .get(normalizedCampaignId, normalizedTimelineId) as { parent_timeline_id: string | null; imported_count: number } | undefined;
  if (derived && (derived.parent_timeline_id !== null || derived.imported_count > 0)) {
    const timelineState = getCampaignTimelineReadSync(db, principalId, normalizedCampaignId, normalizedTimelineId);
    if (!timelineState) return [];
    const linked = db.prepare(`SELECT link.revision,event.command_id FROM campaign_timeline_events link
      JOIN campaign_events event ON event.event_id=link.event_id
      WHERE link.campaign_id=? AND link.timeline_id=? ORDER BY link.revision`).all(normalizedCampaignId, normalizedTimelineId) as
      Array<{ revision: number; command_id: string }>;
    const events: RpgEvent[] = linked.map((link) => {
      const receipt = getCommandReceipt(principalId, normalizedCampaignId, link.command_id);
      if (!receipt || receipt.events.length !== 1) throw new Error("campaign inherited event is incomplete");
      return rpgEventSchema.parse({ ...receipt.events[0], timelineId: normalizedTimelineId, revision: link.revision });
    });
    const imported = db.prepare(`SELECT * FROM campaign_imported_timeline_events
      WHERE campaign_id=? AND timeline_id=? ORDER BY revision`).all(normalizedCampaignId, normalizedTimelineId) as any[];
    for (const row of imported) events.push(rpgEventSchema.parse({ eventId: row.source_event_id,
      commandId: row.source_command_id, campaignId: normalizedCampaignId, timelineId: normalizedTimelineId,
      actorId: row.actor_id, sourceTurnId: row.source_turn_id, type: row.type, revision: row.revision,
      occurredAt: row.occurred_at, data: JSON.parse(row.public_data) }));
    events.sort((left, right) => left.revision - right.revision);
    if (events.length !== timelineState.revision || events.some((event, index) => event.revision !== index + 1))
      throw new Error("campaign inherited event history is incomplete");
    return recentDiceOnly ? events.filter((event) => event.type === "actor_dice_rolled").slice(-20).reverse() : events;
  }
  const auditIdentitySql = recentDiceOnly ? `
      SELECT campaign_id, command_id, timeline_id FROM campaign_events
      WHERE campaign_id = ? AND timeline_id = ? AND type = 'actor_dice_rolled'
      ORDER BY revision DESC, event_id DESC LIMIT 20` : `
      SELECT campaign_id, command_id, timeline_id FROM campaign_commands
      UNION
      SELECT campaign_id, command_id, timeline_id FROM campaign_events
      UNION
      SELECT orphan_receipt.campaign_id, orphan_receipt.command_id, ? AS timeline_id
        FROM command_receipts orphan_receipt
        WHERE NOT EXISTS (SELECT 1 FROM campaign_commands known_command
            WHERE known_command.campaign_id=orphan_receipt.campaign_id
              AND known_command.command_id=orphan_receipt.command_id)
          AND NOT EXISTS (SELECT 1 FROM campaign_events known_event
            WHERE known_event.campaign_id=orphan_receipt.campaign_id
              AND known_event.command_id=orphan_receipt.command_id)
      UNION
      SELECT orphan_roll.campaign_id, orphan_roll.command_id, ? AS timeline_id
        FROM rpg_dice_rolls orphan_roll
        WHERE NOT EXISTS (SELECT 1 FROM campaign_commands known_command
            WHERE known_command.campaign_id=orphan_roll.campaign_id
              AND known_command.command_id=orphan_roll.command_id)
          AND NOT EXISTS (SELECT 1 FROM campaign_events known_event
            WHERE known_event.campaign_id=orphan_roll.campaign_id
              AND known_event.command_id=orphan_roll.command_id)`;
  const rows = db.prepare(`SELECT
      audit_identity.command_id AS audit_command_id,
      command.command_id AS command_presence,
      event.event_id AS event_presence,
      receipt.command_id AS receipt_presence,
      requested_timeline.id AS requested_timeline_presence,
      event_timeline.id AS event_timeline_presence,
      event_timeline.revision AS event_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS event_timeline_event_count,
      requested_timeline.revision AS requested_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_commands invalid_command
          WHERE invalid_command.campaign_id=membership.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_commands command WHERE command.campaign_id=invalid_command.campaign_id
              AND command.command_id=invalid_command.command_id AND (${VALID_AUDIT_COMMAND})))
        + (SELECT COUNT(*) FROM campaign_events invalid_event
          WHERE invalid_event.campaign_id=membership.campaign_id AND NOT EXISTS (
            SELECT 1 FROM campaign_events event WHERE event.campaign_id=invalid_event.campaign_id
              AND event.event_id=invalid_event.event_id AND (${VALID_AUDIT_EVENT})))
        + (SELECT COUNT(*) FROM command_receipts receipt WHERE receipt.campaign_id=membership.campaign_id
          AND COALESCE((typeof(receipt.revision_before)='integer'
            AND receipt.revision_before BETWEEN 0 AND 9007199254740990
            AND typeof(receipt.revision_after)='integer' AND receipt.revision_after=receipt.revision_before+1
            AND EXISTS (SELECT 1 FROM campaign_commands command WHERE command.campaign_id=receipt.campaign_id
              AND command.command_id=receipt.command_id AND command.expected_revision=receipt.revision_before)
            AND EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id=receipt.campaign_id
              AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
              AND event.revision=receipt.revision_after)),0)<>1)
        + (SELECT COUNT(*) FROM rpg_dice_rolls invalid_roll WHERE invalid_roll.campaign_id=membership.campaign_id
          AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll WHERE roll.event_id=invalid_roll.event_id
            AND (${VALID_DICE_ROLL})))
        + (SELECT COUNT(*) FROM rpg_dice_terms term
          WHERE NOT EXISTS (SELECT 1 FROM rpg_dice_rolls parent WHERE parent.event_id=term.event_id)
            AND (EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id=membership.campaign_id
                AND event.event_id=term.event_id)
              OR EXISTS (SELECT 1 FROM command_receipts receipt WHERE receipt.campaign_id=membership.campaign_id
                AND receipt.event_id=term.event_id)))) AS invalid_audit_count,
      (SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_event_count,
      (SELECT MIN(timeline_event.revision) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_min_revision,
      (SELECT MAX(timeline_event.revision) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = membership.campaign_id
          AND timeline_event.timeline_id = ?) AS requested_timeline_max_revision,
      event_actor.id AS event_actor_presence,
      (SELECT COUNT(*) FROM rpg_dice_terms attributable_term
        WHERE attributable_term.event_id = event.event_id) AS attributable_term_count,
      event.event_id, event.command_id, event.campaign_id, event.timeline_id, event.actor_id,
      event.source_turn_id, event.type, event.revision, event.occurred_at,
      event.attribute_id, event.value_before, event.value_after,
      event.resource_name, event.resource_current, event.resource_max,
      (SELECT COUNT(*) FROM rpg_dice_rolls attributable_roll
        WHERE attributable_roll.event_id = event.event_id OR (
          attributable_roll.campaign_id = audit_identity.campaign_id
          AND attributable_roll.command_id = audit_identity.command_id)) AS attributable_roll_count,
      roll.event_id AS roll_event_id, roll.campaign_id AS roll_campaign_id,
      roll.command_id AS roll_command_id, roll.expression AS roll_expression,
      roll.dice_count AS roll_dice_count, roll.dice_sides AS roll_dice_sides,
      roll.selection_type AS roll_selection_type, roll.selection_count AS roll_selection_count,
      roll.modifier AS roll_modifier, roll.total AS roll_total,
      term.event_id AS term_event_id, term.position AS term_position,
      term.value AS term_value, term.kept AS term_kept
    FROM campaign_memberships membership
    JOIN principals principal ON principal.id = membership.principal_id
    JOIN campaigns campaign ON campaign.id = membership.campaign_id
    LEFT JOIN (${auditIdentitySql}) audit_identity
      ON audit_identity.campaign_id = membership.campaign_id AND audit_identity.timeline_id = ?
    LEFT JOIN campaign_timelines requested_timeline
      ON requested_timeline.campaign_id = membership.campaign_id
        AND requested_timeline.id = ?
    LEFT JOIN campaign_events event
      ON event.campaign_id = audit_identity.campaign_id
        AND event.command_id = audit_identity.command_id AND event.timeline_id = audit_identity.timeline_id
    LEFT JOIN rpg_dice_rolls roll
      ON roll.event_id = event.event_id OR (
        roll.campaign_id = audit_identity.campaign_id AND roll.command_id = audit_identity.command_id)
    LEFT JOIN rpg_dice_terms term ON term.event_id = roll.event_id
    LEFT JOIN campaign_commands command
      ON command.campaign_id = audit_identity.campaign_id AND command.command_id = audit_identity.command_id
        AND command.timeline_id = audit_identity.timeline_id AND command.actor_id = event.actor_id
        AND command.source_turn_id IS event.source_turn_id
        AND command.expected_revision + 1 = event.revision
        AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
            AND command.attribute_id = event.attribute_id AND command.value = event.value_after
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND command.dice_expression IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id IS NULL)
          OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
            AND command.attribute_id IS NULL AND command.value IS NULL AND command.dice_expression IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND command.resource_name = event.resource_name
            AND command.resource_current = event.resource_current AND command.resource_max = event.resource_max
            AND roll.event_id IS NULL)
          OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
            AND command.attribute_id IS NULL AND command.value IS NULL
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id = event.event_id AND roll.campaign_id = event.campaign_id
            AND roll.command_id = event.command_id AND command.dice_expression = roll.expression
            AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
            AND command.dice_selection_type = roll.selection_type
            AND command.dice_selection_count IS roll.selection_count
            AND command.dice_modifier = roll.modifier))
        AND length(command.idempotency_key) BETWEEN 1 AND 128
        AND command.idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = audit_identity.campaign_id AND receipt.command_id = audit_identity.command_id
        AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision
        AND receipt.revision_before + 1 = receipt.revision_after
        AND receipt.revision_before = command.expected_revision
    LEFT JOIN campaign_timelines event_timeline
      ON event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id
    LEFT JOIN campaign_actors event_actor
      ON event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id
    WHERE membership.principal_id = ? AND membership.campaign_id = ?
      AND (membership.role IN ('gm', 'player', 'observer') OR (
        membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
      ))
    ORDER BY event.revision ${recentDiceOnly ? "DESC" : "ASC"},
      event.event_id ${recentDiceOnly ? "DESC" : "ASC"}, term.position ASC`)
    .all(normalizedTimelineId, normalizedTimelineId, normalizedTimelineId,
      ...(recentDiceOnly
        ? [normalizedCampaignId, normalizedTimelineId]
        : [normalizedTimelineId, normalizedTimelineId]),
      normalizedTimelineId, normalizedTimelineId,
      principalId, normalizedCampaignId) as DiceCampaignEventReadRow[];
  if (rows.length === 0) return [];
  const first = rows[0]!;
  if (first.requested_timeline_presence === null) {
    if (rows.some((row) => row.audit_command_id !== null)) {
      throw new Error("campaign event audit record is incomplete");
    }
    return [];
  }
  const timelineRevision = revisionSchema.parse(first.requested_timeline_revision);
  const eventCount = revisionSchema.parse(first.requested_timeline_event_count);
  const completeHistory = eventCount === timelineRevision && (timelineRevision === 0
    ? first.requested_timeline_min_revision === null && first.requested_timeline_max_revision === null
    : first.requested_timeline_min_revision === 1
      && first.requested_timeline_max_revision === timelineRevision);
  if (!completeHistory || revisionSchema.parse(first.invalid_audit_count) !== 0
      || rows.some((row) => row.requested_timeline_presence !== first.requested_timeline_presence
      || row.requested_timeline_revision !== first.requested_timeline_revision
      || row.requested_timeline_event_count !== first.requested_timeline_event_count
      || row.requested_timeline_min_revision !== first.requested_timeline_min_revision
      || row.requested_timeline_max_revision !== first.requested_timeline_max_revision
      || row.invalid_audit_count !== first.invalid_audit_count)) {
    throw new Error("campaign event audit record is incomplete");
  }
  if (first.audit_command_id === null) return [];

  const events: RpgEvent[] = [];
  for (let start = 0; start < rows.length;) {
    const identity = rows[start]!.audit_command_id;
    let end = start + 1;
    while (end < rows.length && rows[end]!.audit_command_id === identity) end += 1;
    const eventRows = rows.slice(start, end);
    events.push(eventRows[0]!.type === "actor_dice_rolled"
      ? diceEventFromReadRows(eventRows)
      : eventFromReadRow(eventRows[0]!));
    start = end;
  }
  return events;
}

function listRecentCampaignDiceEvents(
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
): CampaignDiceEvent[] {
  const events = listCampaignEvents(actorPrincipalId, campaignId, timelineId, true);
  if (events.some((event) => event.type !== "actor_dice_rolled")) {
    throw new Error("campaign event audit record is incomplete");
  }
  return events as CampaignDiceEvent[];
}

function getCommandReceipt(
  actorPrincipalId: string,
  campaignId: string,
  commandId: string,
): CommandReceipt | null {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedCommandId = resourceIdSchema.parse(commandId);
  const rows = db.prepare(`SELECT
      audit_identity.command_id AS audit_command_id,
      command.command_id AS command_presence,
      event.event_id AS event_presence,
      receipt.command_id AS receipt_presence,
      requested_timeline.id AS requested_timeline_presence,
      event_timeline.id AS event_timeline_presence,
      event_timeline.revision AS event_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS event_timeline_event_count,
      requested_timeline.revision AS requested_timeline_revision,
      ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
        WHERE timeline_event.campaign_id = event.campaign_id
          AND timeline_event.timeline_id = event.timeline_id)
        + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_event_count,
      (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events timeline_event
          WHERE timeline_event.campaign_id=event.campaign_id AND timeline_event.timeline_id=event.timeline_id
        UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_min_revision,
      (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events timeline_event
          WHERE timeline_event.campaign_id=event.campaign_id AND timeline_event.timeline_id=event.timeline_id
        UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
          WHERE imported.campaign_id=event.campaign_id AND imported.timeline_id=event.timeline_id)) AS requested_timeline_max_revision,
      event_actor.id AS event_actor_presence,
      (SELECT COUNT(*) FROM rpg_dice_terms attributable_term
        WHERE attributable_term.event_id = event.event_id) AS attributable_term_count,
      receipt.revision_before, receipt.revision_after,
      event.event_id, event.command_id, event.campaign_id, event.timeline_id, event.actor_id,
      event.source_turn_id, event.type, event.revision, event.occurred_at,
      event.attribute_id, event.value_before, event.value_after,
      event.resource_name, event.resource_current, event.resource_max,
      (SELECT COUNT(*) FROM rpg_dice_rolls attributable_roll
        WHERE attributable_roll.event_id = event.event_id OR (
          attributable_roll.campaign_id = audit_identity.campaign_id
          AND attributable_roll.command_id = audit_identity.command_id)) AS attributable_roll_count,
      roll.event_id AS roll_event_id, roll.campaign_id AS roll_campaign_id,
      roll.command_id AS roll_command_id, roll.expression AS roll_expression,
      roll.dice_count AS roll_dice_count, roll.dice_sides AS roll_dice_sides,
      roll.selection_type AS roll_selection_type, roll.selection_count AS roll_selection_count,
      roll.modifier AS roll_modifier, roll.total AS roll_total,
      term.event_id AS term_event_id, term.position AS term_position,
      term.value AS term_value, term.kept AS term_kept
    FROM campaign_memberships membership
    JOIN principals principal ON principal.id = membership.principal_id
    JOIN campaigns campaign ON campaign.id = membership.campaign_id
    JOIN (
      SELECT campaign_id, command_id FROM campaign_commands
      UNION
      SELECT campaign_id, command_id FROM campaign_events
      UNION
      SELECT campaign_id, command_id FROM command_receipts
      UNION
      SELECT campaign_id, command_id FROM rpg_dice_rolls
    ) audit_identity
      ON audit_identity.campaign_id = membership.campaign_id AND audit_identity.command_id = ?
    LEFT JOIN campaign_events event
      ON event.campaign_id = audit_identity.campaign_id AND event.command_id = audit_identity.command_id
    LEFT JOIN rpg_dice_rolls roll
      ON roll.event_id = event.event_id OR (
        roll.campaign_id = audit_identity.campaign_id AND roll.command_id = audit_identity.command_id)
    LEFT JOIN rpg_dice_terms term ON term.event_id = roll.event_id
    LEFT JOIN campaign_commands command
      ON command.campaign_id = audit_identity.campaign_id AND command.command_id = audit_identity.command_id
        AND command.timeline_id = event.timeline_id AND command.actor_id = event.actor_id
        AND command.source_turn_id IS event.source_turn_id
        AND command.expected_revision + 1 = event.revision
        AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
            AND command.attribute_id = event.attribute_id AND command.value = event.value_after
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND command.dice_expression IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id IS NULL)
          OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
            AND command.attribute_id IS NULL AND command.value IS NULL AND command.dice_expression IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND command.resource_name = event.resource_name
            AND command.resource_current = event.resource_current AND command.resource_max = event.resource_max
            AND roll.event_id IS NULL)
          OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
            AND command.attribute_id IS NULL AND command.value IS NULL
            AND command.resource_name IS NULL AND command.resource_current IS NULL AND command.resource_max IS NULL
            AND event.attribute_id IS NULL AND event.value_before IS NULL AND event.value_after IS NULL
            AND event.resource_name IS NULL AND event.resource_current IS NULL AND event.resource_max IS NULL
            AND roll.event_id = event.event_id AND roll.campaign_id = event.campaign_id
            AND roll.command_id = event.command_id AND command.dice_expression = roll.expression
            AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
            AND command.dice_selection_type = roll.selection_type
            AND command.dice_selection_count IS roll.selection_count
            AND command.dice_modifier = roll.modifier))
        AND length(command.idempotency_key) BETWEEN 1 AND 128
        AND command.idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
    LEFT JOIN command_receipts receipt
      ON receipt.campaign_id = audit_identity.campaign_id AND receipt.command_id = audit_identity.command_id
        AND receipt.revision_before = command.expected_revision
        AND receipt.revision_after = command.expected_revision + 1
        AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision
    LEFT JOIN campaign_timelines requested_timeline
      ON requested_timeline.campaign_id = event.campaign_id AND requested_timeline.id = event.timeline_id
    LEFT JOIN campaign_timelines event_timeline
      ON event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id
    LEFT JOIN campaign_actors event_actor
      ON event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id
    WHERE membership.principal_id = ? AND membership.campaign_id = ?
      AND (membership.role IN ('gm', 'player', 'observer') OR (
        membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
      ))
    ORDER BY term.position ASC`)
    .all(normalizedCommandId, principalId, normalizedCampaignId) as CommandReceiptReadRow[];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (
    row.receipt_presence === null || row.revision_before === null || row.revision_after === null
    || row.event_id === null || row.audit_command_id !== normalizedCommandId
    || row.requested_timeline_presence === null || row.event_timeline_presence === null
  ) {
    throw new Error("command receipt audit record is incomplete");
  }
  const timelineRevision = revisionSchema.parse(row.requested_timeline_revision);
  const timelineEventCount = revisionSchema.parse(row.requested_timeline_event_count);
  const completeHistory = timelineEventCount === timelineRevision && (timelineRevision === 0
    ? row.requested_timeline_min_revision === null && row.requested_timeline_max_revision === null
    : row.requested_timeline_min_revision === 1 && row.requested_timeline_max_revision === timelineRevision);
  if (!completeHistory || rows.some((candidate) =>
      candidate.audit_command_id !== row.audit_command_id
      || candidate.revision_before !== row.revision_before || candidate.revision_after !== row.revision_after
      || candidate.requested_timeline_presence !== row.requested_timeline_presence
      || candidate.requested_timeline_revision !== row.requested_timeline_revision
      || candidate.requested_timeline_event_count !== row.requested_timeline_event_count
      || candidate.requested_timeline_min_revision !== row.requested_timeline_min_revision
      || candidate.requested_timeline_max_revision !== row.requested_timeline_max_revision)) {
    throw new Error("command receipt audit record is incomplete");
  }
  const event = row.type === "actor_dice_rolled" ? diceEventFromReadRows(rows) : eventFromReadRow(row);
  return commandReceiptSchema.parse({
    commandId: normalizedCommandId,
    campaignId: normalizedCampaignId,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
}

  return { listCampaignEvents, listRecentCampaignDiceEvents, getCommandReceipt };
}
