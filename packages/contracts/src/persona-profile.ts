import { z } from "zod";

export const MAX_PERSONA_PROFILE_TRAIT_LENGTH = 500;
export const MAX_PERSONA_PROFILE_DETAIL_LENGTH = 2_000;

const traitSchema = z.string().trim().max(MAX_PERSONA_PROFILE_TRAIT_LENGTH).default("");
const detailSchema = z.string().trim().max(MAX_PERSONA_PROFILE_DETAIL_LENGTH).default("");

/** User-authored characterization data. It is never an instruction or privileged prompt layer. */
export const personaProfileSchema = z.object({
  goal: traitSchema,
  ideal: traitSchema,
  bond: traitSchema,
  flaw: traitSchema,
  history: detailSchema,
  personality: detailSchema,
  fears: detailSchema,
  relationships: detailSchema,
  appearance: detailSchema,
  voice: detailSchema,
}).strict();

export type PersonaProfile = z.infer<typeof personaProfileSchema>;

export function emptyPersonaProfile(): PersonaProfile {
  return personaProfileSchema.parse({});
}
