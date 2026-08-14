import { z } from "zod";
import {
  damageTypeSchema,
  enemyTemplateCatalogReferenceSchema,
  itemCatalogDefinitionSchema,
  itemCatalogReferenceSchema,
} from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  combatLogEventSchema,
  combatTeamSchema,
  encounterRewardSchema,
  encounterStatusSchema,
  rewardBundleIdSchema,
  rewardClaimIdSchema,
} from "./encounters.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema } from "./rpg-characters.js";
import { diceRollResultSchema } from "./rpg-dice.js";
import { inventoryEntryIdSchema } from "./inventory.js";

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
  narration: z.string().trim().min(1).max(1_000),
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
  claim: z.discriminatedUnion("state", [
    z.object({ state: z.literal("unclaimed") }).strict(),
    z.object({ state: z.literal("claimed"), rewardClaimId: rewardClaimIdSchema, claimedAt: utcIsoTimestampSchema }).strict(),
  ]),
}).strict();

export const combatRewardListResponseSchema = z.object({ rewards: z.array(combatRewardGrantPublicSchema).max(32) }).strict();
export const combatRewardClaimRequestSchema = z.object({
  rewardClaimId: rewardClaimIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const combatRewardClaimResponseSchema = z.object({
  reward: combatRewardGrantPublicSchema.refine((reward) => reward.claim.state === "claimed", "claimed reward is required"),
  receipt: encounterCommandReceiptPublicSchema,
}).strict();

const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const combatRewardClaimResultResponseSchema = z.object({
  reward: combatRewardGrantPublicSchema.refine((reward) => reward.claim.state === "claimed", "claimed reward is required"),
  requestBinding: z.object({
    campaignId: resourceIdSchema,
    combatId: resourceIdSchema,
    rewardBundleId: rewardBundleIdSchema,
    recipientActorId: actorIdSchema,
    claimedAt: utcIsoTimestampSchema,
    requestEvidence: combatRewardClaimRequestSchema,
    canonicalRequestDigest: sha256DigestSchema,
  }).strict(),
  receipt: encounterCommandReceiptPublicSchema,
}).strict().superRefine((response, context) => {
  const binding=response.requestBinding,claim=response.reward.claim;
  if(response.reward.rewardBundleId!==binding.rewardBundleId||response.reward.recipientActorId!==binding.recipientActorId
      ||claim.state!=="claimed"||claim.rewardClaimId!==binding.requestEvidence.rewardClaimId||claim.claimedAt!==binding.claimedAt
      ||response.receipt.idempotencyKey!==binding.requestEvidence.idempotencyKey
      ||response.receipt.revisionBefore!==binding.requestEvidence.expectedRevision
      ||response.receipt.revisionAfter!==binding.requestEvidence.expectedRevision+1){
    context.addIssue({code:"custom",message:"claim result must match its exact request and receipt"});
  }
});

/** Reconstructs the exact persisted claim command without exposing its raw command record. */
export function canonicalCombatRewardClaimRequestFrame(input:{campaignId:string;combatId:string;rewardBundleId:string;
  recipientActorId:string;claimedAt:string;request:CombatRewardClaimRequest}):string{
  const request=combatRewardClaimRequestSchema.parse(input.request);
  return JSON.stringify({campaignId:resourceIdSchema.parse(input.campaignId),claimedAt:utcIsoTimestampSchema.parse(input.claimedAt),
    encounterId:resourceIdSchema.parse(input.combatId),expectedRevision:request.expectedRevision,idempotencyKey:request.idempotencyKey,
    recipientActorId:actorIdSchema.parse(input.recipientActorId),rewardBundleId:rewardBundleIdSchema.parse(input.rewardBundleId),
    rewardClaimId:request.rewardClaimId,type:"claim_reward_bundle"});
}

export function verifyCombatRewardClaimResultBinding(expected:{campaignId:string;combatId:string;rewardBundleId:string;
  recipientActorId:string;request:CombatRewardClaimRequest},result:CombatRewardClaimResultResponse,sha256:(value:string)=>string):boolean{
  try{
    const parsed=combatRewardClaimResultResponseSchema.parse(result),binding=parsed.requestBinding;
    if(binding.campaignId!==expected.campaignId||binding.combatId!==expected.combatId||binding.rewardBundleId!==expected.rewardBundleId
        ||binding.recipientActorId!==expected.recipientActorId||JSON.stringify(binding.requestEvidence)!==JSON.stringify(combatRewardClaimRequestSchema.parse(expected.request)))return false;
    return sha256(canonicalCombatRewardClaimRequestFrame({...expected,claimedAt:binding.claimedAt}))===binding.canonicalRequestDigest;
  }catch{return false;}
}

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

/** M5.3 prerequisite only. This action is not part of the live combat action or route unions. */
export const USE_CONSUMABLE_ACTION_COST = "action" as const;
export const useConsumableTargetPolicySchema = z.enum([
  "damage-only-enemy",
  "beneficial-only-self-or-ally",
  "single-target",
]);
export const useConsumableEligibilityReasonSchema = z.enum([
  "not-consumable",
  "no-effects",
  "unsupported-effect",
  "spell-slot-level-identity-unavailable",
  "instant-modifier-semantics-unavailable",
  "noninstant-modifier",
]);
export const useConsumableEligibilitySchema = z.discriminatedUnion("eligible", [
  z.object({ eligible: z.literal(true), targetPolicy: useConsumableTargetPolicySchema }).strict(),
  z.object({
    eligible: z.literal(false),
    reasons: z.array(useConsumableEligibilityReasonSchema)
      .min(1).max(useConsumableEligibilityReasonSchema.options.length)
      .superRefine((reasons, context) => {
        if (new Set(reasons).size !== reasons.length) {
          context.addIssue({ code: "custom", message: "eligibility reasons must be unique" });
        }
      }),
  }).strict(),
]);

export type UseConsumableCatalogItem = z.infer<typeof itemCatalogDefinitionSchema>;
export type UseConsumableEligibility = z.infer<typeof useConsumableEligibilitySchema>;

/** Pure catalog policy. Runtime must additionally verify ownership, quantity, turn, target, and revisions. */
export const evaluateUseConsumableEligibility = (item: UseConsumableCatalogItem): UseConsumableEligibility => {
  const reasons = new Set<z.infer<typeof useConsumableEligibilityReasonSchema>>();
  if (item.mechanics.category !== "consumable") reasons.add("not-consumable");
  if (item.mechanics.effects.length === 0) reasons.add("no-effects");

  const polarities = new Set<"hostile" | "beneficial">();
  let hasNeutralEffect = false;
  for (const effect of item.mechanics.effects) {
    if (effect.type === "damage") {
      polarities.add("hostile");
    } else if (effect.type === "healing") {
      polarities.add("beneficial");
    } else if (effect.type === "resource") {
      // Item resource effects do not identify a spell-slot level, so they cannot be settled safely.
      if (effect.resource === "spell-slot") reasons.add("spell-slot-level-identity-unavailable");
      else if (effect.amount === 0) hasNeutralEffect = true;
      else polarities.add(effect.amount < 0 ? "hostile" : "beneficial");
    } else if (effect.type === "modifier") {
      reasons.add(effect.duration === "instant"
        ? "instant-modifier-semantics-unavailable"
        : "noninstant-modifier");
    } else {
      reasons.add("unsupported-effect");
    }
  }
  if (hasNeutralEffect && polarities.size === 0) polarities.add("beneficial");
  if (reasons.size > 0) return { eligible: false, reasons: [...reasons] };
  return {
    eligible: true,
    targetPolicy: polarities.size > 1
      ? "single-target"
      : polarities.has("hostile") ? "damage-only-enemy" : "beneficial-only-self-or-ally",
  };
};

export const useConsumableTargetSchema = z.object({
  combatantId: resourceIdSchema,
  relation: z.enum(["self", "ally", "enemy"]),
  /** Private actor identity is server-derived and never appears in this contract. */
  actorBacked: z.boolean(),
}).strict();

const useConsumableCatalogDiceSchema = z.object({
  count: z.number().int().min(1).max(20),
  sides: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12), z.literal(20)]),
  modifier: z.number().int().min(-100).max(100),
}).strict();
export const useConsumableEffectDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("damage"), damageType: damageTypeSchema, dice: useConsumableCatalogDiceSchema }).strict(),
  z.object({ kind: z.literal("healing"), dice: useConsumableCatalogDiceSchema.extend({ modifier: z.number().int().min(0).max(100) }).strict() }).strict(),
  z.object({ kind: z.literal("resource"), resource: z.enum(["health", "guard", "focus"]), amount: z.number().int().min(-1_000_000).max(1_000_000) }).strict(),
]);
export const useConsumablePlannedEffectSchema = z.object({
  effectOrdinal: z.number().int().min(0).max(15),
  effect: useConsumableEffectDescriptorSchema,
}).strict();
export const useConsumableEffectPlanSchema = z.object({
  effectCount: z.number().int().min(1).max(16),
  effects: z.array(useConsumablePlannedEffectSchema).min(1).max(16),
}).strict().superRefine((plan, context) => {
  if (plan.effectCount !== plan.effects.length
      || plan.effects.some((effect, index) => effect.effectOrdinal !== index)) {
    context.addIssue({ code: "custom", message: "effect plan must contain every ordinal exactly once in order", path: ["effects"] });
  }
});

const sameItemReference = (left: z.infer<typeof itemCatalogReferenceSchema>, right: z.infer<typeof itemCatalogReferenceSchema>) =>
  left.kind === right.kind && left.packId === right.packId
  && left.packVersion === right.packVersion && left.definitionId === right.definitionId;

/** Derives the only trusted plan from a parsed eligible item and its exact pinned reference. */
export const deriveUseConsumableEffectPlan = (
  itemInput: unknown,
  pinnedReference: z.infer<typeof itemCatalogReferenceSchema>,
): z.infer<typeof useConsumableEffectPlanSchema> | null => {
  const parsed = itemCatalogDefinitionSchema.safeParse(itemInput);
  if (!parsed.success || !sameItemReference(parsed.data.reference, pinnedReference)
      || !evaluateUseConsumableEligibility(parsed.data).eligible) return null;
  const effects = parsed.data.mechanics.effects.map((effect, effectOrdinal) => {
    if (effect.type === "damage") return { effectOrdinal, effect: { kind: "damage" as const, damageType: effect.damageType, dice: effect.dice } };
    if (effect.type === "healing") return { effectOrdinal, effect: { kind: "healing" as const, dice: effect.dice } };
    if (effect.type === "resource" && effect.resource !== "spell-slot") {
      return { effectOrdinal, effect: { kind: "resource" as const, resource: effect.resource, amount: effect.amount } };
    }
    return null;
  });
  if (effects.some((effect) => effect === null)) return null;
  return useConsumableEffectPlanSchema.parse({ effectCount: effects.length, effects });
};

export const verifyUseConsumableEffectPlan = (item: unknown, pinnedReference: unknown, plan: unknown): boolean => {
  try {
    const reference = itemCatalogReferenceSchema.parse(pinnedReference);
    const supplied = useConsumableEffectPlanSchema.parse(plan);
    const derived = deriveUseConsumableEffectPlan(item, reference);
    return derived !== null && JSON.stringify(supplied) === JSON.stringify(derived);
  } catch {
    return false;
  }
};

/** One server-authored legal action pins one possession, catalog definition, and combat target. */
export const useConsumableLegalActionSchema = z.object({
  legalActionId: resourceIdSchema,
  kind: z.literal("use-consumable"),
  actingCombatantId: resourceIdSchema,
  inventoryEntryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: z.literal(1),
  actionCost: z.literal(USE_CONSUMABLE_ACTION_COST),
  targetPolicy: useConsumableTargetPolicySchema,
  target: useConsumableTargetSchema,
  effectPlan: useConsumableEffectPlanSchema,
}).strict().superRefine((action, context) => {
  const validRelation = action.targetPolicy === "damage-only-enemy"
    ? action.target.relation === "enemy"
    : action.targetPolicy === "beneficial-only-self-or-ally"
      ? action.target.relation === "self" || action.target.relation === "ally"
      : true;
  if (!validRelation) {
    context.addIssue({ code: "custom", message: "target relation must satisfy the consumable target policy", path: ["target"] });
  }
  if ((action.target.relation === "self") !== (action.target.combatantId === action.actingCombatantId)) {
    context.addIssue({ code: "custom", message: "self relation must exactly match the acting combatant", path: ["target"] });
  }
});

/** Caller intent repeats fixed identity pins, but never supplies catalog mechanics or settlement values. */
export const useConsumableCommandRequestSchema = z.object({
  legalActionId: resourceIdSchema,
  inventoryEntryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: z.literal(1),
  targetCombatantId: resourceIdSchema,
  targetActorBacked: z.boolean(),
  expectedCombatRevision: expectedRevisionSchema,
  expectedActingM15Revision: expectedRevisionSchema,
  expectedTargetM15Revision: expectedRevisionSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
}).strict().refine((request) => request.targetActorBacked === (request.expectedTargetM15Revision !== null), {
  message: "actor-backed targets require an expected target M1.5 revision",
  path: ["expectedTargetM15Revision"],
});

const useConsumableAmountSchema = z.number().int().min(-1_000_000).max(1_000_000);
const useConsumableCountSchema = z.number().int().min(0).max(1_000_000);
const useConsumableEffectOrdinalSchema = z.number().int().min(0).max(15);
export const useConsumableSettlementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("combat-hp-damage"),
    effectOrdinal: useConsumableEffectOrdinalSchema,
    damageType: damageTypeSchema,
    roll: diceRollResultSchema,
    requested: useConsumableCountSchema,
    adjustment: z.enum(["none", "resistance", "vulnerability", "immunity"]),
    applied: useConsumableCountSchema,
    before: useConsumableCountSchema,
    after: useConsumableCountSchema,
  }).strict().superRefine((settlement, context) => {
    const adjusted = settlement.adjustment === "immunity" ? 0
      : settlement.adjustment === "resistance" ? Math.floor(settlement.requested / 2)
      : settlement.adjustment === "vulnerability" ? settlement.requested * 2
      : settlement.requested;
    if (settlement.requested !== Math.max(0, settlement.roll.total)
        || settlement.applied !== Math.min(settlement.before, adjusted)
        || settlement.after !== settlement.before - settlement.applied) {
      context.addIssue({ code: "custom", message: "damage must equal clipped exact adjusted roll evidence", path: ["applied"] });
    }
  }),
  z.object({
    kind: z.literal("combat-hp-healing"),
    effectOrdinal: useConsumableEffectOrdinalSchema,
    roll: diceRollResultSchema,
    requested: useConsumableCountSchema,
    applied: useConsumableCountSchema,
    before: useConsumableCountSchema,
    after: useConsumableCountSchema,
  }).strict().superRefine((settlement, context) => {
    if (settlement.requested !== Math.max(0, settlement.roll.total)
        || settlement.applied !== settlement.after - settlement.before
        || settlement.applied > settlement.requested) {
      context.addIssue({ code: "custom", message: "healing delta must be bounded by its roll evidence", path: ["applied"] });
    }
  }),
  z.object({
    kind: z.literal("combat-hp-resource"),
    effectOrdinal: useConsumableEffectOrdinalSchema,
    resource: z.literal("health"),
    requested: useConsumableAmountSchema,
    applied: useConsumableAmountSchema,
    before: useConsumableCountSchema,
    after: useConsumableCountSchema,
  }).strict().superRefine((settlement, context) => {
    if (settlement.applied !== settlement.after - settlement.before
        || Math.abs(settlement.applied) > Math.abs(settlement.requested)
        || (settlement.applied !== 0 && Math.sign(settlement.applied) !== Math.sign(settlement.requested))) {
      context.addIssue({ code: "custom", message: "resource delta must be a bounded part of the requested change", path: ["applied"] });
    }
  }),
  z.object({
    kind: z.literal("actor-resource-delta"),
    effectOrdinal: useConsumableEffectOrdinalSchema,
    resource: z.enum(["guard", "focus"]),
    requested: useConsumableAmountSchema,
    applied: useConsumableAmountSchema,
  }).strict().superRefine((settlement, context) => {
    if (Math.abs(settlement.applied) > Math.abs(settlement.requested)
        || (settlement.applied !== 0 && Math.sign(settlement.applied) !== Math.sign(settlement.requested))) {
      context.addIssue({ code: "custom", message: "actor resource delta must be bounded by the requested amount", path: ["applied"] });
    }
  }),
]);

export const useConsumableOutcomeSchema = z.object({
  targetCombatantId: resourceIdSchema,
  settlements: z.array(useConsumableSettlementSchema).min(1).max(16),
}).strict();

export const useConsumableM15RevisionDeltaSchema = z.object({
  before: revisionSchema,
  after: revisionSchema,
}).strict().refine((delta) => delta.after === delta.before + 1, "an M1.5 mutation advances exactly one revision");

export const useConsumableResolutionSchema = z.object({
  actionId: resourceIdSchema,
  legalActionId: resourceIdSchema,
  kind: z.literal("use-consumable"),
  actingCombatantId: resourceIdSchema,
  target: useConsumableTargetSchema,
  targetPolicy: useConsumableTargetPolicySchema,
  actionCost: z.literal(USE_CONSUMABLE_ACTION_COST),
  consumed: z.object({
    inventoryEntryId: inventoryEntryIdSchema,
    item: itemCatalogReferenceSchema,
    quantity: z.literal(1),
  }).strict(),
  effectPlan: useConsumableEffectPlanSchema,
  outcome: useConsumableOutcomeSchema,
  combatRevisionBefore: revisionSchema,
  combatRevisionAfter: revisionSchema,
  actingM15Revision: useConsumableM15RevisionDeltaSchema,
  targetM15Revision: useConsumableM15RevisionDeltaSchema.nullable(),
}).strict().superRefine((resolution, context) => {
  if (resolution.combatRevisionAfter !== resolution.combatRevisionBefore + 1) {
    context.addIssue({ code: "custom", message: "consumable use advances combat exactly one revision", path: ["combatRevisionAfter"] });
  }
  if (resolution.outcome.targetCombatantId !== resolution.target.combatantId) {
    context.addIssue({ code: "custom", message: "outcome must bind the exact target combatant", path: ["outcome", "targetCombatantId"] });
  }
  const validRelation = resolution.targetPolicy === "damage-only-enemy"
    ? resolution.target.relation === "enemy"
    : resolution.targetPolicy === "beneficial-only-self-or-ally"
      ? resolution.target.relation === "self" || resolution.target.relation === "ally"
      : true;
  if (!validRelation || ((resolution.target.relation === "self") !== (resolution.target.combatantId === resolution.actingCombatantId))) {
    context.addIssue({ code: "custom", message: "resolved target must satisfy the exact target policy", path: ["target"] });
  }
  const selfTarget = resolution.target.relation === "self";
  if ((selfTarget && resolution.targetM15Revision !== null)
      || (!selfTarget && resolution.target.actorBacked !== (resolution.targetM15Revision !== null))) {
    context.addIssue({ code: "custom", message: "distinct actor-backed targets require one target M1.5 revision; self uses the acting revision", path: ["targetM15Revision"] });
  }
  if (resolution.outcome.settlements.length !== resolution.effectPlan.effectCount
      || resolution.outcome.settlements.some((settlement, index) => settlement.effectOrdinal !== index)) {
    context.addIssue({ code: "custom", message: "settlements must bijectively follow the advertised effect plan", path: ["outcome", "settlements"] });
  }
  resolution.outcome.settlements.forEach((settlement, index) => {
    const descriptor = resolution.effectPlan.effects[index]?.effect;
    const rollMatches = (dice: { count: number; sides: number; modifier: number }, roll: z.infer<typeof diceRollResultSchema>) =>
      roll.normalized.count === dice.count && roll.normalized.sides === dice.sides
      && roll.normalized.modifier === dice.modifier && roll.normalized.selection.type === "all";
    const matches = descriptor?.kind === "damage" && settlement.kind === "combat-hp-damage"
      ? settlement.damageType === descriptor.damageType && rollMatches(descriptor.dice, settlement.roll)
      : descriptor?.kind === "healing" && settlement.kind === "combat-hp-healing"
        ? rollMatches(descriptor.dice, settlement.roll)
        : descriptor?.kind === "resource" && descriptor.resource === "health" && settlement.kind === "combat-hp-resource"
          ? settlement.resource === descriptor.resource && settlement.requested === descriptor.amount
            : descriptor?.kind === "resource" && descriptor.resource !== "health" && settlement.kind === "actor-resource-delta"
              ? settlement.resource === descriptor.resource && settlement.requested === descriptor.amount
              : false;
    if (!matches) context.addIssue({ code: "custom", message: "settlement must exactly match its catalog effect descriptor", path: ["outcome", "settlements", index] });
  });
  if (!resolution.target.actorBacked
      && resolution.outcome.settlements.some((settlement) => settlement.kind === "actor-resource-delta")) {
    context.addIssue({ code: "custom", message: "actor resources require an actor-backed target", path: ["outcome", "settlements"] });
  }
});

export const useConsumableCanonicalRequestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const USE_CONSUMABLE_REQUEST_FRAME_VERSION = "velvet.use-consumable-request.v1" as const;
export const canonicalUseConsumableRequestFrame = (requestInput: unknown): string => {
  const request = useConsumableCommandRequestSchema.parse(requestInput);
  return JSON.stringify({
    version: USE_CONSUMABLE_REQUEST_FRAME_VERSION,
    legalActionId: request.legalActionId,
    inventoryEntryId: request.inventoryEntryId,
    item: {
      kind: request.item.kind,
      packId: request.item.packId,
      packVersion: request.item.packVersion,
      definitionId: request.item.definitionId,
    },
    quantity: request.quantity,
    targetCombatantId: request.targetCombatantId,
    targetActorBacked: request.targetActorBacked,
    expectedCombatRevision: request.expectedCombatRevision,
    expectedActingM15Revision: request.expectedActingM15Revision,
    expectedTargetM15Revision: request.expectedTargetM15Revision,
    idempotencyKey: request.idempotencyKey,
  });
};
export type UseConsumableSha256 = (canonicalFrame: string) => string;
export const verifyUseConsumableRequestDigest = (
  request: unknown,
  digest: unknown,
  trustedSha256: UseConsumableSha256,
): boolean => {
  try {
    const expected = useConsumableCanonicalRequestDigestSchema.parse(digest);
    const actual = useConsumableCanonicalRequestDigestSchema.parse(trustedSha256(canonicalUseConsumableRequestFrame(request)));
    return actual === expected;
  } catch {
    return false;
  }
};
export const useConsumableCommandResultSchema = z.object({
  resolution: useConsumableResolutionSchema,
  requestBinding: z.object({
    requestEvidence: useConsumableCommandRequestSchema,
    canonicalRequestDigest: useConsumableCanonicalRequestDigestSchema,
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  receipt: encounterCommandReceiptPublicSchema,
}).strict().superRefine((result, context) => {
  if (result.receipt.revisionBefore !== result.resolution.combatRevisionBefore
      || result.receipt.revisionAfter !== result.resolution.combatRevisionAfter) {
    context.addIssue({ code: "custom", message: "receipt must bind the consumable combat revision", path: ["receipt"] });
  }
  if (result.requestBinding.idempotencyKey !== result.receipt.idempotencyKey) {
    context.addIssue({ code: "custom", message: "request binding and receipt idempotency keys must match", path: ["requestBinding", "idempotencyKey"] });
  }
  const request = result.requestBinding.requestEvidence;
  const resolution = result.resolution;
  if (request.idempotencyKey !== result.requestBinding.idempotencyKey) {
    context.addIssue({ code: "custom", message: "request evidence and binding idempotency keys must match", path: ["requestBinding", "requestEvidence", "idempotencyKey"] });
  }
  if (request.legalActionId !== resolution.legalActionId
      || request.inventoryEntryId !== resolution.consumed.inventoryEntryId
      || !sameItemReference(request.item, resolution.consumed.item)
      || request.quantity !== resolution.consumed.quantity
      || request.targetCombatantId !== resolution.target.combatantId
      || request.targetActorBacked !== resolution.target.actorBacked) {
    context.addIssue({ code: "custom", message: "resolution must bind every requested action identity", path: ["resolution"] });
  }
  if (request.expectedCombatRevision !== resolution.combatRevisionBefore
      || request.expectedActingM15Revision !== resolution.actingM15Revision.before) {
    context.addIssue({ code: "custom", message: "resolution must begin at the requested combat and acting M1.5 revisions", path: ["resolution"] });
  }
  if (resolution.target.relation === "self") {
    if (!resolution.target.actorBacked
        || request.expectedTargetM15Revision !== request.expectedActingM15Revision
        || resolution.targetM15Revision !== null) {
      context.addIssue({ code: "custom", message: "self target must alias the single acting M1.5 revision", path: ["resolution", "targetM15Revision"] });
    }
  } else if (request.expectedTargetM15Revision === null
      ? resolution.targetM15Revision !== null
      : resolution.targetM15Revision?.before !== request.expectedTargetM15Revision) {
    context.addIssue({ code: "custom", message: "target M1.5 evidence must begin at the requested target revision", path: ["resolution", "targetM15Revision"] });
  }
});

/** Trusted wrapper verification binds the exact canonical request, result digest, and receipt key. */
export const verifyUseConsumableCommandResultBinding = (
  requestInput: unknown,
  resultInput: unknown,
  trustedSha256: UseConsumableSha256,
): boolean => {
  try {
    const request = useConsumableCommandRequestSchema.parse(requestInput);
    const result = useConsumableCommandResultSchema.parse(resultInput);
    return JSON.stringify(request) === JSON.stringify(result.requestBinding.requestEvidence)
      && request.idempotencyKey === result.requestBinding.idempotencyKey
      && verifyUseConsumableRequestDigest(request, result.requestBinding.canonicalRequestDigest, trustedSha256);
  } catch {
    return false;
  }
};

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
export type CombatRewardClaimRequest = z.infer<typeof combatRewardClaimRequestSchema>;
export type CombatRewardClaimResponse = z.infer<typeof combatRewardClaimResponseSchema>;
export type CombatRewardClaimResultResponse = z.infer<typeof combatRewardClaimResultResponseSchema>;
export type CombatEndCommandResponse = z.infer<typeof combatEndCommandResponseSchema>;
export type CombatCommandResultResponse = z.infer<typeof combatCommandResultResponseSchema>;
export type UseConsumableTargetPolicy = z.infer<typeof useConsumableTargetPolicySchema>;
export type UseConsumableEffectDescriptor = z.infer<typeof useConsumableEffectDescriptorSchema>;
export type UseConsumableEffectPlan = z.infer<typeof useConsumableEffectPlanSchema>;
export type UseConsumableLegalAction = z.infer<typeof useConsumableLegalActionSchema>;
export type UseConsumableCommandRequest = z.infer<typeof useConsumableCommandRequestSchema>;
export type UseConsumableSettlement = z.infer<typeof useConsumableSettlementSchema>;
export type UseConsumableOutcome = z.infer<typeof useConsumableOutcomeSchema>;
export type UseConsumableResolution = z.infer<typeof useConsumableResolutionSchema>;
export type UseConsumableCommandResult = z.infer<typeof useConsumableCommandResultSchema>;
