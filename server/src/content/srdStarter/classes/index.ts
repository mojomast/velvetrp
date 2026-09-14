import type { StarterReferences } from "../references.js";
import { fighterDefinition, fighterLevels } from "./fighter.js";
import { clericDefinition, clericLevels } from "./cleric.js";
import { barbarianDefinition, barbarianLevels } from "./barbarian.js";
import { rogueDefinition, rogueLevels } from "./rogue.js";
import { wizardDefinition, wizardLevels } from "./wizard.js";
import { paladinDefinition, paladinLevels } from "./paladin.js";
import { rangerDefinition, rangerLevels } from "./ranger.js";
import { bardDefinition, bardLevels, bardSubclasses } from "./bard.js";
import { druidDefinition, druidLevels, druidSubclasses } from "./druid.js";
import { monkDefinition, monkLevels, monkSubclasses } from "./monk.js";
import { sorcererDefinition, sorcererLevels, sorcererSubclasses } from "./sorcerer.js";
import { warlockDefinition, warlockLevels, warlockSubclasses } from "./warlock.js";

export { fighterDefinition, fighterLevels } from "./fighter.js";
export { clericDefinition, clericLevels } from "./cleric.js";
export { barbarianDefinition, barbarianLevels } from "./barbarian.js";
export { rogueDefinition, rogueLevels } from "./rogue.js";
export { wizardDefinition, wizardLevels } from "./wizard.js";
export { paladinDefinition, paladinLevels } from "./paladin.js";
export { rangerDefinition, rangerLevels } from "./ranger.js";
export { bardDefinition, bardLevels, bardSubclasses } from "./bard.js";
export { druidDefinition, druidLevels, druidSubclasses } from "./druid.js";
export { monkDefinition, monkLevels, monkSubclasses } from "./monk.js";
export { sorcererDefinition, sorcererLevels, sorcererSubclasses } from "./sorcerer.js";
export { warlockDefinition, warlockLevels, warlockSubclasses } from "./warlock.js";

/**
 * Class modules in canonical catalog order. Wave 2 (C2) appends one module per
 * SRD class here after its owning file lands; each module owns exactly one file
 * under `classes/`.
 */
interface ClassModule {
  definition: (refs: StarterReferences) => object;
  levels: (refs: StarterReferences) => object[];
  subclasses?: (refs: StarterReferences) => object[];
}

const classModules: readonly ClassModule[] = [
  { definition: fighterDefinition, levels: fighterLevels },
  { definition: clericDefinition, levels: clericLevels },
  { definition: barbarianDefinition, levels: barbarianLevels },
  { definition: rogueDefinition, levels: rogueLevels },
  { definition: wizardDefinition, levels: wizardLevels },
  { definition: paladinDefinition, levels: paladinLevels },
  { definition: rangerDefinition, levels: rangerLevels },
  { definition: bardDefinition, levels: bardLevels, subclasses: bardSubclasses },
  { definition: druidDefinition, levels: druidLevels, subclasses: druidSubclasses },
  { definition: monkDefinition, levels: monkLevels, subclasses: monkSubclasses },
  { definition: sorcererDefinition, levels: sorcererLevels, subclasses: sorcererSubclasses },
  { definition: warlockDefinition, levels: warlockLevels, subclasses: warlockSubclasses },
];

export function buildClasses(refs: StarterReferences): object[] {
  return classModules.map((module) => module.definition(refs));
}

export function buildClassLevels(refs: StarterReferences): object[] {
  return classModules.flatMap((module) => module.levels(refs));
}

export function buildSubclasses(refs: StarterReferences): object[] {
  return classModules.flatMap((module) => module.subclasses?.(refs) ?? []);
}
