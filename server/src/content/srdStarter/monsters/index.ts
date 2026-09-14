import type { StarterReferences } from "../references.js";
import type { MonsterBandBuilder } from "./enemyBuilder.js";
import { cr1Band } from "./cr-1.js";
import { cr2Band } from "./cr-2.js";
import { cr3Band } from "./cr-3.js";
import { cr4Band } from "./cr-4.js";
import { cr5Band } from "./cr-5.js";

export * from "./enemyBuilder.js";
export { cr1Band } from "./cr-1.js";
export { cr2Band } from "./cr-2.js";
export { cr3Band } from "./cr-3.js";
export { cr4Band } from "./cr-4.js";
export { cr5Band } from "./cr-5.js";

/**
 * Higher-CR SRD monster bands. Each file under `monsters/` owns one band and
 * exports a `band(refs)`; Wave 2 (C4) registers its builder here. The original
 * low-CR profiles remain in `enemies.ts`/`abilities.ts`.
 */
const monsterBands: readonly MonsterBandBuilder[] = [
  cr1Band,
  cr2Band,
  cr3Band,
  cr4Band,
  cr5Band,
];

export function buildMonsterAbilities(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).abilities);
}

export function buildMonsterEnemies(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).enemies);
}
