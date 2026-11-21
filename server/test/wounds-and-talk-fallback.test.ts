// Approved tests from the round-5 playtest on a400fe7.
// 1. "Breathing hard, I look at what's left of the beetles and check my wounds."
//    was provider scene dressing with no current/max hit points. A wound/status
//    question with health context must report current and max HP, like an explicit
//    "give me my hit points" ask.
// 2. Social turns that mention "road", "walk", or "bow my head" were classified as
//    travel and canned as "You set your sights on the road, but you have not left yet."
//    (roleplayer 2 and 13). Talk, questions, and a bow are not departures.
import { describe, expect, it } from "vitest";
import { narrationFallback, type NarrationFallbackContext } from "../src/routes/rpg/v1/adventureTurns.js";

const fallbackContext = {
  currentLocation: "Slake-Head",
  reachablePlaces: ["Slake Market", "The Steps"],
  health: { current: 8, max: 15 },
} as NarrationFallbackContext;

describe("wound status questions report current and max HP", () => {
  it("falls back to a hit-point report for 'check my wounds' when health context is present", () => {
    const text = narrationFallback(
      "Breathing hard, I look at what's left of the beetles and check my wounds.",
      [],
      fallbackContext,
    );
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/\b8\b/);
    expect(text).toMatch(/\b15\b/);
    expect(text).not.toMatch(/stay where you are/i);
    expect(text).not.toMatch(/have not left yet/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });
});

describe("social declarations are not travel fallbacks", () => {
  it("does not use the 'have not left yet' line when a toast mentions the road and walking in blind", () => {
    const declaration =
      'I accept the cup with both hands and a small bow over it. "You\'re kind. This is the first warmth I\'ve had since the road." I sip, then glance toward the far end. "What manner of man is Orl Tace? I\'d not walk in blind.';
    const text = narrationFallback(declaration, [], fallbackContext);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).not.toMatch(/have not left yet/i);
    expect(text).not.toMatch(/set your sights on the road/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });

  it("does not use the 'have not left yet' line when the actor bows their head and asks a question", () => {
    const declaration =
      'I draw my hand back and bow my head to him, just slightly. Then, quiet: "The cold furnace. Whose is it, and why does no one relight it?';
    const text = narrationFallback(declaration, [], fallbackContext);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).not.toMatch(/have not left yet/i);
    expect(text).not.toMatch(/set your sights on the road/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });
});
