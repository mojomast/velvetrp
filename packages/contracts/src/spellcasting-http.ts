import { z } from "zod";
import { actorPowerCommandResponseSchema, actorPowerCommandRequestSchema } from "./powers-http.js";
import { powerReferenceSchema } from "./powers.js";

export const spellComponentDeclarationSchema = z.object({
  verbal: z.boolean(),
  somatic: z.boolean(),
  material: z.boolean(),
}).strict();

export const castSpellCommandRequestSchema = actorPowerCommandRequestSchema.extend({
  powerRef: powerReferenceSchema.refine((reference) => reference.kind === "spell", "powerRef must identify a spell"),
  components: spellComponentDeclarationSchema,
}).strict();

export const castSpellCommandResponseSchema = actorPowerCommandResponseSchema;
export type CastSpellCommandRequest = z.infer<typeof castSpellCommandRequestSchema>;
export type CastSpellCommandResponse = z.infer<typeof castSpellCommandResponseSchema>;
