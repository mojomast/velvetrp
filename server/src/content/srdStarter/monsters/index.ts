import type { StarterReferences } from "../references.js";
import type { MonsterBandBuilder } from "./enemyBuilder.js";

export * from "./enemyBuilder.js";

/**
 * Higher-CR SRD monster bands. Each file under `monsters/` owns one band and
 * exports a `band(refs)`; Wave 2 (C4) registers its builder here. The original
 * low-CR profiles remain in `enemies.ts`/`abilities.ts`.
 */
const monsterBands: readonly MonsterBandBuilder[] = [];

export function buildMonsterAbilities(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).abilities);
}

export function buildMonsterEnemies(refs: StarterReferences): object[] {
  return monsterBands.flatMap((band) => band(refs).enemies);
}
