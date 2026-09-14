import type { RulesetCapability } from "../types.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";
import { rawEncounterXp } from "./encounterXp.js";

/**
 * SRD 5.1 encounter rewards: award raw challenge-rating XP for defeated
 * monsters and report level-up eligibility against the standard XP curve.
 * Rewards deliberately ignore the multiple-monster encounter multiplier,
 * which is a building tool and never applied to awarded XP. Pure and
 * injected-input only.
 */

export const DND_5E_ENCOUNTER_REWARD_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "encounter-rewards", version: "1.0.0", status: "partial" as const }),
]);

/** Cumulative XP required to reach each character level 2-20 in SRD 5.1. */
export const SRD_LEVEL_XP_THRESHOLDS: readonly { level: number; xp: number }[] = Object.freeze([
  { level: 2, xp: 300 },
  { level: 3, xp: 900 },
  { level: 4, xp: 2700 },
  { level: 5, xp: 6500 },
  { level: 6, xp: 14000 },
  { level: 7, xp: 23000 },
  { level: 8, xp: 34000 },
  { level: 9, xp: 48000 },
  { level: 10, xp: 64000 },
  { level: 11, xp: 85000 },
  { level: 12, xp: 100000 },
  { level: 13, xp: 120000 },
  { level: 14, xp: 140000 },
  { level: 15, xp: 165000 },
  { level: 16, xp: 195000 },
  { level: 17, xp: 225000 },
  { level: 18, xp: 265000 },
  { level: 19, xp: 305000 },
  { level: 20, xp: 355000 },
].map((entry) => Object.freeze(entry)));

export type EncounterRewardDefeated = Readonly<{ challengeRating: number; count: number }>;
export type ExperienceThreshold = Readonly<{ level: number; xp: number }>;
export type EncounterRewardsInput = Readonly<{
  defeated: readonly EncounterRewardDefeated[];
  currentXp: number;
  currentLevel: number;
  thresholds?: readonly ExperienceThreshold[];
}>;
export type EncounterRewardsPlan = Readonly<{
  xpAwarded: number;
  totalXp: number;
  currentLevel: number;
  nextLevel: number | null;
  nextLevelXp: number | null;
  levelUpEligible: boolean;
  levelsGained: number;
  legal: boolean;
  reasons: readonly string[];
}>;

/**
 * Plan SRD XP rewards for defeated monsters: raw XP is added to the character's
 * total and level-up eligibility is reported against the standard SRD curve.
 */
export function planDnd5eEncounterRewards(input: EncounterRewardsInput): EncounterRewardsPlan {
  requireNonNegativeInteger(input.currentXp, "current XP");
  requireInteger(input.currentLevel, "current level");
  const thresholds = input.thresholds ?? SRD_LEVEL_XP_THRESHOLDS;
  for (const threshold of thresholds) {
    requireInteger(threshold.level, "threshold level");
    requireNonNegativeInteger(threshold.xp, "threshold XP");
  }
  const reasons: string[] = [];
  if (input.currentLevel < 1 || input.currentLevel > 20) {
    reasons.push(`current level ${input.currentLevel} is outside 1-20`);
  }
  const xpAwarded = rawEncounterXp(input.defeated);
  const totalXp = input.currentXp + xpAwarded;
  const next = thresholds.reduce<ExperienceThreshold | null>(
    (lowest, threshold) =>
      threshold.level > input.currentLevel && (lowest === null || threshold.level < lowest.level) ? threshold : lowest,
    null,
  );
  const nextLevelXp = next ? next.xp : null;
  const levelUpEligible = nextLevelXp !== null && totalXp >= nextLevelXp;
  const levelsGained = thresholds.filter((threshold) => threshold.level > input.currentLevel && threshold.xp <= totalXp).length;
  return Object.freeze({
    xpAwarded,
    totalXp,
    currentLevel: input.currentLevel,
    nextLevel: next ? next.level : null,
    nextLevelXp,
    levelUpEligible,
    levelsGained,
    legal: reasons.length === 0,
    reasons: frozenList(reasons),
  });
}
