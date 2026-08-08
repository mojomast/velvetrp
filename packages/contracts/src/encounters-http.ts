import { z } from "zod";
import { enemyTemplateCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  combatLogEventSchema,
  combatTeamSchema,
  encounterRewardSchema,
  encounterStatusSchema,
  rewardBundleIdSchema,
} from "./encounters.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema } from "./rpg-characters.js";

export const encounterNameSchema = z.string().trim().min(1).max(200);

export const encounterActorIntentSchema = z.object({
  kind: z.literal("actor"),
  actorId: actorIdSchema,
  team: combatTeamSchema,
}).strict();

export const encounterEnemyIntentSchema = z.object({
  kind: z.literal("enemy"),
  template: enemyTemplateCatalogReferenceSchema,
  team: combatTeamSchema,
}).strict();

/** Preparation accepts identities and teams only; runtime mechanics remain server-owned. */
export const encounterCombatantIntentSchema = z.discriminatedUnion("kind", [
  encounterActorIntentSchema,
  encounterEnemyIntentSchema,
]);

export const encounterCreateRequestSchema = z.object({
  sessionId: resourceIdSchema,
  name: encounterNameSchema,
  combatants: z.array(encounterCombatantIntentSchema).min(1).max(32),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((request, context) => {
  const actors = request.combatants.flatMap((combatant) => combatant.kind === "actor" ? [combatant.actorId] : []);
  if (new Set(actors).size !== actors.length) {
    context.addIssue({ code: "custom", message: "actor combatants must be unique", path: ["combatants"] });
  }
});

export const encounterCombatantPublicSchema = z.discriminatedUnion("kind", [
  z.object({
    combatantId: resourceIdSchema,
    kind: z.literal("actor"),
    team: combatTeamSchema,
    actorId: actorIdSchema,
  }).strict(),
  z.object({
    combatantId: resourceIdSchema,
    kind: z.literal("enemy"),
    team: combatTeamSchema,
    template: enemyTemplateCatalogReferenceSchema.nullable(),
  }).strict(),
]);

export const encounterPublicSchema = z.object({
  encounterId: resourceIdSchema,
  sessionId: resourceIdSchema,
  name: encounterNameSchema,
  status: encounterStatusSchema,
  combatId: resourceIdSchema.nullable(),
  combatants: z.array(encounterCombatantPublicSchema).max(128),
  revision: revisionSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict().superRefine((encounter, context) => {
  const ids = encounter.combatants.map((combatant) => combatant.combatantId);
  if (new Set(ids).size !== ids.length
      || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
    context.addIssue({ code: "custom", message: "combatants must be unique and stably ordered", path: ["combatants"] });
  }
  const expectsCombat = encounter.status !== "preparing";
  if (expectsCombat !== (encounter.combatId !== null)) {
    context.addIssue({ code: "custom", message: "combat identity must match encounter status", path: ["combatId"] });
  }
});

export const encounterListResponseSchema = z.object({
  encounters: z.array(encounterPublicSchema).max(10_000),
}).strict().superRefine((response, context) => {
  const ids = response.encounters.map((encounter) => encounter.encounterId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "encounters must be unique", path: ["encounters"] });
  }
});

export const encounterCreateResponseSchema = z.object({ encounter: encounterPublicSchema }).strict();

export const encounterStartCommandRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const combatantStateSchema = z.discriminatedUnion("kind", [
  z.object({
    combatantId: resourceIdSchema,
    kind: z.literal("actor"),
    team: combatTeamSchema,
    actorId: actorIdSchema,
    hitPoints: z.number().int().min(-1_000_000).max(1_000_000),
    maximumHitPoints: z.number().int().min(1).max(1_000_000),
    status: z.enum(["active", "defeated", "fled", "removed"]),
  }).strict(),
  z.object({
    combatantId: resourceIdSchema,
    kind: z.literal("enemy"),
    team: combatTeamSchema,
    template: enemyTemplateCatalogReferenceSchema.nullable(),
    hitPoints: z.number().int().min(-1_000_000).max(1_000_000),
    maximumHitPoints: z.number().int().min(1).max(1_000_000),
    status: z.enum(["active", "defeated", "fled", "removed"]),
  }).strict(),
]);

export const combatLegalActionSchema = z.object({
  legalActionId: resourceIdSchema,
  kind: z.enum(["attack", "power", "item", "defend", "flee", "end-turn"]),
  targetIds: z.array(resourceIdSchema).max(128),
}).strict();

export const combatStateSchema = z.object({
  combatId: resourceIdSchema,
  round: z.number().int().min(1).max(1_000_000),
  currentCombatant: resourceIdSchema.nullable(),
  combatants: z.array(combatantStateSchema).min(1).max(128),
  legalActions: z.array(combatLegalActionSchema).max(128),
  revision: revisionSchema,
}).strict().superRefine((combat, context) => {
  const combatantIds = combat.combatants.map((combatant) => combatant.combatantId);
  if (new Set(combatantIds).size !== combatantIds.length) {
    context.addIssue({ code: "custom", message: "combatants must be unique", path: ["combatants"] });
  }
  if (combat.currentCombatant !== null && !combatantIds.includes(combat.currentCombatant)) {
    context.addIssue({ code: "custom", message: "current combatant must belong to combat", path: ["currentCombatant"] });
  }
  const legalActionIds = combat.legalActions.map((action) => action.legalActionId);
  if (new Set(legalActionIds).size !== legalActionIds.length) {
    context.addIssue({ code: "custom", message: "legal actions must be unique", path: ["legalActions"] });
  }
  if (combat.legalActions.some((action) => action.targetIds.some((targetId) => !combatantIds.includes(targetId)))) {
    context.addIssue({ code: "custom", message: "legal action targets must belong to combat", path: ["legalActions"] });
  }
});

export const encounterCommandReceiptPublicSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "an encounter command advances exactly one revision");

export const encounterStartCommandResponseSchema = z.object({
  combat: combatStateSchema,
  receipt: encounterCommandReceiptPublicSchema,
}).strict();

/** Combat identity is route-owned on reads and remains explicit in start responses. */
export const combatReadResponseSchema = z.object({
  round: z.number().int().min(1).max(1_000_000),
  currentCombatant: resourceIdSchema.nullable(),
  combatants: z.array(combatantStateSchema).min(1).max(128),
  legalActions: z.array(combatLegalActionSchema).max(128),
  revision: revisionSchema,
}).strict().superRefine((combat, context) => {
  const combatantIds = combat.combatants.map((combatant) => combatant.combatantId);
  if (new Set(combatantIds).size !== combatantIds.length) {
    context.addIssue({ code: "custom", message: "combatants must be unique", path: ["combatants"] });
  }
  if (combat.currentCombatant !== null && !combatantIds.includes(combat.currentCombatant)) {
    context.addIssue({ code: "custom", message: "current combatant must belong to combat", path: ["currentCombatant"] });
  }
  const legalActionIds = combat.legalActions.map((action) => action.legalActionId);
  if (new Set(legalActionIds).size !== legalActionIds.length) {
    context.addIssue({ code: "custom", message: "legal actions must be unique", path: ["legalActions"] });
  }
  if (combat.legalActions.some((action) => action.targetIds.some((targetId) => !combatantIds.includes(targetId)))) {
    context.addIssue({ code: "custom", message: "legal action targets must belong to combat", path: ["legalActions"] });
  }
});

export const combatLogQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).max(1_000_000),
  limit: z.coerce.number().int().min(1).max(100),
}).strict();

export const combatLogEntryPublicSchema = z.object({
  logEntryId: resourceIdSchema,
  sequence: z.number().int().min(1).max(1_000_000),
  occurredAt: utcIsoTimestampSchema,
  event: combatLogEventSchema,
}).strict();

export const combatLogResponseSchema = z.object({
  entries: z.array(combatLogEntryPublicSchema).max(100),
  nextAfterSequence: z.number().int().min(1).max(1_000_000).nullable(),
}).strict().superRefine((response, context) => {
  if (response.entries.some((entry, index) => index > 0
      && entry.sequence <= response.entries[index - 1]!.sequence)) {
    context.addIssue({ code: "custom", message: "combat log entries must be ordered by sequence", path: ["entries"] });
  }
  if (response.nextAfterSequence !== null
      && response.nextAfterSequence !== response.entries.at(-1)?.sequence) {
    context.addIssue({ code: "custom", message: "next sequence must match the final entry", path: ["nextAfterSequence"] });
  }
});

/** The starter combat vocabulary currently has no caller-selected action choices. */
export const combatActionCommandRequestSchema = z.object({
  legalActionId: resourceIdSchema,
  targetIds: z.array(resourceIdSchema).max(1),
  choices: z.tuple([]),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const combatActionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("damage"),
    targetId: resourceIdSchema,
    damageType: z.literal("physical"),
    requested: z.literal(1),
    applied: z.number().int().min(0).max(1),
    hitPointsBefore: z.number().int().min(0).max(1_000_000),
    hitPointsAfter: z.number().int().min(0).max(1_000_000),
    statusBefore: z.literal("active"),
    statusAfter: z.enum(["active", "defeated"]),
  }).strict(),
  z.object({
    kind: z.literal("status"),
    targetId: resourceIdSchema,
    statusBefore: z.literal("active"),
    statusAfter: z.literal("fled"),
  }).strict(),
]);

export const combatActionResolutionSchema = z.object({
  actionId: resourceIdSchema,
  legalActionId: resourceIdSchema,
  kind: z.enum(["attack", "flee", "end-turn"]),
  actingCombatantId: resourceIdSchema,
  targetIds: z.array(resourceIdSchema).max(1),
  outcomes: z.array(combatActionOutcomeSchema).max(1),
  roundBefore: z.number().int().min(1).max(1_000_000),
  roundAfter: z.number().int().min(1).max(1_000_000),
  currentCombatantBefore: resourceIdSchema,
  currentCombatantAfter: resourceIdSchema.nullable(),
}).strict().superRefine((resolution, context) => {
  if (resolution.kind === "attack") {
    const outcome = resolution.outcomes[0];
    if (resolution.targetIds.length !== 1 || outcome?.kind !== "damage"
        || outcome.targetId !== resolution.targetIds[0]
        || outcome.applied !== outcome.hitPointsBefore - outcome.hitPointsAfter) {
      context.addIssue({ code: "custom", message: "attack resolution must contain one exact damage outcome" });
    }
  } else if (resolution.kind === "flee") {
    const outcome = resolution.outcomes[0];
    if (resolution.targetIds.length !== 0 || outcome?.kind !== "status"
        || outcome.targetId !== resolution.actingCombatantId) {
      context.addIssue({ code: "custom", message: "flee resolution must contain the acting combatant status outcome" });
    }
  } else if (resolution.targetIds.length !== 0 || resolution.outcomes.length !== 0) {
    context.addIssue({ code: "custom", message: "end turn cannot contain targets or outcomes" });
  }
});

export const combatActionCommandResponseSchema = z.object({
  resolution: combatActionResolutionSchema,
  combat: combatStateSchema,
  receipt: encounterCommandReceiptPublicSchema,
}).strict().refine((response) => response.combat.revision === response.receipt.revisionAfter,
  { message: "combat revision must match the command receipt", path: ["combat", "revision"] });

export const combatEndCommandRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const combatRewardGrantPublicSchema = z.object({
  rewardBundleId: rewardBundleIdSchema,
  recipientActorId: actorIdSchema,
  createdAt: utcIsoTimestampSchema,
  rewards: z.array(encounterRewardSchema).min(1).max(128),
}).strict();

export const combatEndCommandResponseSchema = z.object({
  encounter: encounterPublicSchema,
  rewards: z.array(combatRewardGrantPublicSchema).max(32),
  receipt: encounterCommandReceiptPublicSchema,
}).strict().superRefine((response, context) => {
  if (response.encounter.status !== "completed") {
    context.addIssue({ code: "custom", message: "ended combat must be completed", path: ["encounter", "status"] });
  }
  if (response.encounter.revision !== response.receipt.revisionAfter) {
    context.addIssue({ code: "custom", message: "encounter revision must match the command receipt", path: ["encounter", "revision"] });
  }
  const bundles=response.rewards.map((reward)=>reward.rewardBundleId);
  const recipients=response.rewards.map((reward)=>reward.recipientActorId);
  if(new Set(bundles).size!==bundles.length||new Set(recipients).size!==recipients.length){
    context.addIssue({code:"custom",message:"reward bundles and recipients must be unique",path:["rewards"]});
  }
});

/** Immutable receipt lookup result. This endpoint never executes a command. */
export const combatCommandResultResponseSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("action"), result: combatActionCommandResponseSchema }).strict(),
  z.object({ operation: z.literal("end"), result: combatEndCommandResponseSchema }).strict(),
]);

export type EncounterCreateRequest = z.infer<typeof encounterCreateRequestSchema>;
export type EncounterCombatantPublic = z.infer<typeof encounterCombatantPublicSchema>;
export type EncounterPublic = z.infer<typeof encounterPublicSchema>;
export type CombatantState = z.infer<typeof combatantStateSchema>;
export type CombatLegalAction = z.infer<typeof combatLegalActionSchema>;
export type CombatState = z.infer<typeof combatStateSchema>;
export type EncounterStartCommandRequest = z.infer<typeof encounterStartCommandRequestSchema>;
export type CombatReadResponse = z.infer<typeof combatReadResponseSchema>;
export type CombatLogQuery = z.infer<typeof combatLogQuerySchema>;
export type CombatLogEntryPublic = z.infer<typeof combatLogEntryPublicSchema>;
export type CombatLogResponse = z.infer<typeof combatLogResponseSchema>;
export type CombatActionCommandRequest = z.infer<typeof combatActionCommandRequestSchema>;
export type CombatActionResolution = z.infer<typeof combatActionResolutionSchema>;
export type CombatActionCommandResponse = z.infer<typeof combatActionCommandResponseSchema>;
export type CombatEndCommandRequest = z.infer<typeof combatEndCommandRequestSchema>;
export type CombatRewardGrantPublic = z.infer<typeof combatRewardGrantPublicSchema>;
export type CombatEndCommandResponse = z.infer<typeof combatEndCommandResponseSchema>;
export type CombatCommandResultResponse = z.infer<typeof combatCommandResultResponseSchema>;
