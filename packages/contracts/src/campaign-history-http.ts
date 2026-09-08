import { z } from "zod";
import {
  campaignAdministrationEventSchema,
  campaignAdministrationEventTypeSchema,
  campaignCheckpointSchema,
  campaignRecapSchema,
  campaignTimelineHistorySchema,
  createCampaignCheckpointInputSchema,
  createCampaignRecapInputSchema,
  forkCampaignTimelineInputSchema,
} from "./campaign-administration.js";
import { resourceIdSchema } from "./domain-primitives.js";
import { adventureCombatPowerPublicReceiptSchema } from "./adventure-power-rest.js";
import { adventureProgressionPublicReceiptSchema, adventureQuestLifecyclePublicReceiptSchema } from "./adventure-quest-progression.js";
import {
  actorAttributeSetEventSchema,
  actorDiceRolledEventSchema,
  actorResourceInitializedEventSchema,
  revisionSchema,
} from "./rpg-commands.js";
import { diceRollResultSchema } from "./rpg-dice.js";

const MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE = 100;

/** HTTP history projections omit the campaign ID owned by the route. */
export const campaignHistoryHttpTimelineSchema = campaignTimelineHistorySchema.omit({ campaignId: true });
export const campaignHistoryHttpTimelinesResponseSchema = z.object({
  activeTimelineId: resourceIdSchema,
  timelines: z.array(campaignHistoryHttpTimelineSchema).max(1_000),
}).strict();

export const campaignHistoryHttpEventSchema = z.discriminatedUnion("type", [
  actorAttributeSetEventSchema.omit({ campaignId: true }),
  actorResourceInitializedEventSchema.omit({ campaignId: true }),
  actorDiceRolledEventSchema.omit({ campaignId: true }),
]);
export const campaignHistoryHttpEventsQuerySchema = z.object({
  timelineId: resourceIdSchema,
  afterRevision: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE),
}).strict();
export const campaignHistoryHttpEventsResponseSchema = z.object({
  events: z.array(campaignHistoryHttpEventSchema).max(MAX_CAMPAIGN_HISTORY_EVENTS_PAGE_SIZE),
  nextAfterRevision: revisionSchema.nullable(),
}).strict();

/** Receipts publish command results without repeating the route-owned campaign ID. */
export const campaignHistoryHttpAdministrationEventSchema = campaignAdministrationEventSchema.omit({ campaignId: true });
export const campaignHistoryHttpCommandReceiptSchema = z.object({
  commandId: resourceIdSchema,
  type: campaignAdministrationEventTypeSchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  events: z.tuple([campaignHistoryHttpAdministrationEventSchema]),
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({ code: "custom", message: "revisionAfter must equal revisionBefore plus one", path: ["revisionAfter"] });
  }

  const [event] = receipt.events;
  if (event.revision !== receipt.revisionAfter) {
    context.addIssue({ code: "custom", message: "event revision must match revisionAfter", path: ["events", 0, "revision"] });
  }
  if (event.commandId !== receipt.commandId) {
    context.addIssue({ code: "custom", message: "event commandId must match receipt", path: ["events", 0, "commandId"] });
  }
});

/**
 * A receipt opened from the history log. Unlike mutation receipts, this
 * projection contains no command/event/campaign/actor/source-turn identities
 * and no generic administration payload. Only reviewed mechanic result data
 * or administration metadata crosses the read boundary.
 */
export const campaignHistoryHttpPublicMechanicEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("actor_attribute_set"), data: z.object({ valueBefore: z.number().int().min(-1_000).max(1_000), valueAfter: z.number().int().min(-1_000).max(1_000) }).strict() }).strict(),
  z.object({ type: z.literal("actor_resource_initialized"), data: z.object({ current: z.number().int().min(0), max: z.number().int().min(0) }).strict() }).strict(),
  actorDiceRolledEventSchema.pick({ type: true, data: true }),
]);
export const campaignHistoryHttpPublicReceiptSchema = z.discriminatedUnion("kind", [
  adventureQuestLifecyclePublicReceiptSchema.extend({kind:z.literal("quest-lifecycle")}).strict(),
  adventureProgressionPublicReceiptSchema.extend({kind:z.literal("progression")}).strict(),
  adventureCombatPowerPublicReceiptSchema.extend({kind:z.literal("combat-power")}).strict(),
  z.object({kind:z.literal("combat-consumable"),itemName:z.string().trim().min(1).max(200),target:z.string().trim().min(1).max(200),
    quantity:z.literal(1),actionCost:z.literal("action"),outcomes:z.array(z.discriminatedUnion("kind",[
      z.object({kind:z.literal("damage"),damageType:z.string().trim().min(1).max(64),roll:diceRollResultSchema,requested:z.number().int().min(0),adjustment:z.enum(["none","resistance","vulnerability","immunity"]),applied:z.number().int().min(0),before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
      z.object({kind:z.literal("healing"),roll:diceRollResultSchema,requested:z.number().int().min(0),applied:z.number().int().min(0),before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
      z.object({kind:z.literal("resource"),resource:z.enum(["Health","Guard","Focus"]),requested:z.number().int(),applied:z.number().int(),before:z.number().int().min(0).nullable(),after:z.number().int().min(0).nullable()}).strict(),
    ])).min(1).max(16),roundBefore:revisionSchema,roundAfter:revisionSchema,revisionBefore:revisionSchema,revisionAfter:revisionSchema,
    occurredAt:z.string().datetime({offset:false,precision:3})}).strict().refine(value=>value.revisionAfter===value.revisionBefore+1,"combat consumable receipt must advance once"),
  z.object({kind:z.literal("commerce"),action:z.enum(["buy","sell","give"]),vendorLabel:z.string().trim().min(1).max(200),shopLabel:z.string().trim().min(1).max(200),itemLabel:z.string().trim().min(1).max(200),quantity:z.number().int().min(1).max(1_000_000),currencyLabel:z.string().trim().min(1).max(200),priceMinorUnits:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),debitMinorUnits:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),creditMinorUnits:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),balanceBefore:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),balanceAfter:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),revisionBefore:revisionSchema,revisionAfter:revisionSchema,occurredAt:z.string().datetime({offset:false,precision:3})}).strict().refine(value=>value.revisionAfter===value.revisionBefore+1,"commerce receipt revision must advance once"),
  z.object({kind:z.literal("power"),powerName:z.string().trim().min(1).max(200),targets:z.array(z.string().trim().min(1).max(200)).min(1).max(32),
    costs:z.array(z.object({label:z.string().trim().min(1).max(200),before:z.number().int().min(0),after:z.number().int().min(0)}).strict()).max(1),
    stateDeltas:z.array(z.object({actor:z.string().trim().min(1).max(200),change:z.string().trim().min(1).max(200),before:z.number().int().min(0).nullable(),after:z.number().int().min(0).nullable()}).strict()).max(512),
    concentration:z.boolean(),revisionBefore:revisionSchema,revisionAfter:revisionSchema,occurredAt:z.string().datetime({offset:false,precision:3})}).strict()
    .refine(value=>value.revisionAfter===value.revisionBefore+1,"power receipt revision must advance once"),
  z.object({kind:z.literal("rest"),restKind:z.enum(["short","long"]),restName:z.enum(["Short rest","Long rest"]),
    recovery:z.array(z.object({label:z.string().trim().min(1).max(200),before:z.number().int().min(0),after:z.number().int().min(0)}).strict()).min(1).max(128),
    revisionBefore:revisionSchema,revisionAfter:revisionSchema,occurredAt:z.string().datetime({offset:false,precision:3})}).strict()
    .refine(value=>value.restName===(value.restKind==="short"?"Short rest":"Long rest")&&value.revisionAfter===value.revisionBefore+1,"rest receipt must be exact"),
  z.object({
    kind: z.literal("inventory"),
    itemLabel: z.string().trim().min(1).max(200),
    action: z.enum(["equip", "unequip", "drop", "gift", "consume"]),
    quantity: z.number().int().min(1).max(1_000_000),
    slot: z.enum(["hand", "body", "focus", "accessory"]).nullable(),
    recipient: z.string().trim().min(1).max(200).nullable(),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "inventory receipt revision must advance once"),
  z.object({
    kind: z.literal("check"),
    checkKind: z.enum(["ability", "skill"]),
    ability: z.enum(["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"]),
    skill: z.string().trim().min(1).max(64).nullable(),
    mode: z.enum(["normal", "advantage", "disadvantage"]),
    difficulty: z.enum(["Very Easy", "Easy", "Medium", "Hard", "Very Hard", "Nearly Impossible"]),
    rolls: z.array(z.object({ value: z.number().int().min(1).max(20), kept: z.boolean() }).strict()).min(1).max(2),
    abilityModifier: z.number().int().min(-10).max(10),
    proficiencyBonus: z.number().int().min(0).max(6),
    modifier: z.number().int().min(-10).max(16),
    total: z.number().int().min(-9).max(36),
    dc: z.number().int().min(5).max(30),
    outcome: z.enum(["success", "failure"]),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().superRefine((value, context) => {
    if ((value.checkKind === "ability") !== (value.skill === null)) context.addIssue({ code: "custom", path: ["skill"], message: "skill must match check kind" });
    if (value.rolls.filter((roll) => roll.kept).length !== 1) context.addIssue({ code: "custom", path: ["rolls"], message: "exactly one roll must be kept" });
    if ((value.mode === "normal" ? 1 : 2) !== value.rolls.length) context.addIssue({ code: "custom", path: ["rolls"], message: "roll count must match mode" });
    if (value.modifier !== value.abilityModifier + value.proficiencyBonus) context.addIssue({ code: "custom", path: ["modifier"], message: "modifier must match its sources" });
    const kept = value.rolls.find((roll) => roll.kept)?.value;
    if (kept === undefined || value.total !== kept + value.modifier) context.addIssue({ code: "custom", path: ["total"], message: "total must match kept roll and modifier" });
    if ((value.outcome === "success") !== (value.total >= value.dc)) context.addIssue({ code: "custom", path: ["outcome"], message: "outcome must match total and DC" });
    if (value.revisionAfter !== value.revisionBefore + 1) context.addIssue({ code: "custom", path: ["revisionAfter"], message: "receipt revision must advance once" });
  }),
  z.object({
    kind: z.literal("mechanic"),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
    event: campaignHistoryHttpPublicMechanicEventSchema,
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "receipt revision must advance once"),
  z.object({
    kind: z.literal("administration"),
    type: campaignAdministrationEventTypeSchema,
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "receipt revision must advance once"),
  z.object({kind:z.literal("combat"),revisionBefore:revisionSchema,revisionAfter:revisionSchema,
    occurredAt:z.string().datetime({offset:false,precision:3}),action:z.enum(["attack","flee","end-turn"]),
    outcome:z.discriminatedUnion("kind",[
      z.object({kind:z.literal("damage"),damageType:z.enum(["physical","bludgeoning","piercing","slashing"]),requested:z.number().int().min(0).max(1_000_000),applied:z.number().int().min(0).max(1_000_000),
        hitPointsBefore:z.number().int().min(0).max(1_000_000),hitPointsAfter:z.number().int().min(0).max(1_000_000),statusAfter:z.enum(["active","defeated"])}).strict(),
      z.object({kind:z.literal("status"),statusAfter:z.literal("fled")}).strict(),
      z.object({kind:z.literal("none")}).strict(),
    ]),roundBefore:revisionSchema,roundAfter:revisionSchema}).strict()
    .refine((value)=>value.revisionAfter===value.revisionBefore+1,"receipt revision must advance once"),
  z.object({
    kind: z.literal("travel"),
    destination: z.string().trim().min(1).max(200),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
    "receipt revision must advance once"),
  z.object({
    kind: z.literal("quest"),
    title: z.string().trim().min(1).max(200),
    objectiveDescription: z.string().trim().min(1).max(2_000),
    progressBefore: z.number().int().min(0).max(1_000_000),
    progressAfter: z.number().int().min(0).max(1_000_000),
    target: z.number().int().min(1).max(1_000_000),
    objectiveCompleted: z.boolean(),
    questCompleted: z.boolean(),
    revisionBefore: revisionSchema,
    revisionAfter: revisionSchema,
    occurredAt: z.string().datetime({ offset: false, precision: 3 }),
  }).strict().superRefine((value, context) => {
    if (value.progressAfter !== value.progressBefore + 1) {
      context.addIssue({ code: "custom", message: "quest progress must advance once", path: ["progressAfter"] });
    }
    if (value.progressAfter > value.target) {
      context.addIssue({ code: "custom", message: "quest progress cannot exceed target", path: ["progressAfter"] });
    }
    if (value.objectiveCompleted !== (value.progressAfter === value.target)) {
      context.addIssue({ code: "custom", message: "objective completion must match progress", path: ["objectiveCompleted"] });
    }
    if (value.questCompleted && !value.objectiveCompleted) {
      context.addIssue({ code: "custom", message: "a completed quest requires a completed objective", path: ["questCompleted"] });
    }
    if (value.revisionAfter !== value.revisionBefore + 1) {
      context.addIssue({ code: "custom", message: "receipt revision must advance once", path: ["revisionAfter"] });
    }
  }),
]);
export const campaignHistoryHttpPublicReceiptResponseSchema = z.object({
  receipt: campaignHistoryHttpPublicReceiptSchema,
}).strict();

export const campaignHistoryHttpCheckpointSchema = campaignCheckpointSchema.omit({ campaignId: true });
export const campaignHistoryHttpCheckpointRequestSchema = createCampaignCheckpointInputSchema;
export const campaignHistoryHttpCheckpointResponseSchema = z.object({
  checkpoint: campaignHistoryHttpCheckpointSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export const campaignHistoryHttpForkRequestSchema = forkCampaignTimelineInputSchema;
export const campaignHistoryHttpForkResponseSchema = z.object({
  timeline: campaignHistoryHttpTimelineSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export const campaignHistoryHttpRecapSchema = campaignRecapSchema.omit({ campaignId: true });
export const campaignHistoryHttpRecapRequestSchema = createCampaignRecapInputSchema;
export const campaignHistoryHttpRecapResponseSchema = z.object({
  recap: campaignHistoryHttpRecapSchema,
  receipt: campaignHistoryHttpCommandReceiptSchema,
}).strict();

export type CampaignHistoryHttpTimeline = z.infer<typeof campaignHistoryHttpTimelineSchema>;
export type CampaignHistoryHttpTimelinesResponse = z.infer<typeof campaignHistoryHttpTimelinesResponseSchema>;
export type CampaignHistoryHttpEvent = z.infer<typeof campaignHistoryHttpEventSchema>;
export type CampaignHistoryHttpEventsQuery = z.infer<typeof campaignHistoryHttpEventsQuerySchema>;
export type CampaignHistoryHttpEventsResponse = z.infer<typeof campaignHistoryHttpEventsResponseSchema>;
export type CampaignHistoryHttpAdministrationEvent = z.infer<typeof campaignHistoryHttpAdministrationEventSchema>;
export type CampaignHistoryHttpCommandReceipt = z.infer<typeof campaignHistoryHttpCommandReceiptSchema>;
export type CampaignHistoryHttpPublicReceipt = z.infer<typeof campaignHistoryHttpPublicReceiptSchema>;
export type CampaignHistoryHttpPublicReceiptResponse = z.infer<typeof campaignHistoryHttpPublicReceiptResponseSchema>;
export type CampaignHistoryHttpCheckpoint = z.infer<typeof campaignHistoryHttpCheckpointSchema>;
export type CampaignHistoryHttpCheckpointRequest = z.infer<typeof campaignHistoryHttpCheckpointRequestSchema>;
export type CampaignHistoryHttpCheckpointResponse = z.infer<typeof campaignHistoryHttpCheckpointResponseSchema>;
export type CampaignHistoryHttpForkRequest = z.infer<typeof campaignHistoryHttpForkRequestSchema>;
export type CampaignHistoryHttpForkResponse = z.infer<typeof campaignHistoryHttpForkResponseSchema>;
export type CampaignHistoryHttpRecap = z.infer<typeof campaignHistoryHttpRecapSchema>;
export type CampaignHistoryHttpRecapRequest = z.infer<typeof campaignHistoryHttpRecapRequestSchema>;
export type CampaignHistoryHttpRecapResponse = z.infer<typeof campaignHistoryHttpRecapResponseSchema>;
