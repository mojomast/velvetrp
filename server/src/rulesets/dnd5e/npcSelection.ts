import type { RulesetCapability } from "../types.js";
import { monsterXp } from "./encounterXp.js";
import { frozenList, requireNonNegativeInteger } from "./internal.js";

/**
 * Deterministic NPC/stat-block selection for SRD 5.1. Given pinned monster
 * templates, an optional role, and an inclusive challenge-rating band, it picks
 * the lowest-challenge eligible candidates first with a stable id tiebreak.
 * Pure and injected-input only; no storage, randomness, or ordering surprises.
 */

const MAX_SELECTION_COUNT = 32;

export type Dnd5eNpcCandidate = Readonly<{
  id: string;
  challengeRating: number;
  roles?: readonly string[];
  tags?: readonly string[];
}>;

export type Dnd5eNpcSelectionInput = Readonly<{
  candidates: readonly Dnd5eNpcCandidate[];
  role?: string;
  minChallengeRating?: number;
  maxChallengeRating?: number;
  count: number;
  excludeIds?: readonly string[];
}>;

export type Dnd5eNpcSelected = Readonly<{ id: string; challengeRating: number }>;

export type Dnd5eNpcSelectionResult = Readonly<{
  selected: readonly Dnd5eNpcSelected[];
  legal: boolean;
  reasons: readonly string[];
}>;

export const DND_5E_NPC_SELECTION_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "npc-selection", version: "1.0.0", status: "partial" as const }),
]);

/** Order by SRD XP value so fractional challenge ratings sort correctly. */
function compareChallengeRatings(left: number, right: number): number {
  const leftXp = monsterXp(left);
  const rightXp = monsterXp(right);
  if (leftXp !== rightXp) return leftXp - rightXp;
  return left - right;
}

export function selectDnd5eNpcStatBlocks(input: Dnd5eNpcSelectionInput): Dnd5eNpcSelectionResult {
  requireNonNegativeInteger(input.count, "count");
  if (input.count < 1) throw new RangeError("count must be a positive integer");
  if (input.count > MAX_SELECTION_COUNT) throw new RangeError(`count must not exceed ${MAX_SELECTION_COUNT}`);

  const seenIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (seenIds.has(candidate.id)) throw new RangeError(`duplicate candidate id: ${candidate.id}`);
    seenIds.add(candidate.id);
    monsterXp(candidate.challengeRating);
  }

  const excluded = new Set(input.excludeIds ?? []);
  const minXp = input.minChallengeRating === undefined ? undefined : monsterXp(input.minChallengeRating);
  const maxXp = input.maxChallengeRating === undefined ? undefined : monsterXp(input.maxChallengeRating);

  const eligible = input.candidates.filter((candidate) => {
    if (excluded.has(candidate.id)) return false;
    if (input.role !== undefined && !(candidate.roles ?? []).includes(input.role)) return false;
    const xp = monsterXp(candidate.challengeRating);
    if (minXp !== undefined && xp < minXp) return false;
    if (maxXp !== undefined && xp > maxXp) return false;
    return true;
  });

  const ordered = [...eligible].sort((left, right) => {
    const byChallenge = compareChallengeRatings(left.challengeRating, right.challengeRating);
    if (byChallenge !== 0) return byChallenge;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const selected = ordered.slice(0, input.count).map((candidate) => Object.freeze({
    id: candidate.id,
    challengeRating: candidate.challengeRating,
  }));

  const reasons: string[] = [];
  const legal = selected.length === input.count;
  if (!legal) reasons.push(`only ${selected.length} of ${input.count} requested NPC stat blocks are available`);

  return Object.freeze({
    selected: frozenList(selected),
    legal,
    reasons: frozenList(reasons),
  });
}
