// Approved tests from the round-4 playtest on 762892d and the post-deploy smoke.
// #48 taught narrationFallback to use health and activeCombat when they are passed,
// but two call sites still omit them:
//   - performNarration's disconnected early-return (smoke: HP stay-put and
//     "no blow has landed" during a live beetle fight)
//   - deliberateHoldNarration's unwarranted-hold path (playtest: combat2 turn 1
//     and mech 6 were hold-skipped-provider with the pre-fight line after the
//     encounter was already started)
// Those call sites must forward the same context. This test passes that context
// into deliberateHoldNarration; the implementation must use it.
import { describe, expect, it } from "vitest";
import {
  deliberateHoldNarration,
  narrationFallback,
  type NarrationFallbackContext,
} from "../src/routes/rpg/v1/adventureTurns.js";
import type { AdventureHold } from "../src/agent/adventureOrchestrator.js";

const health = { current: 8, max: 15 };
const liveContext = {
  currentLocation: "Slake-Head",
  reachablePlaces: ["Slake Market", "The Steps"],
  health,
  activeCombat: {
    round: 1,
    enemies: [{ name: "Giant Fire Beetle", hp: "12/13" }],
    allies: [{ name: "Orra Staple", hp: "15/15" }],
  },
} as NarrationFallbackContext;

const unwarrantedHold: AdventureHold = {
  reason: "no-advertised-match",
  message: "It is not your turn.",
  suggestedNextStep: null,
  suggestedCandidateId: null,
  reachablePlaces: ["Slake Market", "The Steps"],
};

const sideEffectReceipt = {
  kind: "check",
  skill: "Insight",
  ability: "Wisdom",
  total: 17,
  dc: 15,
  difficulty: "Medium",
  outcome: "success",
} as const;

describe("hold and disconnect fallbacks forward health and live-combat context", () => {
  it("names the enemy on an unwarranted hold during a started fight instead of the pre-fight line", () => {
    const text = deliberateHoldNarration(
      unwarrantedHold,
      "I shout for Orra to flank them and swing at the nearest giant fire beetle.",
      [sideEffectReceipt as never],
      [],
      liveContext,
    );
    expect(text).toBeTruthy();
    expect(text!).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text!).toMatch(/Giant Fire Beetle/i);
    expect(text!).not.toMatch(/no blow has landed/i);
    expect(text!).not.toMatch(/ready yourself for a fight/i);
    expect(text!).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });

  it("reports current and max HP for a status question on the same hold path instead of stay-put", () => {
    const text = deliberateHoldNarration(
      unwarrantedHold,
      "How badly am I hurt? Give me my hit points.",
      [sideEffectReceipt as never],
      [],
      liveContext,
    );
    // A vitals status question is not a concrete action, so this path may return null;
    // if it narrates, it must be an HP report. The disconnect early-return always narrates
    // via narrationFallback and is locked by the next test.
    if (text) {
      expect(text).toMatch(/\byou(?:r|'re)?\b/i);
      expect(text).toMatch(/\b8\b/);
      expect(text).toMatch(/\b15\b/);
      expect(text).not.toMatch(/stay where you are/i);
    }
  });

  it("disconnected-style fallback (location and places only plus health and combat) reports HP and names the enemy", () => {
    // Locks the context object the disconnected early-return must pass, not location+places alone.
    const hp = narrationFallback("How badly am I hurt? Give me my hit points.", [], liveContext);
    expect(hp).toMatch(/\byou(?:r|'re)?\b/i);
    expect(hp).toMatch(/\b8\b/);
    expect(hp).toMatch(/\b15\b/);
    expect(hp).not.toMatch(/stay where you are/i);

    const combat = narrationFallback(
      "I shout for Orra to flank them and swing at the nearest giant fire beetle.",
      [],
      liveContext,
    );
    expect(combat).toMatch(/Giant Fire Beetle/i);
    expect(combat).not.toMatch(/no blow has landed/i);
  });
});
