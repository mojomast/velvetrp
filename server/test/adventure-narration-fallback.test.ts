import { describe, expect, it } from "vitest";
import { narrationFallback, narrationRepairIsWorthwhile, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";

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

describe("semantic gate tolerance for internal labels and ordinary inflection", () => {
  const quest = { kind: "quest", questTitle: "Guard the s11 market", objectiveDescription: "Keep the stalls safe",
    progressBefore: 0, progressAfter: 1, targetProgress: 1, objectiveCompleted: true, questCompleted: false };
  const check = { kind: "check", checkKind: "skill", ability: "Intelligence", skill: "Investigation", mode: "normal",
    difficulty: "Medium", rolls: [{ value: 15, kept: true }], abilityModifier: 3, proficiencyBonus: 2, modifier: 5,
    total: 20, dc: 15, outcome: "success" };

  it("grounds a quest receipt whose readable title drops the internal identifier marker", () => {
    expect(providerNarrationMatchesReceipts(
      "The watch closes ranks as Guard the market advances to 1 of 1; the objective is complete.", [quest] as never)).toBe(true);
    // The core label must still be present; a bare mechanic word is not enough.
    expect(providerNarrationMatchesReceipts("The watch closes ranks as a quest advances to 1 of 1.", [quest] as never)).toBe(false);
  });

  it("matches a stopworded destination and an inflected check outcome", () => {
    expect(providerNarrationMatchesReceipts("You arrive at Black Berth.", [{ kind: "travel", destination: "the Black Berth" }] as never)).toBe(true);
    expect(providerNarrationMatchesReceipts("Your Investigation check comes to 20 against DC 15: it succeeded.", [check] as never)).toBe(true);
    expect(providerNarrationMatchesReceipts("Your Investigation check comes to 20 against DC 15: it failed.", [check] as never)).toBe(false);
  });

  it("still rejects an arrival at a different place than the committed destination", () => {
    expect(providerNarrationMatchesReceipts("You arrive at Pointe-Saint-Gilles.", [{ kind: "travel", destination: "Black Berth" }] as never)).toBe(false);
  });
});

describe("context-aware deterministic fallbacks", () => {
  it("composes distinct, stable prose for distinct receipt-free contexts", () => {
    const samples: Array<[string, string]> = [
      ["hold", narrationFallback("I wait.", [])],
      ["conversation", narrationFallback("I greet the keeper and ask about the fog.", [])],
      ["illegal", narrationFallback("/help what commands exist here?", [])],
      ["rest", narrationFallback("I take a short rest by the fire.", [])],
      ["combat", narrationFallback("I attack the goblin with my blade.", [])],
      ["travel-to-current-place", narrationFallback("I walk back to the Market.", [], { currentLocation: "Market" })],
    ];
    for (const [kind, text] of samples) {
      expect(text, kind).toContain("movement or other campaign change is established");
    }
    expect(samples.find(([kind]) => kind === "hold")![1]).not.toBe(samples.find(([kind]) => kind === "conversation")![1]);
    expect(new Set(samples.map(([, text]) => text)).size).toBe(6);
    // Determinism: the same declaration and context always composes the same line.
    expect(narrationFallback("I attack the goblin with my blade.", [])).toBe(narrationFallback("I attack the goblin with my blade.", []));
    expect(narrationFallback("I walk back to the Market.", [], { currentLocation: "Market" }))
      .toBe(narrationFallback("I walk back to the Market.", [], { currentLocation: "Market" }));
  });
});

describe("bounded grounding repair near-miss gate", () => {
  const quest = { kind: "quest", questTitle: "Guard the s11 market", objectiveDescription: "Keep the stalls safe",
    progressBefore: 0, progressAfter: 2, targetProgress: 3, objectiveCompleted: false, questCompleted: false };
  const check = { kind: "check", checkKind: "skill", ability: "Intelligence", skill: "Investigation", mode: "normal",
    difficulty: "Medium", rolls: [{ value: 15, kept: true }], abilityModifier: 3, proficiencyBonus: 2, modifier: 5,
    total: 20, dc: 15, outcome: "success" };

  it("skips a generic placeholder that names no committed fact", () => {
    expect(narrationRepairIsWorthwhile("The authoritative result is clear.", [quest] as never, null, false)).toBe(false);
    expect(narrationRepairIsWorthwhile("The authoritative result is clear.", [check] as never, null, false)).toBe(false);
    expect(narrationRepairIsWorthwhile("", [quest] as never, null, false)).toBe(false);
    expect(narrationRepairIsWorthwhile("Some unrelated atmospheric prose.", [check] as never, null, false)).toBe(false);
  });

  it("repairs a near-miss that already names a committed label or value", () => {
    expect(narrationRepairIsWorthwhile("The guard advances to 2 of 3.", [quest] as never, null, false)).toBe(true);
    expect(narrationRepairIsWorthwhile("Your Investigation check comes to 25.", [check] as never, null, false)).toBe(true);
    expect(narrationRepairIsWorthwhile("At Lantern Quay, you take 7 damage.", [] as never, "Lantern Quay", false)).toBe(true);
  });
});
