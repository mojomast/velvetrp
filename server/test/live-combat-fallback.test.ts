// Approved tests from the round-3 post-deploy playtest on ed5f105.
// After the prepared Giant Fire Beetle fight was already started, "I shout for Orra
// to flank them and swing at the nearest giant fire beetle." fell back to the
// pre-fight line: "You ready yourself for a fight, but no blow has landed yet."
// Live combat fallback must acknowledge the started fight and name the enemy.
import { describe, expect, it } from "vitest";
import { narrationFallback, type NarrationFallbackContext } from "../src/routes/rpg/v1/adventureTurns.js";

const liveContext = {
  currentLocation: "Slake-Head",
  activeCombat: {
    round: 1,
    enemies: [{ name: "Giant Fire Beetle", hp: "12/13" }],
    allies: [{ name: "Orra Staple", hp: "15/15" }],
  },
} as NarrationFallbackContext;

describe("live combat declaration fallback", () => {
  it("does not use the pre-fight 'no blow has landed' line when a fight is already started", () => {
    const text = narrationFallback(
      "I shout for Orra to flank them and swing at the nearest giant fire beetle.",
      [],
      liveContext,
    );
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/Giant Fire Beetle/i);
    expect(text).not.toMatch(/no blow has landed/i);
    expect(text).not.toMatch(/ready yourself for a fight/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });

  it("keeps the pre-fight fallback when no combat is active", () => {
    const text = narrationFallback("I attack the goblin with my blade.", []);
    expect(text).toMatch(/no blow has landed/i);
  });
});
