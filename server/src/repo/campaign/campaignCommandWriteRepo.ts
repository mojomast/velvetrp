// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import {
  MAX_CAMPAIGN_CHARACTER_ROSTER,
  commandEnvelopeSchema,
  commandReceiptSchema,
  publicCampaignCharacterSummarySchema,
  resourceIdSchema,
  revisionSchema,
  rpgEventSchema,
  setActorAttributePayloadSchema,
  utcIsoTimestampSchema,
} from "@velvet/contracts";
import { evaluateDiceExpression, parseDiceExpression } from "../../dice.js";
import { CampaignDiceCharacterConflict, type CampaignDiceVisibleCharacterBinding } from "../diceRepo.js";
import { projectLegacyPersonaDisplayName } from "./legacyPersonaDisplayName.js";
import { createCampaignCharacterRosterOperations } from "./campaignCharacterRosterRepo.js";
import type { CommandEnvelope, CommandReceipt } from "../../types.js";
import type { RepositoryDependencies } from "./campaignTypes.js";

interface CampaignCommandRow {
  campaign_id: string;
  command_id: string;
  idempotency_key: string;
  timeline_id: string;
  actor_id: string;
  expected_revision: number;
  source_turn_id: string | null;
  type: string;
  attribute_id: string | null;
  value: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
  dice_expression: string | null;
  dice_count: number | null;
  dice_sides: number | null;
  dice_selection_type: string | null;
  dice_selection_count: number | null;
  dice_modifier: number | null;
}

interface CommandRetryRow extends CampaignCommandRow {
  retry_timeline_presence: string | null;
  retry_timeline_revision: unknown;
  retry_timeline_event_count: unknown;
  retry_actor_presence: string | null;
  revision_before: number | null;
  revision_after: number | null;
  receipt_event_id: string | null;
  event_id: string | null;
  event_campaign_id: string | null;
  event_command_id: string | null;
  event_timeline_id: string | null;
  event_actor_id: string | null;
  event_source_turn_id: string | null;
  event_type: string | null;
  event_revision: number | null;
  occurred_at: string | null;
  event_attribute_id: string | null;
  value_before: number | null;
  value_after: number | null;
  resource_name: string | null;
  resource_current: number | null;
  resource_max: number | null;
  event_resource_name: string | null;
  event_resource_current: number | null;
  event_resource_max: number | null;
  dice_roll_presence: string | null;
}

function commandRowMatchesEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  return envelope.command.type === "set_actor_attribute"
    && row.campaign_id === envelope.campaignId
    && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey
    && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId
    && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId
    && row.type === envelope.command.type
    && row.attribute_id === envelope.command.payload.attributeId
    && row.value === envelope.command.payload.value
    && row.resource_name === null
    && row.resource_current === null
    && row.resource_max === null
    && row.dice_expression === null && row.dice_count === null && row.dice_sides === null
    && row.dice_selection_type === null && row.dice_selection_count === null && row.dice_modifier === null;
}

function commandRowMatchesResourceEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  return envelope.command.type === "initialize_actor_resource"
    && row.campaign_id === envelope.campaignId
    && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey
    && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId
    && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId
    && row.type === envelope.command.type
    && row.attribute_id === null
    && row.value === null
    && row.resource_name === envelope.command.payload.name
    && row.resource_current === envelope.command.payload.current
    && row.resource_max === envelope.command.payload.max
    && row.dice_expression === null && row.dice_count === null && row.dice_sides === null
    && row.dice_selection_type === null && row.dice_selection_count === null && row.dice_modifier === null;
}

function commandRowMatchesDiceEnvelope(row: CampaignCommandRow, envelope: CommandEnvelope): boolean {
  if (envelope.command.type !== "roll_actor_dice") return false;
  const normalized = parseDiceExpression(envelope.command.payload.expression);
  const selectionCount = normalized.selection.type === "keep_highest"
    || normalized.selection.type === "keep_lowest" ? normalized.selection.count : null;
  return row.campaign_id === envelope.campaignId && row.command_id === envelope.commandId
    && row.idempotency_key === envelope.idempotencyKey && row.timeline_id === envelope.timelineId
    && row.actor_id === envelope.actorId && row.expected_revision === envelope.expectedRevision
    && row.source_turn_id === envelope.sourceTurnId && row.type === "roll_actor_dice"
    && row.attribute_id === null && row.value === null && row.resource_name === null
    && row.resource_current === null && row.resource_max === null
    && row.dice_expression === envelope.command.payload.expression
    && row.dice_count === normalized.count && row.dice_sides === normalized.sides
    && row.dice_selection_type === normalized.selection.type
    && row.dice_selection_count === selectionCount && row.dice_modifier === normalized.modifier;
}

/** Rebuild an immutable prior result rather than re-running any command logic. */
function receiptFromRetryRow(row: CommandRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (
    row.retry_timeline_presence === null || row.retry_timeline_revision === null
    || row.retry_actor_presence === null
    || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
    || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
    || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
    || row.event_revision === null || row.occurred_at === null || row.event_attribute_id === null
    || row.value_before === null || row.value_after === null
    || row.event_resource_name !== null || row.event_resource_current !== null || row.event_resource_max !== null
    || row.dice_roll_presence !== null
  ) {
    throw new Error("set actor attribute command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id) {
    throw new Error("set actor attribute command retry is invalid");
  }
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.event_command_id,
    campaignId: row.event_campaign_id,
    timelineId: row.event_timeline_id,
    actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id,
    type: row.event_type,
    revision: row.event_revision,
    occurredAt: row.occurred_at,
    data: {
      attributeId: row.event_attribute_id,
      valueBefore: row.value_before,
      valueAfter: row.value_after,
    },
  });
  const receipt = commandReceiptSchema.parse({
    commandId: row.command_id,
    campaignId: row.campaign_id,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
  const retryTimelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const retryTimelineEventCount = revisionSchema.parse(row.retry_timeline_event_count);
  if (event.type !== "actor_attribute_set" || envelope.command.type !== "set_actor_attribute") {
    throw new Error("set actor attribute command retry is invalid");
  }
  // The receipt schema intentionally has only receipt/event invariants. A retry
  // additionally requires the stored event to be the exact result of this row.
  if (
    event.timelineId !== envelope.timelineId || event.actorId !== envelope.actorId
    || event.sourceTurnId !== envelope.sourceTurnId
    || event.data.attributeId !== envelope.command.payload.attributeId
    || event.data.valueAfter !== envelope.command.payload.value
    || receipt.revisionBefore !== envelope.expectedRevision
    || retryTimelineRevision < event.revision
    || retryTimelineEventCount !== retryTimelineRevision
  ) {
    throw new Error("set actor attribute command retry is invalid");
  }
  return receipt;
}

function executeSetActorAttributeSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "set_actor_attribute") {
    throw new Error("executeSetActorAttribute requires a set_actor_attribute command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    // Authorization deliberately precedes all command identity lookups so an
    // unauthorized caller cannot discover whether a command has been used.
    const authorized = db.prepare(`SELECT 1
      FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?
        AND (membership.role = 'gm' OR (
          membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
        ))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("set actor attribute command unavailable");

    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id,
        actor_id, expected_revision, source_turn_id, type, attribute_id, value,
        resource_name, resource_current, resource_max, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier
      FROM campaign_commands
      WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesEnvelope(collisions[0]!, envelope)) {
        throw new Error("set actor attribute command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
          retry_timeline.id AS retry_timeline_presence,
          retry_timeline.revision AS retry_timeline_revision,
          ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
            WHERE timeline_event.campaign_id = command.campaign_id
              AND timeline_event.timeline_id = command.timeline_id)
            + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
              WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) AS retry_timeline_event_count,
          retry_actor.id AS retry_actor_presence,
          receipt.revision_before, receipt.revision_after, receipt.event_id AS receipt_event_id,
          event.event_id, event.campaign_id AS event_campaign_id, event.command_id AS event_command_id,
          event.timeline_id AS event_timeline_id, event.actor_id AS event_actor_id,
           event.source_turn_id AS event_source_turn_id, event.type AS event_type,
           event.revision AS event_revision, event.occurred_at, event.attribute_id AS event_attribute_id,
           event.value_before, event.value_after, event.resource_name AS event_resource_name,
            event.resource_current AS event_resource_current, event.resource_max AS event_resource_max,
            (SELECT roll.event_id FROM rpg_dice_rolls roll WHERE roll.event_id = event.event_id) AS dice_roll_presence
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt
          ON receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id
        LEFT JOIN campaign_events event
          ON event.campaign_id = receipt.campaign_id AND event.command_id = receipt.command_id
            AND event.event_id = receipt.event_id AND event.revision = receipt.revision_after
        LEFT JOIN campaign_timelines retry_timeline
          ON retry_timeline.campaign_id = event.campaign_id AND retry_timeline.id = event.timeline_id
        LEFT JOIN campaign_actors retry_actor
          ON retry_actor.campaign_id = event.campaign_id AND retry_actor.id = event.actor_id
        WHERE command.campaign_id = ? AND command.command_id = ? AND command.idempotency_key = ?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CommandRetryRow | undefined;
      if (!retry) throw new Error("set actor attribute command retry is incomplete");
      return receiptFromRetryRow(retry, envelope);
    }

    const timeline = db.prepare(`SELECT timeline.revision
      FROM campaigns campaign
      JOIN campaign_timelines timeline
        ON timeline.campaign_id = campaign.id AND timeline.id = campaign.active_timeline_id
      WHERE campaign.id = ? AND campaign.active_timeline_id = ?`)
      .get(envelope.campaignId, envelope.timelineId) as { revision: unknown } | undefined;
    if (!timeline) throw new Error("set actor attribute command timeline is inactive");
    const timelineRevision = revisionSchema.parse(timeline.revision);
    if (timelineRevision !== envelope.expectedRevision) {
      throw new Error("set actor attribute command revision does not match");
    }
    const target = db.prepare(`SELECT actor.sheet_id, sheet.updated_at,
        attribute.attribute_id, attribute.value
      FROM campaign_actors actor
      JOIN campaign_characters campaign_character
        ON campaign_character.campaign_id = actor.campaign_id
          AND campaign_character.id = actor.campaign_character_id
      JOIN rpg_campaign_sheets sheet
        ON sheet.campaign_id = actor.campaign_id AND sheet.id = actor.sheet_id
          AND sheet.campaign_character_id = campaign_character.id
      JOIN rpg_character_attributes attribute
        ON attribute.campaign_id = sheet.campaign_id AND attribute.sheet_id = sheet.id
          AND attribute.attribute_id = ?
      WHERE actor.campaign_id = ? AND actor.id = ?`)
      .get(command.payload.attributeId, envelope.campaignId, envelope.actorId) as
      | { sheet_id: string; updated_at: string; attribute_id: string; value: number }
      | undefined;
    if (!target) throw new Error("set actor attribute command target unavailable");
    // Treat persisted state as untrusted. These shared contract schemas keep a
    // damaged row from reaching dependency consumption or command writes.
    const targetSheetId = resourceIdSchema.parse(target.sheet_id);
    const targetUpdatedAt = utcIsoTimestampSchema.parse(target.updated_at);
    const targetAttribute = setActorAttributePayloadSchema.parse({
      attributeId: target.attribute_id,
      value: target.value,
    });
    if (targetAttribute.value === command.payload.value) {
      throw new Error("set actor attribute command cannot be a no-op");
    }

    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    if (occurredAt < targetUpdatedAt) {
      throw new Error("set actor attribute command timestamp cannot precede sheet updated_at");
    }
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({
      eventId,
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      timelineId: envelope.timelineId,
      actorId: envelope.actorId,
      sourceTurnId: envelope.sourceTurnId,
      type: "actor_attribute_set",
      revision: revisionAfter,
      occurredAt,
      data: {
        attributeId: command.payload.attributeId,
        valueBefore: targetAttribute.value,
        valueAfter: command.payload.value,
      },
    });
    if (event.type !== "actor_attribute_set") {
      throw new Error("set actor attribute command produced an invalid event");
    }
    const receipt = commandReceiptSchema.parse({
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision,
      revisionAfter,
      events: [event],
    });

    // This order is part of the persistence contract and satisfies the v12
    // audit triggers without temporarily weakening any foreign key.
    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.commandId, envelope.idempotencyKey, envelope.timelineId,
        envelope.actorId, envelope.expectedRevision, envelope.sourceTurnId, command.type,
        command.payload.attributeId, command.payload.value);
    const attributeWrite = db.prepare(`UPDATE rpg_character_attributes SET value = ?
      WHERE campaign_id = ? AND sheet_id = ? AND attribute_id = ? AND value = ?`)
      .run(command.payload.value, envelope.campaignId, targetSheetId,
        command.payload.attributeId, targetAttribute.value);
    if (attributeWrite.changes !== 1) throw new Error("set actor attribute command target changed");
    const sheetWrite = db.prepare(`UPDATE rpg_campaign_sheets SET updated_at = ?
      WHERE campaign_id = ? AND id = ? AND updated_at = ?`)
      .run(occurredAt, envelope.campaignId, targetSheetId, targetUpdatedAt);
    if (sheetWrite.changes !== 1) throw new Error("set actor attribute command target changed");
    const timelineWrite = db.prepare(`UPDATE campaign_timelines SET revision = ?
      WHERE campaign_id = ? AND id = ? AND revision = ?`)
      .run(revisionAfter, envelope.campaignId, envelope.timelineId, envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("set actor attribute command revision changed");
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.campaignId, event.commandId, event.timelineId, event.actorId,
        event.sourceTurnId, event.type, event.revision, event.occurredAt, event.data.attributeId,
        event.data.valueBefore, event.data.valueAfter);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id) VALUES (?, ?, ?, ?, ?)`)
      .run(receipt.campaignId, receipt.commandId, receipt.revisionBefore, receipt.revisionAfter, event.eventId);
    return receipt;
  });
  return run.immediate();
}

function executeRollActorDiceSync(db: DatabaseDriver.Database, dependencies: RepositoryDependencies,
  actorPrincipalId: string, input: CommandEnvelope): CommandReceipt {
  return executeRollActorDiceAtomic(db, dependencies, actorPrincipalId, input);
}

interface LockedDiceCharacterAncestryRow {
  actor_id: unknown;
  campaign_character_id: unknown;
  actor_campaign_id: unknown;
  sheet_id: unknown;
  sheet_campaign_character_id: unknown;
  sheet_campaign_id: unknown;
}

function executeRollActorDiceForVisibleCharacterSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
  inputBinding: CampaignDiceVisibleCharacterBinding,
): CommandReceipt {
  const position = inputBinding.position;
  if (!Number.isSafeInteger(position) || position < 1 || position > MAX_CAMPAIGN_CHARACTER_ROSTER) {
    throw new Error("campaign dice visible character position is invalid");
  }
  const name = publicCampaignCharacterSummarySchema.shape.name.parse(inputBinding.name);
  const campaignCharacterId = resourceIdSchema.parse(inputBinding.campaignCharacterId);

  return executeRollActorDiceAtomic(db, dependencies, actorPrincipalId, input, (envelope, principalId) => {
    // BEGIN IMMEDIATE is already held. Roster drift cannot occur between this
    // validation and the generic executor's RNG, identities, clock, or writes.
    const roster = createCampaignCharacterRosterOperations(
      db,
      projectLegacyPersonaDisplayName,
    ).getCampaignCharacterRoster(principalId, envelope.campaignId);
    if (roster === null) throw new Error("roll actor dice command unavailable");
    const current = roster.characters[position - 1];
    if (current === undefined || current.id !== campaignCharacterId || current.name !== name) {
      throw new CampaignDiceCharacterConflict();
    }

    const ancestry = db.prepare(`SELECT actor.id AS actor_id,
        actor.campaign_character_id, actor.campaign_id AS actor_campaign_id,
        sheet.id AS sheet_id, sheet.campaign_character_id AS sheet_campaign_character_id,
        sheet.campaign_id AS sheet_campaign_id
      FROM campaign_characters cc
      JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=cc.campaign_id
        AND sheet.campaign_character_id=cc.id
      JOIN campaign_actors actor ON actor.campaign_id=cc.campaign_id
        AND actor.campaign_character_id=cc.id AND actor.sheet_id=sheet.id
      WHERE cc.campaign_id=? AND cc.id=?`).all(envelope.campaignId, campaignCharacterId) as
      LockedDiceCharacterAncestryRow[];
    if (ancestry.length !== 1) throw new Error("campaign dice character ancestry is malformed");
    const row = ancestry[0]!;
    const actorId = resourceIdSchema.parse(row.actor_id);
    resourceIdSchema.parse(row.sheet_id);
    if (resourceIdSchema.parse(row.campaign_character_id) !== campaignCharacterId
      || resourceIdSchema.parse(row.actor_campaign_id) !== envelope.campaignId
      || resourceIdSchema.parse(row.sheet_campaign_character_id) !== campaignCharacterId
      || resourceIdSchema.parse(row.sheet_campaign_id) !== envelope.campaignId) {
      throw new Error("campaign dice character ancestry is malformed");
    }
    if (actorId !== envelope.actorId) throw new CampaignDiceCharacterConflict();
  });
}

function resourceReceiptFromRetryRow(row: CommandRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (
    row.retry_timeline_presence === null || row.retry_timeline_revision === null
    || row.retry_actor_presence === null
    || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
    || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
    || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
    || row.event_revision === null || row.occurred_at === null
    || row.event_attribute_id !== null || row.value_before !== null || row.value_after !== null
    || row.event_resource_name === null || row.event_resource_current === null || row.event_resource_max === null
    || row.dice_roll_presence !== null
  ) {
    throw new Error("initialize actor resource command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id) {
    throw new Error("initialize actor resource command retry is invalid");
  }
  const event = rpgEventSchema.parse({
    eventId: row.event_id,
    commandId: row.event_command_id,
    campaignId: row.event_campaign_id,
    timelineId: row.event_timeline_id,
    actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id,
    type: row.event_type,
    revision: row.event_revision,
    occurredAt: row.occurred_at,
    data: {
      name: row.event_resource_name,
      current: row.event_resource_current,
      max: row.event_resource_max,
    },
  });
  const receipt = commandReceiptSchema.parse({
    commandId: row.command_id,
    campaignId: row.campaign_id,
    revisionBefore: row.revision_before,
    revisionAfter: row.revision_after,
    events: [event],
  });
  const retryTimelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const retryTimelineEventCount = revisionSchema.parse(row.retry_timeline_event_count);
  if (event.type !== "actor_resource_initialized" || envelope.command.type !== "initialize_actor_resource") {
    throw new Error("initialize actor resource command retry is invalid");
  }
  if (
    event.timelineId !== envelope.timelineId || event.actorId !== envelope.actorId
    || event.sourceTurnId !== envelope.sourceTurnId
    || event.data.name !== envelope.command.payload.name
    || event.data.current !== envelope.command.payload.current
    || event.data.max !== envelope.command.payload.max
    || receipt.revisionBefore !== envelope.expectedRevision
    || retryTimelineRevision < event.revision
    || retryTimelineEventCount !== retryTimelineRevision
  ) {
    throw new Error("initialize actor resource command retry is invalid");
  }
  return receipt;
}

function executeInitializeActorResourceSync(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  actorPrincipalId: string,
  input: CommandEnvelope,
): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "initialize_actor_resource") {
    throw new Error("executeInitializeActorResource requires an initialize_actor_resource command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    const authorized = db.prepare(`SELECT 1
      FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ?
        AND (membership.role = 'gm' OR (
          membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id
        ))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("initialize actor resource command unavailable");

    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id,
        actor_id, expected_revision, source_turn_id, type, attribute_id, value,
        resource_name, resource_current, resource_max, dice_expression, dice_count, dice_sides,
        dice_selection_type, dice_selection_count, dice_modifier
      FROM campaign_commands
      WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesResourceEnvelope(collisions[0]!, envelope)) {
        throw new Error("initialize actor resource command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
          retry_timeline.id AS retry_timeline_presence,
          retry_timeline.revision AS retry_timeline_revision,
          ((SELECT COUNT(*) FROM campaign_timeline_events timeline_event
            WHERE timeline_event.campaign_id = command.campaign_id
              AND timeline_event.timeline_id = command.timeline_id)
            + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
              WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) AS retry_timeline_event_count,
          retry_actor.id AS retry_actor_presence,
          receipt.revision_before, receipt.revision_after, receipt.event_id AS receipt_event_id,
          event.event_id, event.campaign_id AS event_campaign_id, event.command_id AS event_command_id,
          event.timeline_id AS event_timeline_id, event.actor_id AS event_actor_id,
          event.source_turn_id AS event_source_turn_id, event.type AS event_type,
          event.revision AS event_revision, event.occurred_at, event.attribute_id AS event_attribute_id,
          event.value_before, event.value_after, event.resource_name AS event_resource_name,
            event.resource_current AS event_resource_current, event.resource_max AS event_resource_max,
            (SELECT roll.event_id FROM rpg_dice_rolls roll WHERE roll.event_id = event.event_id) AS dice_roll_presence
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt
          ON receipt.campaign_id = command.campaign_id AND receipt.command_id = command.command_id
        LEFT JOIN campaign_events event
          ON event.campaign_id = receipt.campaign_id AND event.command_id = receipt.command_id
            AND event.event_id = receipt.event_id AND event.revision = receipt.revision_after
        LEFT JOIN campaign_timelines retry_timeline
          ON retry_timeline.campaign_id = event.campaign_id AND retry_timeline.id = event.timeline_id
        LEFT JOIN campaign_actors retry_actor
          ON retry_actor.campaign_id = event.campaign_id AND retry_actor.id = event.actor_id
        WHERE command.campaign_id = ? AND command.command_id = ? AND command.idempotency_key = ?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CommandRetryRow | undefined;
      if (!retry) throw new Error("initialize actor resource command retry is incomplete");
      return resourceReceiptFromRetryRow(retry, envelope);
    }

    const timeline = db.prepare(`SELECT timeline.revision
      FROM campaigns campaign
      JOIN campaign_timelines timeline
        ON timeline.campaign_id = campaign.id AND timeline.id = campaign.active_timeline_id
      WHERE campaign.id = ? AND campaign.active_timeline_id = ?`)
      .get(envelope.campaignId, envelope.timelineId) as { revision: unknown } | undefined;
    if (!timeline) throw new Error("initialize actor resource command timeline is inactive");
    const timelineRevision = revisionSchema.parse(timeline.revision);
    if (timelineRevision !== envelope.expectedRevision) {
      throw new Error("initialize actor resource command revision does not match");
    }

    const target = db.prepare(`SELECT actor.id
      FROM campaign_actors actor
      JOIN campaign_characters campaign_character
        ON campaign_character.campaign_id = actor.campaign_id
          AND campaign_character.id = actor.campaign_character_id
      JOIN rpg_campaign_sheets sheet
        ON sheet.campaign_id = actor.campaign_id AND sheet.id = actor.sheet_id
          AND sheet.campaign_character_id = campaign_character.id
      WHERE actor.campaign_id = ? AND actor.id = ?`)
      .get(envelope.campaignId, envelope.actorId) as { id: string } | undefined;
    if (!target) throw new Error("initialize actor resource command target unavailable");
    resourceIdSchema.parse(target.id);
    const existingResource = db.prepare(`SELECT campaign_id FROM rpg_actor_resources
      WHERE actor_id = ? AND name = ?`).get(envelope.actorId, command.payload.name) as
      | { campaign_id: unknown }
      | undefined;
    if (existingResource) {
      if (resourceIdSchema.parse(existingResource.campaign_id) !== envelope.campaignId) {
        throw new Error("initialize actor resource command resource is invalid");
      }
      throw new Error("initialize actor resource command resource already exists");
    }

    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({
      eventId,
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      timelineId: envelope.timelineId,
      actorId: envelope.actorId,
      sourceTurnId: envelope.sourceTurnId,
      type: "actor_resource_initialized",
      revision: revisionAfter,
      occurredAt,
      data: command.payload,
    });
    if (event.type !== "actor_resource_initialized") {
      throw new Error("initialize actor resource command produced an invalid event");
    }
    const receipt = commandReceiptSchema.parse({
      commandId: envelope.commandId,
      campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision,
      revisionAfter,
      events: [event],
    });

    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.commandId, envelope.idempotencyKey, envelope.timelineId,
        envelope.actorId, envelope.expectedRevision, envelope.sourceTurnId, command.type,
        command.payload.name, command.payload.current, command.payload.max);
    db.prepare(`INSERT INTO rpg_actor_resources (campaign_id, actor_id, name, current, max)
      VALUES (?, ?, ?, ?, ?)`)
      .run(envelope.campaignId, envelope.actorId, command.payload.name,
        command.payload.current, command.payload.max);
    const timelineWrite = db.prepare(`UPDATE campaign_timelines SET revision = ?
      WHERE campaign_id = ? AND id = ? AND revision = ?`)
      .run(revisionAfter, envelope.campaignId, envelope.timelineId, envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("initialize actor resource command revision changed");
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, resource_name, resource_current, resource_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.campaignId, event.commandId, event.timelineId, event.actorId,
        event.sourceTurnId, event.type, event.revision, event.occurredAt,
        event.data.name, event.data.current, event.data.max);
    db.prepare(`INSERT INTO command_receipts
      (campaign_id, command_id, revision_before, revision_after, event_id) VALUES (?, ?, ?, ?, ?)`)
      .run(receipt.campaignId, receipt.commandId, receipt.revisionBefore, receipt.revisionAfter, event.eventId);
    return receipt;
  });
  return run.immediate();
}

interface DiceRetryRow extends CommandRetryRow {
  retry_timeline_min_revision: unknown; retry_timeline_max_revision: unknown;
  retry_timeline_invalid_event_count: unknown;
  retry_campaign_character_presence: string | null; retry_character_presence: string | null;
  retry_sheet_presence: string | null;
  roll_event_id: string | null; roll_campaign_id: string | null; roll_command_id: string | null;
  roll_expression: string | null; roll_dice_count: number | null; roll_dice_sides: number | null;
  roll_selection_type: string | null; roll_selection_count: number | null;
  roll_modifier: number | null; roll_total: number | null;
}

function diceReceiptFromRetryRow(db: DatabaseDriver.Database, row: DiceRetryRow, envelope: CommandEnvelope): CommandReceipt {
  if (envelope.command.type !== "roll_actor_dice" || row.retry_timeline_presence === null
      || row.retry_timeline_revision === null || row.retry_actor_presence === null
      || row.retry_campaign_character_presence === null || row.retry_character_presence === null
      || row.retry_sheet_presence === null
      || row.revision_before === null || row.revision_after === null || row.receipt_event_id === null
      || row.event_id === null || row.event_campaign_id === null || row.event_command_id === null
      || row.event_timeline_id === null || row.event_actor_id === null || row.event_type === null
      || row.event_revision === null || row.occurred_at === null || row.event_attribute_id !== null
      || row.value_before !== null || row.value_after !== null || row.event_resource_name !== null
      || row.event_resource_current !== null || row.event_resource_max !== null || row.roll_event_id === null
      || row.roll_campaign_id === null || row.roll_command_id === null || row.roll_expression === null
      || row.roll_dice_count === null || row.roll_dice_sides === null || row.roll_selection_type === null
      || row.roll_modifier === null || row.roll_total === null) {
    throw new Error("roll actor dice command retry is incomplete");
  }
  if (row.receipt_event_id !== row.event_id || row.roll_event_id !== row.event_id) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const terms = db.prepare("SELECT position, value, kept FROM rpg_dice_terms WHERE event_id = ? ORDER BY position")
    .all(row.event_id) as Array<{ position: unknown; value: unknown; kept: unknown }>;
  const normalized = parseDiceExpression(row.roll_expression);
  const physicalCount = normalized.selection.type === "advantage" || normalized.selection.type === "disadvantage"
    ? 2 : normalized.count;
  if (terms.length !== physicalCount || terms.some((term, index) => term.position !== index)) {
    throw new Error("roll actor dice command retry is incomplete");
  }
  // Do not coerce corrupt SQLite values into booleans.  A database opened with
  // checks disabled can contain text, fractions, or arbitrary integers here;
  // every such row must make historical reconstruction fail closed.
  if (terms.some((term) => typeof term.kept !== "number" || !Number.isInteger(term.kept)
      || (term.kept !== 0 && term.kept !== 1))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const termData = terms.map((term) => ({ value: term.value, kept: term.kept === 1 }));
  const selectionCount = normalized.selection.type === "keep_highest" || normalized.selection.type === "keep_lowest"
    ? normalized.selection.count : null;
  if (row.roll_campaign_id !== row.campaign_id || row.roll_command_id !== row.command_id
      || row.roll_dice_count !== normalized.count || row.roll_dice_sides !== normalized.sides
      || row.roll_selection_type !== normalized.selection.type || row.roll_selection_count !== selectionCount
      || row.roll_modifier !== normalized.modifier) throw new Error("roll actor dice command retry is invalid");
  const keepCount = selectionCount ?? (normalized.selection.type === "all" ? normalized.count : 1);
  const keepHigh = normalized.selection.type === "keep_highest" || normalized.selection.type === "advantage";
  const expectedKept = new Set(termData.map((_, index) => index).sort((left, right) => {
    if (normalized.selection.type === "all") return left - right;
    const difference = keepHigh ? Number(termData[right]!.value) - Number(termData[left]!.value)
      : Number(termData[left]!.value) - Number(termData[right]!.value);
    return difference === 0 ? left - right : difference;
  }).slice(0, keepCount));
  if (termData.some((term, index) => term.kept !== expectedKept.has(index))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  const event = rpgEventSchema.parse({ eventId: row.event_id, commandId: row.event_command_id,
    campaignId: row.event_campaign_id, timelineId: row.event_timeline_id, actorId: row.event_actor_id,
    sourceTurnId: row.event_source_turn_id, type: row.event_type, revision: row.event_revision,
    occurredAt: row.occurred_at, data: { expression: row.roll_expression, normalized, terms: termData,
      modifier: row.roll_modifier, total: row.roll_total } });
  const receipt = commandReceiptSchema.parse({ commandId: row.command_id, campaignId: row.campaign_id,
    revisionBefore: row.revision_before, revisionAfter: row.revision_after, events: [event] });
  const timelineRevision = revisionSchema.parse(row.retry_timeline_revision);
  const eventCount = revisionSchema.parse(row.retry_timeline_event_count);
  const invalidEventCount = revisionSchema.parse(row.retry_timeline_invalid_event_count);
  if (event.type !== "actor_dice_rolled" || event.timelineId !== envelope.timelineId
      || event.actorId !== envelope.actorId || event.sourceTurnId !== envelope.sourceTurnId
      || event.data.expression !== envelope.command.payload.expression
      || receipt.revisionBefore !== envelope.expectedRevision || timelineRevision < event.revision
      || eventCount !== timelineRevision || invalidEventCount !== 0 || (timelineRevision > 0
        && (row.retry_timeline_min_revision !== 1 || row.retry_timeline_max_revision !== timelineRevision))) {
    throw new Error("roll actor dice command retry is invalid");
  }
  return receipt;
}

// A retry may return an old receipt only when every event through the current
// timeline head still has its exact immutable parents and a complete variant.
// Keep this as one bounded SQL aggregate rather than reconstructing unbounded
// later history in application memory.
const validResourceIdSql = (value: string): string => `(typeof(${value})='text'
  AND length(${value}) BETWEEN 1 AND 128 AND instr(${value},char(0))=0
  AND ${value} NOT GLOB '*[^A-Za-z0-9._:-]*')`;

const DICE_RETRY_INVALID_HISTORY_COUNT = `(SELECT COUNT(*) FROM campaign_events history
  WHERE history.campaign_id=command.campaign_id AND history.timeline_id=command.timeline_id
    AND NOT EXISTS (
      SELECT 1 FROM campaign_commands history_command
      JOIN command_receipts history_receipt
        ON history_receipt.campaign_id=history_command.campaign_id
        AND history_receipt.command_id=history_command.command_id
        AND history_receipt.revision_before=history_command.expected_revision
        AND history_receipt.revision_after=history.revision
        AND history_receipt.event_id=history.event_id
      JOIN campaign_timelines history_timeline
        ON history_timeline.campaign_id=history.campaign_id AND history_timeline.id=history.timeline_id
        AND history_timeline.revision>=history.revision
      JOIN campaign_actors history_actor
        ON history_actor.campaign_id=history.campaign_id AND history_actor.id=history.actor_id
      LEFT JOIN rpg_dice_rolls history_roll ON history_roll.event_id=history.event_id
      WHERE history_command.campaign_id=history.campaign_id
        AND history_command.command_id=history.command_id
        AND history_command.timeline_id=history.timeline_id
        AND history_command.actor_id=history.actor_id
        AND history_command.source_turn_id IS history.source_turn_id
        AND history_command.expected_revision+1=history.revision
        AND ${validResourceIdSql("history_command.campaign_id")}
        AND ${validResourceIdSql("history_command.command_id")}
        AND ${validResourceIdSql("history_command.idempotency_key")}
        AND ${validResourceIdSql("history_command.timeline_id")}
        AND ${validResourceIdSql("history_command.actor_id")}
        AND (history_command.source_turn_id IS NULL
          OR ${validResourceIdSql("history_command.source_turn_id")})
        AND ${validResourceIdSql("history.event_id")}
        AND ${validResourceIdSql("history.campaign_id")}
        AND ${validResourceIdSql("history.command_id")}
        AND ${validResourceIdSql("history.timeline_id")}
        AND ${validResourceIdSql("history.actor_id")}
        AND (history.source_turn_id IS NULL OR ${validResourceIdSql("history.source_turn_id")})
        AND ${validResourceIdSql("history_receipt.campaign_id")}
        AND ${validResourceIdSql("history_receipt.command_id")}
        AND ${validResourceIdSql("history_receipt.event_id")}
        AND ${validResourceIdSql("history_timeline.campaign_id")}
        AND ${validResourceIdSql("history_timeline.id")}
        AND ${validResourceIdSql("history_actor.campaign_id")}
        AND ${validResourceIdSql("history_actor.id")}
        AND history.occurred_at=strftime('%Y-%m-%dT%H:%M:%fZ',history.occurred_at)
        AND substr(history.occurred_at,12,2) BETWEEN '00' AND '23'
        AND (
          (history_command.type='set_actor_attribute' AND history.type='actor_attribute_set'
            AND history_command.attribute_id=history.attribute_id
            AND ${validResourceIdSql("history_command.attribute_id")}
            AND ${validResourceIdSql("history.attribute_id")}
            AND history_command.value=history.value_after AND history.value_before<>history.value_after
            AND typeof(history.value_before)='integer' AND history.value_before BETWEEN -1000 AND 1000
            AND typeof(history.value_after)='integer' AND history.value_after BETWEEN -1000 AND 1000
            AND history_command.resource_name IS NULL AND history_command.resource_current IS NULL
            AND history_command.resource_max IS NULL AND history_command.dice_expression IS NULL
            AND history_command.dice_count IS NULL AND history_command.dice_sides IS NULL
            AND history_command.dice_selection_type IS NULL
            AND history_command.dice_selection_count IS NULL AND history_command.dice_modifier IS NULL
            AND history.resource_name IS NULL AND history.resource_current IS NULL
            AND history.resource_max IS NULL AND history_roll.event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history.event_id))
          OR (history_command.type='initialize_actor_resource' AND history.type='actor_resource_initialized'
            AND history_command.attribute_id IS NULL AND history_command.value IS NULL
            AND history_command.dice_expression IS NULL AND history_command.dice_count IS NULL
            AND history_command.dice_sides IS NULL AND history_command.dice_selection_type IS NULL
            AND history_command.dice_selection_count IS NULL AND history_command.dice_modifier IS NULL
            AND history.attribute_id IS NULL
            AND history.value_before IS NULL AND history.value_after IS NULL
            AND history_command.resource_name=history.resource_name
            AND ${validResourceIdSql("history_command.resource_name")}
            AND ${validResourceIdSql("history.resource_name")}
            AND history_command.resource_current=history.resource_current
            AND history_command.resource_max=history.resource_max
            AND typeof(history.resource_current)='integer' AND history.resource_current BETWEEN 0 AND 1000000
            AND typeof(history.resource_max)='integer' AND history.resource_max BETWEEN 0 AND 1000000
            AND history.resource_current<=history.resource_max AND history_roll.event_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history.event_id))
          OR (history_command.type='roll_actor_dice' AND history.type='actor_dice_rolled'
            AND history_command.attribute_id IS NULL AND history_command.value IS NULL
            AND history_command.resource_name IS NULL AND history_command.resource_current IS NULL
            AND history_command.resource_max IS NULL AND history.attribute_id IS NULL
            AND history.value_before IS NULL AND history.value_after IS NULL
            AND history.resource_name IS NULL AND history.resource_current IS NULL
            AND history.resource_max IS NULL AND history_roll.campaign_id=history.campaign_id
            AND history_roll.command_id=history.command_id
            AND ${validResourceIdSql("history_roll.event_id")}
            AND ${validResourceIdSql("history_roll.campaign_id")}
            AND ${validResourceIdSql("history_roll.command_id")}
            AND history_roll.expression=history_command.dice_expression
            AND history_roll.dice_count=history_command.dice_count
            AND history_roll.dice_sides=history_command.dice_sides
            AND history_roll.selection_type=history_command.dice_selection_type
            AND history_roll.selection_count IS history_command.dice_selection_count
            AND history_roll.modifier=history_command.dice_modifier
            AND typeof(history_roll.dice_count)='integer' AND history_roll.dice_count BETWEEN 1 AND 100
            AND typeof(history_roll.dice_sides)='integer' AND history_roll.dice_sides BETWEEN 2 AND 1000
            AND typeof(history_roll.modifier)='integer' AND history_roll.modifier BETWEEN -1000 AND 1000
            AND typeof(history_roll.total)='integer' AND history_roll.total BETWEEN -1000 AND 101000
            AND ((history_roll.selection_type='all' AND history_roll.selection_count IS NULL)
              OR (history_roll.selection_type IN ('keep_highest','keep_lowest')
                AND typeof(history_roll.selection_count)='integer'
                AND history_roll.selection_count BETWEEN 1 AND history_roll.dice_count)
              OR (history_roll.selection_type IN ('advantage','disadvantage')
                AND history_roll.selection_count IS NULL AND history_roll.dice_count=1))
            AND history_roll.expression=CAST(history_roll.dice_count AS TEXT)||'d'||CAST(history_roll.dice_sides AS TEXT)
              ||CASE history_roll.selection_type WHEN 'all' THEN ''
                WHEN 'keep_highest' THEN 'kh'||CAST(history_roll.selection_count AS TEXT)
                WHEN 'keep_lowest' THEN 'kl'||CAST(history_roll.selection_count AS TEXT)
                WHEN 'advantage' THEN 'adv' ELSE 'dis' END
              ||CASE WHEN history_roll.modifier=0 THEN '' WHEN history_roll.modifier>0
                THEN '+'||CAST(history_roll.modifier AS TEXT) ELSE CAST(history_roll.modifier AS TEXT) END
            AND (SELECT COUNT(*) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)
              =CASE WHEN history_roll.selection_type IN ('advantage','disadvantage')
                THEN 2 ELSE history_roll.dice_count END
            AND (SELECT COALESCE(MIN(position),0) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)=0
            AND (SELECT COALESCE(MAX(position),-1) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id)
              =CASE WHEN history_roll.selection_type IN ('advantage','disadvantage')
                THEN 1 ELSE history_roll.dice_count-1 END
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id
                AND (typeof(history_term.position)<>'integer' OR typeof(history_term.value)<>'integer'
                  OR history_term.value<1 OR history_term.value>history_roll.dice_sides
                  OR typeof(history_term.kept)<>'integer' OR history_term.kept NOT IN (0,1)))
            AND (SELECT COUNT(*) FROM rpg_dice_terms history_term
              WHERE history_term.event_id=history_roll.event_id AND history_term.kept=1)
              =CASE WHEN history_roll.selection_type IN ('keep_highest','keep_lowest')
                THEN history_roll.selection_count
                WHEN history_roll.selection_type IN ('advantage','disadvantage') THEN 1
                ELSE history_roll.dice_count END
            AND NOT EXISTS (SELECT 1 FROM rpg_dice_terms kept
              JOIN rpg_dice_terms discarded ON discarded.event_id=kept.event_id
              WHERE kept.event_id=history_roll.event_id AND kept.kept=1 AND discarded.kept=0
                AND ((history_roll.selection_type IN ('keep_highest','advantage')
                    AND (kept.value<discarded.value OR (kept.value=discarded.value
                      AND kept.position>discarded.position)))
                  OR (history_roll.selection_type IN ('keep_lowest','disadvantage')
                    AND (kept.value>discarded.value OR (kept.value=discarded.value
                      AND kept.position>discarded.position)))))
            AND history_roll.total=history_roll.modifier+
              (SELECT COALESCE(SUM(value),0) FROM rpg_dice_terms history_term
                WHERE history_term.event_id=history_roll.event_id AND history_term.kept=1))
        )
    ))`;

function executeRollActorDiceAtomic(db: DatabaseDriver.Database, dependencies: RepositoryDependencies,
  actorPrincipalId: string, input: CommandEnvelope,
  validateLockedTarget?: (envelope: CommandEnvelope, principalId: string) => void): CommandReceipt {
  const principalId = resourceIdSchema.parse(actorPrincipalId);
  const envelope = commandEnvelopeSchema.parse(input);
  if (envelope.command.type !== "roll_actor_dice") {
    throw new Error("executeRollActorDice requires a roll_actor_dice command");
  }
  const command = envelope.command;
  const run = db.transaction(() => {
    const authorized = db.prepare(`SELECT 1 FROM campaign_memberships membership
      JOIN principals principal ON principal.id = membership.principal_id
      JOIN campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ? AND membership.principal_id = ? AND
        (membership.role = 'gm' OR (membership.role = 'owner' AND campaign.owner_principal_id = membership.principal_id))`)
      .get(envelope.campaignId, principalId);
    if (!authorized) throw new Error("roll actor dice command unavailable");
    validateLockedTarget?.(envelope, principalId);
    const collisions = db.prepare(`SELECT campaign_id, command_id, idempotency_key, timeline_id, actor_id,
      expected_revision, source_turn_id, type, attribute_id, value, resource_name, resource_current,
      resource_max, dice_expression, dice_count, dice_sides, dice_selection_type, dice_selection_count,
      dice_modifier FROM campaign_commands WHERE campaign_id = ? AND (command_id = ? OR idempotency_key = ?)
      ORDER BY rowid`).all(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as CampaignCommandRow[];
    if (collisions.length > 0) {
      if (collisions.length !== 1 || !commandRowMatchesDiceEnvelope(collisions[0]!, envelope)) {
        throw new Error("roll actor dice command identity collision");
      }
      const retry = db.prepare(`SELECT command.*,
        timeline.id retry_timeline_presence, timeline.revision retry_timeline_revision,
        ((SELECT COUNT(*) FROM campaign_timeline_events h WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id)
          + (SELECT COUNT(*) FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_event_count,
        (SELECT MIN(revision) FROM (SELECT revision FROM campaign_timeline_events h
            WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id
          UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_min_revision,
        (SELECT MAX(revision) FROM (SELECT revision FROM campaign_timeline_events h
            WHERE h.campaign_id=command.campaign_id AND h.timeline_id=command.timeline_id
          UNION ALL SELECT revision FROM campaign_imported_timeline_events imported
            WHERE imported.campaign_id=command.campaign_id AND imported.timeline_id=command.timeline_id)) retry_timeline_max_revision,
        (${DICE_RETRY_INVALID_HISTORY_COUNT} + (SELECT COUNT(*) FROM campaign_timeline_events link
          LEFT JOIN campaign_events linked_event ON linked_event.event_id=link.event_id
          WHERE link.campaign_id=command.campaign_id AND link.timeline_id=command.timeline_id
            AND (linked_event.event_id IS NULL OR linked_event.campaign_id<>link.campaign_id
              OR linked_event.revision<>link.revision
              OR (link.inherited=0 AND linked_event.timeline_id<>link.timeline_id)))) retry_timeline_invalid_event_count,
        actor.id retry_actor_presence, receipt.revision_before, receipt.revision_after, receipt.event_id receipt_event_id,
        campaign_character.id retry_campaign_character_presence,
        character.id retry_character_presence, sheet.id retry_sheet_presence,
        event.event_id, event.campaign_id event_campaign_id, event.command_id event_command_id,
        event.timeline_id event_timeline_id, event.actor_id event_actor_id, event.source_turn_id event_source_turn_id,
        event.type event_type, event.revision event_revision, event.occurred_at, event.attribute_id event_attribute_id,
        event.value_before, event.value_after, event.resource_name event_resource_name,
        event.resource_current event_resource_current, event.resource_max event_resource_max,
        roll.event_id dice_roll_presence, roll.event_id roll_event_id, roll.campaign_id roll_campaign_id,
        roll.command_id roll_command_id, roll.expression roll_expression, roll.dice_count roll_dice_count,
        roll.dice_sides roll_dice_sides, roll.selection_type roll_selection_type,
        roll.selection_count roll_selection_count, roll.modifier roll_modifier, roll.total roll_total
        FROM campaign_commands command
        LEFT JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        LEFT JOIN campaign_events event ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id
          AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
        LEFT JOIN campaign_timelines timeline ON timeline.campaign_id=event.campaign_id AND timeline.id=event.timeline_id
        LEFT JOIN campaign_actors actor ON actor.campaign_id=event.campaign_id AND actor.id=event.actor_id
        LEFT JOIN campaign_characters campaign_character
          ON campaign_character.campaign_id=actor.campaign_id
          AND campaign_character.id=actor.campaign_character_id
        LEFT JOIN characters character ON character.id=campaign_character.character_id
        LEFT JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id
          AND sheet.id=actor.sheet_id AND sheet.campaign_character_id=campaign_character.id
        LEFT JOIN rpg_dice_rolls roll ON roll.event_id=event.event_id
        WHERE command.campaign_id=? AND command.command_id=? AND command.idempotency_key=?`)
        .get(envelope.campaignId, envelope.commandId, envelope.idempotencyKey) as DiceRetryRow | undefined;
      if (!retry) throw new Error("roll actor dice command retry is incomplete");
      return diceReceiptFromRetryRow(db, retry, envelope);
    }
    const timeline = db.prepare(`SELECT timeline.revision FROM campaigns campaign JOIN campaign_timelines timeline
      ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id
      WHERE campaign.id=? AND campaign.active_timeline_id=?`).get(envelope.campaignId, envelope.timelineId) as
      { revision: unknown } | undefined;
    if (!timeline) throw new Error("roll actor dice command timeline is inactive");
    if (revisionSchema.parse(timeline.revision) !== envelope.expectedRevision) {
      throw new Error("roll actor dice command revision does not match");
    }
    const target = db.prepare(`SELECT actor.id FROM campaign_actors actor
      JOIN campaign_characters cc ON cc.campaign_id=actor.campaign_id AND cc.id=actor.campaign_character_id
      JOIN characters character ON character.id=cc.character_id
      JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id AND sheet.id=actor.sheet_id
        AND sheet.campaign_character_id=cc.id WHERE actor.campaign_id=? AND actor.id=?`)
      .get(envelope.campaignId, envelope.actorId) as { id: unknown } | undefined;
    if (!target) throw new Error("roll actor dice command target unavailable");
    resourceIdSchema.parse(target.id);
    const result = evaluateDiceExpression(command.payload.expression, dependencies.rng);
    const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
    const occurredAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const revisionAfter = envelope.expectedRevision + 1;
    const event = rpgEventSchema.parse({ eventId, commandId: envelope.commandId, campaignId: envelope.campaignId,
      timelineId: envelope.timelineId, actorId: envelope.actorId, sourceTurnId: envelope.sourceTurnId,
      type: "actor_dice_rolled", revision: revisionAfter, occurredAt, data: result });
    if (event.type !== "actor_dice_rolled") throw new Error("roll actor dice command produced an invalid event");
    const receipt = commandReceiptSchema.parse({ commandId: envelope.commandId, campaignId: envelope.campaignId,
      revisionBefore: envelope.expectedRevision, revisionAfter, events: [event] });
    const selectionCount = result.normalized.selection.type === "keep_highest"
      || result.normalized.selection.type === "keep_lowest" ? result.normalized.selection.count : null;
    db.prepare(`INSERT INTO campaign_commands (campaign_id,command_id,idempotency_key,timeline_id,actor_id,
      expected_revision,source_turn_id,type,dice_expression,dice_count,dice_sides,dice_selection_type,
      dice_selection_count,dice_modifier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope.campaignId,
      envelope.commandId,envelope.idempotencyKey,envelope.timelineId,envelope.actorId,envelope.expectedRevision,
      envelope.sourceTurnId,command.type,result.expression,result.normalized.count,result.normalized.sides,
      result.normalized.selection.type,selectionCount,result.modifier);
    const timelineWrite = db.prepare("UPDATE campaign_timelines SET revision=? WHERE campaign_id=? AND id=? AND revision=?")
      .run(revisionAfter,envelope.campaignId,envelope.timelineId,envelope.expectedRevision);
    if (timelineWrite.changes !== 1) throw new Error("roll actor dice command revision changed");
    db.prepare(`INSERT INTO rpg_dice_rolls (event_id,campaign_id,command_id,expression,dice_count,dice_sides,
      selection_type,selection_count,modifier,total) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(event.eventId,event.campaignId,
      event.commandId,result.expression,result.normalized.count,result.normalized.sides,result.normalized.selection.type,
      selectionCount,result.modifier,result.total);
    const insertTerm = db.prepare("INSERT INTO rpg_dice_terms (event_id,position,value,kept) VALUES (?,?,?,?)");
    result.terms.forEach((term, position) => insertTerm.run(event.eventId,position,term.value,term.kept ? 1 : 0));
    db.prepare(`INSERT INTO campaign_events (event_id,campaign_id,command_id,timeline_id,actor_id,source_turn_id,
      type,revision,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(event.eventId,event.campaignId,event.commandId,
      event.timelineId,event.actorId,event.sourceTurnId,event.type,event.revision,event.occurredAt);
    const receiptWrite = db.prepare("INSERT INTO command_receipts (campaign_id,command_id,revision_before,revision_after,event_id) VALUES (?,?,?,?,?)")
      .run(receipt.campaignId,receipt.commandId,receipt.revisionBefore,receipt.revisionAfter,event.eventId);
    if (receiptWrite.changes !== 1) throw new Error("roll actor dice command receipt was not persisted");
    return receipt;
  });
  return run.immediate();
}

/**
 * Connection-scoped command writes. Keeping the implementation here prevents
 * the composed campaign facade from becoming an import dependency of a write
 * boundary (and therefore from forming a runtime cycle).
 */
export function createCampaignCommandWriteOperations(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
) {
  return {
    executeSetActorAttribute: (actorPrincipalId: string, input: CommandEnvelope) =>
      executeSetActorAttributeSync(db, dependencies, actorPrincipalId, input),
    executeInitializeActorResource: (actorPrincipalId: string, input: CommandEnvelope) =>
      executeInitializeActorResourceSync(db, dependencies, actorPrincipalId, input),
    executeRollActorDice: (actorPrincipalId: string, input: CommandEnvelope) =>
      executeRollActorDiceSync(db, dependencies, actorPrincipalId, input),
    executeRollActorDiceForVisibleCharacter: (
      actorPrincipalId: string,
      input: CommandEnvelope,
      binding: CampaignDiceVisibleCharacterBinding,
    ) => executeRollActorDiceForVisibleCharacterSync(db, dependencies, actorPrincipalId, input, binding),
  };
}
