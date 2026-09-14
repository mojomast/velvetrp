import type { StarterReferences } from "../references.js";
import { buildLevel0Spells } from "./level-0.js";
import { buildLevel1Spells } from "./level-1.js";
import { buildLevel2Spells } from "./level-2.js";
import { buildLevel3Spells } from "./level-3.js";
import { buildLevel4Spells } from "./level-4.js";
import { buildLevel5Spells } from "./level-5.js";
import { buildLevel6Spells } from "./level-6.js";
import { buildLevel7Spells } from "./level-7.js";
import { buildLevel8Spells } from "./level-8.js";
import { buildLevel9Spells } from "./level-9.js";

export { buildLevel0Spells } from "./level-0.js";
export { buildLevel1Spells } from "./level-1.js";
export { buildLevel2Spells } from "./level-2.js";
export { buildLevel3Spells } from "./level-3.js";
export { buildLevel4Spells } from "./level-4.js";
export { buildLevel5Spells } from "./level-5.js";
export { buildLevel6Spells } from "./level-6.js";
export { buildLevel7Spells } from "./level-7.js";
export { buildLevel8Spells } from "./level-8.js";
export { buildLevel9Spells } from "./level-9.js";

/**
 * Spell level bands in ascending order. Each file under `spells/` owns one
 * band; Wave 2 (C3) registers its builder here.
 */
type SpellBandBuilder = (refs: StarterReferences) => object[];

const spellLevelBands: readonly SpellBandBuilder[] = [
  buildLevel0Spells,
  buildLevel1Spells,
  buildLevel2Spells,
  buildLevel3Spells,
  buildLevel4Spells,
  buildLevel5Spells,
  buildLevel6Spells,
  buildLevel7Spells,
  buildLevel8Spells,
  buildLevel9Spells,
];

export function buildSpells(refs: StarterReferences): object[] {
  return spellLevelBands.flatMap((build) => build(refs));
}
