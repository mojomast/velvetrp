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

/** Pure M1.4 preview. No repository, clock, IDs, RNG, network, or writes. */
export function calculateCharacterProgression(input: ProgressionCalculatorInput): ProgressionPreview {
  const value = progressionCalculatorInputSchema.parse(input);
  const thresholdLevel = value.profile.mode === "xp"
    ? value.profile.thresholds.filter((threshold) => threshold.xp <= value.totalXp).at(-1)!.level
    : Math.min(value.profile.maxLevel, 1 + value.milestoneCount);
  // Compensation never silently removes an already applied level.
  const eligibleLevel = Math.max(value.currentLevel, thresholdLevel);
  const classKey=refKey(value.selectedClassRef),seenLevels=new Set<number>();
  for(const step of value.classLevels){if(refKey(step.mechanics.classRef)!==classKey)throw new Error("progression class level has a mismatched selected class");
    if(seenLevels.has(step.mechanics.level))throw new Error("progression catalog contains a duplicate class level");seenLevels.add(step.mechanics.level);}
  const byLevel = new Map(value.classLevels.map((step) => [step.mechanics.level, step]));
  const selections = new Map(value.selections.map((selection) => [selection.choiceId, selection.ability]));
  const knownAbilities = new Set(value.knownAbilities.map(refKey));
  const knownSpells = new Set(value.knownSpells.map(refKey));
  const resources = new Map(value.resources.map((resource) => [resource.resourceId, { ...resource }]));
  let derived = value.currentDerived;
  let hp = value.currentHp;
  const levels: ProgressionPreview["levels"] = [];
  const pendingChoices: ProgressionPreview["pendingChoices"] = [];
  for (let level = value.currentLevel + 1; level <= eligibleLevel; level += 1) {
    const step = byLevel.get(level);
    if (!step) throw new Error(`progression catalog has no exact class level ${level}`);
    const selectedAbilities: typeof step.mechanics.abilityRefs = [];
    for (const choice of step.mechanics.progressionChoices ?? []) {
      const pending = { level, choiceId: choice.choiceId, kind: "ability" as const, required: true as const, options: choice.options };
      pendingChoices.push(pending);
      const selected = selections.get(choice.choiceId);
      if (selected && choice.options.some((option) => refKey(option) === refKey(selected)) && !knownAbilities.has(refKey(selected))) {
        selectedAbilities.push(selected); knownAbilities.add(refKey(selected));
      }
    }
    const before = derived;
    const after = calculateCharacterDerivedStats({ scores: value.derivedBase.scores, racialBonuses: {},
      classHp: before.maxHp + step.mechanics.hpGain - Math.floor((value.derivedBase.scores.resolve - 10) / 2),
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
      resources: resourceChanges, fixedAbilities, selectedAbilities, spells,
      derivedBefore: before, derivedAfter: after });
    derived = after;
  }
  const tokenPayload = { campaignCharacterId: value.campaignCharacterId, revision: value.revision, mode: value.profile.mode,
    currentLevel: value.currentLevel, eligibleLevel, totalXp: value.totalXp, milestoneCount: value.milestoneCount,
    pendingChoices, levels };
  const token = createHash("sha256").update(JSON.stringify(tokenPayload)).digest("hex");
  return progressionPreviewSchema.parse({ ...tokenPayload, token });
}
