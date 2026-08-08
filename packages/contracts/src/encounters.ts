import { z } from "zod";
import { enemyTemplateCatalogReferenceSchema, itemCatalogReferenceSchema, currencyCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";

/** Stable identities are deliberately separate from catalog and actor identities. */
export const encounterIdSchema = resourceIdSchema;
export const combatantIdSchema = resourceIdSchema;
export const enemyInstanceIdSchema = resourceIdSchema;
export const combatLogEntryIdSchema = resourceIdSchema;
export const rewardBundleIdSchema = resourceIdSchema;
export const rewardClaimIdSchema = resourceIdSchema;
export const combatActionIdSchema = resourceIdSchema;

export const combatTeamSchema = z.enum(["allies", "enemies"]);
/** Both variants are explicit so the server can preserve their distinct provenance. */
export const encounterKindSchema = z.enum(["prepared", "improvised"]);
export const encounterStatusSchema = z.enum(["preparing", "active", "completed", "escaped"]);
export const combatActionKindSchema = z.enum(["attack", "power", "item", "defend", "flee", "end-turn"]);

/**
 * Tactics are a server-owned, closed fallback selector, not a script, formula,
 * condition tree, or client supplied AI override.
 */
export const deterministicFallbackTacticSchema = z.object({
  kind: z.literal("deterministic_fallback"),
  tacticId: resourceIdSchema,
}).strict();
export const enemyTacticSchema = deterministicFallbackTacticSchema;

/**
 * Creation asks the server to pin a catalog enemy and its closed tactic. HP,
 * initiative, combatant membership, and every resolution value are server
 * state, so this intentionally contains no runtime mechanics.
 */
export const enemySpawnIntentSchema = z.object({
  enemyInstanceId: enemyInstanceIdSchema,
  template: enemyTemplateCatalogReferenceSchema,
  tactic: deterministicFallbackTacticSchema,
}).strict();

/** Spawn identity and pinned template for an enemy in one encounter. Runtime HP is server state. */
export const enemyInstanceSchema = z.object({
  campaignId: campaignIdSchema,
  encounterId: encounterIdSchema,
  enemyInstanceId: enemyInstanceIdSchema,
  template: enemyTemplateCatalogReferenceSchema,
  tactic: deterministicFallbackTacticSchema,
  spawnedAt: utcIsoTimestampSchema,
}).strict();

export const combatantReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: actorIdSchema }).strict(),
  z.object({ kind: z.literal("enemy"), enemyInstanceId: enemyInstanceIdSchema }).strict(),
]);

const encounterMutationBase = {
  campaignId: campaignIdSchema,
  encounterId: encounterIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

/**
 * Creation explicitly binds an already attached session. Enemy references are
 * spawn intents only; the server derives combatants, HP, initiative, outcome,
 * and rewards from the pinned catalog inputs. Rewards therefore need no
 * caller-authored amount, item, currency, or rules payload.
 */
export const createEncounterCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("create_encounter"),
  sessionId: resourceIdSchema,
  kind: encounterKindSchema,
  enemySpawns: z.array(enemySpawnIntentSchema).max(128),
  createdAt: utcIsoTimestampSchema,
}).strict().superRefine((command, context) => {
  const spawnedIds = new Set<string>();
  command.enemySpawns.forEach((spawn, index) => {
    if (spawnedIds.has(spawn.enemyInstanceId)) {
      context.addIssue({ code: "custom", path: ["enemySpawns", index, "enemyInstanceId"], message: "enemy spawn IDs must be unique" });
    }
    spawnedIds.add(spawn.enemyInstanceId);
  });
});

export const joinCombatantCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("join_combatant"),
  combatantId: combatantIdSchema,
  combatant: combatantReferenceSchema,
  team: combatTeamSchema,
  joinedAt: utcIsoTimestampSchema,
}).strict();

/** Asking to resolve initiative intentionally has no client-provided initiative value. */
export const resolveInitiativeCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("resolve_initiative"),
  resolvedAt: utcIsoTimestampSchema,
}).strict();

/** Server projection of a resolved initiative entry; it is never command input. */
export const initiativeSchema = z.object({
  combatantId: combatantIdSchema,
  initiative: z.number().int().min(-10_000).max(10_000),
  resolvedAt: utcIsoTimestampSchema,
}).strict();

export const advanceTurnCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("advance_turn"),
  advancedAt: utcIsoTimestampSchema,
}).strict();
export const advanceRoundCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("advance_round"),
  advancedAt: utcIsoTimestampSchema,
}).strict();

const actionCommandBase = {
  ...encounterMutationBase,
  actionId: combatActionIdSchema,
  combatantId: combatantIdSchema,
  submittedAt: utcIsoTimestampSchema,
};

export const attackCombatActionCommandSchema = z.object({
  ...actionCommandBase,
  type: z.literal("attack"),
  attackId: resourceIdSchema,
  targetCombatantId: combatantIdSchema,
}).strict();
export const powerCombatActionCommandSchema = z.object({
  ...actionCommandBase,
  type: z.literal("power"),
  powerId: resourceIdSchema,
  targetCombatantId: combatantIdSchema.nullable(),
}).strict();
export const itemCombatActionCommandSchema = z.object({
  ...actionCommandBase,
  type: z.literal("item"),
  inventoryEntryId: resourceIdSchema,
  targetCombatantId: combatantIdSchema.nullable(),
}).strict();
export const defendCombatActionCommandSchema = z.object({ ...actionCommandBase, type: z.literal("defend") }).strict();
export const fleeCombatActionCommandSchema = z.object({ ...actionCommandBase, type: z.literal("flee") }).strict();
export const endTurnCombatActionCommandSchema = z.object({ ...actionCommandBase, type: z.literal("end-turn") }).strict();
export const combatActionCommandSchema = z.discriminatedUnion("type", [
  attackCombatActionCommandSchema, powerCombatActionCommandSchema, itemCombatActionCommandSchema,
  defendCombatActionCommandSchema, fleeCombatActionCommandSchema, endTurnCombatActionCommandSchema,
]);

/** Server-issued choices for the current turn. This is an allowlist, never an action override. */
export const legalCombatActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attack"), attackId: resourceIdSchema, targetCombatantIds: z.array(combatantIdSchema).min(1).max(128) }).strict(),
  z.object({ kind: z.literal("power"), powerId: resourceIdSchema, targetCombatantIds: z.array(combatantIdSchema).max(128), allowsNoTarget: z.boolean() }).strict(),
  z.object({ kind: z.literal("item"), inventoryEntryId: resourceIdSchema, targetCombatantIds: z.array(combatantIdSchema).max(128), allowsNoTarget: z.boolean() }).strict(),
  z.object({ kind: z.literal("defend") }).strict(),
  z.object({ kind: z.literal("flee") }).strict(),
  z.object({ kind: z.literal("end-turn") }).strict(),
]);
export const legalCombatActionAllowlistSchema = z.object({
  campaignId: campaignIdSchema,
  encounterId: encounterIdSchema,
  combatantId: combatantIdSchema,
  revision: revisionSchema,
  issuedAt: utcIsoTimestampSchema,
  actions: z.array(legalCombatActionSchema).min(1).max(128),
}).strict().superRefine((allowlist, context) => {
  const keys = new Set<string>();
  allowlist.actions.forEach((action, index) => {
    const id = action.kind === "attack" ? action.attackId : action.kind === "power" ? action.powerId : action.kind === "item" ? action.inventoryEntryId : "";
    const key = `${action.kind}:${id}`;
    if (keys.has(key)) context.addIssue({ code: "custom", message: "legal actions must be unique", path: ["actions", index] });
    keys.add(key);
  });
});

export const combatLogEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("encounter_created") }).strict(),
  z.object({ kind: z.literal("combatant_joined"), combatantId: combatantIdSchema }).strict(),
  z.object({ kind: z.literal("initiative_resolved"), combatantId: combatantIdSchema }).strict(),
  z.object({ kind: z.literal("round_advanced"), round: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("turn_advanced"), combatantId: combatantIdSchema }).strict(),
  z.object({ kind: z.literal("combat_terminal") }).strict(),
  z.object({ kind: z.literal("encounter_completed") }).strict(),
  z.object({ kind: z.literal("action_resolved"), actionId: combatActionIdSchema, action: combatActionKindSchema }).strict(),
  z.object({
    kind: z.literal("combatant_state_changed"),
    combatantId: combatantIdSchema,
    hitPoints: z.number().int().min(-1_000_000).max(1_000_000),
    status: z.enum(["active", "defeated", "fled", "removed"]),
  }).strict(),
  z.object({ kind: z.literal("rewards_granted"), rewardBundleIds: z.array(rewardBundleIdSchema).max(128) }).strict(),
  z.object({ kind: z.literal("reward_claimed"), rewardClaimId: rewardClaimIdSchema }).strict(),
]);
export const combatLogEntrySchema = z.object({
  logEntryId: combatLogEntryIdSchema,
  campaignId: campaignIdSchema,
  encounterId: encounterIdSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  occurredAt: utcIsoTimestampSchema,
  event: combatLogEventSchema,
}).strict();
export const combatLogSchema = z.array(combatLogEntrySchema).max(10_000);

export const encounterRewardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("currency"), currency: currencyCatalogReferenceSchema, amount: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ kind: z.literal("item"), item: itemCatalogReferenceSchema, quantity: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ kind: z.literal("experience"), amount: z.number().int().min(1).max(1_000_000) }).strict(),
]);
export const rewardBundleSchema = z.object({
  rewardBundleId: rewardBundleIdSchema,
  campaignId: campaignIdSchema,
  encounterId: encounterIdSchema,
  createdAt: utcIsoTimestampSchema,
  rewards: z.array(encounterRewardSchema).min(1).max(128),
}).strict();
export const claimRewardBundleCommandSchema = z.object({
  ...encounterMutationBase,
  type: z.literal("claim_reward_bundle"),
  rewardClaimId: rewardClaimIdSchema,
  rewardBundleId: rewardBundleIdSchema,
  recipientActorId: actorIdSchema,
  claimedAt: utcIsoTimestampSchema,
}).strict();

/** Closed mutation boundary for encounter lifecycle, commands, and reward claims. */
export const encounterCommandSchema = z.discriminatedUnion("type", [
  createEncounterCommandSchema, joinCombatantCommandSchema, resolveInitiativeCommandSchema,
  advanceTurnCommandSchema, advanceRoundCommandSchema, ...combatActionCommandSchema.options,
  claimRewardBundleCommandSchema,
]);

/** Descriptive aliases retain the noun-first vocabulary used by adjacent lanes. */
export const encounterCreateCommandSchema = createEncounterCommandSchema;
export const combatantJoinCommandSchema = joinCombatantCommandSchema;
export const initiativeCommandSchema = resolveInitiativeCommandSchema;
export const turnAdvanceCommandSchema = advanceTurnCommandSchema;
export const roundAdvanceCommandSchema = advanceRoundCommandSchema;
export const actionCommandSchema = combatActionCommandSchema;
export const legalActionAllowlistSchema = legalCombatActionAllowlistSchema;
export const rewardClaimCommandSchema = claimRewardBundleCommandSchema;

export type EnemyTactic = z.infer<typeof enemyTacticSchema>;
export type EncounterKind = z.infer<typeof encounterKindSchema>;
export type EnemySpawnIntent = z.infer<typeof enemySpawnIntentSchema>;
export type EnemyInstance = z.infer<typeof enemyInstanceSchema>;
export type CombatantReference = z.infer<typeof combatantReferenceSchema>;
export type Initiative = z.infer<typeof initiativeSchema>;
export type CombatActionCommand = z.infer<typeof combatActionCommandSchema>;
export type EncounterCommand = z.infer<typeof encounterCommandSchema>;
export type LegalCombatAction = z.infer<typeof legalCombatActionSchema>;
export type LegalCombatActionAllowlist = z.infer<typeof legalCombatActionAllowlistSchema>;
export type CombatLogEntry = z.infer<typeof combatLogEntrySchema>;
export type EncounterReward = z.infer<typeof encounterRewardSchema>;
export type RewardBundle = z.infer<typeof rewardBundleSchema>;
export type ClaimRewardBundleCommand = z.infer<typeof claimRewardBundleCommandSchema>;
