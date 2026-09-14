import type { StarterReferences } from "../references.js";
import { buildLevel0Spells } from "./level-0.js";
import { buildLevel1Spells } from "./level-1.js";

export { buildLevel0Spells } from "./level-0.js";
export { buildLevel1Spells } from "./level-1.js";

/**
 * Spell level bands in ascending order. Wave 2 (C3) adds one file per band
 * under `spells/` and registers its builder here.
 */
const spellLevelBands = [buildLevel0Spells, buildLevel1Spells];

export function buildSpells(refs: StarterReferences): object[] {
  return spellLevelBands.flatMap((build) => build(refs));
}
