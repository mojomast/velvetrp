import { z } from "zod";
import { canonicalSha256DigestSchema } from "./agent-execution.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";
import { damageTypeSchema } from "./content-catalog.js";
import { diceRollResultSchema } from "./rpg-dice.js";

const displayTextSchema = z.string().trim().min(1).max(200);
const deltaSchema = z.object({ label: displayTextSchema, before: z.number().int().min(0), after: z.number().int().min(0) }).strict();

export const adventurePowerCandidateSchema = z.object({
  candidateId: resourceIdSchema,
  digest: canonicalSha256DigestSchema,
  powerName: displayTextSchema,
  targets: z.array(displayTextSchema).min(1).max(32),
  costs: z.array(displayTextSchema).max(1),
  concentration: z.boolean(),
  effects: z.array(z.enum(["damage", "healing", "resource", "modifier", "condition"])).min(1).max(5),
  confirmationRequired: z.literal(true),
}).strict();

export const adventureRestCandidateSchema = z.object({
  candidateId: resourceIdSchema,
  digest: canonicalSha256DigestSchema,
  restKind: z.enum(["short", "long"]),
  restName: z.enum(["Short rest", "Long rest"]),
  recovery: z.array(deltaSchema).min(1).max(128),
  confirmationRequired: z.literal(true),
}).strict().refine((value) => value.restName === (value.restKind === "short" ? "Short rest" : "Long rest"), "rest name must match kind");

/** Providers select an opaque server-owned action and cannot supply mechanics. */
export const adventurePowerRestSelectionSchema = z.object({ candidateId: resourceIdSchema, digest: canonicalSha256DigestSchema }).strict();

const combatConsumableConsequenceSchema=z.object({kind:z.enum(["damage","healing","resource"]),
  label:displayTextSchema}).strict();
export const adventureCombatConsumableCandidateSchema=z.object({candidateId:resourceIdSchema,digest:canonicalSha256DigestSchema,
  itemName:displayTextSchema,target:displayTextSchema,quantity:z.literal(1),actionCost:z.literal("action"),
  consequences:z.array(combatConsumableConsequenceSchema).min(1).max(16),confirmationRequired:z.literal(true)}).strict();

const combatPowerConsequenceSchema=z.object({kind:z.enum(["damage","healing","effect"]),label:displayTextSchema}).strict();
export const adventureCombatPowerCandidateSchema=z.object({candidateId:resourceIdSchema,digest:canonicalSha256DigestSchema,
  powerName:displayTextSchema,target:displayTextSchema,actionCost:z.enum(["action","bonus-action"]),costs:z.array(displayTextSchema).max(1),
  consequences:z.array(combatPowerConsequenceSchema).min(1).max(16),concentration:z.boolean(),confirmationRequired:z.literal(true)}).strict();

const combatConsumableOutcomeSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("damage"),damageType:damageTypeSchema,roll:diceRollResultSchema,requested:z.number().int().min(0),
    adjustment:z.enum(["none","resistance","vulnerability","immunity"]),applied:z.number().int().min(0),
    before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
  z.object({kind:z.literal("healing"),roll:diceRollResultSchema,requested:z.number().int().min(0),applied:z.number().int().min(0),
    before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
  z.object({kind:z.literal("resource"),resource:z.enum(["Health","Guard","Focus"]),requested:z.number().int(),applied:z.number().int(),
    before:z.number().int().min(0).nullable(),after:z.number().int().min(0).nullable()}).strict(),
]);
export const adventureCombatConsumablePublicReceiptSchema=z.object({itemName:displayTextSchema,target:displayTextSchema,
  quantity:z.literal(1),actionCost:z.literal("action"),outcomes:z.array(combatConsumableOutcomeSchema).min(1).max(16),
  roundBefore:revisionSchema,roundAfter:revisionSchema,revisionBefore:revisionSchema,revisionAfter:revisionSchema,
  occurredAt:utcIsoTimestampSchema}).strict().refine(value=>value.revisionAfter===value.revisionBefore+1,
    "combat consumable receipt revision must advance once");

const combatPowerOutcomeSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("damage"),damageType:damageTypeSchema,roll:diceRollResultSchema,requested:z.number().int().min(0),
    adjustment:z.enum(["none","resistance","vulnerability","immunity"]),applied:z.number().int().min(0),
    before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
  z.object({kind:z.literal("healing"),roll:diceRollResultSchema,requested:z.number().int().min(0),applied:z.number().int().min(0),
    before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
  z.object({kind:z.literal("temporary-hit-points"),roll:diceRollResultSchema,requested:z.number().int().min(0),granted:z.number().int().min(0),
    before:z.number().int().min(0),after:z.number().int().min(0)}).strict(),
  z.object({kind:z.literal("effect"),effect:displayTextSchema,replacedConcentration:z.boolean()}).strict(),
]);
export const adventureCombatPowerPublicReceiptSchema=z.object({powerName:displayTextSchema,target:displayTextSchema,
  actionCost:z.enum(["action","bonus-action"]),costs:z.array(deltaSchema).max(1),outcomes:z.array(combatPowerOutcomeSchema).min(1).max(16),
  concentration:z.boolean(),roundBefore:revisionSchema,roundAfter:revisionSchema,revisionBefore:revisionSchema,
  revisionAfter:revisionSchema,occurredAt:utcIsoTimestampSchema}).strict().refine(value=>value.revisionAfter===value.revisionBefore+1,
    "combat power receipt revision must advance once");

export const adventurePowerPublicReceiptSchema = z.object({
  powerName: displayTextSchema,
  targets: z.array(displayTextSchema).min(1).max(32),
  costs: z.array(deltaSchema).max(1),
  stateDeltas: z.array(z.object({ actor: displayTextSchema, change: displayTextSchema,
    before: z.number().int().min(0).nullable(), after: z.number().int().min(0).nullable() }).strict()).max(512),
  concentration: z.boolean(),
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1, "power receipt revision must advance once");

export const adventureRestPublicReceiptSchema = z.object({
  restKind: z.enum(["short", "long"]),
  restName: z.enum(["Short rest", "Long rest"]),
  recovery: z.array(deltaSchema).min(1).max(128),
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.restName !== (value.restKind === "short" ? "Short rest" : "Long rest")) context.addIssue({ code: "custom", path: ["restName"], message: "rest name must match kind" });
  if (value.revisionAfter !== value.revisionBefore + 1) context.addIssue({ code: "custom", path: ["revisionAfter"], message: "rest receipt revision must advance once" });
});

export type AdventurePowerCandidate = z.infer<typeof adventurePowerCandidateSchema>;
export type AdventureRestCandidate = z.infer<typeof adventureRestCandidateSchema>;
export type AdventurePowerPublicReceipt = z.infer<typeof adventurePowerPublicReceiptSchema>;
export type AdventureRestPublicReceipt = z.infer<typeof adventureRestPublicReceiptSchema>;
export type AdventureCombatConsumableCandidate=z.infer<typeof adventureCombatConsumableCandidateSchema>;
export type AdventureCombatConsumablePublicReceipt=z.infer<typeof adventureCombatConsumablePublicReceiptSchema>;
export type AdventureCombatPowerCandidate=z.infer<typeof adventureCombatPowerCandidateSchema>;
export type AdventureCombatPowerPublicReceipt=z.infer<typeof adventureCombatPowerPublicReceiptSchema>;
