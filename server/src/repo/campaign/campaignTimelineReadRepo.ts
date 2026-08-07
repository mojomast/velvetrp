// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignMembershipReadSchema,
  campaignTimelineSchema,
  resourceIdSchema,
  revisionSchema,
} from "@velvet/contracts";
import type { CampaignTimeline } from "../../types.js";

interface CampaignTimelineReadRow {
  actor_campaign_id: string;
  actor_principal_id: string;
  actor_role: string;
  actor_created_at: string;
  campaign_id: string;
  active_timeline_id: string;
  active_timeline_presence: string | null;
  active_timeline_campaign_id: string | null;
  timeline_id: string | null;
  timeline_campaign_id: string | null;
  timeline_revision: unknown;
  timeline_created_at: string | null;
  event_count: unknown;
  command_count: unknown;
  receipt_count: unknown;
  minimum_revision: unknown;
  maximum_revision: unknown;
  distinct_revision_count: unknown;
  invalid_audit_count: unknown;
}

const SQL_VALID_RESOURCE_ID = (column: string): string =>
  `length(${column}) BETWEEN 1 AND 128 AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;
const SQL_VALID_TIMESTAMP = (column: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL
    AND ${column} = strftime('%Y-%m-%dT%H:%M:%fZ', ${column})
    AND substr(${column}, 12, 2) BETWEEN '00' AND '23'`;

/*
 * This predicate deliberately repeats the persisted audit contract in SQL. The
 * timeline list cannot reconstruct history with follow-up queries: each row
 * carries a bounded aggregate proving that every attributable audit root is a
 * complete, exact command/event/receipt variant (and, for dice, roll/terms).
 */
export const VALID_AUDIT_COMMAND = `
  ${SQL_VALID_RESOURCE_ID("command.command_id")}
  AND ${SQL_VALID_RESOURCE_ID("command.timeline_id")}
  AND ${SQL_VALID_RESOURCE_ID("command.actor_id")}
  AND (command.source_turn_id IS NULL OR (${SQL_VALID_RESOURCE_ID("command.source_turn_id")}))
  AND typeof(command.expected_revision) = 'integer'
  AND command.expected_revision BETWEEN 0 AND 9007199254740990
  AND EXISTS (SELECT 1 FROM campaign_timelines command_timeline
    WHERE command_timeline.campaign_id = command.campaign_id AND command_timeline.id = command.timeline_id)
  AND EXISTS (SELECT 1 FROM campaign_actors command_actor
    WHERE command_actor.campaign_id = command.campaign_id AND command_actor.id = command.actor_id)
  AND (SELECT COUNT(*) FROM campaign_events event
    WHERE event.campaign_id = command.campaign_id AND event.command_id = command.command_id) = 1
  AND (SELECT COUNT(*) FROM command_receipts receipt
    WHERE receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id) = 1
  AND EXISTS (SELECT 1
    FROM campaign_events event
    JOIN command_receipts receipt ON receipt.campaign_id = event.campaign_id
      AND receipt.command_id = event.command_id AND receipt.event_id = event.event_id
    WHERE event.campaign_id = command.campaign_id AND event.command_id = command.command_id
      AND event.timeline_id = command.timeline_id AND event.actor_id = command.actor_id
      AND event.source_turn_id IS command.source_turn_id
      AND event.revision = command.expected_revision + 1
      AND receipt.revision_before = command.expected_revision
      AND receipt.revision_after = event.revision
      AND typeof(receipt.revision_before) = 'integer' AND typeof(receipt.revision_after) = 'integer'
      AND ((command.type = 'set_actor_attribute' AND event.type = 'actor_attribute_set'
          AND ${SQL_VALID_RESOURCE_ID("command.attribute_id")}
          AND typeof(command.value) = 'integer' AND command.value BETWEEN -1000 AND 1000
          AND event.attribute_id = command.attribute_id AND event.value_after = command.value
          AND command.resource_name IS NULL AND command.resource_current IS NULL
          AND command.resource_max IS NULL AND command.dice_expression IS NULL
          AND command.dice_count IS NULL AND command.dice_sides IS NULL
          AND command.dice_selection_type IS NULL AND command.dice_selection_count IS NULL
          AND command.dice_modifier IS NULL)
        OR (command.type = 'initialize_actor_resource' AND event.type = 'actor_resource_initialized'
          AND command.attribute_id IS NULL AND command.value IS NULL
          AND ${SQL_VALID_RESOURCE_ID("command.resource_name")}
          AND typeof(command.resource_current) = 'integer' AND command.resource_current BETWEEN 0 AND 1000000
          AND typeof(command.resource_max) = 'integer' AND command.resource_max BETWEEN 0 AND 1000000
          AND command.resource_current <= command.resource_max
          AND event.resource_name = command.resource_name
          AND event.resource_current = command.resource_current AND event.resource_max = command.resource_max
          AND command.dice_expression IS NULL AND command.dice_count IS NULL
          AND command.dice_sides IS NULL AND command.dice_selection_type IS NULL
          AND command.dice_selection_count IS NULL AND command.dice_modifier IS NULL)
        OR (command.type = 'roll_actor_dice' AND event.type = 'actor_dice_rolled'
          AND command.attribute_id IS NULL AND command.value IS NULL AND command.resource_name IS NULL
          AND command.resource_current IS NULL AND command.resource_max IS NULL
          AND EXISTS (SELECT 1 FROM rpg_dice_rolls roll
            WHERE roll.campaign_id = command.campaign_id AND roll.command_id = command.command_id
              AND roll.event_id = event.event_id AND roll.expression = command.dice_expression
              AND roll.dice_count = command.dice_count AND roll.dice_sides = command.dice_sides
              AND roll.selection_type = command.dice_selection_type
              AND roll.selection_count IS command.dice_selection_count
              AND roll.modifier = command.dice_modifier))))`;

export const VALID_AUDIT_EVENT = `
  ${SQL_VALID_RESOURCE_ID("event.event_id")} AND ${SQL_VALID_RESOURCE_ID("event.command_id")}
  AND ${SQL_VALID_RESOURCE_ID("event.timeline_id")} AND ${SQL_VALID_RESOURCE_ID("event.actor_id")}
  AND (event.source_turn_id IS NULL OR (${SQL_VALID_RESOURCE_ID("event.source_turn_id")}))
  AND typeof(event.revision) = 'integer' AND event.revision BETWEEN 1 AND 9007199254740991
  AND ${SQL_VALID_TIMESTAMP("event.occurred_at")}
  AND EXISTS (SELECT 1 FROM campaign_timelines event_timeline
    WHERE event_timeline.campaign_id = event.campaign_id AND event_timeline.id = event.timeline_id)
  AND EXISTS (SELECT 1 FROM campaign_actors event_actor
    WHERE event_actor.campaign_id = event.campaign_id AND event_actor.id = event.actor_id)
  AND EXISTS (SELECT 1 FROM campaign_commands command
    WHERE command.campaign_id = event.campaign_id AND command.command_id = event.command_id
      AND command.timeline_id = event.timeline_id AND command.actor_id = event.actor_id
      AND command.source_turn_id IS event.source_turn_id AND command.expected_revision + 1 = event.revision)
  AND EXISTS (SELECT 1 FROM command_receipts receipt
    WHERE receipt.campaign_id = event.campaign_id AND receipt.command_id = event.command_id
      AND receipt.event_id = event.event_id AND receipt.revision_after = event.revision)
  AND ((event.type = 'actor_attribute_set' AND ${SQL_VALID_RESOURCE_ID("event.attribute_id")}
      AND typeof(event.value_before) = 'integer' AND event.value_before BETWEEN -1000 AND 1000
      AND typeof(event.value_after) = 'integer' AND event.value_after BETWEEN -1000 AND 1000
      AND event.value_before <> event.value_after AND event.resource_name IS NULL
      AND event.resource_current IS NULL AND event.resource_max IS NULL
      AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id))
    OR (event.type = 'actor_resource_initialized' AND event.attribute_id IS NULL
      AND event.value_before IS NULL AND event.value_after IS NULL
      AND ${SQL_VALID_RESOURCE_ID("event.resource_name")}
      AND typeof(event.resource_current) = 'integer' AND event.resource_current BETWEEN 0 AND 1000000
      AND typeof(event.resource_max) = 'integer' AND event.resource_max BETWEEN 0 AND 1000000
      AND event.resource_current <= event.resource_max
      AND NOT EXISTS (SELECT 1 FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id))
    OR (event.type = 'actor_dice_rolled' AND event.attribute_id IS NULL
      AND event.value_before IS NULL AND event.value_after IS NULL AND event.resource_name IS NULL
      AND event.resource_current IS NULL AND event.resource_max IS NULL
      AND (SELECT COUNT(*) FROM rpg_dice_rolls roll
        WHERE roll.campaign_id = event.campaign_id AND roll.event_id = event.event_id) = 1))`;

export const VALID_DICE_ROLL = `
  ${SQL_VALID_RESOURCE_ID("roll.event_id")} AND ${SQL_VALID_RESOURCE_ID("roll.command_id")}
  AND typeof(roll.dice_count) = 'integer' AND roll.dice_count BETWEEN 1 AND 100
  AND typeof(roll.dice_sides) = 'integer' AND roll.dice_sides BETWEEN 2 AND 1000
  AND typeof(roll.modifier) = 'integer' AND roll.modifier BETWEEN -1000 AND 1000
  AND typeof(roll.total) = 'integer' AND roll.total BETWEEN -1000 AND 101000
  AND ((roll.selection_type = 'all' AND roll.selection_count IS NULL)
    OR (roll.selection_type IN ('keep_highest', 'keep_lowest')
      AND typeof(roll.selection_count) = 'integer'
      AND roll.selection_count BETWEEN 1 AND roll.dice_count)
    OR (roll.selection_type IN ('advantage', 'disadvantage')
      AND roll.selection_count IS NULL AND roll.dice_count = 1))
  AND roll.expression = CAST(roll.dice_count AS TEXT) || 'd' || CAST(roll.dice_sides AS TEXT)
    || CASE roll.selection_type WHEN 'all' THEN '' WHEN 'keep_highest' THEN 'kh' || CAST(roll.selection_count AS TEXT)
      WHEN 'keep_lowest' THEN 'kl' || CAST(roll.selection_count AS TEXT)
      WHEN 'advantage' THEN 'adv' ELSE 'dis' END
    || CASE WHEN roll.modifier = 0 THEN '' WHEN roll.modifier > 0
      THEN '+' || CAST(roll.modifier AS TEXT) ELSE CAST(roll.modifier AS TEXT) END
  AND EXISTS (SELECT 1 FROM campaign_commands command
    WHERE command.campaign_id = roll.campaign_id AND command.command_id = roll.command_id
      AND command.type = 'roll_actor_dice' AND command.dice_expression = roll.expression
      AND command.dice_count = roll.dice_count AND command.dice_sides = roll.dice_sides
      AND command.dice_selection_type = roll.selection_type
      AND command.dice_selection_count IS roll.selection_count AND command.dice_modifier = roll.modifier)
  AND EXISTS (SELECT 1 FROM campaign_events event
    WHERE event.campaign_id = roll.campaign_id AND event.command_id = roll.command_id
      AND event.event_id = roll.event_id AND event.type = 'actor_dice_rolled')
  AND EXISTS (SELECT 1 FROM command_receipts receipt
    WHERE receipt.campaign_id = roll.campaign_id AND receipt.command_id = roll.command_id
      AND receipt.event_id = roll.event_id)
  AND (SELECT COUNT(*) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 2 ELSE roll.dice_count END
  AND (SELECT COUNT(DISTINCT term.position) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 2 ELSE roll.dice_count END
  AND (SELECT COALESCE(MIN(term.position), -1) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id) = 0
  AND (SELECT COALESCE(MAX(term.position), -1) FROM rpg_dice_terms term WHERE term.event_id = roll.event_id)
    = CASE WHEN roll.selection_type IN ('advantage', 'disadvantage') THEN 1 ELSE roll.dice_count - 1 END
  AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms term
    WHERE term.event_id = roll.event_id AND (
      typeof(term.position) <> 'integer' OR typeof(term.value) <> 'integer'
      OR term.value < 1 OR term.value > roll.dice_sides
      OR typeof(term.kept) <> 'integer' OR term.kept NOT IN (0, 1)
      OR term.kept <> CASE
        WHEN roll.selection_type = 'all' THEN 1
        WHEN roll.selection_type IN ('keep_highest', 'advantage') THEN
          CASE WHEN (SELECT COUNT(*) FROM rpg_dice_terms better
            WHERE better.event_id = roll.event_id AND (better.value > term.value
              OR (better.value = term.value AND better.position < term.position)))
            < COALESCE(roll.selection_count, 1) THEN 1 ELSE 0 END
        ELSE CASE WHEN (SELECT COUNT(*) FROM rpg_dice_terms better
            WHERE better.event_id = roll.event_id AND (better.value < term.value
              OR (better.value = term.value AND better.position < term.position)))
            < COALESCE(roll.selection_count, 1) THEN 1 ELSE 0 END END))
  AND roll.total = roll.modifier + (SELECT COALESCE(SUM(term.value), 0)
    FROM rpg_dice_terms term WHERE term.event_id = roll.event_id AND term.kept = 1)`;

const CAMPAIGN_TIMELINE_READ_SELECT = `SELECT
  membership.campaign_id AS actor_campaign_id, membership.principal_id AS actor_principal_id,
  membership.role AS actor_role, membership.created_at AS actor_created_at,
  campaign.id AS campaign_id, campaign.active_timeline_id,
  active_timeline.id AS active_timeline_presence,
  active_timeline.campaign_id AS active_timeline_campaign_id,
  timeline.id AS timeline_id, timeline.campaign_id AS timeline_campaign_id,
  timeline.revision AS timeline_revision, timeline.created_at AS timeline_created_at,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS event_count,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS command_count,
  ((SELECT COUNT(*) FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)
    + (SELECT COUNT(*) FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS receipt_count,
  (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS minimum_revision,
  (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS maximum_revision,
  (SELECT COUNT(DISTINCT revision) FROM (SELECT revision FROM campaign_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id UNION ALL
      SELECT revision FROM campaign_imported_timeline_events event
      WHERE event.campaign_id=campaign.id AND event.timeline_id=timeline.id)) AS distinct_revision_count,
  ((SELECT COUNT(*) FROM campaign_commands command WHERE command.campaign_id = campaign.id
      AND COALESCE((${VALID_AUDIT_COMMAND}), 0) <> 1)
    + (SELECT COUNT(*) FROM campaign_events event WHERE event.campaign_id = campaign.id
      AND COALESCE((${VALID_AUDIT_EVENT}), 0) <> 1)
    + (SELECT COUNT(*) FROM command_receipts receipt WHERE receipt.campaign_id = campaign.id AND COALESCE((
      typeof(receipt.revision_before) = 'integer' AND receipt.revision_before BETWEEN 0 AND 9007199254740990
      AND typeof(receipt.revision_after) = 'integer' AND receipt.revision_after = receipt.revision_before + 1
      AND EXISTS (SELECT 1 FROM campaign_commands command WHERE command.campaign_id = receipt.campaign_id
        AND command.command_id = receipt.command_id AND command.expected_revision = receipt.revision_before)
      AND EXISTS (SELECT 1 FROM campaign_events event WHERE event.campaign_id = receipt.campaign_id
        AND event.command_id = receipt.command_id AND event.event_id = receipt.event_id
        AND event.revision = receipt.revision_after)), 0) <> 1)
    + (SELECT COUNT(*) FROM rpg_dice_rolls roll WHERE roll.campaign_id = campaign.id
      AND COALESCE((${VALID_DICE_ROLL}), 0) <> 1)
    + (SELECT COUNT(*) FROM rpg_dice_terms term
      WHERE NOT EXISTS (SELECT 1 FROM rpg_dice_rolls owning_roll
          WHERE owning_roll.event_id = term.event_id)
        AND (EXISTS (SELECT 1 FROM campaign_events event
          WHERE event.campaign_id = campaign.id AND event.event_id = term.event_id)
        OR EXISTS (SELECT 1 FROM command_receipts receipt
          WHERE receipt.campaign_id = campaign.id AND receipt.event_id = term.event_id)))) AS invalid_audit_count
FROM campaign_memberships membership
JOIN principals principal ON principal.id = membership.principal_id
JOIN campaigns campaign ON campaign.id = membership.campaign_id
LEFT JOIN campaign_timelines active_timeline
  ON active_timeline.campaign_id = campaign.id AND active_timeline.id = campaign.active_timeline_id
LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id
WHERE membership.principal_id = ? AND membership.campaign_id = ?
  AND (membership.role IN ('gm', 'player', 'observer') OR (
    membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))
ORDER BY timeline.created_at ASC, timeline.id COLLATE BINARY ASC`;

// Keep get authorization and every audit aggregate byte-for-byte shared with
// the list boundary; only constrain the left-joined projection to its target.
const CAMPAIGN_TIMELINE_GET_SELECT = CAMPAIGN_TIMELINE_READ_SELECT
  .replace(
    "LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id",
    "LEFT JOIN campaign_timelines timeline ON timeline.campaign_id = campaign.id AND timeline.id = ?",
  )
  .replace("\nORDER BY timeline.created_at ASC, timeline.id COLLATE BINARY ASC", "");

function toCampaignTimelineRead(row: CampaignTimelineReadRow): CampaignTimeline {
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    if (row.active_timeline_presence === null
        || row.active_timeline_presence !== row.active_timeline_id
        || row.active_timeline_campaign_id !== row.campaign_id
        || row.timeline_id === null || row.timeline_campaign_id !== row.campaign_id
        || row.timeline_created_at === null) {
      throw new Error();
    }
    const timeline = campaignTimelineSchema.parse({
      id: row.timeline_id,
      campaignId: row.timeline_campaign_id,
      revision: row.timeline_revision,
      createdAt: row.timeline_created_at,
    });
    const revision = timeline.revision;
    const eventCount = revisionSchema.parse(row.event_count);
    const commandCount = revisionSchema.parse(row.command_count);
    const receiptCount = revisionSchema.parse(row.receipt_count);
    const distinctCount = revisionSchema.parse(row.distinct_revision_count);
    const invalidCount = revisionSchema.parse(row.invalid_audit_count);
    if (eventCount !== revision || commandCount !== revision || receiptCount !== revision
        || distinctCount !== revision || invalidCount !== 0
        || (revision === 0
          ? row.minimum_revision !== null || row.maximum_revision !== null
          : row.minimum_revision !== 1 || row.maximum_revision !== revision)) {
      throw new Error();
    }
    return timeline;
  } catch {
    throw new Error("campaign timeline aggregate is malformed");
  }
}

export function listCampaignTimelinesSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
): CampaignTimeline[] {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const rows = db.prepare(CAMPAIGN_TIMELINE_READ_SELECT)
    .all(principalId, normalizedCampaignId) as CampaignTimelineReadRow[];
  return rows.map(toCampaignTimelineRead);
}

export function getCampaignTimelineSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
): CampaignTimeline | null {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const normalizedCampaignId = resourceIdSchema.parse(campaignId);
  const normalizedTimelineId = resourceIdSchema.parse(timelineId);
  const row = db.prepare(CAMPAIGN_TIMELINE_GET_SELECT)
    .get(normalizedTimelineId, principalId, normalizedCampaignId) as CampaignTimelineReadRow | undefined;
  if (!row) return null;
  if (row.timeline_id !== null) return toCampaignTimelineRead(row);

  // A left-joined miss must still validate attributable campaign integrity for
  // an authorized member; only the genuine absent/cross-campaign target is null.
  try {
    campaignMembershipReadSchema.parse({
      campaignId: row.actor_campaign_id,
      principalId: row.actor_principal_id,
      role: row.actor_role,
      createdAt: row.actor_created_at,
    });
    if (row.active_timeline_presence === null
        || row.active_timeline_presence !== row.active_timeline_id
        || row.active_timeline_campaign_id !== row.campaign_id
        || revisionSchema.parse(row.invalid_audit_count) !== 0
        || row.timeline_campaign_id !== null || row.timeline_revision !== null
        || row.timeline_created_at !== null || row.minimum_revision !== null
        || row.maximum_revision !== null || row.event_count !== 0
        || row.command_count !== 0 || row.receipt_count !== 0
        || row.distinct_revision_count !== 0) {
      throw new Error();
    }
    return null;
  } catch {
    throw new Error("campaign timeline aggregate is malformed");
  }
}
