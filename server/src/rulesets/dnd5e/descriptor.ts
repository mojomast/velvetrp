import type { RulesetDescriptor, RulesetMechanics, RulesetModule } from "../types.js";
import { resolveDnd5eAttack } from "./attack.js";
import { DND_5E_RULESET_CAPABILITIES } from "./capabilities.js";
import { planDnd5eConcentrationDamage, planDnd5eCondition } from "./conditions.js";
import { planDnd5eDamageAdjustment, resolveDnd5eDamageRoll } from "./damage.js";
import {
  dnd5eAbilityModifier, dnd5eProficiencyBonus, resolveDnd5eCheck, resolveDnd5eD20Test,
} from "./d20.js";
import { deriveDnd5eCharacter } from "./derived.js";
import { planDnd5eMovement, resolveDnd5eInitiative } from "./movement.js";
import { planDnd5eResourceCosts, planDnd5eSpellCost } from "./resources.js";
import { planDnd5eRest } from "./rests.js";

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

export const DND_5E_RULESET_DESCRIPTOR: RulesetDescriptor = Object.freeze({
  id: "dnd-5e", version: "1.0.0", name: "SRD 5.1 (2014 Fifth Edition) Development Module",
  scope: "Pure deterministic core mechanics with explicit evidence and state-change plans; not complete D&D rules support.",
  source: Object.freeze({ title: "System Reference Document 5.1", publisher: "Wizards of the Coast LLC", edition: "2014 fifth edition", url: "https://dnd.wizards.com/resources/systems-reference-document" }),
  license: Object.freeze({ name: "Creative Commons Attribution 4.0 International", identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/legalcode", attribution: "This work includes material taken from the System Reference Document 5.1 (SRD 5.1) by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under CC-BY-4.0, available at https://creativecommons.org/licenses/by/4.0/legalcode." }),
  supportedMechanics, capabilities: DND_5E_RULESET_CAPABILITIES, abilities, difficultyClasses,
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
