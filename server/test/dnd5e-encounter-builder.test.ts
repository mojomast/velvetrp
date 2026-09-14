import { describe, expect, it } from "vitest";
import { planDnd5eEncounter, type Dnd5eEncounterInput } from "../src/rulesets/dnd5e/encounterBuilder.js";
import { partyXpThresholds } from "../src/rulesets/dnd5e/encounterXp.js";

function hardInput(): Dnd5eEncounterInput {
  return {
    partyLevels: [3, 3, 3, 3],
    targetDifficulty: "hard",
    candidates: [
      { id: "goblin", challengeRating: 1 },
      { id: "kobold", challengeRating: 0.5 },
      { id: "ogre", challengeRating: 3 },
      { id: "hobgoblin", challengeRating: 2 },
    ],
  };
}

describe("planDnd5eEncounter", () => {
  it("fills the hard band for a party of four level-3 characters", () => {
    const thresholds = partyXpThresholds([3, 3, 3, 3]);
    const plan = planDnd5eEncounter(hardInput());
    expect(plan.legal).toBe(true);
    expect(plan.difficulty).toBe("hard");
    expect(plan.targetXp).toBe(thresholds.hard);
    expect(plan.upperBound).toBe(thresholds.deadly);
    expect(plan.monsterCount).toBeGreaterThan(0);
    expect(plan.adjustedXp).toBeGreaterThanOrEqual(thresholds.hard);
    expect(plan.adjustedXp).toBeLessThan(thresholds.deadly);
    const rosterCount = plan.roster.reduce((total, entry) => total + entry.count, 0);
    expect(rosterCount).toBe(plan.monsterCount);
  });

  it("reports an illegal plan with a reason when there are no candidates", () => {
    const plan = planDnd5eEncounter({ ...hardInput(), candidates: [] });
    expect(plan.legal).toBe(false);
    expect(plan.monsterCount).toBe(0);
    expect(plan.reasons.length).toBeGreaterThan(0);
  });

  it("is deterministic for identical input", () => {
    const input = hardInput();
    const first = JSON.stringify(planDnd5eEncounter(input));
    const second = JSON.stringify(planDnd5eEncounter(input));
    expect(first).toBe(second);
  });

  it("does not mutate its inputs", () => {
    const candidates = Object.freeze([
      Object.freeze({ id: "ogre", challengeRating: 3 }),
      Object.freeze({ id: "goblin", challengeRating: 1 }),
    ]);
    const input: Dnd5eEncounterInput = Object.freeze({ partyLevels: Object.freeze([3, 3, 3, 3]), targetDifficulty: "hard", candidates });
    const before = JSON.stringify(input);
    planDnd5eEncounter(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("caps the roster at maxMonsters", () => {
    const plan = planDnd5eEncounter({
      partyLevels: [3, 3, 3, 3],
      targetDifficulty: "easy",
      candidates: [{ id: "rat", challengeRating: 0 }],
      maxMonsters: 3,
    });
    expect(plan.monsterCount).toBe(3);
    expect(plan.roster.reduce((total, entry) => total + entry.count, 0)).toBe(3);
  });
});
