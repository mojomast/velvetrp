import { createHash } from "node:crypto";
import {
  progressionCalculatorInputSchema,
  progressionPreviewSchema,
  type ProgressionCalculatorInput,
  type ProgressionPreview,
} from "@velvet/contracts";
import { calculateCharacterDerivedStats } from "./characterBuilderCalculator.js";

const refKey = (value: { packId: string; packVersion: string; kind: string; definitionId: string }) =>
  `${value.packId}\0${value.packVersion}\0${value.kind}\0${value.definitionId}`;

type ProgressionAbilityScoreIncrease = NonNullable<ProgressionPreview["levels"][number]["abilityScoreIncreases"]>[number];

/** Applies one bounded ASI distribution, or returns null when it does not exactly
 * spend the offered points on unique offered abilities. Pure; no mutation of input. */
function applyAbilityScoreIncreases(
  choice: { points: number; scores: readonly string[] },
  selection: { increases: ReadonlyArray<{ ability: { definitionId: string }; amount: number }> },
  current: Record<string, number>,
): { scores: Record<string, number>; increases: ProgressionAbilityScoreIncrease[] } | null {
  const offered = new Set<string>(choice.scores);
  const seen = new Set<string>();
  const next = { ...current };
  const increases: ProgressionAbilityScoreIncrease[] = [];
  let total = 0;
  for (const increase of selection.increases) {
    const attribute = increase.ability.definitionId;
    const currentValue = next[attribute];
    if (!offered.has(attribute) || seen.has(attribute) || typeof currentValue !== "number") return null;
    seen.add(attribute);
    total += increase.amount;
    next[attribute] = currentValue + increase.amount;
    increases.push({ attribute: attribute as ProgressionAbilityScoreIncrease["attribute"], amount: increase.amount });
  }
  if (total !== choice.points) return null;
  return { scores: next, increases };
}

/** Pure M1.4 preview. No repository, clock, IDs, RNG, network, or writes. */
export function calculateCharacterProgression(
  input: ProgressionCalculatorInput,
  rulesetIdentity?: { rulesetId: string; rulesetVersion: string },
): ProgressionPreview {
  const value = progressionCalculatorInputSchema.parse(input);
  const thresholdLevel = value.profile.mode === "xp"
    ? value.profile.thresholds.filter((threshold) => threshold.xp <= value.totalXp).at(-1)!.level
    : Math.min(value.profile.maxLevel, 1 + value.milestoneCount);
  // Compensation never silently removes an already applied level.
  const maximumClassLevel = Math.max(...value.classLevels.map((step) => step.mechanics.level));
  const eligibleLevel = Math.max(value.currentLevel, Math.min(thresholdLevel, maximumClassLevel));
  const classKey=refKey(value.selectedClassRef),seenLevels=new Set<number>();
  if (value.raceRef.kind !== "race") throw new Error("progression ancestry reference is not a race");
  for(const step of value.classLevels){if(refKey(step.mechanics.classRef)!==classKey)throw new Error("progression class level has a mismatched selected class");
    if(seenLevels.has(step.mechanics.level))throw new Error("progression catalog contains a duplicate class level");seenLevels.add(step.mechanics.level);}
  const byLevel = new Map(value.classLevels.map((step) => [step.mechanics.level, step]));
  const selections = new Map(value.selections.map((selection) => [selection.choiceId, selection]));
  const knownAbilities = new Set(value.knownAbilities.map(refKey));
  const knownSpells = new Set(value.knownSpells.map(refKey));
  const resources = new Map(value.resources.map((resource) => [resource.resourceId, { ...resource }]));
  // Ability scores are carried forward across crossed levels so every later level's
  // derived stats reflect earlier ability-score increases.
  let scores: Record<string, number> = { ...value.derivedBase.scores };
  const abilityModifier = (score: number) => Math.floor((score - 10) / 2);
  const durabilityAttribute = (candidate: Record<string, number>): string => {
    if (typeof candidate.constitution === "number") return "constitution";
    if (typeof candidate.resolve === "number") return "resolve";
    throw new Error("progression requires a durability ability score");
  };
  let derived = value.currentDerived;
  let hp = value.currentHp;
  const levels: ProgressionPreview["levels"] = [];
  const pendingChoices: ProgressionPreview["pendingChoices"] = [];
  for (let level = value.currentLevel + 1; level <= eligibleLevel; level += 1) {
    const step = byLevel.get(level);
    if (!step) throw new Error(`progression catalog has no exact class level ${level}`);
    const selectedAbilities: typeof step.mechanics.abilityRefs = [];
    const selectedFeats: NonNullable<ProgressionPreview["levels"][number]["selectedFeats"]> = [];
    const selectedSubclasses: NonNullable<ProgressionPreview["levels"][number]["selectedSubclasses"]> = [];
    const abilityScoreIncreases: NonNullable<ProgressionPreview["levels"][number]["abilityScoreIncreases"]> = [];
    // Scores as they stood before this level's ASI; `derived`/`before` were computed from them.
    const scoresBefore = scores;
    for (const choice of step.mechanics.progressionChoices ?? []) {
      const selected = selections.get(choice.choiceId);
      if (choice.kind === "ability") {
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "ability", required: true, options: choice.options });
        if (selected?.kind === "ability" && selected.ability.kind === "ability" && choice.options.some((option) => refKey(option) === refKey(selected.ability)) && !knownAbilities.has(refKey(selected.ability))) {
          selectedAbilities.push(selected.ability); knownAbilities.add(refKey(selected.ability));
        }
      } else if (choice.kind === "feat") {
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "feat", required: true, options: choice.options });
        if (selected?.kind === "feat" && selected.ability.kind === "feat" && choice.options.some((option) => refKey(option) === refKey(selected.ability))) {
          selectedFeats.push(selected.ability);
        }
      } else if (choice.kind === "subclass") {
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "subclass", required: true, options: choice.options });
        if (selected?.kind === "subclass" && selected.ability.kind === "subclass" && choice.options.some((option) => refKey(option) === refKey(selected.ability))) {
          selectedSubclasses.push(selected.ability);
        }
      } else {
        // Ability-score targets are reference-only, so the pending choice offers exact
        // ability-score references synthesized from the catalog's bounded attribute ids.
        const options = choice.scores.map((attribute) => ({ packId: step.reference.packId,
          packVersion: step.reference.packVersion, kind: "ability-score" as const, definitionId: attribute }));
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "ability-score-increase", required: true, points: choice.points, options });
        if (selected?.kind === "ability-score-increase") {
          const applied = applyAbilityScoreIncreases(choice, selected, scores);
          if (applied) { scores = applied.scores; abilityScoreIncreases.push(...applied.increases); }
        }
      }
    }
    const before = derived;
    // The repository persists race-adjusted scores; do not apply ancestry bonuses again.
    const durabilityScore = scoresBefore[durabilityAttribute(scoresBefore)];
    if (durabilityScore === undefined) throw new Error("progression requires a durability ability score");
    const after = calculateCharacterDerivedStats({ ...(rulesetIdentity ?? {}), scores: scores as typeof value.derivedBase.scores, racialBonuses: {},
      classHp: before.maxHp + step.mechanics.hpGain - abilityModifier(durabilityScore),
      raceSpeed: value.derivedBase.raceSpeed, proficiencyBonus: step.mechanics.proficiencyBonus,
      spellcastingAttribute: value.derivedBase.spellcastingAttribute });
    const hpBefore = hp;
    const damage = before.maxHp - hpBefore;
    hp = Math.max(0, after.maxHp - damage);
    const resourceChanges = (step.mechanics.resourceGrants ?? []).map((grant) => {
      const current = resources.get(grant.resourceId) ?? { resourceId: grant.resourceId, current: 0, max: 0 };
      const change = { resourceId: grant.resourceId, currentBefore: current.current, currentAfter: current.current + grant.currentIncrease,
        maxBefore: current.max, maxAfter: current.max + grant.maxIncrease };
      resources.set(grant.resourceId, { resourceId: grant.resourceId, current: change.currentAfter, max: change.maxAfter });
      return change;
    });
    const fixedAbilities = step.mechanics.abilityRefs.filter((reference) => !knownAbilities.has(refKey(reference)));
    fixedAbilities.forEach((reference) => knownAbilities.add(refKey(reference)));
    const spells = step.mechanics.spellRefs.filter((reference) => !knownSpells.has(refKey(reference)));
    spells.forEach((reference) => knownSpells.add(refKey(reference)));
    levels.push({ level, hp: { maxBefore: before.maxHp, maxAfter: after.maxHp, currentBefore: hpBefore,
      currentAfter: hp, gain: step.mechanics.hpGain }, proficiency: { before: Number(before.explanations.find((entry) => entry.statistic === "spell-attack")?.inputs.proficiencyBonus ?? step.mechanics.proficiencyBonus), after: step.mechanics.proficiencyBonus },
      resources: resourceChanges, fixedAbilities, selectedAbilities, selectedFeats, selectedSubclasses, abilityScoreIncreases, spells,
      derivedBefore: before, derivedAfter: after });
    derived = after;
  }
  const tokenPayload = { campaignCharacterId: value.campaignCharacterId, revision: value.revision, mode: value.profile.mode,
    currentLevel: value.currentLevel, eligibleLevel, totalXp: value.totalXp, milestoneCount: value.milestoneCount,
    pendingChoices, levels };
  const token = createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex");
  return progressionPreviewSchema.parse({ ...tokenPayload, token });
}
