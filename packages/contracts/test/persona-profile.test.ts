import { describe, expect, expectTypeOf, it } from "vitest";
import {
  emptyPersonaProfile,
  MAX_PERSONA_PROFILE_DETAIL_LENGTH,
  MAX_PERSONA_PROFILE_TRAIT_LENGTH,
  personaProfileSchema,
  type PersonaProfile,
} from "../src/persona-profile.js";

describe("persona profile contract", () => {
  it("defaults every optional field to an empty string and trims supplied data", () => {
    const empty = emptyPersonaProfile();
    expect(empty).toEqual({
      goal: "", ideal: "", bond: "", flaw: "", history: "", personality: "",
      fears: "", relationships: "", appearance: "", voice: "",
    });
    expect(personaProfileSchema.parse({ goal: "  Find home.  ", voice: "  Soft-spoken.\n" }))
      .toEqual({ ...empty, goal: "Find home.", voice: "Soft-spoken." });
    expectTypeOf<PersonaProfile>().toEqualTypeOf<typeof personaProfileSchema._output>();
  });

  it("rejects unknown, non-string, and over-limit fields", () => {
    expect(personaProfileSchema.safeParse({ secret: "hidden" }).success).toBe(false);
    expect(personaProfileSchema.safeParse({ goal: 3 }).success).toBe(false);
    expect(personaProfileSchema.safeParse({ goal: "x".repeat(MAX_PERSONA_PROFILE_TRAIT_LENGTH + 1) }).success).toBe(false);
    expect(personaProfileSchema.safeParse({ history: "x".repeat(MAX_PERSONA_PROFILE_DETAIL_LENGTH + 1) }).success).toBe(false);
  });
});
