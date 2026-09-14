import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  combatStateSchema,
  combatLogSchema,
  combatActionCommandResponseSchema,
  combatCommandResultResponseSchema,
  combatEndCommandResponseSchema,
  encounterPublicSchema,
  legalCombatActionAllowlistSchema,
  useConsumableCommandResultSchema,
  combatRewardClaimResultResponseSchema,
  encounterCommandSchema,
  encounterSetupCandidatesResponseSchema,
  utcIsoTimestampSchema,
  type CombatState,
  type CombatLogEntry,
  type EncounterPublic,
  type EncounterSetupCandidatesResponse,
  type LegalCombatActionAllowlist,
  type CombatCommandResultResponse,
  type UseConsumableLegalAction,
  type UseConsumableCommandResult,
  type CombatRewardGrantPublic,
  type CombatRewardClaimResultResponse,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import { projectCombatLogRows, type CombatLogRow } from "./encounterRowTypes.js";
import { buildCombatActionPlans, isDndCombat, readCombatTurnEconomy } from "./combatActionPlan.js";
import { buildUseConsumableLegalActions, mayActForConsumable, readUseConsumableCommandResult } from "./useConsumableRuntime.js";
import { readReactionAvailability } from "./opportunityAttackRuntime.js";
import { readReadyActions } from "./reaction/readyActionRuntime.js";

/** Dependencies required by non-mutating encounter operations. */
export interface EncounterReadDependencies { clock: Clock; }

export type EncounterLifecycleSnapshot = EncounterPublic & { campaignId: string };
export type EncounterSetupCandidatesSnapshot = EncounterSetupCandidatesResponse & { campaignId: string };
export type EncounterCombatSnapshot = CombatState & { campaignId: string; encounterId: string };
export type CombatLogPage = {
  campaignId: string;
  encounterId: string;
  entries: CombatLogEntry[];
  nextAfterSequence: number | null;
};

/** Actor-authorized, non-mutating encounter operations. */
export interface EncounterReadRepository {
  /** Returns lifecycle summaries for one visible campaign, or null when the campaign is concealed. */
  listEncounters(principal: string, campaignId: string): EncounterLifecycleSnapshot[] | null;
  /** Returns only campaign-pinned, public setup choices available to a GM. */
  getEncounterSetupCandidates(principal: string, campaignId: string): EncounterSetupCandidatesSnapshot | null;
  /** Returns authoritative public combat state by its globally unique encounter-backed identity. */
  getCombatState(principal: string, combatId: string): EncounterCombatSnapshot | null;
  /** Returns a stable append-only page, or null when the combat is absent or concealed. */
  listCombatLogPage(principal: string, combatId: string, afterSequence: number, limit: number): CombatLogPage | null;
  /** Returns actions currently available to the principal's active combatant. */
  getLegalCombatActionAllowlist(principal: string, campaignId: string, encounterId: string): LegalCombatActionAllowlist | null;
  /** Reads an existing immutable HTTP command result without executing or replaying it. */
  getCombatCommandResult(principal: string, campaignId: string, combatId: string, idempotencyKey: string): CombatCommandResultResponse | null;
  /** Lists only reward bundles addressed to actors currently controlled by the principal (or every bundle for a GM). */
  listCombatRewards(principal:string,combatId:string):CombatRewardGrantPublic[]|null;
  /** Reads a settled claim only for its current recipient controller, by its original key or claim identity. */
  getCombatRewardClaimResult(principal:string,campaignId:string,combatId:string,rewardBundleId:string,claimIdentity:string):CombatRewardClaimResultResponse|null;
  /** Returns validated public combat-log entries when the principal may view the encounter. */
  listCombatLog(principal: string, campaignId: string, encounterId: string): unknown[];
  /** Repository-only legal actions; deliberately excluded from the live HTTP combat union. */
  getUseConsumableLegalActions(principal:string,combatId:string):UseConsumableLegalAction[];
  /** Reads one immutable repository-only consumable result by its internal command identity. */
  getUseConsumableCommandResult(principal:string,commandId:string):UseConsumableCommandResult|null;
  /** Reads one immutable consumable result in its combat by the caller's command key. */
  getUseConsumableCommandResultByKey(principal:string,combatId:string,idempotencyKey:string):UseConsumableCommandResult|null;
}

/** Creates the database-backed read repository for encounter state. */
export function createEncounterReadRepository(
  db: DatabaseDriver.Database,
  dependencies: EncounterReadDependencies,
): EncounterReadRepository {
  const member = (principal: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principal),
  );
  const controls = (principal: string, campaignId: string, actorId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(campaignId, actorId, principal),
  );
  const gm = (principal: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(campaignId, principal),
  );
  const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
    ?Object.fromEntries(Object.keys(item).sort().map((key)=>[key,item[key]])):item);
  const sha256=(value:string)=>createHash("sha256").update(value).digest("hex");
  const combatantRows = (encounterId: string): any[] => db.prepare(`SELECT c.*,survival.successes survival_successes,survival.failures survival_failures,
    COALESCE(temporary.hit_points,0) temporary_hit_points,
    provenance.pack_id provenance_pack_id,provenance.pack_version provenance_pack_version,
    provenance.definition_id provenance_definition_id
    FROM combatant c LEFT JOIN combat_survival_v61 survival ON survival.encounter_id=c.encounter_id AND survival.combatant_id=c.combatant_id
      LEFT JOIN combat_temporary_hit_points_v62 temporary ON temporary.encounter_id=c.encounter_id AND temporary.combatant_id=c.combatant_id
      LEFT JOIN encounter_enemy_provenance_v31 provenance
      ON provenance.encounter_id=c.encounter_id AND provenance.combatant_id=c.combatant_id
    WHERE c.encounter_id=? ORDER BY c.combatant_id`).all(encounterId) as any[];

  const publicCombatant = (row: any) => row.combatant_kind === "actor"
    ? { combatantId: row.combatant_id, kind: "actor" as const, team: row.team, actorId: row.actor_id }
    : {
        combatantId: row.combatant_id,
        kind: "enemy" as const,
        team: row.team,
        template: row.provenance_pack_id === null
          ? null
          : {
              kind: "enemy-template" as const,
              packId: row.provenance_pack_id,
              packVersion: row.provenance_pack_version,
              definitionId: row.provenance_definition_id,
            },
      };
  // Display names are joined from authorized sources only: campaign persona
  // names for actors, and publicly reachable enemy-template definitions for
  // enemies. Missing or private names stay absent so the client falls back to
  // neutral position labels instead of inferring hidden identities.
  const actorDisplayName = (campaignId: string, actorId: string): string | null => {
    const row = db.prepare(`SELECT persona.name
      FROM campaign_actors actor
      JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
      JOIN characters persona ON persona.id=character.character_id
      WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as { name: string } | undefined;
    return row?.name?.trim() ? row.name : null;
  };
  const enemyDisplayName = (template: { packId: string; packVersion: string; definitionId: string } | null): string | null => {
    if (!template) return null;
    const row = db.prepare(`SELECT public_definition_json FROM rpg_catalog_definition_visibility
      WHERE pack_id=? AND pack_version=? AND kind='enemy-template' AND definition_id=? AND publicly_reachable=1`)
      .get(template.packId, template.packVersion, template.definitionId) as { public_definition_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.public_definition_json) as { name?: unknown };
      return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : null;
    } catch { return null; }
  };
  const combatConditions = (encounterId: string, combatantId: string, round: number) => db.prepare(`SELECT condition,expires_at_round
    FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=? AND (expires_at_round IS NULL OR expires_at_round>=?)
    ORDER BY condition,source_combatant_id`).all(encounterId, combatantId, round).map((row: any) => ({
      condition: row.condition, expiresAtRound: row.expires_at_round,
    }));
  const combatMarkers = (encounterId: string, combatantId: string): Array<"helped" | "hidden"> => db.prepare(`SELECT marker
    FROM combat_markers_v64 WHERE encounter_id=? AND combatant_id=? ORDER BY marker`).all(encounterId, combatantId).map((row: any) => row.marker);

  const listEncounters = (principal: string, campaignId: string): EncounterLifecycleSnapshot[] | null => {
    if (!member(principal, campaignId)) return null;
    const rows = db.prepare(`SELECT e.*,metadata.name,root.revision
      FROM encounter e JOIN encounter_lifecycle_v31 metadata ON metadata.encounter_id=e.encounter_id
      JOIN combat_mutation_revisions_v27 root ON root.encounter_id=e.encounter_id
      WHERE e.campaign_id=? ORDER BY e.created_at,e.encounter_id`).all(campaignId) as any[];
    return rows.map((row) => ({
      campaignId,
      ...encounterPublicSchema.parse({
        encounterId: row.encounter_id,
        sessionId: row.session_id,
        name: row.name,
        status: row.status,
        combatId: row.status === "preparing" ? null : row.encounter_id,
        combatants: combatantRows(row.encounter_id).map(publicCombatant),
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    }));
  };

  const getEncounterSetupCandidates = (principal: string, campaignId: string): EncounterSetupCandidatesSnapshot | null => {
    if (!gm(principal, campaignId)) return null;
    const sessions = db.prepare(`SELECT attached.session_id
      FROM campaign_sessions attached
      WHERE attached.campaign_id=? AND NOT EXISTS(
        SELECT 1 FROM encounter open WHERE open.session_id=attached.session_id AND open.status IN ('preparing','active')
      ) ORDER BY attached.session_id`).all(campaignId) as Array<{ session_id: string }>;
    const actors = db.prepare(`SELECT actor.id actor_id,persona.name label
      FROM campaign_actors actor
      JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
      JOIN characters persona ON persona.id=character.character_id
      JOIN rpg_actor_resources health ON health.campaign_id=actor.campaign_id AND health.actor_id=actor.id
        AND health.name='health' AND health.current>0
      WHERE actor.campaign_id=? AND NOT EXISTS(
        SELECT 1 FROM combatant joined JOIN encounter open ON open.encounter_id=joined.encounter_id
        WHERE joined.campaign_id=actor.campaign_id AND joined.actor_id=actor.id AND open.status IN ('preparing','active')
      ) ORDER BY actor.id`).all(campaignId) as Array<{ actor_id: string; label: string | null }>;
    const enemies = db.prepare(`SELECT definition.pack_id,definition.pack_version,definition.definition_id,visibility.public_definition_json
      FROM rpg_campaign_catalog_definitions_v25 definition
      JOIN campaign_catalog_current_pins pin ON pin.campaign_id=definition.campaign_id
        AND pin.pack_id=definition.pack_id AND pin.pack_version=definition.pack_version
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=definition.pack_id AND visibility.pack_version=definition.pack_version
        AND visibility.kind=definition.kind AND visibility.definition_id=definition.definition_id AND visibility.publicly_reachable=1
      WHERE definition.campaign_id=? AND definition.kind='enemy-template'
      ORDER BY definition.pack_id,definition.pack_version,definition.definition_id`).all(campaignId) as Array<{
        pack_id: string; pack_version: string; definition_id: string; public_definition_json: string;
      }>;
    const result = encounterSetupCandidatesResponseSchema.parse({
      sessions: sessions.map((session) => ({ sessionId: session.session_id })),
      actors: actors.map((actor) => ({ actorId: actor.actor_id, label: actor.label })),
      enemies: enemies.map((enemy) => {
        const publicDefinition = JSON.parse(enemy.public_definition_json) as { name?: unknown };
        return {
          template: { kind: "enemy-template" as const, packId: enemy.pack_id, packVersion: enemy.pack_version, definitionId: enemy.definition_id },
          label: publicDefinition.name,
        };
      }),
      teams: { actor: "allies" as const, enemy: "enemies" as const },
    });
    return { campaignId, ...result };
  };

  const getCombatState = (principal: string, combatId: string): EncounterCombatSnapshot | null => {
    const encounter = db.prepare(`SELECT e.*,root.revision FROM encounter e
      JOIN combat_mutation_revisions_v27 root ON root.encounter_id=e.encounter_id
      WHERE e.encounter_id=? AND e.status<>'preparing'`).get(combatId) as any;
    if (!encounter || !member(principal, encounter.campaign_id)) return null;
    const rows = combatantRows(combatId);
    const active = rows.filter((row) => row.status === "active" || row.status === "unconscious");
    const current = active.find((row) => row.combatant_id === encounter.current_turn_combatant_id) ?? null;
    const turnEconomy = readCombatTurnEconomy(db, combatId);
    if (encounter.status === "active" && current && isDndCombat(db, encounter.campaign_id)
        && (!turnEconomy || turnEconomy.combatantId !== current.combatant_id || turnEconomy.round !== encounter.round_number)) {
      throw new Error("D&D combat turn economy is unavailable or stale");
    }
     const legalActions = buildCombatActionPlans(db, principal, encounter.campaign_id, combatId,
       encounter.current_turn_combatant_id).map((plan) => ({
       legalActionId: plan.legalActionId, kind: plan.kind, targetIds: plan.targetIds, ...(turnEconomy?{cost:plan.cost}:{}),
     }));
     const dndCombat = isDndCombat(db, encounter.campaign_id);
     const combat = combatStateSchema.parse({
      combatId,
      round: encounter.round_number,
      currentCombatant: encounter.current_turn_combatant_id,
      combatants: rows.map((row) => {
        const identity = publicCombatant(row);
        const displayName = identity.kind === "actor" ? actorDisplayName(encounter.campaign_id, identity.actorId)
          : enemyDisplayName(identity.template);
        const markers = dndCombat ? combatMarkers(combatId, row.combatant_id) : [];
        return {
          ...identity,
          ...(displayName ? { displayName } : {}),
          hitPoints: row.hit_points,
          maximumHitPoints: row.maximum_hit_points,
          ...(dndCombat ? { temporaryHitPoints: row.temporary_hit_points, conditions: combatConditions(combatId, row.combatant_id, encounter.round_number) } : {}),
          ...(markers.length ? { markers } : {}),
          status: row.status,
          ...(row.actor_id !== null && row.survival_successes !== null ? { deathSaves: { successes: row.survival_successes, failures: row.survival_failures } } : {}),
        };
      }),
      legalActions,
       ...(isDndCombat(db,encounter.campaign_id)?{turnEconomy}:{}),
       ...(isDndCombat(db,encounter.campaign_id)?{reactionAvailability:readReactionAvailability(db,combatId,encounter.round_number)}:{}),
       ...(isDndCombat(db,encounter.campaign_id)?{readyActions:readReadyActions(db,combatId,encounter.round_number).map((ready)=>({
         combatantId:ready.combatantId,readyId:ready.readyId,responseKind:ready.responseKind,responseId:ready.responseId,
         trigger:{event:ready.triggerEvent,subject:ready.triggerSubject,
           ...(ready.maxDistanceFeet===null?{}:{maxDistanceFeet:ready.maxDistanceFeet}),
           ...(ready.requiresHit?{requiresHit:true}:{})},
         expiresAtRound:ready.expiresAtRound}))}:{}),
      revision: encounter.revision,
    });
    return { campaignId: encounter.campaign_id, encounterId: encounter.encounter_id, ...combat };
  };
  const listCombatLogPage = (principal: string, combatId: string, afterSequence: number, limit: number): CombatLogPage | null => {
    const encounter = db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=? AND status<>'preparing'").get(combatId) as any;
    if (!encounter || !member(principal, encounter.campaign_id)) return null;
    const rows = db.prepare(`SELECT log_id,log_json,occurred_at FROM combat_log WHERE encounter_id=?
      ORDER BY occurred_at,log_ordinal,log_id`).all(combatId) as CombatLogRow[];
    const remaining = projectCombatLogRows(rows, encounter.campaign_id, combatId)
      .filter((entry) => entry.sequence > afterSequence);
    const entries = remaining.slice(0, limit);
    return {
      campaignId: encounter.campaign_id,
      encounterId: combatId,
      entries,
      nextAfterSequence: remaining.length > entries.length ? entries.at(-1)!.sequence : null,
    };
  };
  /** Builds the authoritative action projection for a principal's current combatant. */
  const getLegalCombatActionAllowlist = (principal: string, campaignId: string, encounterId: string): LegalCombatActionAllowlist | null => {
    if (!member(principal, campaignId)) return null;
    const encounter = db.prepare("SELECT * FROM encounter WHERE encounter_id=? AND campaign_id=? AND status='active'").get(encounterId, campaignId) as any;
    const current = encounter?.current_turn_combatant_id && db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(encounterId, encounter.current_turn_combatant_id) as any;
    if (!current?.actor_id || !controls(principal, campaignId, current.actor_id)) return null;
    const plans=buildCombatActionPlans(db,principal,campaignId,encounterId,current.combatant_id);
    const actions: any[] = plans.flatMap((plan) => {
      // Keep this projection one-to-one with the command kinds accepted by the
      // public allowlist. Unsupported plan kinds are intentionally omitted.
      if (plan.kind === "attack") return [{ kind: "attack", attackId: plan.legalActionId, attackType: plan.attackType, targetCombatantIds: plan.targetIds,
        ...(plan.targetEvidence ? { targetEvidence: plan.targetEvidence } : {}) }];
      if (plan.kind === "grapple") return [{ kind: "grapple", targetCombatantIds: plan.targetIds }];
      if (plan.kind === "escape-grapple") return [{ kind: "escape-grapple" }];
      if (plan.kind === "help") return [{ kind: "help", targetCombatantIds: plan.targetIds }];
      if (plan.kind === "dash" || plan.kind === "disengage" || plan.kind === "hide" || plan.kind === "flee" || plan.kind === "end-turn")
        return [{ kind: plan.kind }];
      return [];
    });
    const revision = (db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId) as any)?.revision;
    return legalCombatActionAllowlistSchema.parse({ campaignId, encounterId, combatantId: current.combatant_id, revision: revision ?? 0,
      issuedAt: utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString()), actions,
      coverEvidence: plans.flatMap((plan) => plan.targetEvidence ?? []) });
  };
  /** Projects only schema-valid public entries from the immutable combat audit log. */
  const listCombatLog = (principal: string, campaignId: string, encounterId: string): unknown[] => {
    if (!member(principal, campaignId) || !db.prepare("SELECT 1 FROM encounter WHERE encounter_id=? AND campaign_id=?").get(encounterId, campaignId)) return [];
    const rows = db.prepare("SELECT log_id,log_json,occurred_at FROM combat_log WHERE encounter_id=? ORDER BY occurred_at,log_ordinal,log_id").all(encounterId) as CombatLogRow[];
    return combatLogSchema.parse(projectCombatLogRows(rows, campaignId, encounterId));
  };
  const getCombatCommandResult = (principal: string, campaignId: string, combatId: string, idempotencyKey: string): CombatCommandResultResponse | null => {
    const encounter = db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=? AND campaign_id=?").get(combatId, campaignId) as { campaign_id: string } | undefined;
    if (!encounter || !member(principal, campaignId)) return null;
    const row = db.prepare(`SELECT command.command_type,command.actor_id,receipt.canonical_result_json
      FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id)
      WHERE command.encounter_id=? AND command.idempotency_key=? AND command.command_type IN ('resolve_action','grant_rewards')
        AND COALESCE(json_extract(command.canonical_request_json,'$.kind'),'')<>'use-consumable'`)
      .get(combatId, idempotencyKey) as { command_type: "resolve_action" | "grant_rewards"; actor_id: string | null; canonical_result_json: string } | undefined;
    if (!row) return null;
    if (row.command_type === "resolve_action" && !gm(principal, campaignId)
      && (row.actor_id === null || !controls(principal, campaignId, row.actor_id))) return null;
    if (row.command_type === "grant_rewards" && !gm(principal, campaignId)) return null;
    const internal = JSON.parse(row.canonical_result_json) as any;
    if (internal.campaignId !== campaignId || internal.encounterId !== combatId) throw new Error("combat command receipt binding is invalid");
    if (row.command_type === "resolve_action") {
      const combat = internal.combat;
      const result = combatActionCommandResponseSchema.parse({ resolution: internal.resolution,
        combat: { combatId, round: combat.round, currentCombatant: combat.currentCombatant, combatants: combat.combatants, legalActions: combat.legalActions, turnEconomy:combat.turnEconomy, revision: combat.revision },
        receipt: { idempotencyKey: internal.receipt.idempotencyKey, revisionBefore: internal.receipt.revisionBefore, revisionAfter: internal.receipt.revisionAfter, occurredAt: internal.receipt.occurredAt } });
      return combatCommandResultResponseSchema.parse({ operation: "action", result });
    }
    const encounterResult = internal.encounter;
    const result = combatEndCommandResponseSchema.parse({ encounter: { encounterId: combatId, sessionId: encounterResult.sessionId, name: encounterResult.name,
       status: encounterResult.status, combatId: encounterResult.combatId, combatants: encounterResult.combatants, revision: encounterResult.revision,
       createdAt: encounterResult.createdAt, updatedAt: encounterResult.updatedAt }, rewards: internal.rewards.map(({ campaignId: _campaign, encounterId: _encounter, ...reward }: any) => ({...reward,claim:reward.claim??{state:"unclaimed"}})),
      receipt: { idempotencyKey: internal.receipt.idempotencyKey, revisionBefore: internal.receipt.revisionBefore, revisionAfter: internal.receipt.revisionAfter, occurredAt: internal.receipt.occurredAt } });
    return combatCommandResultResponseSchema.parse({ operation: "end", result });
  };
  const getUseConsumableCommandResultByKey=(principal:string,combatId:string,idempotencyKey:string):UseConsumableCommandResult|null=>{
    const rows=db.prepare(`SELECT command.actor_id,encounter.campaign_id,receipt.canonical_result_json
      FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id)
      JOIN encounter ON encounter.encounter_id=command.encounter_id
      WHERE command.encounter_id=? AND command.idempotency_key=? AND command.command_type='resolve_action'
        AND json_extract(command.canonical_request_json,'$.kind')='use-consumable'`)
      .all(combatId,idempotencyKey) as Array<{actor_id:string|null;campaign_id:string;canonical_result_json:string}>;
    if(rows.length>1)throw new Error("consumable result identity is ambiguous within combat");
    const row=rows[0];
    if(!row?.actor_id||!mayActForConsumable(db,principal,row.campaign_id,row.actor_id))return null;
    return useConsumableCommandResultSchema.parse(JSON.parse(row.canonical_result_json));
  };
  const listCombatRewards=(principal:string,combatId:string):CombatRewardGrantPublic[]|null=>{
    const encounter=db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=?").get(combatId) as {campaign_id:string}|undefined;
    if(!encounter||!member(principal,encounter.campaign_id))return null;
    const rows=db.prepare(`SELECT bundle.*,claim.reward_claim_id,claim.claimed_at FROM reward_bundle bundle
      LEFT JOIN reward_claim_v27 claim ON claim.reward_bundle_id=bundle.reward_bundle_id
      WHERE bundle.encounter_id=? ORDER BY bundle.created_at,bundle.reward_bundle_id`).all(combatId) as any[];
    return rows.filter((row)=>gm(principal,encounter.campaign_id)||controls(principal,encounter.campaign_id,row.recipient_actor_id)).map((row)=>{
      const entries=db.prepare(`SELECT amount_minor,currency_pack_id,currency_pack_version,currency_definition_id
        FROM reward_entry_v27 WHERE reward_bundle_id=? ORDER BY entry_ordinal`).all(row.reward_bundle_id) as any[];
      return {rewardBundleId:row.reward_bundle_id,recipientActorId:row.recipient_actor_id,createdAt:row.created_at,
        rewards:entries.map((entry)=>({kind:"currency" as const,currency:{kind:"currency" as const,packId:entry.currency_pack_id,
          packVersion:entry.currency_pack_version,definitionId:entry.currency_definition_id},amount:entry.amount_minor})),
        claim:row.reward_claim_id?{state:"claimed" as const,rewardClaimId:row.reward_claim_id,claimedAt:row.claimed_at}:{state:"unclaimed" as const}};
    });
  };
  const getCombatRewardClaimResult=(principal:string,campaignId:string,combatId:string,rewardBundleId:string,claimIdentity:string):CombatRewardClaimResultResponse|null=>{
    const rows=db.prepare(`SELECT bundle.recipient_actor_id,bundle.created_at bundle_created_at,claim.reward_claim_id,claim.claimed_at,
        command.idempotency_key,command.canonical_request_json,command.request_digest,command.expected_revision,command.resulting_revision,
        receipt.canonical_result_json,receipt.result_digest,receipt.occurred_at
      FROM reward_bundle bundle
      JOIN reward_claim_v27 claim ON claim.campaign_id=bundle.campaign_id AND claim.reward_bundle_id=bundle.reward_bundle_id AND claim.encounter_id=bundle.encounter_id
      JOIN combat_reward_settlements_v51 settlement ON settlement.campaign_id=claim.campaign_id AND settlement.reward_bundle_id=claim.reward_bundle_id
        AND settlement.encounter_id=claim.encounter_id AND settlement.recipient_actor_id=bundle.recipient_actor_id AND settlement.reward_claim_id=claim.reward_claim_id
      JOIN combat_commands_v27 command ON command.encounter_id=claim.encounter_id AND command.command_id=claim.command_id
      JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        AND receipt.resulting_revision=command.resulting_revision
      WHERE bundle.campaign_id=? AND bundle.encounter_id=? AND bundle.reward_bundle_id=?
        AND (command.idempotency_key=? OR claim.reward_claim_id=?)`)
      .all(campaignId,combatId,rewardBundleId,claimIdentity,claimIdentity) as any[];
    if(rows.length>1)throw new Error("combat reward claim result identity is ambiguous");
    const row=rows[0];
    if(!row||!controls(principal,campaignId,row.recipient_actor_id))return null;
    const request=encounterCommandSchema.parse(JSON.parse(row.canonical_request_json));
    const internalResult=JSON.parse(row.canonical_result_json);
    if(request.type!=="claim_reward_bundle"||request.campaignId!==campaignId||request.encounterId!==combatId
        ||request.rewardBundleId!==rewardBundleId||request.recipientActorId!==row.recipient_actor_id
        ||request.rewardClaimId!==row.reward_claim_id||request.claimedAt!==row.claimed_at
        ||request.idempotencyKey!==row.idempotency_key||request.expectedRevision!==row.expected_revision
        ||row.resulting_revision!==row.expected_revision+1||row.request_digest!==sha256(canonical(request))
        ||row.result_digest!==sha256(canonical(internalResult))||internalResult?.encounterId!==combatId
        ||internalResult?.receipt?.idempotencyKey!==row.idempotency_key||internalResult?.receipt?.revisionBefore!==row.expected_revision
        ||internalResult?.receipt?.revisionAfter!==row.resulting_revision||internalResult?.receipt?.occurredAt!==row.occurred_at)
      throw new Error("combat reward claim receipt graph is invalid");
    const entries=db.prepare(`SELECT amount_minor,currency_pack_id,currency_pack_version,currency_definition_id
      FROM reward_entry_v27 WHERE campaign_id=? AND reward_bundle_id=? ORDER BY entry_ordinal`).all(campaignId,rewardBundleId) as any[];
    const reward={rewardBundleId,recipientActorId:row.recipient_actor_id,createdAt:row.bundle_created_at,
      rewards:entries.map((entry)=>({kind:"currency" as const,currency:{kind:"currency" as const,packId:entry.currency_pack_id,
        packVersion:entry.currency_pack_version,definitionId:entry.currency_definition_id},amount:entry.amount_minor})),
      claim:{state:"claimed" as const,rewardClaimId:row.reward_claim_id,claimedAt:row.claimed_at}};
    return combatRewardClaimResultResponseSchema.parse({reward,requestBinding:{campaignId,combatId,rewardBundleId,
      recipientActorId:row.recipient_actor_id,claimedAt:row.claimed_at,requestEvidence:{rewardClaimId:request.rewardClaimId,
        expectedRevision:request.expectedRevision,idempotencyKey:request.idempotencyKey},canonicalRequestDigest:row.request_digest},
      receipt:{idempotencyKey:row.idempotency_key,revisionBefore:row.expected_revision,revisionAfter:row.resulting_revision,occurredAt:row.occurred_at}});
  };
  return { listEncounters, getEncounterSetupCandidates, getCombatState, listCombatLogPage, getLegalCombatActionAllowlist, listCombatLog, getCombatCommandResult,
    listCombatRewards,getCombatRewardClaimResult,
    getUseConsumableLegalActions:(principal,combatId)=>db.transaction(()=>buildUseConsumableLegalActions(db,principal,combatId)).deferred(),
    getUseConsumableCommandResult:(principal,commandId)=>db.transaction(()=>readUseConsumableCommandResult(db,principal,commandId)).deferred(),
    getUseConsumableCommandResultByKey:(principal,combatId,key)=>db.transaction(()=>getUseConsumableCommandResultByKey(principal,combatId,key)).deferred() };
}
