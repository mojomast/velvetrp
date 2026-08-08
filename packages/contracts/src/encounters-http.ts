import { z } from "zod";
import { enemyTemplateCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { combatTeamSchema, encounterStatusSchema } from "./encounters.js";
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

export type EncounterCreateRequest = z.infer<typeof encounterCreateRequestSchema>;
export type EncounterCombatantPublic = z.infer<typeof encounterCombatantPublicSchema>;
export type EncounterPublic = z.infer<typeof encounterPublicSchema>;
export type CombatantState = z.infer<typeof combatantStateSchema>;
export type CombatLegalAction = z.infer<typeof combatLegalActionSchema>;
export type CombatState = z.infer<typeof combatStateSchema>;
export type EncounterStartCommandRequest = z.infer<typeof encounterStartCommandRequestSchema>;
