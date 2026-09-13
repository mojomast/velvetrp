import type {
  AbilityId, AttackConditionInput, AttackConditionPlan, AttackInput, AttackResolution, CharacterDerivedInput, CharacterDerivedValues, CheckInput,
  CheckResolution, ConcentrationPlan, ConditionId, ConditionStatePlan, D20RollEvidence, D20TestInput,
  D20TestResolution, DamageAdjustment, DamageAdjustmentPlan, DamageRollInput, DamageRollResolution, EncumbranceInput, EncumbrancePlan, ExhaustionEffects,
  InitiativeEntry, InitiativeResult, LegalActionPlan, MovementInput, MovementPlan, RecoveryPlan,
  ResourceCost, ResourceCostPlan, ResourcePool, RestInput, RollMode, RulesetDescriptor, RulesetMechanics, RulesetModule,
  SkillId, SpellCostInput, SpellCostPlan, TestKind, TestResolution,
} from "./types.js";

function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer`);
}

function requireNonNegativeInteger(value: number, name: string): void {
  requireInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

function frozenList<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function dnd5eAbilityModifier(score: number): number {
  requireInteger(score, "ability score");
  return Math.floor((score - 10) / 2);
}

export function dnd5eProficiencyBonus(level: number): number {
  requireInteger(level, "level");
  if (level < 1 || level > 20) throw new RangeError("level must be between 1 and 20");
  return 2 + Math.floor((level - 1) / 4);
}

export function resolveDnd5eCheck(input: CheckInput): CheckResolution {
  requireInteger(input.d20, "d20");
  if (input.d20 < 1 || input.d20 > 20) throw new RangeError("d20 must be between 1 and 20");
  requireNonNegativeInteger(input.proficiencyBonus, "proficiency bonus");
  requireInteger(input.dc, "DC");
  const abilityModifier = dnd5eAbilityModifier(input.abilityScore);
  const total = input.d20 + abilityModifier + input.proficiencyBonus;
  return Object.freeze({ d20: input.d20, abilityModifier, proficiencyBonus: input.proficiencyBonus, total, dc: input.dc, success: total >= input.dc });
}

export function dnd5eRollMode(advantageSources = 0, disadvantageSources = 0): RollMode {
  requireNonNegativeInteger(advantageSources, "advantage sources");
  requireNonNegativeInteger(disadvantageSources, "disadvantage sources");
  if (advantageSources > 0 && disadvantageSources === 0) return "advantage";
  if (disadvantageSources > 0 && advantageSources === 0) return "disadvantage";
  return "normal";
}

function selectD20(rolls: readonly number[], mode: RollMode): D20RollEvidence {
  const expected = mode === "normal" ? 1 : 2;
  if (rolls.length !== expected) throw new RangeError(`${mode} requires exactly ${expected} d20 roll${expected === 1 ? "" : "s"}`);
  rolls.forEach((roll) => {
    requireInteger(roll, "d20");
    if (roll < 1 || roll > 20) throw new RangeError("d20 must be between 1 and 20");
  });
  const selected = mode === "advantage" ? Math.max(...rolls) : mode === "disadvantage" ? Math.min(...rolls) : rolls[0]!;
  return Object.freeze({ supplied: frozenList(rolls), mode, selectedIndex: rolls.indexOf(selected), selected });
}

export function resolveDnd5eD20Test(input: D20TestInput): D20TestResolution {
  requireInteger(input.dc, "DC");
  const proficiencyBonus = input.proficiencyBonus ?? 0;
  const proficiencyMultiplier = input.proficiencyMultiplier ?? (proficiencyBonus > 0 ? 1 : 0);
  const flatBonus = input.flatBonus ?? 0;
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  if (![0, 0.5, 1, 2].includes(proficiencyMultiplier)) throw new RangeError("proficiency multiplier must be 0, 0.5, 1, or 2");
  requireInteger(flatBonus, "flat bonus");
  const evidence = selectD20(input.rolls, dnd5eRollMode(input.advantageSources, input.disadvantageSources));
  const abilityModifier = dnd5eAbilityModifier(input.abilityScore);
  const appliedProficiency = Math.floor(proficiencyBonus * proficiencyMultiplier);
  const total = evidence.selected + abilityModifier + appliedProficiency + flatBonus;
  return Object.freeze({ evidence, abilityModifier, proficiencyBonus, proficiencyMultiplier, appliedProficiency, flatBonus, total, dc: input.dc, success: total >= input.dc });
}

/**
 * SRD 5.1 unarmed strike: a melee attack with which every creature is
 * proficient, dealing 1 + Strength modifier bludgeoning damage. A zero-count
 * die keeps the damage an explicit flat bonus while reusing the shared roll
 * and critical-hit machinery.
 */
export const DND_5E_UNARMED_STRIKE = Object.freeze({
  attackAbility: "strength" as const,
  attackType: "melee" as const,
  damageType: "bludgeoning" as const,
  damageDie: Object.freeze({ count: 0, sides: 4 }),
  flatDamageBonus: 1,
  proficient: true as const,
});

export const DND_5E_SKILL_ABILITIES: Readonly<Record<SkillId, AbilityId>> = Object.freeze({
  acrobatics: "dexterity", "animal-handling": "wisdom", arcana: "intelligence", athletics: "strength",
  deception: "charisma", history: "intelligence", insight: "wisdom", intimidation: "charisma",
  investigation: "intelligence", medicine: "wisdom", nature: "intelligence", perception: "wisdom",
  performance: "charisma", persuasion: "charisma", religion: "intelligence", "sleight-of-hand": "dexterity",
  stealth: "dexterity", survival: "wisdom",
});

export function resolveDnd5eAbilityTest(kind: Exclude<TestKind, "skill-check">, ability: AbilityId, input: D20TestInput): TestResolution {
  return Object.freeze({ ...resolveDnd5eD20Test(input), kind, ability });
}

export function resolveDnd5eSkillTest(skill: SkillId, input: D20TestInput): TestResolution {
  return Object.freeze({ ...resolveDnd5eD20Test(input), kind: "skill-check", ability: DND_5E_SKILL_ABILITIES[skill], skill });
}

export function dnd5ePassiveCheck(abilityScore: number, proficiencyBonus = 0, proficiencyMultiplier: 0 | 0.5 | 1 | 2 = proficiencyBonus > 0 ? 1 : 0, advantageSources = 0, disadvantageSources = 0): number {
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  const mode = dnd5eRollMode(advantageSources, disadvantageSources);
  const modeAdjustment = mode === "advantage" ? 5 : mode === "disadvantage" ? -5 : 0;
  return 10 + dnd5eAbilityModifier(abilityScore) + Math.floor(proficiencyBonus * proficiencyMultiplier) + modeAdjustment;
}

export function resolveDnd5eAttack(input: AttackInput): AttackResolution {
  requireInteger(input.armorClass, "armor class");
  const criticalThreshold = input.criticalThreshold ?? 20;
  requireInteger(criticalThreshold, "critical threshold");
  if (criticalThreshold < 2 || criticalThreshold > 20) throw new RangeError("critical threshold must be between 2 and 20");
  const resolution = resolveDnd5eD20Test({ ...input, dc: input.armorClass });
  const natural = resolution.evidence.selected;
  const automaticMiss = natural === 1;
  const critical = natural !== 1 && natural >= criticalThreshold;
  const hit = !automaticMiss && (critical || resolution.success);
  return Object.freeze({ ...resolution, armorClass: input.armorClass, hit, critical, automaticMiss });
}

/**
 * SRD 5.1 exhaustion: level 1 disadvantage on ability checks; level 2 speed
 * halved; level 3 disadvantage on attack rolls and saving throws; level 4 hit
 * point maximum halved; level 5 speed 0; level 6 death.
 */
export function deriveDnd5eExhaustionEffects(level: number): ExhaustionEffects {
  requireInteger(level, "exhaustion level");
  if (level < 0 || level > 6) throw new RangeError("exhaustion level must be between 0 and 6");
  return Object.freeze({
    level,
    checkDisadvantage: level >= 1,
    speedMultiplier: level >= 5 ? 0 : level >= 2 ? 0.5 : 1,
    attackDisadvantage: level >= 3,
    saveDisadvantage: level >= 3,
    hitPointMaximumMultiplier: level >= 4 ? 0.5 : 1,
  });
}

/**
 * SRD 5.1 condition effects on one attack roll. Attacker hindrances produce
 * disadvantage; a blinded, restrained, stunned, or unconscious target (and a
 * prone target in melee) produces advantage. Advantage and disadvantage from
 * any source cancel. A melee attack against an unconscious, paralyzed, or
 * petrified target is a critical hit when it hits.
 */
export function planDnd5eAttackConditions(input: AttackConditionInput): AttackConditionPlan {
  const attacker = new Set(input.attacker), target = new Set(input.target);
  let advantageSources = 0, disadvantageSources = 0;
  for (const condition of ["blinded", "poisoned", "prone", "restrained"] as const) if (attacker.has(condition)) disadvantageSources += 1;
  if (input.longRange) disadvantageSources += 1;
  if (deriveDnd5eExhaustionEffects(input.attackerExhaustion ?? 0).attackDisadvantage) disadvantageSources += 1;
  for (const condition of ["blinded", "restrained", "stunned", "unconscious"] as const) if (target.has(condition)) advantageSources += 1;
  if (target.has("prone")) { if (input.kind === "melee") advantageSources += 1; else disadvantageSources += 1; }
  const autoCritical = input.kind === "melee"
    && (target.has("unconscious") || target.has("paralyzed") || target.has("petrified"));
  return Object.freeze({ mode: dnd5eRollMode(advantageSources, disadvantageSources), autoCritical });
}

export function resolveDnd5eDamageRoll(input: DamageRollInput): DamageRollResolution {
  if (input.rolls.length !== input.dice.length) throw new RangeError("damage roll groups must match dice terms");
  const critical = input.critical ?? false;
  const evidence = input.dice.map((term, index) => {
    requireNonNegativeInteger(term.count, "die count");
    requireInteger(term.sides, "die sides");
    if (term.sides < 2) throw new RangeError("die sides must be at least 2");
    const rolls = input.rolls[index]!;
    const expected = term.count * (critical ? 2 : 1);
    if (rolls.length !== expected) throw new RangeError(`damage term requires exactly ${expected} rolls`);
    rolls.forEach((roll) => {
      requireInteger(roll, "damage die");
      if (roll < 1 || roll > term.sides) throw new RangeError(`damage die must be between 1 and ${term.sides}`);
    });
    return Object.freeze({ ...term, rolls: frozenList(rolls), subtotal: rolls.reduce((sum, roll) => sum + roll, 0) });
  });
  const modifier = input.modifier ?? 0;
  requireInteger(modifier, "damage modifier");
  return Object.freeze({ critical, evidence: frozenList(evidence), modifier, total: Math.max(0, evidence.reduce((sum, term) => sum + term.subtotal, 0) + modifier) });
}

export function planDnd5eDamageAdjustment(incoming: number, adjustment: DamageAdjustment): DamageAdjustmentPlan {
  requireNonNegativeInteger(incoming, "incoming damage");
  const applied = adjustment === "immunity" ? 0 : adjustment === "resistance" ? Math.floor(incoming / 2) : adjustment === "vulnerability" ? incoming * 2 : incoming;
  return Object.freeze({ incoming, adjustment, applied, hitPointDelta: applied === 0 ? 0 : -applied });
}

export function resolveDnd5eInitiative(entries: readonly InitiativeEntry[]): readonly InitiativeResult[] {
  const seen = new Set<string>();
  const results = entries.map((entry) => {
    if (!entry.id || seen.has(entry.id)) throw new Error(`initiative ID must be unique and non-empty: ${entry.id}`);
    seen.add(entry.id);
    requireInteger(entry.roll, "initiative roll");
    if (entry.roll < 1 || entry.roll > 20) throw new RangeError("initiative roll must be between 1 and 20");
    const dexterityModifier = dnd5eAbilityModifier(entry.dexterityScore);
    const bonus = entry.bonus ?? 0;
    requireInteger(bonus, "initiative bonus");
    return Object.freeze({ id: entry.id, roll: entry.roll, dexterityModifier, bonus, total: entry.roll + dexterityModifier + bonus });
  });
  results.sort((a, b) => b.total - a.total || b.dexterityModifier - a.dexterityModifier || a.id.localeCompare(b.id));
  return frozenList(results);
}

/**
 * SRD 5.1 carrying capacity. Encumbered (weight above 5 x Strength) reduces
 * speed by 10; heavily encumbered (above 10 x Strength) reduces speed by 20 and
 * imposes disadvantage on ability checks, saving throws, and attacks. Capacity
 * is 15 x Strength.
 */
export function planDnd5eEncumbrance(input: EncumbranceInput): EncumbrancePlan {
  requireNonNegativeInteger(input.carriedWeight, "carried weight");
  requireInteger(input.strengthScore, "strength score");
  if (input.strengthScore < 1 || input.strengthScore > 30) throw new RangeError("strength score must be between 1 and 30");
  const heavily = input.carriedWeight > input.strengthScore * 10;
  const encumbered = input.carriedWeight > input.strengthScore * 5;
  return Object.freeze({
    tier: heavily ? "heavily-encumbered" : encumbered ? "encumbered" : "unencumbered",
    carryingCapacity: input.strengthScore * 15,
    speedReduction: heavily ? 20 : encumbered ? 10 : 0,
    checkPenaltyDisadvantage: heavily,
  });
}

export function planDnd5eMovement(input: MovementInput): MovementPlan {
  requireNonNegativeInteger(input.distance, "distance");
  requireNonNegativeInteger(input.speed, "speed");
  const mode = input.mode ?? "walk";
  const specialSpeed = input.specialSpeed;
  if (specialSpeed !== undefined) requireNonNegativeInteger(specialSpeed, "special speed");
  const extraCost = input.difficultTerrain ? 1 : 0;
  const modeCost = mode === "walk" || specialSpeed !== undefined ? 1 : 2;
  const cost = input.distance * (modeCost + extraCost);
  const budget = (specialSpeed ?? input.speed) * (input.dash ? 2 : 1);
  const reasons = cost > budget ? ["movement cost exceeds available speed"] : [];
  return Object.freeze({ distance: input.distance, cost, budget, remaining: Math.max(0, budget - cost), legal: reasons.length === 0, reasons: frozenList(reasons) });
}

export function planDnd5eRest(input: RestInput): RecoveryPlan {
  requireNonNegativeInteger(input.currentHitPoints, "current hit points");
  requireNonNegativeInteger(input.maxHitPoints, "maximum hit points");
  requireNonNegativeInteger(input.hitDiceRemaining, "hit dice remaining");
  dnd5eProficiencyBonus(input.level);
  const reasons: string[] = [];
  if (input.currentHitPoints > input.maxHitPoints) reasons.push("current hit points exceed maximum hit points");
  if (input.hitDiceRemaining > input.level) reasons.push("hit dice remaining exceed level");
  const spends = input.hitDiceSpent ?? [];
  if (input.kind === "long" && spends.length > 0) reasons.push("hit dice cannot be spent as part of this long-rest plan");
  if (spends.length > input.hitDiceRemaining) reasons.push("not enough hit dice remain");
  let recovered = 0;
  spends.forEach((spend) => {
    requireInteger(spend.die, "hit die");
    requireInteger(spend.constitutionModifier, "constitution modifier");
    if (spend.die < 1) reasons.push("hit die results must be positive");
    recovered += Math.max(0, spend.die + spend.constitutionModifier);
  });
  if (input.kind === "long") recovered = Math.max(0, input.maxHitPoints - input.currentHitPoints);
  const legal = reasons.length === 0;
  const hitDiceRecovered = input.kind === "long" ? Math.min(input.level - input.hitDiceRemaining, Math.max(1, Math.floor(input.level / 2))) : 0;
  return Object.freeze({
    kind: input.kind,
    hitPointsRecovered: legal ? Math.min(recovered, Math.max(0, input.maxHitPoints - input.currentHitPoints)) : 0,
    resultingHitPoints: legal ? Math.min(input.maxHitPoints, input.currentHitPoints + recovered) : input.currentHitPoints,
    hitDiceSpent: legal && input.kind === "short" ? spends.length : 0,
    hitDiceRecovered: legal ? Math.max(0, hitDiceRecovered) : 0,
    clearExhaustionLevels: legal && input.kind === "long" && input.exhausted ? 1 : 0,
    legal,
    reasons: frozenList(reasons),
  });
}

export function planDnd5eConcentrationDamage(damage: number, concentrating: boolean, checkInput?: Omit<D20TestInput, "dc" | "abilityScore"> & Readonly<{ constitutionScore: number }>): ConcentrationPlan {
  requireNonNegativeInteger(damage, "damage");
  if (!concentrating || damage === 0) return Object.freeze({ required: false, dc: null, broken: false });
  const dc = Math.max(10, Math.floor(damage / 2));
  if (checkInput === undefined) return Object.freeze({ required: true, dc, broken: false });
  const check = resolveDnd5eAbilityTest("concentration-check", "constitution", { ...checkInput, abilityScore: checkInput.constitutionScore, dc });
  return Object.freeze({ required: true, dc, broken: !check.success, check });
}

export function planDnd5eConcentrationReplacement(currentEffectId: string | null, nextEffectId: string): LegalActionPlan<"replace-concentration", { endEffectId: string | null; startEffectId: string }> {
  const reasons = !nextEffectId ? ["next concentration effect ID is required"] : [];
  return Object.freeze({ kind: "replace-concentration", legal: reasons.length === 0, reasons: frozenList(reasons), result: reasons.length ? null : Object.freeze({ endEffectId: currentEffectId, startEffectId: nextEffectId }) });
}

export function planDnd5eCondition(before: readonly ConditionId[], operation: "add" | "remove", condition: ConditionId): ConditionStatePlan {
  const unique = [...new Set(before)];
  const present = unique.includes(condition);
  const after = operation === "add" ? (present ? unique : [...unique, condition]) : unique.filter((item) => item !== condition);
  return Object.freeze({ operation, condition, before: frozenList(unique), after: frozenList(after), changed: operation === "add" ? !present : present });
}

export function planDnd5eResourceCosts(pools: readonly ResourcePool[], costs: readonly ResourceCost[]): ResourceCostPlan {
  const reasons: string[] = [];
  const amounts = new Map<string, number>();
  const poolIds = new Set<string>();
  pools.forEach((pool) => {
    if (poolIds.has(pool.id)) reasons.push(`duplicate resource pool: ${pool.id}`);
    poolIds.add(pool.id);
    requireNonNegativeInteger(pool.current, `${pool.id} current`);
    requireNonNegativeInteger(pool.maximum, `${pool.id} maximum`);
    if (pool.current > pool.maximum) reasons.push(`${pool.id} current exceeds maximum`);
  });
  costs.forEach((cost) => {
    requireNonNegativeInteger(cost.amount, `${cost.resourceId} cost`);
    amounts.set(cost.resourceId, (amounts.get(cost.resourceId) ?? 0) + cost.amount);
  });
  amounts.forEach((amount, id) => {
    const pool = pools.find((candidate) => candidate.id === id);
    if (pool === undefined) reasons.push(`missing resource pool: ${id}`);
    else if (amount > pool.current) reasons.push(`insufficient resource: ${id}`);
  });
  const legal = reasons.length === 0;
  const resultingPools = pools.map((pool) => Object.freeze({ ...pool, current: legal ? pool.current - (amounts.get(pool.id) ?? 0) : pool.current }));
  return Object.freeze({ legal, costs: frozenList(costs.map((cost) => Object.freeze({ ...cost }))), resultingPools: frozenList(resultingPools), reasons: frozenList(reasons) });
}

export function planDnd5eSpellCost(input: SpellCostInput): SpellCostPlan {
  requireNonNegativeInteger(input.spellLevel, "spell level");
  requireNonNegativeInteger(input.slotLevel, "slot level");
  const reasons: string[] = [];
  if (input.spellLevel > 9 || input.slotLevel > 9) reasons.push("spell and slot levels must not exceed 9");
  if (input.spellLevel > 0 && input.slotLevel < input.spellLevel) reasons.push("slot level is below spell level");
  if (input.spellLevel > 0 && (input.slots[input.slotLevel] ?? 0) < 1) reasons.push("no spell slot is available at that level");
  if (input.consumesMaterial && !input.materialAvailable) reasons.push("consumed material is unavailable");
  const legal = reasons.length === 0;
  const resultingSlots = { ...input.slots };
  if (legal && input.spellLevel > 0) resultingSlots[input.slotLevel] = resultingSlots[input.slotLevel]! - 1;
  return Object.freeze({ legal, slotLevel: input.slotLevel, resultingSlots: Object.freeze(resultingSlots), consumesMaterial: legal && (input.consumesMaterial ?? false), reasons: frozenList(reasons) });
}

export function deriveDnd5eCharacter(input: CharacterDerivedInput): CharacterDerivedValues {
  const proficiencyBonus = dnd5eProficiencyBonus(input.level);
  requireInteger(input.armorBase, "armor base");
  requireNonNegativeInteger(input.speed, "speed");
  const ids: AbilityId[] = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const abilityModifiers = Object.freeze(Object.fromEntries(ids.map((id) => [id, dnd5eAbilityModifier(input.abilityScores[id])])) as unknown as Record<AbilityId, number>);
  const dexterityForArmor = input.armorDexterity === "none" ? 0 : input.armorDexterity === "maximum-2" ? Math.min(2, abilityModifiers.dexterity) : abilityModifiers.dexterity;
  const perceptionMultiplier = input.perceptionExpertise ? 2 : input.perceptionProficient ? 1 : 0;
  return Object.freeze({
    abilityModifiers,
    proficiencyBonus,
    armorClass: input.armorBase + dexterityForArmor + (input.shieldBonus ?? 0),
    initiativeModifier: abilityModifiers.dexterity,
    passivePerception: 10 + abilityModifiers.wisdom + proficiencyBonus * perceptionMultiplier,
    speed: input.speed,
  });
}

export function planDnd5eAction<TKind extends string, TResult>(kind: TKind, reasons: readonly string[], result: TResult): LegalActionPlan<TKind, TResult> {
  const legal = reasons.length === 0;
  return Object.freeze({ kind, legal, reasons: frozenList(reasons), result: legal ? result : null });
}

const abilities = Object.freeze([
  Object.freeze({ id: "strength", name: "Strength", abbreviation: "STR" }), Object.freeze({ id: "dexterity", name: "Dexterity", abbreviation: "DEX" }),
  Object.freeze({ id: "constitution", name: "Constitution", abbreviation: "CON" }), Object.freeze({ id: "intelligence", name: "Intelligence", abbreviation: "INT" }),
  Object.freeze({ id: "wisdom", name: "Wisdom", abbreviation: "WIS" }), Object.freeze({ id: "charisma", name: "Charisma", abbreviation: "CHA" }),
]);
const difficultyClasses = Object.freeze([
  Object.freeze({ id: "very-easy", name: "Very Easy", value: 5 }), Object.freeze({ id: "easy", name: "Easy", value: 10 }),
  Object.freeze({ id: "medium", name: "Medium", value: 15 }), Object.freeze({ id: "hard", name: "Hard", value: 20 }),
  Object.freeze({ id: "very-hard", name: "Very Hard", value: 25 }), Object.freeze({ id: "nearly-impossible", name: "Nearly Impossible", value: 30 }),
]);
const supportedMechanics = Object.freeze(["d20 tests and passive checks", "attacks and damage", "initiative and movement", "rests and concentration", "conditions and resource plans", "character derived values"]);
const partialCapabilities = new Set(["damage", "movement", "rests", "concentration", "conditions", "spell-costs", "derived-values", "exhaustion"]);
const capabilityVersions: Readonly<Record<string, string>> = Object.freeze({ attacks: "1.2.0", conditions: "1.1.0", damage: "1.1.0", movement: "1.1.0" });
const capabilities = Object.freeze([
  "checks", "passive-checks", "attacks", "damage", "initiative", "movement", "rests", "concentration", "conditions", "exhaustion", "resources", "spell-costs", "derived-values", "legal-action-plans",
].map((id) => Object.freeze({ id, version: capabilityVersions[id] ?? "1.0.0", status: partialCapabilities.has(id) ? "partial" as const : "supported" as const })));

export const DND_5E_RULESET_DESCRIPTOR: RulesetDescriptor = Object.freeze({
  id: "dnd-5e", version: "1.0.0", name: "SRD 5.1 (2014 Fifth Edition) Development Module",
  scope: "Pure deterministic core mechanics with explicit evidence and state-change plans; not complete D&D rules support.",
  source: Object.freeze({ title: "System Reference Document 5.1", publisher: "Wizards of the Coast LLC", edition: "2014 fifth edition", url: "https://dnd.wizards.com/resources/systems-reference-document" }),
  license: Object.freeze({ name: "Creative Commons Attribution 4.0 International", identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/legalcode", attribution: "This work includes material taken from the System Reference Document 5.1 (SRD 5.1) by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under CC-BY-4.0, available at https://creativecommons.org/licenses/by/4.0/legalcode." }),
  supportedMechanics, capabilities, abilities, difficultyClasses,
});

const DND_5E_MECHANICS: RulesetMechanics = Object.freeze({
  resolveD20Test: resolveDnd5eD20Test,
  resolveAttack: resolveDnd5eAttack,
  resolveDamageRoll: resolveDnd5eDamageRoll,
  planDamageAdjustment: planDnd5eDamageAdjustment,
  resolveInitiative: resolveDnd5eInitiative,
  planMovement: planDnd5eMovement,
  planRest: planDnd5eRest,
  planConcentrationDamage: planDnd5eConcentrationDamage,
  planCondition: planDnd5eCondition,
  planResourceCosts: planDnd5eResourceCosts,
  planSpellCost: planDnd5eSpellCost,
  deriveCharacter: deriveDnd5eCharacter,
});

export const DND_5E_RULESET: RulesetModule = Object.freeze({
  descriptor: DND_5E_RULESET_DESCRIPTOR,
  abilityModifier: dnd5eAbilityModifier,
  proficiencyBonus: dnd5eProficiencyBonus,
  resolveCheck: resolveDnd5eCheck,
  mechanics: DND_5E_MECHANICS,
});
