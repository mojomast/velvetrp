import type { StarterReferences } from "../references.js";
import { fighterDefinition, fighterLevels } from "./fighter.js";
import { clericDefinition, clericLevels } from "./cleric.js";
import { barbarianDefinition, barbarianLevels } from "./barbarian.js";
import { rogueDefinition, rogueLevels } from "./rogue.js";
import { wizardDefinition, wizardLevels } from "./wizard.js";
import { paladinDefinition, paladinLevels } from "./paladin.js";
import { rangerDefinition, rangerLevels } from "./ranger.js";

export { fighterDefinition, fighterLevels } from "./fighter.js";
export { clericDefinition, clericLevels } from "./cleric.js";
export { barbarianDefinition, barbarianLevels } from "./barbarian.js";
export { rogueDefinition, rogueLevels } from "./rogue.js";
export { wizardDefinition, wizardLevels } from "./wizard.js";
export { paladinDefinition, paladinLevels } from "./paladin.js";
export { rangerDefinition, rangerLevels } from "./ranger.js";

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
