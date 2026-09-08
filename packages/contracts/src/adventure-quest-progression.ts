import { z } from "zod";
import { canonicalSha256DigestSchema } from "./agent-execution.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";

const text = z.string().trim().min(1).max(200);
const delta = z.object({ label: text, before: z.number().int().min(0), after: z.number().int().min(0) }).strict();

export const adventureQuestLifecycleCandidateSchema = z.object({
  candidateId: resourceIdSchema, digest: canonicalSha256DigestSchema,
  action: z.enum(["accept", "abandon", "claim-reward"]), questTitle: text,
  reward: z.object({ label: text, kind: text, amount: z.number().int().min(0).nullable(), recipient: text }).strict().nullable(),
  confirmationRequired: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.action === "claim-reward") !== (value.reward !== null)) context.addIssue({ code: "custom", path: ["reward"], message: "reward summary must match action" });
  if (value.action !== "accept" && !value.confirmationRequired) context.addIssue({ code: "custom", path: ["confirmationRequired"], message: "abandon and reward claims require confirmation" });
});

export const adventureProgressionReadSchema = z.object({
  available: z.boolean(), className: text.nullable(), currentLevel: z.number().int().min(1).max(20).nullable(),
  eligibleLevel: z.number().int().min(1).max(20).nullable(), mode: z.enum(["xp", "milestone"]).nullable(),
  totalXp: z.number().int().min(0).nullable(), milestoneCount: z.number().int().min(0).nullable(),
  pendingChoices: z.array(z.object({ level: z.number().int().min(2).max(20), label: text, options: z.array(text).min(2).max(16) }).strict()).max(32),
}).strict();

export const adventureProgressionCandidateSchema = z.object({
  candidateId: resourceIdSchema, digest: canonicalSha256DigestSchema, className: text,
  levelBefore: z.number().int().min(1).max(20), levelAfter: z.number().int().min(2).max(20),
  features: z.array(text).max(128), resources: z.array(delta).max(128), confirmationRequired: z.literal(true),
}).strict().refine((value) => value.levelAfter > value.levelBefore, "progression candidate must advance level");

export const adventureQuestLifecyclePublicReceiptSchema = z.object({
  action: z.enum(["accept", "abandon", "claim-reward"]), questTitle: text,
  statusBefore: z.enum(["offered", "active", "completed", "abandoned"]), statusAfter: z.enum(["offered", "active", "completed", "abandoned"]),
  reward: z.object({ label: text, kind: text, amount: z.number().int().min(0).nullable(), recipient: text }).strict().nullable(),
  revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema,
}).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1, "quest lifecycle receipt must advance once");

export const adventureProgressionPublicReceiptSchema = z.object({
  className: text, levelBefore: z.number().int().min(1).max(20), levelAfter: z.number().int().min(2).max(20),
  features: z.array(text).max(128), resources: z.array(delta).max(128),
  revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema,
}).strict().refine((value) => value.levelAfter > value.levelBefore && value.revisionAfter === value.revisionBefore + 1,
  "progression receipt must advance level and revision once");

export type AdventureQuestLifecycleCandidate = z.infer<typeof adventureQuestLifecycleCandidateSchema>;
export type AdventureProgressionRead = z.infer<typeof adventureProgressionReadSchema>;
export type AdventureProgressionCandidate = z.infer<typeof adventureProgressionCandidateSchema>;
export type AdventureQuestLifecyclePublicReceipt = z.infer<typeof adventureQuestLifecyclePublicReceiptSchema>;
export type AdventureProgressionPublicReceipt = z.infer<typeof adventureProgressionPublicReceiptSchema>;
