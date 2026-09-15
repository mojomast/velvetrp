import { describe, expect, it } from "vitest";
import {
  DND_5E_NPC_SELECTION_CAPABILITIES,
  selectDnd5eNpcStatBlocks,
} from "../src/rulesets/dnd5e/npcSelection.js";

const CANDIDATES = [
  { id: "goblin", challengeRating: 0.25, roles: ["skirmisher"], tags: ["humanoid"] },
  { id: "bugbear", challengeRating: 1, roles: ["brute"] },
  { id: "hobgoblin", challengeRating: 0.5, roles: ["soldier"] },
  { id: "orc", challengeRating: 0.5, roles: ["soldier"] },
  { id: "ogre", challengeRating: 2, roles: ["brute"] },
  { id: "kobold", challengeRating: 0.125, roles: ["skirmisher"] },
  { id: "bandit", challengeRating: 0.125, roles: ["soldier"] },
] as const;

describe("selectDnd5eNpcStatBlocks", () => {
  it("filters by role and inclusive CR band, then selects in deterministic order", () => {
    expect(DND_5E_NPC_SELECTION_CAPABILITIES).toEqual([
      { id: "npc-selection", version: "1.1.0", status: "supported" },
    ]);

    const result = selectDnd5eNpcStatBlocks({
      candidates: CANDIDATES,
      role: "soldier",
      minChallengeRating: 0.125,
      maxChallengeRating: 0.5,
      count: 3,
    });

    expect(result.selected).toEqual([
      { id: "bandit", challengeRating: 0.125 },
      { id: "hobgoblin", challengeRating: 0.5 },
      { id: "orc", challengeRating: 0.5 },
    ]);
    expect(result.legal).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports illegality when fewer candidates are available than requested", () => {
    const result = selectDnd5eNpcStatBlocks({ candidates: CANDIDATES, role: "brute", count: 3 });

    expect(result.selected).toEqual([
      { id: "bugbear", challengeRating: 1 },
      { id: "ogre", challengeRating: 2 },
    ]);
    expect(result.legal).toBe(false);
    expect(result.reasons).toHaveLength(1);
  });

  it("honors excludeIds", () => {
    const result = selectDnd5eNpcStatBlocks({
      candidates: CANDIDATES,
      role: "soldier",
      count: 2,
      excludeIds: ["orc"],
    });

    expect(result.selected.map((entry) => entry.id)).toEqual(["bandit", "hobgoblin"]);
    expect(result.legal).toBe(true);
  });

  it("is stable across runs and does not mutate its inputs", () => {
    const candidates = [
      { id: "orc", challengeRating: 0.5, roles: ["soldier"] },
      { id: "bandit", challengeRating: 0.125, roles: ["soldier"] },
      { id: "hobgoblin", challengeRating: 0.5, roles: ["soldier"] },
    ];
    const snapshot = JSON.stringify(candidates);
    const input = { candidates, role: "soldier", count: 3 };

    const first = selectDnd5eNpcStatBlocks(input);
    const second = selectDnd5eNpcStatBlocks(input);

    expect(first).toEqual(second);
    expect(first.selected.map((entry) => entry.id)).toEqual(["bandit", "hobgoblin", "orc"]);
    expect(JSON.stringify(candidates)).toBe(snapshot);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.selected)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
  });

  it("orders fractional challenge ratings by XP value (0.125 < 0.5 < 1)", () => {
    const candidates = [
      { id: "high", challengeRating: 1 },
      { id: "mid", challengeRating: 0.5 },
      { id: "low", challengeRating: 0.125 },
    ];

    const result = selectDnd5eNpcStatBlocks({ candidates, count: 3 });

    expect(result.selected.map((entry) => entry.id)).toEqual(["low", "mid", "high"]);
    expect(result.legal).toBe(true);
  });
});
