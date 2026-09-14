import type { StarterReferences } from "../references.js";
import { magicArmorWeapons } from "./armor-weapons.js";
import { magicPotionsScrolls } from "./potions-scrolls.js";
import { magicRings } from "./rings.js";
import { magicRodsStaffsWands } from "./rods-staffs-wands.js";
import { magicWondrousAM } from "./wondrous-a-m.js";
import { magicWondrousNZ } from "./wondrous-n-z.js";

export type MagicItemBuilder = (refs: StarterReferences) => object[];

export { magicArmorWeapons } from "./armor-weapons.js";
export { magicPotionsScrolls } from "./potions-scrolls.js";
export { magicRings } from "./rings.js";
export { magicRodsStaffsWands } from "./rods-staffs-wands.js";
export { magicWondrousAM } from "./wondrous-a-m.js";
export { magicWondrousNZ } from "./wondrous-n-z.js";

/**
 * SRD 5.1 magic items, one file per category under `magicItems/`. `mechanics.magic`
 * drives the encounter magic-item engine via magicItemDefinitionFromCatalog().
 */
const magicItemModules: readonly MagicItemBuilder[] = [
  magicArmorWeapons,
  magicPotionsScrolls,
  magicRings,
  magicRodsStaffsWands,
  magicWondrousAM,
  magicWondrousNZ,
];

export function buildMagicItems(refs: StarterReferences): object[] {
  return magicItemModules.flatMap((build) => build(refs));
}
