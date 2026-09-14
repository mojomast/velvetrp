import type { RulesetCapability } from "../types.js";

/**
 * SRD 5.1 encounter-building math: the challenge-rating XP table, the
 * per-character encounter XP thresholds, and the multiple-monster multiplier
 * (with the SRD party-size adjustment). Pure and injected-input only; this is
 * the shared foundation for the encounter builder, rewards, and NPC selection.
 */

/** Fractional-exact challenge rating keys used by the SRD tables. */
export const DND_5E_CHALLENGE_XP: Readonly<Record<string, number>> = Object.freeze({
  "0": 10, "1/8": 25, "1/4": 50, "1/2": 100,
  "1": 200, "2": 450, "3": 700, "4": 1100, "5": 1800, "6": 2300, "7": 2900, "8": 3900, "9": 5000, "10": 5900,
  "11": 7200, "12": 8400, "13": 10000, "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000, "19": 22000, "20": 25000,
  "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000, "26": 90000, "27": 105000, "28": 120000, "29": 135000, "30": 155000,
});

/** Easy/medium/hard/deadly XP thresholds per character level 1-20. */
export const DND_5E_LEVEL_XP_THRESHOLDS: Readonly<Record<number, readonly [number, number, number, number]>> = Object.freeze({
  1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400], 4: [125, 250, 375, 500], 5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400], 7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100], 9: [550, 1100, 1600, 2400], 10: [600, 1200, 1900, 2800],
  11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500], 13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200], 17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500], 19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
});

const MULTIPLIER_STEPS: readonly number[] = Object.freeze([1, 1.5, 2, 2.5, 3, 4]);
const DIFFICULTY_ORDER = ["easy", "medium", "hard", "deadly"] as const;

export type EncounterDifficulty = "trivial" | "easy" | "medium" | "hard" | "deadly";
export type EncounterMonster = Readonly<{ challengeRating: number; count: number }>;
export type PartyXpThresholds = Readonly<{ easy: number; medium: number; hard: number; deadly: number }>;

function requireFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

/** Exact SRD table key for a challenge rating (0, 1/8, 1/4, 1/2, then integers). */
export function challengeRatingKey(challengeRating: number): string {
  requireFiniteNonNegative(challengeRating, "challenge rating");
  if (challengeRating === 0.125) return "1/8";
  if (challengeRating === 0.25) return "1/4";
  if (challengeRating === 0.5) return "1/2";
  if (Number.isInteger(challengeRating) && DND_5E_CHALLENGE_XP[String(challengeRating)] !== undefined) return String(challengeRating);
  throw new Error(`challenge rating ${challengeRating} is not an SRD challenge rating`);
}

/** XP awarded for one monster of the given challenge rating. */
export function monsterXp(challengeRating: number): number {
  return DND_5E_CHALLENGE_XP[challengeRatingKey(challengeRating)]!;
}

function baseMultiplierStep(monsterCount: number): number {
  if (monsterCount <= 1) return 0;
  if (monsterCount === 2) return 1;
  if (monsterCount <= 6) return 2;
  if (monsterCount <= 10) return 3;
  if (monsterCount <= 14) return 4;
  return 5;
}

/** SRD multiple-monster multiplier, adjusted one step for parties below 3 or above 5. */
export function encounterMultiplier(monsterCount: number, partySize: number): number {
  if (!Number.isInteger(monsterCount) || monsterCount < 1) throw new Error("monster count must be a positive integer");
  if (!Number.isInteger(partySize) || partySize < 1) throw new Error("party size must be a positive integer");
  let step = baseMultiplierStep(monsterCount);
  if (partySize < 3) step = Math.min(MULTIPLIER_STEPS.length - 1, step + 1);
  else if (partySize > 5) step = Math.max(0, step - 1);
  return MULTIPLIER_STEPS[step]!;
}

/** Raw XP before the multiple-monster multiplier is applied. */
export function rawEncounterXp(monsters: readonly EncounterMonster[]): number {
  return monsters.reduce((total, monster) => {
    if (!Number.isInteger(monster.count) || monster.count < 0) throw new Error("monster count must be a non-negative integer");
    return total + monsterXp(monster.challengeRating) * monster.count;
  }, 0);
}

/** Adjusted encounter XP: raw XP times the SRD multiplier for the monster count. */
export function adjustedEncounterXp(monsters: readonly EncounterMonster[], partySize: number): number {
  const count = monsters.reduce((total, monster) => {
    if (!Number.isInteger(monster.count) || monster.count < 0) throw new Error("monster count must be a non-negative integer");
    return total + monster.count;
  }, 0);
  const raw = rawEncounterXp(monsters);
  if (count === 0) return 0;
  return raw * encounterMultiplier(count, partySize);
}

/** Summed party thresholds (one entry per character level). */
export function partyXpThresholds(partyLevels: readonly number[]): PartyXpThresholds {
  if (partyLevels.length === 0) throw new Error("party must have at least one character");
  const totals: [number, number, number, number] = [0, 0, 0, 0];
  for (const level of partyLevels) {
    if (!Number.isInteger(level) || DND_5E_LEVEL_XP_THRESHOLDS[level] === undefined) throw new Error(`character level ${level} is outside 1-20`);
    const row = DND_5E_LEVEL_XP_THRESHOLDS[level]!;
    totals[0] += row[0]!; totals[1] += row[1]!; totals[2] += row[2]!; totals[3] += row[3]!;
  }
  return Object.freeze({ easy: totals[0]!, medium: totals[1]!, hard: totals[2]!, deadly: totals[3]! });
}

/** Difficulty of an adjusted XP total against a party: the highest threshold met. */
export function encounterDifficulty(adjustedXp: number, partyLevels: readonly number[]): EncounterDifficulty {
  requireFiniteNonNegative(adjustedXp, "adjusted XP");
  const thresholds = partyXpThresholds(partyLevels);
  let difficulty: EncounterDifficulty = "trivial";
  for (const tier of DIFFICULTY_ORDER) if (adjustedXp >= thresholds[tier]) difficulty = tier;
  return difficulty;
}

export const DND_5E_ENCOUNTER_XP_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([]);
