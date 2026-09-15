export type AbilityId = "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma";

export type AbilityDescriptor = Readonly<{ id: AbilityId | string; name: string; abbreviation: string }>;
export type DifficultyClassDescriptor = Readonly<{ id: string; name: string; value: number }>;
export type RulesetSourceDescriptor = Readonly<{ title: string; publisher: string; edition: string; url: string }>;
export type RulesetLicenseDescriptor = Readonly<{
  name: string;
  identifier: string;
  url: string;
  attribution: string;
}>;

export type RulesetCapability = Readonly<{
  id: string;
  version: string;
  status: "supported" | "partial" | "unsupported";
  notes?: string;
}>;

export type RulesetDescriptor = Readonly<{
  id: string;
  version: string;
  name: string;
  scope: string;
  source: RulesetSourceDescriptor;
  license: RulesetLicenseDescriptor;
  supportedMechanics: readonly string[];
  capabilities?: readonly RulesetCapability[];
  abilities: readonly AbilityDescriptor[];
  difficultyClasses: readonly DifficultyClassDescriptor[];
}>;

/** Legacy check contract retained for repository integrations. */
export type CheckInput = Readonly<{ d20: number; abilityScore: number; proficiencyBonus: number; dc: number }>;
export type CheckResolution = Readonly<{
  d20: number;
  abilityModifier: number;
  proficiencyBonus: number;
  total: number;
  dc: number;
  success: boolean;
}>;

export type RollMode = "normal" | "advantage" | "disadvantage";
export type D20RollEvidence = Readonly<{
  supplied: readonly number[];
  mode: RollMode;
  selectedIndex: number;
  selected: number;
}>;
export type D20TestInput = Readonly<{
  rolls: readonly number[];
  abilityScore: number;
  proficiencyBonus?: number;
  proficiencyMultiplier?: 0 | 0.5 | 1 | 2;
  flatBonus?: number;
  dc: number;
  advantageSources?: number;
  disadvantageSources?: number;
}>;
export type D20TestResolution = Readonly<{
  evidence: D20RollEvidence;
  abilityModifier: number;
  proficiencyBonus: number;
  proficiencyMultiplier: 0 | 0.5 | 1 | 2;
  appliedProficiency: number;
  flatBonus: number;
  total: number;
  dc: number;
  success: boolean;
}>;

export type SkillId =
  | "acrobatics" | "animal-handling" | "arcana" | "athletics" | "deception" | "history"
  | "insight" | "intimidation" | "investigation" | "medicine" | "nature" | "perception"
  | "performance" | "persuasion" | "religion" | "sleight-of-hand" | "stealth" | "survival";

export type TestKind = "ability-check" | "skill-check" | "saving-throw" | "concentration-check";
export type TestResolution = D20TestResolution & Readonly<{ kind: TestKind; ability: AbilityId; skill?: SkillId }>;

export type AttackInput = Omit<D20TestInput, "abilityScore" | "dc"> & Readonly<{
  abilityScore: number;
  armorClass: number;
  criticalThreshold?: number;
}>;
export type AttackResolution = D20TestResolution & Readonly<{
  armorClass: number;
  hit: boolean;
  critical: boolean;
  automaticMiss: boolean;
}>;

export type DiceTerm = Readonly<{ count: number; sides: number }>;
export type DiceTermEvidence = DiceTerm & Readonly<{ rolls: readonly number[]; subtotal: number }>;
export type DamageRollInput = Readonly<{
  dice: readonly DiceTerm[];
  rolls: readonly (readonly number[])[];
  modifier?: number;
  critical?: boolean;
}>;
export type DamageRollResolution = Readonly<{
  critical: boolean;
  evidence: readonly DiceTermEvidence[];
  modifier: number;
  total: number;
}>;
export type DamageAdjustment = "normal" | "resistance" | "vulnerability" | "immunity";
export type DamageAdjustmentPlan = Readonly<{
  incoming: number;
  adjustment: DamageAdjustment;
  applied: number;
  hitPointDelta: number;
}>;

export type InitiativeEntry = Readonly<{ id: string; dexterityScore: number; roll: number; bonus?: number }>;
export type InitiativeResult = Readonly<{
  id: string;
  roll: number;
  dexterityModifier: number;
  bonus: number;
  total: number;
}>;

export type MovementMode = "walk" | "climb" | "swim" | "crawl";
export type MovementInput = Readonly<{
  distance: number;
  speed: number;
  mode?: MovementMode;
  difficultTerrain?: boolean;
  dash?: boolean;
  specialSpeed?: number;
}>;
export type MovementPlan = Readonly<{
  distance: number;
  cost: number;
  budget: number;
  remaining: number;
  legal: boolean;
  reasons: readonly string[];
}>;

export type HitDiceSpend = Readonly<{ die: number; constitutionModifier: number }>;
export type RestInput = Readonly<{
  kind: "short" | "long";
  currentHitPoints: number;
  maxHitPoints: number;
  hitDiceRemaining: number;
  hitDiceSpent?: readonly HitDiceSpend[];
  level: number;
  exhausted?: boolean;
}>;
export type RecoveryPlan = Readonly<{
  kind: "short" | "long";
  hitPointsRecovered: number;
  resultingHitPoints: number;
  hitDiceSpent: number;
  hitDiceRecovered: number;
  clearExhaustionLevels: number;
  legal: boolean;
  reasons: readonly string[];
}>;

export type ConcentrationPlan = Readonly<{
  required: boolean;
  dc: number | null;
  broken: boolean;
  check?: TestResolution;
}>;

export type ConditionId =
  | "blinded" | "charmed" | "deafened" | "frightened" | "grappled" | "incapacitated"
  | "invisible" | "paralyzed" | "petrified" | "poisoned" | "prone" | "restrained"
  | "stunned" | "unconscious";
export type ConditionStatePlan = Readonly<{
  operation: "add" | "remove";
  condition: ConditionId;
  before: readonly ConditionId[];
  after: readonly ConditionId[];
  changed: boolean;
}>;

/** Pure input for the SRD condition effects that modify an attack roll. */
export type AttackConditionInput = Readonly<{
  attacker: readonly ConditionId[];
  target: readonly ConditionId[];
  kind: "melee" | "ranged" | "thrown";
  longRange?: boolean;
  /** Exhaustion level 3+ imposes disadvantage on attack rolls. */
  attackerExhaustion?: number;
  /** Help or hidden grants advantage on the next attack roll. */
  attackerBenefit?: boolean;
  /** A ranged attack made while a hostile is within 5 feet has disadvantage. */
  attackerInMelee?: boolean;
  /** True when the target is unseen by the attacker (heavily obscured or invisible). */
  targetUnseen?: boolean;
  /** True when the attacker is unseen by the target. */
  attackerUnseen?: boolean;
}>;
export type AttackConditionPlan = Readonly<{ mode: RollMode; autoCritical: boolean }>;

/** SRD 5.1 exhaustion levels 0-6 and their mechanical effects. */
export type ExhaustionEffects = Readonly<{
  level: number;
  checkDisadvantage: boolean;
  speedMultiplier: 0 | 0.5 | 1;
  attackDisadvantage: boolean;
  saveDisadvantage: boolean;
  hitPointMaximumMultiplier: 0.5 | 1;
}>;

/** SRD 5.1 carrying, encumbered, and heavily encumbered thresholds. */
export type EncumbranceInput = Readonly<{ carriedWeight: number; strengthScore: number }>;
export type EncumbrancePlan = Readonly<{
  tier: "unencumbered" | "encumbered" | "heavily-encumbered";
  carryingCapacity: number;
  speedReduction: number;
  checkPenaltyDisadvantage: boolean;
}>;

export type ResourcePool = Readonly<{ id: string; current: number; maximum: number }>;
export type ResourceCost = Readonly<{ resourceId: string; amount: number }>;
export type ResourceCostPlan = Readonly<{
  legal: boolean;
  costs: readonly ResourceCost[];
  resultingPools: readonly ResourcePool[];
  reasons: readonly string[];
}>;
export type SpellCostInput = Readonly<{
  spellLevel: number;
  slotLevel: number;
  slots: Readonly<Record<number, number>>;
  materialAvailable?: boolean;
  consumesMaterial?: boolean;
}>;
export type SpellCostPlan = Readonly<{
  legal: boolean;
  slotLevel: number;
  resultingSlots: Readonly<Record<number, number>>;
  consumesMaterial: boolean;
  reasons: readonly string[];
}>;

export type CharacterDerivedInput = Readonly<{
  level: number;
  abilityScores: Readonly<Record<AbilityId, number>>;
  armorBase: number;
  armorDexterity: "none" | "maximum-2" | "full";
  shieldBonus?: number;
  speed: number;
  perceptionProficient?: boolean;
  perceptionExpertise?: boolean;
}>;
export type CharacterDerivedValues = Readonly<{
  abilityModifiers: Readonly<Record<AbilityId, number>>;
  proficiencyBonus: number;
  armorClass: number;
  initiativeModifier: number;
  passivePerception: number;
  speed: number;
}>;

export type LegalActionPlan<TKind extends string = string, TResult = unknown> = Readonly<{
  kind: TKind;
  legal: boolean;
  reasons: readonly string[];
  result: TResult | null;
}>;

export type RulesetMechanics = Readonly<{
  resolveD20Test(input: D20TestInput): D20TestResolution;
  resolveAttack(input: AttackInput): AttackResolution;
  resolveDamageRoll(input: DamageRollInput): DamageRollResolution;
  planDamageAdjustment(incoming: number, adjustment: DamageAdjustment): DamageAdjustmentPlan;
  resolveInitiative(entries: readonly InitiativeEntry[]): readonly InitiativeResult[];
  planMovement(input: MovementInput): MovementPlan;
  planRest(input: RestInput): RecoveryPlan;
  planConcentrationDamage(damage: number, concentrating: boolean, checkInput?: Omit<D20TestInput, "dc" | "abilityScore"> & Readonly<{ constitutionScore: number }>): ConcentrationPlan;
  planCondition(before: readonly ConditionId[], operation: "add" | "remove", condition: ConditionId): ConditionStatePlan;
  planResourceCosts(pools: readonly ResourcePool[], costs: readonly ResourceCost[]): ResourceCostPlan;
  planSpellCost(input: SpellCostInput): SpellCostPlan;
  deriveCharacter(input: CharacterDerivedInput): CharacterDerivedValues;
}>;

export type RulesetModule = Readonly<{
  descriptor: RulesetDescriptor;
  abilityModifier(score: number): number;
  proficiencyBonus(level: number): number;
  resolveCheck(input: CheckInput): CheckResolution;
  /** Present when the descriptor advertises the corresponding versioned capabilities. */
  mechanics?: RulesetMechanics;
}>;
