import type { RulesetCapability } from "../types.js";
import {
  adjustedEncounterXp,
  encounterDifficulty,
  monsterXp,
  partyXpThresholds,
  rawEncounterXp,
  type EncounterDifficulty,
} from "./encounterXp.js";
import { frozenList, requireInteger } from "./internal.js";

/**
 * Deterministic SRD 5.1 encounter builder. Given a party and a pool of candidate
 * monsters it greedily fills the target XP band, highest challenge rating first,
 * and reports the resulting roster and difficulty. Pure and RNG-free.
 */

export const DND_5E_ENCOUNTER_BUILDER_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "encounter-builder", version: "1.0.0", status: "partial" as const }),
]);

export type EncounterBuilderDifficulty = "easy" | "medium" | "hard" | "deadly";

export type Dnd5eEncounterCandidate = Readonly<{ id: string; challengeRating: number }>;

export type Dnd5eEncounterInput = Readonly<{
  partyLevels: readonly number[];
  targetDifficulty: EncounterBuilderDifficulty;
  candidates: readonly Dnd5eEncounterCandidate[];
  maxMonsters?: number;
}>;

export type Dnd5eEncounterRosterEntry = Readonly<{ id: string; challengeRating: number; count: number }>;

export type Dnd5eEncounterPlan = Readonly<{
  targetDifficulty: EncounterBuilderDifficulty;
  targetXp: number;
  upperBound: number | null;
  roster: readonly Dnd5eEncounterRosterEntry[];
  rawXp: number;
  adjustedXp: number;
  difficulty: EncounterDifficulty;
  monsterCount: number;
  legal: boolean;
  reasons: readonly string[];
}>;

const TARGET_DIFFICULTIES: readonly EncounterBuilderDifficulty[] = Object.freeze(["easy", "medium", "hard", "deadly"]);

const DIFFICULTY_RANK: Readonly<Record<EncounterDifficulty, number>> = Object.freeze({
  trivial: 0, easy: 1, medium: 2, hard: 3, deadly: 4,
});

export function planDnd5eEncounter(input: Dnd5eEncounterInput): Dnd5eEncounterPlan {
  const thresholds = partyXpThresholds(input.partyLevels);
  if (!TARGET_DIFFICULTIES.includes(input.targetDifficulty)) throw new Error(`unsupported target difficulty: ${input.targetDifficulty}`);
  const requestedMax = input.maxMonsters ?? 20;
  requireInteger(requestedMax, "maxMonsters");
  if (requestedMax < 1) throw new RangeError("maxMonsters must be a positive integer");
  const maxMonsters = Math.min(requestedMax, 50);
  const seenIds = new Set<string>();
  input.candidates.forEach((candidate) => {
    if (typeof candidate.id !== "string" || candidate.id.length === 0) throw new Error("candidate id must be a non-empty string");
    if (seenIds.has(candidate.id)) throw new Error(`duplicate candidate id: ${candidate.id}`);
    seenIds.add(candidate.id);
    try {
      monsterXp(candidate.challengeRating);
    } catch {
      throw new Error(`candidate ${candidate.id} has an invalid SRD challenge rating`);
    }
  });

  const bands: Readonly<Record<EncounterBuilderDifficulty, readonly [number, number | null]>> = {
    easy: [thresholds.easy, thresholds.medium],
    medium: [thresholds.medium, thresholds.hard],
    hard: [thresholds.hard, thresholds.deadly],
    deadly: [thresholds.deadly, null],
  };
  const [targetXp, upperBound] = bands[input.targetDifficulty];

  const sorted = [...input.candidates].sort(
    (a, b) => b.challengeRating - a.challengeRating || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const counts = new Map<string, number>();
  let monsterCount = 0;
  while (monsterCount < maxMonsters) {
    let added = false;
    for (const candidate of sorted) {
      const trial = sorted
        .filter((entry) => counts.has(entry.id) || entry.id === candidate.id)
        .map((entry) => ({
          challengeRating: entry.challengeRating,
          count: (counts.get(entry.id) ?? 0) + (entry.id === candidate.id ? 1 : 0),
        }));
      if (upperBound === null || adjustedEncounterXp(trial, input.partyLevels.length) < upperBound) {
        counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
        monsterCount += 1;
        added = true;
        break;
      }
    }
    if (!added) break;
  }

  const roster = sorted
    .filter((candidate) => counts.has(candidate.id))
    .map((candidate) => Object.freeze({ id: candidate.id, challengeRating: candidate.challengeRating, count: counts.get(candidate.id)! }));
  const monsters = roster.map((entry) => ({ challengeRating: entry.challengeRating, count: entry.count }));
  const rawXp = rawEncounterXp(monsters);
  const adjustedXp = adjustedEncounterXp(monsters, input.partyLevels.length);
  const difficulty = encounterDifficulty(adjustedXp, input.partyLevels);

  const reasons: string[] = [];
  if (input.candidates.length === 0) reasons.push("no candidate monsters were supplied");
  const legal = monsterCount > 0 && difficulty === input.targetDifficulty;
  if (!legal && input.candidates.length > 0) {
    if (monsterCount === 0) reasons.push(`no candidate monster fits the ${input.targetDifficulty} target band`);
    else if (DIFFICULTY_RANK[difficulty] < DIFFICULTY_RANK[input.targetDifficulty]) reasons.push(`the roster is below the ${input.targetDifficulty} target`);
    else if (DIFFICULTY_RANK[difficulty] > DIFFICULTY_RANK[input.targetDifficulty]) reasons.push(`the roster exceeds the ${input.targetDifficulty} target`);
    if (monsterCount === maxMonsters) reasons.push("the maximum monster count was reached");
  }

  return Object.freeze({
    targetDifficulty: input.targetDifficulty,
    targetXp,
    upperBound,
    roster: frozenList(roster),
    rawXp,
    adjustedXp,
    difficulty,
    monsterCount,
    legal,
    reasons: frozenList(reasons),
  });
}
