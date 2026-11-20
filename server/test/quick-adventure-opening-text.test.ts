// Approved test (playtest kink #3a): the Quick adventure opening is player-facing prose and must
// spell place names the way the world does ("Slake-Head"), not as lowercase identifiers.
import { describe, expect, it } from "vitest";
import { readSintermarkRecipe } from "../src/quickstart/sintermarkBuilder.js";

describe("Sintermark opening text", () => {
  it("names the starting place in its proper case", () => {
    const opening = readSintermarkRecipe().opening ?? "";
    expect(opening).toContain("The campaign opens at Slake-Head in the Slake");
    expect(opening).not.toMatch(/\bslake-head\b/);
  });
});
