// Approved tests from the round-3 post-deploy playtest on ed5f105.
// "How badly am I hurt? Give me my hit points." was canned with gate=current-location
// and the stay-put location fallback. Provider prose like "You are at 8 of 15 hit points"
// was treated as a change of place, and honest vitals that match actor state were
// rejected as unsupported-vitals. A status question should be answerable.
import { describe, expect, it } from "vitest";
import {
  narrationFallback,
  narrationGateFailure,
  type NarrationFallbackContext,
} from "../src/routes/rpg/v1/adventureTurns.js";
import type { ActorStateContext } from "../src/agent/actorStateContext.js";

const location = "Slake-Head";
const health = { current: 8, max: 15 };
const actorState: ActorStateContext = {
  health,
  resources: null,
  inventory: null,
  quests: null,
  activeCombat: null,
};
const fallbackContext = {
  currentLocation: location,
  reachablePlaces: ["Slake Market", "The Steps"],
  health,
} as NarrationFallbackContext;

describe("HP status questions are not location or invented-vitals failures", () => {
  it("accepts second-person hit-point status that matches actor state without naming the place", () => {
    const text = "You are at 8 of 15 hit points. The wounds are ugly, but you can still stand.";
    expect(narrationGateFailure(text, [], location, actorState)).toBeNull();
  });

  it("accepts 'you have N of M hit points' when those numbers match actor state", () => {
    expect(narrationGateFailure("You have 8 of 15 hit points left.", [], location, actorState)).toBeNull();
  });

  it("still rejects being placed at a different named location", () => {
    expect(narrationGateFailure("You are at The Steps.", [], location, actorState)).toBe("current-location");
  });

  it("still rejects invented hit-point totals that do not match actor state", () => {
    expect(narrationGateFailure("You have 99 of 15 hit points left.", [], location, actorState)).toBe(
      "unsupported-vitals",
    );
  });

  it("falls back to a second-person hit-point report instead of the stay-put location line", () => {
    const text = narrationFallback("How badly am I hurt? Give me my hit points.", [], fallbackContext);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/\b8\b/);
    expect(text).toMatch(/\b15\b/);
    expect(text).not.toMatch(/stay where you are/i);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });
});
