import { createHash } from "node:crypto";
import {
  progressionCalculatorInputSchema,
  progressionPreviewSchema,
  type MulticlassProficiency,
  type ProgressionCalculatorInput,
  type ProgressionPreview,
} from "@velvet/contracts";
import { calculateCharacterDerivedStats } from "./characterBuilderCalculator.js";
import {
  multiclassClassIdFromDefinitionId,
  multiclassProficiencyGrants,
  multiclassSpellSlotsFor,
  qualifiesForMulticlass,
  type Dnd5eMulticlassLevel,
} from "./rulesets/dnd5e/multiclassing.js";
import type { AbilityId } from "./rulesets/types.js";

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
  if ((value.classProgressions?.length ?? 0) > 1 || (value.classLevelsByClass?.length ?? 0) > 1) {
    return calculateMulticlassProgression(value, rulesetIdentity);
  }
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
      } else if (choice.kind === "class") {
        // Class choices are resolved by the additive multiclass calculator; a
        // single-class input never carries them.
        throw new Error("multiclass class choice requires class progression input");
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

type ProgressionStep = ProgressionCalculatorInput["classLevels"][number];
type ProgressionClassRef = ProgressionStep["mechanics"]["classRef"];
type ResolvedMulticlassProgression = {
  classRef: ProgressionClassRef;
  steps: Map<number, ProgressionStep>;
  maximum: number;
};

/** Additive multiclass preview. It is only entered when the character holds more
 * than one class or the catalog offers an additional class, so single-class
 * characters continue through the exact original calculator path. */
function calculateMulticlassProgression(
  value: ProgressionCalculatorInput,
  rulesetIdentity?: { rulesetId: string; rulesetVersion: string },
): ProgressionPreview {
  const thresholdLevel = value.profile.mode === "xp"
    ? value.profile.thresholds.filter((threshold) => threshold.xp <= value.totalXp).at(-1)!.level
    : Math.min(value.profile.maxLevel, 1 + value.milestoneCount);
  if (value.raceRef.kind !== "race") throw new Error("progression ancestry reference is not a race");
  const progressionInputs = value.classProgressions && value.classProgressions.length > 0
    ? value.classProgressions
    : [{ classRef: value.selectedClassRef, classLevels: value.classLevels }];
  const primaryKey = refKey(value.selectedClassRef);
  const progressions = new Map<string, ResolvedMulticlassProgression>();
  let maximumTotal = 0;
  for (const entry of progressionInputs) {
    const key = refKey(entry.classRef);
    if (progressions.has(key)) throw new Error("progression contains a duplicate class");
    const steps = new Map<number, ProgressionStep>();
    for (const step of entry.classLevels) {
      if (refKey(step.mechanics.classRef) !== key) throw new Error("progression class level has a mismatched class");
      if (steps.has(step.mechanics.level)) throw new Error("progression catalog contains a duplicate class level");
      steps.set(step.mechanics.level, step);
    }
    if (!steps.size) throw new Error("progression class has no executable class levels");
    const maximum = Math.max(...steps.keys());
    maximumTotal += maximum;
    progressions.set(key, { classRef: entry.classRef, steps, maximum });
  }
  if (!progressions.has(primaryKey)) throw new Error("progression is missing the selected class");
  maximumTotal = Math.min(20, maximumTotal);
  const eligibleLevel = Math.max(value.currentLevel, Math.min(thresholdLevel, maximumTotal));
  const currentClassLevels = new Map<string, { classRef: ProgressionClassRef; level: number }>();
  for (const entry of value.classLevelsByClass ?? [{ classRef: value.selectedClassRef, level: value.currentLevel }]) {
    const key = refKey(entry.classRef);
    if (currentClassLevels.has(key)) throw new Error("progression contains a duplicate class level tally");
    currentClassLevels.set(key, { classRef: entry.classRef, level: entry.level });
  }
  const nextLevel = new Map<string, number>();
  for (const [key, entry] of currentClassLevels) nextLevel.set(key, entry.level + 1);
  const nextClassStep = (key: string): { level: number; step: ProgressionStep; classRef: ProgressionClassRef } => {
    const progression = progressions.get(key)!;
    const level = nextLevel.get(key) ?? 1;
    const step = progression.steps.get(level);
    if (!step) throw new Error(`progression class has no exact class level ${level}`);
    return { level, step, classRef: progression.classRef };
  };
  const selections = new Map(value.selections.map((selection) => [selection.choiceId, selection]));
  const knownAbilities = new Set(value.knownAbilities.map(refKey));
  const knownSpells = new Set(value.knownSpells.map(refKey));
  const resources = new Map(value.resources.map((resource) => [resource.resourceId, { ...resource }]));
  const grantedProficiencies = new Set<MulticlassProficiency>();
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
    // The primary class ladder determines the base step for this total level; a
    // resolved class choice substitutes another class's next class level.
    const primary = progressions.get(primaryKey)!;
    let advanced = primary.steps.get(level)
      ? { level, step: primary.steps.get(level)!, classRef: primary.classRef }
      : nextClassStep(primaryKey);
    const classChoice = (advanced.step.mechanics.progressionChoices ?? [])
      .find((choice) => choice.kind === "class");
    const classSelection = classChoice ? selections.get(classChoice.choiceId) : undefined;
    let granted: MulticlassProficiency[] = [];
    if (classChoice && classSelection?.kind === "class") {
      const targetKey = refKey(classSelection.ability);
      const progression = progressions.get(targetKey);
      if (!progression) throw new Error("multiclass selection is not an offered class progression");
      const target = nextClassStep(targetKey);
      const classId = multiclassClassIdFromDefinitionId(progression.classRef.definitionId);
      const firstEntry = target.level === 1 && !currentClassLevels.has(targetKey);
      if (firstEntry && classId) {
        if (!qualifiesForMulticlass(classId, scores as Record<AbilityId, number>)) {
          throw new Error(`multiclass prerequisite is not met for ${progression.classRef.definitionId}`);
        }
        granted = [...multiclassProficiencyGrants(classId, [...grantedProficiencies] as never)];
        granted.forEach((entry) => grantedProficiencies.add(entry));
      }
      advanced = target;
    }
    const advancedKey = refKey(advanced.classRef);
    nextLevel.set(advancedKey, advanced.step.mechanics.level + 1);
    currentClassLevels.set(advancedKey, { classRef: advanced.classRef, level: advanced.step.mechanics.level });
    const selectedAbilities: typeof advanced.step.mechanics.abilityRefs = [];
    const selectedFeats: NonNullable<ProgressionPreview["levels"][number]["selectedFeats"]> = [];
    const selectedSubclasses: NonNullable<ProgressionPreview["levels"][number]["selectedSubclasses"]> = [];
    const abilityScoreIncreases: NonNullable<ProgressionPreview["levels"][number]["abilityScoreIncreases"]> = [];
    const scoresBefore = scores;
    for (const choice of advanced.step.mechanics.progressionChoices ?? []) {
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
      } else if (choice.kind === "class") {
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "class", required: true, options: choice.options });
      } else {
        const options = choice.scores.map((attribute) => ({ packId: advanced.step.reference.packId,
          packVersion: advanced.step.reference.packVersion, kind: "ability-score" as const, definitionId: attribute }));
        pendingChoices.push({ level, choiceId: choice.choiceId, kind: "ability-score-increase", required: true, points: choice.points, options });
        if (selected?.kind === "ability-score-increase") {
          const applied = applyAbilityScoreIncreases(choice, selected, scores);
          if (applied) { scores = applied.scores; abilityScoreIncreases.push(...applied.increases); }
        }
      }
    }
    const before = derived;
    const durabilityScore = scoresBefore[durabilityAttribute(scoresBefore)];
    if (durabilityScore === undefined) throw new Error("progression requires a durability ability score");
    const after = calculateCharacterDerivedStats({ ...(rulesetIdentity ?? {}), scores: scores as typeof value.derivedBase.scores, racialBonuses: {},
      classHp: before.maxHp + advanced.step.mechanics.hpGain - abilityModifier(durabilityScore),
      raceSpeed: value.derivedBase.raceSpeed, proficiencyBonus: advanced.step.mechanics.proficiencyBonus,
      spellcastingAttribute: value.derivedBase.spellcastingAttribute });
    const hpBefore = hp;
    const damage = before.maxHp - hpBefore;
    hp = Math.max(0, after.maxHp - damage);
    const resourceChanges = (advanced.step.mechanics.resourceGrants ?? []).map((grant) => {
      const current = resources.get(grant.resourceId) ?? { resourceId: grant.resourceId, current: 0, max: 0 };
      const change = { resourceId: grant.resourceId, currentBefore: current.current, currentAfter: current.current + grant.currentIncrease,
        maxBefore: current.max, maxAfter: current.max + grant.maxIncrease };
      resources.set(grant.resourceId, { resourceId: grant.resourceId, current: change.currentAfter, max: change.maxAfter });
      return change;
    });
    const fixedAbilities = advanced.step.mechanics.abilityRefs.filter((reference) => !knownAbilities.has(refKey(reference)));
    fixedAbilities.forEach((reference) => knownAbilities.add(refKey(reference)));
    const spells = advanced.step.mechanics.spellRefs.filter((reference) => !knownSpells.has(refKey(reference)));
    spells.forEach((reference) => knownSpells.add(refKey(reference)));
    levels.push({ level, hp: { maxBefore: before.maxHp, maxAfter: after.maxHp, currentBefore: hpBefore,
      currentAfter: hp, gain: advanced.step.mechanics.hpGain },
      proficiency: { before: Number(before.explanations.find((entry) => entry.statistic === "spell-attack")?.inputs.proficiencyBonus ?? advanced.step.mechanics.proficiencyBonus), after: advanced.step.mechanics.proficiencyBonus },
      resources: resourceChanges, fixedAbilities, selectedAbilities, selectedFeats, selectedSubclasses, abilityScoreIncreases, spells,
      classRef: advanced.classRef, classLevel: advanced.step.mechanics.level,
      ...(granted.length ? { grantedProficiencies: granted } : {}),
      derivedBefore: before, derivedAfter: after });
    derived = after;
  }
  const classLevelsByClass = [...currentClassLevels.values()]
    .map((entry) => ({ classRef: entry.classRef, level: entry.level }))
    .sort((left, right) => refKey(left.classRef).localeCompare(refKey(right.classRef)));
  const casterLevels: Dnd5eMulticlassLevel[] = [];
  for (const entry of currentClassLevels.values()) {
    const classId = multiclassClassIdFromDefinitionId(entry.classRef.definitionId);
    if (classId) casterLevels.push({ classId, level: entry.level });
  }
  const spellSlots = classLevelsByClass.length > 1 ? multiclassSpellSlotsFor(casterLevels) : undefined;
  const tokenPayload = { campaignCharacterId: value.campaignCharacterId, revision: value.revision, mode: value.profile.mode,
    currentLevel: value.currentLevel, eligibleLevel, totalXp: value.totalXp, milestoneCount: value.milestoneCount,
    pendingChoices, levels, classLevelsByClass, ...(spellSlots ? { spellSlots } : {}) };
  const token = createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex");
  return progressionPreviewSchema.parse({ ...tokenPayload, token });
}
