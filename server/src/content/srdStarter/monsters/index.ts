import type { StarterReferences } from "../references.js";
import type { MonsterBandBuilder } from "./enemyBuilder.js";
import { cr1Band } from "./cr-1.js";
import { cr2Band } from "./cr-2.js";
import { cr3Band } from "./cr-3.js";
import { cr4Band } from "./cr-4.js";
import { cr5Band } from "./cr-5.js";
import { cr6To7Band } from "./cr-6-7.js";
import { cr8To9Band } from "./cr-8-9.js";
import { cr10To11Band } from "./cr-10-11.js";
import { cr12To14Band } from "./cr-12-14.js";
import { cr15To16Band } from "./cr-15-16.js";
import { cr17To20Band } from "./cr-17-20.js";
import { cr21To30Band } from "./cr-21-30.js";

export * from "./enemyBuilder.js";
export { cr1Band } from "./cr-1.js";
export { cr2Band } from "./cr-2.js";
export { cr3Band } from "./cr-3.js";
export { cr4Band } from "./cr-4.js";
export { cr5Band } from "./cr-5.js";
export { cr6To7Band } from "./cr-6-7.js";
export { cr8To9Band } from "./cr-8-9.js";
export { cr10To11Band } from "./cr-10-11.js";
export { cr12To14Band } from "./cr-12-14.js";
export { cr15To16Band } from "./cr-15-16.js";
export { cr17To20Band } from "./cr-17-20.js";
export { cr21To30Band } from "./cr-21-30.js";

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
  cr6To7Band,
  cr8To9Band,
  cr10To11Band,
  cr12To14Band,
  cr15To16Band,
  cr17To20Band,
  cr21To30Band,
];

export function buildMonsterAbilities(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).abilities);
}

export function buildMonsterEnemies(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).enemies);
}
