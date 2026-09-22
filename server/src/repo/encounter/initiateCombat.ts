/**
 * Target-initiated combat service.
 *
 * Materializes and starts one encounter when a player attacks a campaign NPC or
 * another campaign actor. The player-facing authorization mirrors
 * `mayActForConsumable`: the principal must be a campaign member who controls
 * the initiating actor (owner, GM, or the actor's controlling principal).
 * Observers and foreign campaigns are rejected.
 *
 * Encounter creation and start are intentionally routed through the GM
 * lifecycle commands, so template pinning, enemy provenance, initiative, turn
 * economy and the automatic tactical map + tokens happen exactly as they do for
 * GM-created encounters. Because those commands require GM authority, this
 * service resolves the campaign's GM authority (the initiating principal when
 * they already hold it, otherwise the campaign owner) and runs the create/start
 * pair in one transaction. Nothing is left behind when start fails.
 *
 * Deterministic replay: when no explicit `idempotencyKey` is supplied, both
 * lifecycle keys are derived from the request. Repeating the same request
 * converges on the same encounter and combat through the lifecycle's own
 * idempotency replay instead of materializing a second encounter. Callers that
 * need a distinct later combat can pass a fresh `idempotencyKey`.
 */
import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  encounterCreateRequestSchema,
  encounterStartCommandRequestSchema,
  idempotencyKeySchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type EncounterCreateRequest,
} from "@velvet/contracts";
import { z } from "zod";
import { createCreateLifecycleEncounter, createStartLifecycleEncounter } from "./actionExecution/lifecycle.js";
import { canonical, type EncounterWriteDependencies } from "./actionExecution/shared.js";
import {
  EncounterAuthorizationError,
  EncounterConflictError,
  EncounterStaleError,
  EncounterUnavailableError,
} from "./encounterErrors.js";
import type { EncounterCombatSnapshot } from "./encounterReadRepo.js";
import { NpcCombatProfileError, resolveNpcCombatProfile, type NpcCombatProfile, type NpcCombatTier } from "./npcCombatProfile.js";
import { mayActForConsumable } from "./useConsumableRuntime.js";

/** Attackable target identity: a campaign NPC or another campaign actor. */
export const combatInitiationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("npc"), npcId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("actor"), actorId: resourceIdSchema }).strict(),
]);
export type CombatInitiationTarget = z.infer<typeof combatInitiationTargetSchema>;

export const initiateCombatInputSchema = z.object({
  principalId: resourceIdSchema,
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  actorId: resourceIdSchema,
  target: combatInitiationTargetSchema,
  /** Optional stable request identity; defaults to a value derived from the request. */
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
export type InitiateCombatInput = z.infer<typeof initiateCombatInputSchema>;

/** Typed failure codes for {@link initiateCombatFromTarget}. */
export type CombatInitiationFailureCode =
  | "COMBAT_INITIATION_INVALID_INPUT"
  | "COMBAT_INITIATION_FORBIDDEN"
  | "COMBAT_INITIATION_CAMPAIGN_NOT_FOUND"
  | "COMBAT_INITIATION_ACTOR_NOT_FOUND"
  | "COMBAT_INITIATION_TARGET_NOT_FOUND"
  | "COMBAT_INITIATION_NPC_UNRESOLVABLE"
  | "COMBAT_INITIATION_ACTIVE_ENCOUNTER"
  | "COMBAT_INITIATION_CONFLICT";

/** Raised when target-initiated combat cannot be materialized or started. */
export class CombatInitiationError extends Error {
  readonly code: CombatInitiationFailureCode;
  constructor(code: CombatInitiationFailureCode, message: string) {
    super(message);
    this.name = "CombatInitiationError";
    this.code = code;
  }
}

/** Result of one successful or replayed combat initiation. */
export interface InitiateCombatResult {
  readonly campaignId: string;
  readonly encounterId: string;
  /** The encounter doubles as the combat identity in this repository. */
  readonly combatId: string;
  readonly combat: EncounterCombatSnapshot;
  /** NPC-only: the derived combat role tier. */
  readonly tier?: NpcCombatTier;
  /** NPC-only: the pinned, publicly visible enemy template. */
  readonly template?: NpcCombatProfile["template"];
  /** NPC-only: the tier derivation rationale preserved for later presentation. */
  readonly rationale?: string;
}

interface ActorIdentity {
  readonly actorId: string;
  readonly name: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function actorIdentity(db: DatabaseDriver.Database, campaignId: string, actorId: string): ActorIdentity | null {
  const row = db.prepare(`SELECT actor.id actor_id,persona.name name
    FROM campaign_actors actor
    JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
    JOIN characters persona ON persona.id=character.character_id
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as { actor_id: string; name: string } | undefined;
  return row ? { actorId: row.actor_id, name: row.name } : null;
}

/**
 * Resolves an authority principal for the lifecycle commands. The initiating
 * principal is reused when they already hold owner/GM authority; otherwise the
 * campaign owner (or sole GM) acts as the materialization authority. Player
 * intent is authorized before this point; this lookup only satisfies the
 * lifecycle's GM gate and never widens what the initiator may do.
 */
function gmAuthorityPrincipal(db: DatabaseDriver.Database, campaignId: string, principalId: string): string | null {
  if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')")
    .get(campaignId, principalId)) return principalId;
  const row = db.prepare(`SELECT membership.principal_id principal_id
    FROM campaign_memberships membership
    JOIN campaigns campaign ON campaign.id=membership.campaign_id
    WHERE membership.campaign_id=? AND membership.role IN ('owner','gm')
    ORDER BY CASE WHEN membership.principal_id=campaign.owner_principal_id THEN 0 ELSE 1 END,membership.principal_id
    LIMIT 1`).get(campaignId) as { principal_id: string } | undefined;
  return row?.principal_id ?? null;
}

function encounterName(initiator: string, target: string): string {
  return `${initiator} attacks ${target}`.trim().slice(0, 200) || "Combat";
}

function profileFromTarget(
  db: DatabaseDriver.Database,
  principalId: string,
  campaignId: string,
  target: CombatInitiationTarget,
): NpcCombatProfile | null {
  if (target.kind !== "npc") return null;
  try {
    return resolveNpcCombatProfile(db, principalId, campaignId, target.npcId);
  } catch (error) {
    if (error instanceof NpcCombatProfileError) {
      if (error.code === "NPC_PROFILE_FORBIDDEN") {
        throw new CombatInitiationError("COMBAT_INITIATION_FORBIDDEN", error.message);
      }
      if (error.code === "NPC_PROFILE_NPC_NOT_FOUND") {
        throw new CombatInitiationError("COMBAT_INITIATION_TARGET_NOT_FOUND", error.message);
      }
      throw new CombatInitiationError("COMBAT_INITIATION_NPC_UNRESOLVABLE", error.message);
    }
    throw error;
  }
}

/** Maps lifecycle command failures onto the typed initiation failures. */
function asInitiationError(error: unknown): CombatInitiationError | null {
  if (error instanceof CombatInitiationError) return error;
  if (error instanceof EncounterAuthorizationError) {
    return new CombatInitiationError("COMBAT_INITIATION_FORBIDDEN", error.message);
  }
  if (error instanceof EncounterUnavailableError) {
    if (error.message.includes("session does not belong")) {
      return new CombatInitiationError("COMBAT_INITIATION_CAMPAIGN_NOT_FOUND", error.message);
    }
    if (error.message.includes("actor is unavailable")) {
      return new CombatInitiationError("COMBAT_INITIATION_TARGET_NOT_FOUND", error.message);
    }
    if (error.message.includes("enemy template is unavailable")) {
      return new CombatInitiationError("COMBAT_INITIATION_NPC_UNRESOLVABLE", error.message);
    }
    return new CombatInitiationError("COMBAT_INITIATION_CONFLICT", error.message);
  }
  if (error instanceof EncounterConflictError) {
    if (/already has an open encounter|already in an active encounter|already has an active encounter/.test(error.message)) {
      return new CombatInitiationError("COMBAT_INITIATION_ACTIVE_ENCOUNTER", error.message);
    }
    return new CombatInitiationError("COMBAT_INITIATION_CONFLICT", error.message);
  }
  if (error instanceof EncounterStaleError) {
    return new CombatInitiationError("COMBAT_INITIATION_CONFLICT", error.message);
  }
  return null;
}

/**
 * Materializes and starts one encounter for a player attack. See the module
 * documentation for authorization, authority elevation, replay and failure
 * semantics.
 */
export function initiateCombatFromTarget(
  db: DatabaseDriver.Database,
  deps: EncounterWriteDependencies,
  input: InitiateCombatInput,
): InitiateCombatResult {
  deps.assertFactoryMutation();
  const parsed = initiateCombatInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CombatInitiationError("COMBAT_INITIATION_INVALID_INPUT", "combat initiation request is malformed");
  }
  const { principalId, campaignId, sessionId, actorId, target } = parsed.data;

  return db.transaction(() => {
    const campaign = db.prepare("SELECT id FROM campaigns WHERE id=?").get(campaignId);
    if (!campaign) {
      throw new CombatInitiationError("COMBAT_INITIATION_CAMPAIGN_NOT_FOUND", `campaign ${campaignId} is unavailable`);
    }
    if (!db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId)) {
      throw new CombatInitiationError("COMBAT_INITIATION_CAMPAIGN_NOT_FOUND", "campaign is not visible to the principal");
    }
    if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?")
      .get(campaignId, sessionId)) {
      throw new CombatInitiationError("COMBAT_INITIATION_CAMPAIGN_NOT_FOUND", "session does not belong to campaign");
    }

    const initiator = actorIdentity(db, campaignId, actorId);
    if (!initiator) {
      throw new CombatInitiationError("COMBAT_INITIATION_ACTOR_NOT_FOUND", `actor ${actorId} is unavailable`);
    }
    // Mirrors the consumable policy: owner/GM authority or the controlling principal.
    if (!mayActForConsumable(db, principalId, campaignId, actorId)) {
      throw new CombatInitiationError("COMBAT_INITIATION_FORBIDDEN", "principal cannot act for the initiating actor");
    }

    let profile: NpcCombatProfile | null = null;
    let targetName: string;
    if (target.kind === "actor") {
      if (target.actorId === actorId) {
        throw new CombatInitiationError("COMBAT_INITIATION_CONFLICT", "an actor cannot initiate combat against itself");
      }
      const targetActor = actorIdentity(db, campaignId, target.actorId);
      if (!targetActor) {
        throw new CombatInitiationError("COMBAT_INITIATION_TARGET_NOT_FOUND", `actor ${target.actorId} is unavailable`);
      }
      targetName = targetActor.name;
    } else {
      // Resolution preserves the tier derivation and rationale for the caller.
      profile = profileFromTarget(db, principalId, campaignId, target);
      if (!profile) {
        throw new CombatInitiationError("COMBAT_INITIATION_NPC_UNRESOLVABLE", `NPC ${target.npcId} has no combat profile`);
      }
      targetName = profile.name;
    }

    const authority = gmAuthorityPrincipal(db, campaignId, principalId);
    if (!authority) {
      throw new CombatInitiationError("COMBAT_INITIATION_CONFLICT", "campaign has no GM authority to materialize combat");
    }

    // An explicit key is the request identity (a reused key with a different
    // request is a typed conflict); otherwise the whole request identifies it.
    const requestDigest = digest(parsed.data.idempotencyKey === undefined
      ? { campaignId, sessionId, actorId, target }
      : { idempotencyKey: parsed.data.idempotencyKey }).slice(0, 40);
    const createKey = `initiate-combat:create:${requestDigest}`;
    const startKey = `initiate-combat:start:${requestDigest}`;

    const combatants: EncounterCreateRequest["combatants"] = [{ kind: "actor", actorId, team: "allies" }];
    if (profile) combatants.push({ kind: "enemy", template: profile.template, team: "enemies" });
    else if (target.kind === "actor") combatants.push({ kind: "actor", actorId: target.actorId, team: "enemies" });
    const createRequest = encounterCreateRequestSchema.parse({
      sessionId,
      name: encounterName(initiator.name, targetName),
      combatants,
      idempotencyKey: createKey,
    });

    // Exact immutable replay precedes the open-encounter guards: repeating the
    // same request converges on the stored encounter via lifecycle idempotency.
    const replay = db.prepare(`SELECT encounter_id,canonical_create_request_json FROM encounter_lifecycle_v31
      WHERE campaign_id=? AND create_idempotency_key=?`).get(campaignId, createKey) as
      { encounter_id: string; canonical_create_request_json: string } | undefined;
    if (replay && replay.canonical_create_request_json !== canonical(createRequest)) {
      throw new CombatInitiationError("COMBAT_INITIATION_CONFLICT", "idempotency key was reused for a different combat initiation");
    }

    if (!replay) {
      if (db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status IN ('preparing','active') LIMIT 1").get(sessionId)) {
        throw new CombatInitiationError("COMBAT_INITIATION_ACTIVE_ENCOUNTER", "session already has an open encounter");
      }
      if (db.prepare(`SELECT 1 FROM combatant participant JOIN encounter combat USING(encounter_id)
        WHERE participant.campaign_id=? AND participant.actor_id=? AND combat.status IN ('preparing','active') LIMIT 1`)
        .get(campaignId, actorId)) {
        throw new CombatInitiationError("COMBAT_INITIATION_ACTIVE_ENCOUNTER", "initiating actor is already in an open encounter");
      }
    }

    let encounterId: string;
    try {
      const created = createCreateLifecycleEncounter(db, deps)(authority, campaignId, createRequest);
      encounterId = created.encounter.encounterId;
      // Label the materialized enemy with the NPC's public name before the
      // start command generates the tactical map. The combat tracker and the
      // map token then identify the specific NPC instead of the borrowed
      // template. Only target-initiated NPC combat is labeled; GM-created
      // encounters and actor targets keep their persona/template names.
      if (profile) {
        const enemy = db.prepare(`SELECT provenance.combatant_id FROM encounter_enemy_provenance_v31 provenance
          JOIN combatant participant ON participant.encounter_id=provenance.encounter_id
            AND participant.combatant_id=provenance.combatant_id
          WHERE provenance.encounter_id=? AND provenance.campaign_id=? AND provenance.pack_id=?
            AND provenance.pack_version=? AND provenance.definition_id=? AND participant.combatant_kind='enemy'`)
          .get(encounterId, campaignId, profile.template.packId, profile.template.packVersion,
            profile.template.definitionId) as { combatant_id: string } | undefined;
        if (enemy) {
          db.prepare(`INSERT OR IGNORE INTO encounter_combatant_label_v67
            (combatant_id,encounter_id,campaign_id,label,created_at) VALUES(?,?,?,?,?)`)
            .run(enemy.combatant_id, encounterId, campaignId, profile.name,
              utcIsoTimestampSchema.parse(deps.clock.now().toISOString()));
        }
      }
      const priorStart = db.prepare("SELECT canonical_request_json FROM combat_commands_v27 WHERE encounter_id=? AND idempotency_key=?")
        .get(encounterId, startKey) as { canonical_request_json: string } | undefined;
      const startCommand = priorStart
        ? encounterStartCommandRequestSchema.parse(JSON.parse(priorStart.canonical_request_json))
        : { expectedRevision: 1, idempotencyKey: startKey };
      createStartLifecycleEncounter(db, deps)(authority, encounterId, startCommand);
    } catch (error) {
      const mapped = asInitiationError(error);
      if (mapped) throw mapped;
      throw error;
    }

    const combat = deps.reads.getCombatState(principalId, encounterId);
    if (!combat) {
      throw new CombatInitiationError("COMBAT_INITIATION_CONFLICT", "started combat projection is unavailable");
    }
    return {
      campaignId,
      encounterId,
      combatId: combat.combatId,
      combat,
      ...(profile ? { tier: profile.tier, template: profile.template, rationale: profile.rationale } : {}),
    };
  }).immediate();
}
