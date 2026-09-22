import { describe, expect, it } from "vitest";
import { narrationFallback, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";

const combat = (action: string, outcome: unknown, roundBefore = 1, roundAfter = 1) => ({ kind: "combat", action, outcome, roundBefore, roundAfter });
const fallback = (values: unknown[]) => narrationFallback("I act.", values as never);

describe("deterministic combat narration fallback", () => {
  it("reports a miss without damage and a hit with the exact damage type", () => {
    expect(fallback([combat("attack", { kind: "damage", damageType: "slashing", requested: 0, applied: 0, hit: false, critical: false,
      hitPointsBefore: 11, hitPointsAfter: 11, statusAfter: "active" })]))
      .toContain("misses; no damage is applied and the target remains at 11 HP");
    expect(fallback([combat("attack", { kind: "damage", damageType: "slashing", requested: 10, applied: 10, hit: true, critical: false,
      hitPointsBefore: 21, hitPointsAfter: 11, statusAfter: "active" })]))
      .toContain("deals 10 slashing damage");
  });

  it("distinguishes each non-attack action instead of narrating an end-turn", () => {
    for (const [action, phrase] of [["dash", "dashes"], ["hide", "hide"], ["help", "helps an ally"],
      ["disengage", "disengages"], ["ready", "readies an action"], ["escape-grapple", "escape the grapple"]] as const) {
      const text = fallback([combat(action, { kind: "none" }, 2, 3)]);
      expect(text).toContain(phrase);
      expect(text).not.toContain("ends their turn");
    }
    expect(fallback([combat("end-turn", { kind: "none" }, 2, 3)])).toContain("ends their turn");
  });

  it("narrates contests, standing up, and death saves", () => {
    expect(fallback([combat("grapple", { kind: "contest", contest: "grapple", attackerRoll: 15, defenderRoll: 10, success: true, condition: "grappled" })]))
      .toContain("grapple contest resolves 15 against 10: success and is grappled");
    expect(fallback([combat("shove", { kind: "contest", contest: "shove", attackerRoll: 5, defenderRoll: 16, success: false, condition: null })]))
      .toContain("failure");
    expect(fallback([combat("stand-up", { kind: "stand-up", movementCostFeet: 15 })])).toContain("spending 15 feet of movement");
    expect(fallback([combat("death-save", { kind: "survival", successes: 0, failures: 3, statusAfter: "dead" })]))
      .toContain("0 successes and 3 failures");
    expect(fallback([combat("stabilize", { kind: "survival", successes: 0, failures: 0, statusAfter: "stable" })])).toContain("stabilized");
  });
});

const travel = (destination: string) => ({ kind: "travel", destination } as const);
// Mirrors the route: prose the gate rejects settles on the receipt-only fallback narration.
const settleNarration = (text: string, values: unknown[]) => providerNarrationMatchesReceipts(text, values as never)
  ? { text, source: "provider-assisted" as const }
  : { text: fallback(values), source: "deterministic-fallback" as const };

describe("unsupported travel narration without a receipt", () => {
  it("rejects a walking claim, settles on the fallback, and accepts the same claim with a travel receipt", () => {
    const rejected = settleNarration("You walk to the market square.", []);
    expect(rejected.source).toBe("deterministic-fallback");
    expect(rejected.text).toContain("no movement or other campaign change is established");
    expect(settleNarration("You walk to the market square.", [travel("the market square")]))
      .toEqual({ text: "You walk to the market square.", source: "provider-assisted" });
  });

  it("rejects the other added movement verbs in subject form without a travel receipt", () => {
    for (const narration of ["The party heads east.", "You ride to the gate.", "The group marches at dawn.",
      "You set out for the mill.", "The party sets off downriver.", "You make for the harbor."]) {
      expect(providerNarrationMatchesReceipts(narration, []), narration).toBe(false);
    }
  });

  it("keeps a directive's imperative out of the subject form", () => {
    expect(providerNarrationMatchesReceipts("The Bell asks of you: walk the hill track before the fair.", [])).toBe(true);
  });
});
