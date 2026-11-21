// Approved tests from the round-3 post-deploy playtest on ed5f105.
// 6 of 12 remaining canned turns were bare skill-check receipts, e.g.
// "Insight check: 11 rolled normal; +6 modifier gives 17 against Medium DC 15: success."
// When a check is committed and narration falls back, the player should still get
// second-person in-fiction prose that names the skill and the outcome, not a roll log.
import { describe, expect, it } from "vitest";
import { narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";

const success = {
  kind: "check" as const,
  checkKind: "skill" as const,
  ability: "Wisdom",
  skill: "Insight",
  mode: "normal" as const,
  difficulty: "Medium",
  rolls: [{ value: 11, kept: true }],
  abilityModifier: 2,
  proficiencyBonus: 4,
  modifier: 6,
  total: 17,
  dc: 15,
  outcome: "success" as const,
};

const failure = {
  ...success,
  skill: "Perception",
  rolls: [{ value: 1, kept: true }],
  modifier: 4,
  total: 5,
  outcome: "failure" as const,
};

const ROLL_LOG = /rolled normal|modifier gives|\bcheck:\s*\d+\s+rolled/i;

describe("in-fiction check receipt fallback", () => {
  it("renders a successful Insight check in the second person without a roll log", () => {
    const text = narrationFallback("I approach the surveyor and ask whether the ground is still settling.", [success]);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/Insight/i);
    expect(text).toMatch(/success/i);
    expect(text).toMatch(/17/);
    expect(text).toMatch(/15/);
    expect(text).not.toMatch(ROLL_LOG);
    expect(text).not.toMatch(/authoritative|declaration|\breceipt\b/i);
  });

  it("renders a failed Perception check in the second person without a roll log", () => {
    const text = narrationFallback("I watch the cart ruts west of the bell-post.", [failure]);
    expect(text).toMatch(/\byou(?:r|'re)?\b/i);
    expect(text).toMatch(/Perception/i);
    expect(text).toMatch(/fail/i);
    expect(text).toMatch(/5/);
    expect(text).toMatch(/15/);
    expect(text).not.toMatch(ROLL_LOG);
  });
});
