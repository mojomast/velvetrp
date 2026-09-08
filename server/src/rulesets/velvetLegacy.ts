import type { CheckInput, CheckResolution, RulesetDescriptor, RulesetModule } from "./types.js";

export const VELVET_LEGACY_RULESET_DESCRIPTOR: RulesetDescriptor = Object.freeze({
  id: "velvet-starter-v1",
  version: "1.0.0",
  name: "Velvet Starter Legacy Adapter",
  scope: "Behavior-preserving adapter for existing Velvet starter campaigns.",
  source: Object.freeze({ title: "Velvet Starter Rules", publisher: "Velvet", edition: "starter-v1", url: "https://github.com/" }),
  license: Object.freeze({ name: "Original project material", identifier: "Proprietary-original", url: "https://github.com/", attribution: "Original Velvet project mechanics." }),
  supportedMechanics: Object.freeze(["legacy character builder", "legacy checks", "legacy progression", "legacy combat"]),
  capabilities: Object.freeze([
    Object.freeze({ id: "character-builder", version: "1.0.0", status: "supported" as const }),
    Object.freeze({ id: "checks", version: "1.0.0", status: "supported" as const }),
    Object.freeze({ id: "progression", version: "1.0.0", status: "supported" as const }),
    Object.freeze({ id: "attacks", version: "1.0.0", status: "supported" as const }),
  ]),
  abilities: Object.freeze([
    Object.freeze({ id: "might", name: "Might", abbreviation: "MGT" }),
    Object.freeze({ id: "agility", name: "Agility", abbreviation: "AGI" }),
    Object.freeze({ id: "resolve", name: "Resolve", abbreviation: "RES" }),
    Object.freeze({ id: "insight", name: "Insight", abbreviation: "INS" }),
    Object.freeze({ id: "presence", name: "Presence", abbreviation: "PRE" }),
    Object.freeze({ id: "craft", name: "Craft", abbreviation: "CRF" }),
  ]),
  difficultyClasses: Object.freeze([
    Object.freeze({ id: "easy", name: "Easy", value: 8 }),
    Object.freeze({ id: "standard", name: "Standard", value: 10 }),
    Object.freeze({ id: "hard", name: "Hard", value: 12 }),
    Object.freeze({ id: "very-hard", name: "Very Hard", value: 15 }),
  ]),
});

const abilityModifier = (score: number): number => {
  if (!Number.isInteger(score)) throw new RangeError("ability score must be an integer");
  return Math.floor((score - 10) / 2);
};

const resolveCheck = (input: CheckInput): CheckResolution => {
  if (!Number.isInteger(input.d20) || input.d20 < 1 || input.d20 > 20) throw new RangeError("d20 must be between 1 and 20");
  const modifier = abilityModifier(input.abilityScore);
  const total = input.d20 + modifier + input.proficiencyBonus;
  return Object.freeze({ d20: input.d20, abilityModifier: modifier, proficiencyBonus: input.proficiencyBonus, total, dc: input.dc, success: total >= input.dc });
};

export const VELVET_LEGACY_RULESET: RulesetModule = Object.freeze({
  descriptor: VELVET_LEGACY_RULESET_DESCRIPTOR,
  abilityModifier,
  proficiencyBonus: (level) => {
    if (!Number.isInteger(level) || level < 1 || level > 20) throw new RangeError("level must be between 1 and 20");
    return 2 + Math.floor((level - 1) / 4);
  },
  resolveCheck,
});
