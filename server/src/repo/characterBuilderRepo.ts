import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  CHARACTER_DRAFT_EXPIRY_SECONDS,
  abandonCharacterDraftInputSchema,
  characterBuilderAllocationSchema,
  characterBuilderSelectionsSchema,
  characterDraftFinalizationResultSchema,
  characterDraftMutationReceiptSchema,
  characterDraftMutationResultSchema,
  characterFinalizationReceiptSchema,
  characterStartingGrantSchema,
  createCharacterDraftInputSchema,
  finalizeCharacterDraftInputSchema,
  resourceIdSchema,
  updateCharacterDraftInputSchema,
  utcIsoTimestampSchema,
  type CharacterBuilderAllocation,
  type CharacterBuilderAllocationRequest,
  type CharacterBuilderAttributeScores,
  type CharacterDraftFinalizationResult,
  type CharacterDraftMutationReceipt,
  type CharacterDraftMutationResult,
  type CharacterDraftView,
  type CharacterStartingGrant,
  type CreateCharacterDraftInput,
  type FinalizeCharacterDraftInput,
  type UpdateCharacterDraftInput,
} from "@velvet/contracts";
import { calculateCharacterDerivedStats } from "../characterBuilderCalculator.js";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../runtime.js";
import { canonicalCatalogJson } from "./contentCatalog/index.js";
import { initializeCharacterProgressionV24 } from "./characterProgressionRepo.js";
import { buildView, pinsFor, rowFor } from "./characterBuilder/characterBuilderRowTypes.js";
import {
  CharacterBuilderAuthorizationError,
  CharacterBuilderConflictError,
  CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError,
  CharacterBuilderStaleError,
  CharacterBuilderUnavailableError,
} from "./characterBuilder/characterBuilderErrors.js";
import { createCharacterBuilderReadRepository } from "./characterBuilder/characterBuilderReadRepo.js";

export {
  CharacterBuilderAuthorizationError,
  CharacterBuilderConflictError,
  CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError,
  CharacterBuilderStaleError,
  CharacterBuilderUnavailableError,
} from "./characterBuilder/characterBuilderErrors.js";

type Dependencies = { clock: Clock; ids: IdGenerator; rng: RandomNumberGenerator };

/** Roll each physical die independently through the injected bounded RNG. */
export function rollCharacterBuilderAttributes(rng: RandomNumberGenerator): Extract<CharacterBuilderAllocation, { method: "server-roll" }> {
  const nextDie = () => {
    const value = rng.integer(1, 7);
    if (!Number.isSafeInteger(value) || value < 1 || value > 6) throw new Error("character builder RNG returned an out-of-range die");
    return value;
  };
  const terms = CHARACTER_BUILDER_ATTRIBUTE_IDS.map((attributeId) => {
    const dice = [nextDie(), nextDie(), nextDie(), nextDie()];
    const minimum = Math.min(...dice);
    const droppedIndex = dice.indexOf(minimum);
    return { attributeId, dice, droppedIndex, score: dice.reduce((sum, die) => sum + die, 0) - minimum };
  });
  const scores = Object.fromEntries(terms.map((term) => [term.attributeId, term.score]));
  return characterBuilderAllocationSchema.parse({ method: "server-roll", algorithm: "velvet-4d6-drop-first-lowest-v1", scores, terms }) as
    Extract<CharacterBuilderAllocation, { method: "server-roll" }>;
}

function resolveAllocation(request: CharacterBuilderAllocationRequest, rng: RandomNumberGenerator): CharacterBuilderAllocation {
  return request.method === "server-roll" ? rollCharacterBuilderAttributes(rng) : characterBuilderAllocationSchema.parse(request);
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalCatalogJson(value)).digest("hex"); }
function commandRetry(db: DatabaseDriver.Database, campaignId: string, actor: string, key: string): { draft_id: string; type: string; requested_json: string; result_json: string } | undefined {
  return db.prepare(`SELECT command.draft_id,command.type,command.requested_json,receipt.result_json
    FROM character_draft_commands_v19 command
    JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=command.draft_id AND receipt.command_id=command.command_id
    JOIN character_draft_events_v19 event ON event.draft_id=receipt.draft_id AND event.command_id=receipt.command_id
      AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
    JOIN character_draft_revisions_v19 history ON history.draft_id=receipt.draft_id AND history.command_id=receipt.command_id
      AND history.revision=receipt.revision_after AND history.snapshot_json=receipt.result_json->>'$.draft'
    JOIN character_draft_command_provenance_v20 proposal ON proposal.draft_id=command.draft_id AND proposal.command_id=command.command_id
      AND proposal.proposed_event_id=event.event_id AND proposal.proposed_result_json=receipt.result_json
    WHERE command.campaign_id=? AND command.actor_principal_id=? AND command.idempotency_key=?`).get(campaignId, actor, key) as { draft_id: string; type: string; requested_json: string; result_json: string } | undefined;
}
function exactRetry<T>(retry: ReturnType<typeof commandRetry>, type: string, requested: unknown, parser: { parse(value: unknown): T }, draftId?: string): T | null {
  if (!retry) return null;
  if (retry.type !== type || retry.requested_json !== canonicalCatalogJson(requested) || (draftId && retry.draft_id !== draftId)) throw new CharacterBuilderConflictError("idempotency key was reused for a different draft command");
  return parser.parse(JSON.parse(retry.result_json));
}

function insertAudit(db: DatabaseDriver.Database, values: { draftId: string; commandId: string; eventId: string; campaignId: string; actor: string;
  idempotencyKey: string; type: "create" | "update" | "abandon" | "finalize"; expectedRevision: number; requested: unknown;
  revisionAfter: number; occurredAt: string; result: unknown }): void {
  const requestedJson = canonicalCatalogJson(values.requested);
  db.prepare(`INSERT INTO character_draft_commands_v19
    (draft_id,command_id,campaign_id,actor_principal_id,idempotency_key,type,expected_revision,requested_json,request_digest,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(values.draftId, values.commandId, values.campaignId, values.actor, values.idempotencyKey,
      values.type, values.expectedRevision, requestedJson, digest(values.requested), values.occurredAt);
  const eventType = { create: "draft_created", update: "draft_updated", abandon: "draft_abandoned", finalize: "draft_finalized" }[values.type];
  const publicData = { draftId: values.draftId, revision: values.revisionAfter,
    status: values.type === "finalize" ? "finalized" : values.type === "abandon" ? "abandoned" : "active" };
  const proposedEvent = { actorPrincipalId: values.actor, campaignId: values.campaignId, commandId: values.commandId,
    draftId: values.draftId, eventId: values.eventId, occurredAt: values.occurredAt, publicData,
    revision: values.revisionAfter, revisionBefore: values.expectedRevision, type: eventType };
  db.prepare(`INSERT INTO character_draft_command_provenance_v20
    (draft_id,command_id,campaign_id,actor_principal_id,proposed_event_id,proposed_event_type,proposed_event_json,proposed_result_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(values.draftId,values.commandId,values.campaignId,values.actor,values.eventId,eventType,
      canonicalCatalogJson(proposedEvent),canonicalCatalogJson(values.result));
  db.prepare(`INSERT INTO character_draft_revisions_v19 (draft_id,revision,status,snapshot_json,command_id) VALUES (?,?,?,?,?)`)
    .run(values.draftId, values.revisionAfter, publicData.status,
      canonicalCatalogJson((values.result as { draft: unknown }).draft), values.commandId);
  db.prepare(`INSERT INTO character_draft_events_v19
    (draft_id,command_id,event_id,type,revision_before,revision,occurred_at,public_data) VALUES (?,?,?,?,?,?,?,?)`)
    .run(values.draftId, values.commandId, values.eventId, eventType, values.expectedRevision, values.revisionAfter, values.occurredAt,
      canonicalCatalogJson(publicData));
  db.prepare(`INSERT INTO character_draft_receipts_v19
    (draft_id,command_id,event_id,revision_before,revision_after,result_json) VALUES (?,?,?,?,?,?)`)
    .run(values.draftId, values.commandId, values.eventId, values.expectedRevision, values.revisionAfter, canonicalCatalogJson(values.result));
}

export interface CharacterBuilderRepository {
  createCharacterDraft(actorPrincipalId: string, campaignId: string, input: CreateCharacterDraftInput): CharacterDraftMutationResult;
  getCharacterDraft(actorPrincipalId: string, draftId: string): CharacterDraftView | null;
  updateCharacterDraft(actorPrincipalId: string, draftId: string, input: UpdateCharacterDraftInput): CharacterDraftMutationResult;
  abandonCharacterDraft(actorPrincipalId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }): CharacterDraftMutationResult;
  finalizeCharacterDraft(actorPrincipalId: string, draftId: string, input: FinalizeCharacterDraftInput): CharacterDraftFinalizationResult;
  getCharacterDraftReceipt(actorPrincipalId: string, draftId: string, commandId: string): CharacterDraftMutationReceipt | import("@velvet/contracts").CharacterFinalizationReceipt | null;
}

export function createCharacterBuilderRepository(
  db: DatabaseDriver.Database,
  dependencies: Dependencies,
  assertFactoryMutation: () => void,
): CharacterBuilderRepository {
  const reads = createCharacterBuilderReadRepository(db, dependencies);
  return {
    createCharacterDraft(actorPrincipalId, campaignId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), campaign = resourceIdSchema.parse(campaignId);
      const normalized = createCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const auth = reads.authority(actor, campaign); if (!auth || !reads.mayControl(actor, auth, normalized.controllerPrincipalId)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, campaign, actor, normalized.idempotencyKey), "create", requested, characterDraftMutationResultSchema);
        if (retry) return retry;
        reads.validateController(campaign, normalized.controllerPrincipalId);
        const catalog = reads.currentCatalog(campaign);
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        reads.validatePersona(campaign, normalized.personaId, now);
        // All 24 physical dice are requested only after non-random validation.
        const allocation = resolveAllocation(normalized.allocation, dependencies.rng);
        const draftId = resourceIdSchema.parse(dependencies.ids.nextId());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
        const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        const expiresAt = normalized.durability === "expiring"
          ? utcIsoTimestampSchema.parse(new Date(new Date(now).getTime() + CHARACTER_DRAFT_EXPIRY_SECONDS * 1_000).toISOString()) : null;
        const selections = { race: null, background: null, class: null, starterGrant: null };
        db.prepare(`INSERT INTO character_drafts_v19
          (id,campaign_id,persona_id,controller_principal_id,created_by_principal_id,status,durability,expires_at,revision,rules_profile_id,allocation_json,selections_json,created_at,updated_at)
          VALUES (?,?,?,?,?,'active',?,?,0,?,?,?,?,?)`).run(draftId, campaign, normalized.personaId, normalized.controllerPrincipalId,
            actor, normalized.durability, expiresAt, catalog.rulesProfileId, canonicalCatalogJson(allocation), canonicalCatalogJson(selections), now, now);
        const insertPin = db.prepare("INSERT INTO character_draft_pins_v19 (draft_id,position,pack_id,pack_version,publication_digest) VALUES (?,?,?,?,?)");
        catalog.pins.forEach((pin, position) => insertPin.run(draftId, position, pin.packId, pin.packVersion, pin.publicationDigest));
        const draft = buildView(db, rowFor(db, draftId)!, auth.role, now, reads.viewMappers);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "create", revisionBefore: 0, revisionAfter: 0, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId, commandId, eventId, campaignId: campaign, actor, idempotencyKey: normalized.idempotencyKey,
          type: "create", expectedRevision: 0, requested, revisionAfter: 0, occurredAt: now, result });
        return result;
      }).immediate();
    },
    getCharacterDraft: reads.getCharacterDraft,
    updateCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = updateCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = reads.authority(actor, row.campaign_id); if (!auth || !reads.mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "update", requested, characterDraftMutationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be updated");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        if (row.expires_at !== null && row.expires_at <= now) throw new CharacterBuilderExpiredError();
        const definitions = reads.catalogForPins(row.rules_profile_id, pinsFor(db, id));
        const valid = new Set(definitions.filter((value) => ["race", "background", "class"].includes(value.reference.kind)).map((value) => reads.refKey(value.reference)));
        for (const reference of [normalized.selections.race, normalized.selections.background, normalized.selections.class]) {
          if (reference && !valid.has(reads.refKey(reference))) throw new CharacterBuilderUnavailableError("selection is not in the draft's exact pins");
        }
        const old = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
        const selections = characterBuilderSelectionsSchema.parse({ ...old, ...normalized.selections });
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId()), eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("UPDATE character_drafts_v19 SET selections_json=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(canonicalCatalogJson(selections), now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now, reads.viewMappers);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId: id, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "update", revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "update", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    abandonCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = abandonCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = reads.authority(actor, row.campaign_id); if (!auth || !reads.mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "abandon", requested, characterDraftMutationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be abandoned");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId()), eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("UPDATE character_drafts_v19 SET status='abandoned',revision=revision+1,updated_at=? WHERE id=?").run(now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now, reads.viewMappers);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId: id, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "abandon", revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "abandon", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    finalizeCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = finalizeCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = reads.authority(actor, row.campaign_id); if (!auth || !reads.mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "finalize", requested, characterDraftFinalizationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be finalized");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        if (row.expires_at !== null && row.expires_at <= now) throw new CharacterBuilderExpiredError();
        reads.validateController(row.campaign_id, row.controller_principal_id);
        reads.validatePersona(row.campaign_id, row.persona_id, now, id);
        const pins = pinsFor(db, id), current = reads.currentCatalog(row.campaign_id);
        if (!reads.samePins(current, row.rules_profile_id, pins)) throw new CharacterBuilderConflictError("campaign content pins changed after draft creation");
        const allocation = characterBuilderAllocationSchema.parse(JSON.parse(row.allocation_json));
        const selections = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
        const chosen = reads.selectedDefinitions(current.definitions, selections);
        if (!chosen || !selections.starterGrant) throw new CharacterBuilderIncompleteError();
        const derived = calculateCharacterDerivedStats({ scores: allocation.scores, racialBonuses: chosen.race.mechanics.attributeBonuses,
          classHp: chosen.level.mechanics.hpGain, raceSpeed: chosen.race.mechanics.speed,
          proficiencyBonus: chosen.level.mechanics.proficiencyBonus, spellcastingAttribute: chosen.klass.mechanics.primaryAttribute });
        const grants = reads.grantsFor(chosen.background, selections.starterGrant);
        const campaignCharacterId = resourceIdSchema.parse(dependencies.ids.nextId());
        const sheetId = resourceIdSchema.parse(dependencies.ids.nextId());
        const actorId = resourceIdSchema.parse(dependencies.ids.nextId());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
        const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("INSERT INTO campaign_characters (id,campaign_id,character_id,created_at,updated_at) VALUES (?,?,?,?,?)")
          .run(campaignCharacterId, row.campaign_id, row.persona_id, now, now);
        db.prepare(`INSERT INTO rpg_campaign_sheets (id,campaign_id,campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
          background_pack_id,background_pack_version,background_kind,background_definition_id,created_at,updated_at)
          VALUES (?,?,?,?,?,'race',?,?,?,'background',?,?,?)`).run(sheetId, row.campaign_id, campaignCharacterId,
            chosen.race.reference.packId, chosen.race.reference.packVersion, chosen.race.reference.definitionId,
            chosen.background.reference.packId, chosen.background.reference.packVersion, chosen.background.reference.definitionId, now, now);
        db.prepare(`INSERT INTO rpg_character_classes (campaign_id,sheet_id,position,pack_id,pack_version,kind,definition_id,level)
          VALUES (?,?,0,?,?,'class',?,1)`).run(row.campaign_id, sheetId, chosen.klass.reference.packId, chosen.klass.reference.packVersion, chosen.klass.reference.definitionId);
        const attributeInsert = db.prepare("INSERT INTO rpg_character_attributes (campaign_id,sheet_id,position,attribute_id,value) VALUES (?,?,?,?,?)");
        CHARACTER_BUILDER_ATTRIBUTE_IDS.forEach((attributeId, position) => attributeInsert.run(row.campaign_id, sheetId, position, attributeId,
          allocation.scores[attributeId] + (chosen.race.mechanics.attributeBonuses[attributeId] ?? 0)));
        const proficiencyInsert = db.prepare("INSERT INTO rpg_character_proficiencies (campaign_id,sheet_id,position,category,proficiency_id) VALUES (?,?,?,?,?)");
        const proficiencies = [
          ...chosen.background.mechanics.skillRefs.map((reference) => ({ category: "skill", id: reference.definitionId })),
          ...chosen.klass.mechanics.savingAttributes.map((attributeId) => ({ category: "saving-throw", id: attributeId })),
        ];
        [...new Map(proficiencies.map((value) => [`${value.category}\0${value.id}`, value])).values()].forEach((value, position) =>
          proficiencyInsert.run(row.campaign_id, sheetId, position, value.category, value.id));
        const choiceInsert = db.prepare(`INSERT INTO rpg_character_choices
          (campaign_id,sheet_id,position,choice_id,pack_id,pack_version,kind,definition_id) VALUES (?,?,?,?,?,?,?,?)`);
        [chosen.race.reference, chosen.background.reference, chosen.klass.reference].forEach((reference, position) =>
          choiceInsert.run(row.campaign_id, sheetId, position, ["race", "background", "class"][position], reference.packId, reference.packVersion, reference.kind, reference.definitionId));
        db.prepare(`INSERT INTO campaign_actors (id,campaign_id,campaign_character_id,sheet_id,kind,control,created_at,updated_at)
          VALUES (?,?,?,?,'player-character','principal',?,?)`).run(actorId, row.campaign_id, campaignCharacterId, sheetId, now, now);
        db.prepare("INSERT INTO campaign_actor_private_state (actor_id,campaign_id,controller_principal_id,private_notes) VALUES (?,?,?,NULL)")
          .run(actorId, row.campaign_id, row.controller_principal_id);
        db.prepare("INSERT INTO rpg_actor_resources (campaign_id,actor_id,name,current,max) VALUES (?,?,'health',?,?)")
          .run(row.campaign_id, actorId, derived.maxHp, derived.maxHp);
        db.prepare(`INSERT INTO character_derived_snapshots_v19
          (draft_id,campaign_id,campaign_character_id,sheet_id,actor_id,calculator_version,derived_json,created_at)
          VALUES (?,?,?,?,?,'velvet-character-derived-v1',?,?)`).run(id, row.campaign_id, campaignCharacterId, sheetId, actorId, canonicalCatalogJson(derived), now);
        initializeCharacterProgressionV24(db,{campaignCharacterId,campaignId:row.campaign_id,sheetId,actorId,
          classRef:{packId:chosen.klass.reference.packId,packVersion:chosen.klass.reference.packVersion,definitionId:chosen.klass.reference.definitionId},derived,now,mode:normalized.progressionMode??"xp"});
        const grantInsert = db.prepare(`INSERT INTO character_starting_grants_v19
          (draft_id,position,kind,pack_id,pack_version,definition_id,amount,source,grant_json) VALUES (?,?,?,?,?,?,?,?,?)`);
        grants.forEach((grant, position) => grantInsert.run(id, position, grant.kind, grant.reference.packId, grant.reference.packVersion,
          grant.reference.definitionId, grant.kind === "item" ? grant.quantity : grant.amount, grant.source, canonicalCatalogJson(grant)));
        db.prepare("UPDATE character_drafts_v19 SET status='finalized',revision=revision+1,updated_at=? WHERE id=?").run(now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now, reads.viewMappers);
        const receipt = characterFinalizationReceiptSchema.parse({ draftId: id, commandId, eventId, idempotencyKey: normalized.idempotencyKey,
          revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now,
          campaignCharacterId, sheetId, actorId, derived, startingGrants: grants });
        const result = characterDraftFinalizationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "finalize", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    getCharacterDraftReceipt: reads.getCharacterDraftReceipt,
  };
}
