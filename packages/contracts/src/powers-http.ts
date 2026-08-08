import { z } from "zod";
import { recoverySchema } from "./content-catalog.js";
import { powerReferenceSchema } from "./powers.js";
import { revisionSchema } from "./rpg-commands.js";

const boundedPowerCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One exact base spell-slot resource. Slot availability here is capacity only. */
export const actorPowerSlotSchema = z.object({
  slotId: z.string().regex(/^slot-(?:[1-9]|1[0-9]|20)$/),
  level: z.number().int().min(1).max(20),
  current: boundedPowerCountSchema,
  max: boundedPowerCountSchema,
}).strict().superRefine((slot, context) => {
  if (slot.slotId !== `slot-${slot.level}`) context.addIssue({ code: "custom", message: "slot identity must match level", path: ["slotId"] });
  if (slot.current > slot.max) context.addIssue({ code: "custom", message: "slot current cannot exceed max", path: ["current"] });
});

/** Remaining finite ability uses derived from authoritative use and recovery history. */
export const actorPowerUseStateSchema = z.object({
  powerRef: powerReferenceSchema.refine((reference) => reference.kind === "ability"),
  current: boundedPowerCountSchema,
  max: z.number().int().min(1).max(100),
  recovery: recoverySchema,
}).strict().refine((state) => state.current <= state.max, { message: "ability uses cannot exceed max", path: ["current"] });

/**
 * Closed availability reasons for the server-owned resource projection.
 * This intentionally does not claim target, encounter-turn, range, action, or
 * effect legality; a future command still performs those authoritative checks.
 */
export const actorPowerAvailabilityReasonSchema = z.enum([
  "execution-pin-unavailable",
  "finite-uses-exhausted",
  "spell-slot-unavailable",
]);

export const actorPowerLegalNowSchema = z.object({
  powerRef: powerReferenceSchema,
  legal: z.boolean(),
  reasons: z.array(actorPowerAvailabilityReasonSchema).max(actorPowerAvailabilityReasonSchema.options.length),
}).strict().superRefine((entry, context) => {
  if (new Set(entry.reasons).size !== entry.reasons.length) context.addIssue({ code: "custom", message: "availability reasons must be unique", path: ["reasons"] });
  if (entry.legal !== (entry.reasons.length === 0)) context.addIssue({ code: "custom", message: "legal must exactly reflect resource availability reasons", path: ["legal"] });
});

const referenceKey = (reference: z.infer<typeof powerReferenceSchema>) =>
  `${reference.kind}\0${reference.packId}\0${reference.packVersion}\0${reference.definitionId}`;

/**
 * Current fixed starter projection. Every authoritative known power is
 * prepared; callers cannot select preparation. `legalNow` is deliberately
 * limited to exact execution pins and server-owned finite-use/slot capacity.
 */
export const actorPowersResponseSchema = z.object({
  known: z.array(powerReferenceSchema),
  prepared: z.array(powerReferenceSchema),
  slots: z.array(actorPowerSlotSchema).max(20),
  uses: z.array(actorPowerUseStateSchema),
  legalNow: z.array(actorPowerLegalNowSchema),
  revision: revisionSchema,
}).strict().superRefine((response, context) => {
  const keys = response.known.map(referenceKey);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    context.addIssue({ code: "custom", message: "known powers must be unique and stably ordered", path: ["known"] });
  }
  if (JSON.stringify(response.prepared) !== JSON.stringify(response.known)) {
    context.addIssue({ code: "custom", message: "fixed starter rules prepare every known power", path: ["prepared"] });
  }
  if (response.slots.some((slot, index) => index > 0 && slot.level <= response.slots[index - 1]!.level)) {
    context.addIssue({ code: "custom", message: "slots must be uniquely ordered by numeric level", path: ["slots"] });
  }
  const useKeys = response.uses.map((state) => referenceKey(state.powerRef));
  if (new Set(useKeys).size !== useKeys.length || useKeys.some((key, index) => index > 0 && key <= useKeys[index - 1]!)) {
    context.addIssue({ code: "custom", message: "finite uses must be unique and stably ordered", path: ["uses"] });
  }
  if (response.legalNow.length !== response.known.length
      || response.legalNow.some((entry, index) => referenceKey(entry.powerRef) !== keys[index])) {
    context.addIssue({ code: "custom", message: "legalNow must contain exactly one ordered entry per known power", path: ["legalNow"] });
  }
});

export type ActorPowersResponse = z.infer<typeof actorPowersResponseSchema>;
export type ActorPowerAvailabilityReason = z.infer<typeof actorPowerAvailabilityReasonSchema>;
