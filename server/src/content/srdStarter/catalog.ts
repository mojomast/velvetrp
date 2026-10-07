import {
  publishContentCatalogInputSchema,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import { buildManifest } from "./manifest.js";
import { createStarterReferences } from "./references.js";
import { buildRaces } from "./races.js";
import { buildBackgrounds } from "./backgrounds.js";
import { buildClasses, buildClassLevels, buildSubclasses } from "./classes/index.js";
import { buildSkills } from "./skills.js";
import { buildAbilities } from "./abilities.js";
import { buildSpells } from "./spells/index.js";
import { buildItems } from "./items.js";
import { buildMagicItems } from "./magicItems/index.js";
import { buildCurrencies } from "./currencies.js";
import { buildEnemies } from "./enemies.js";
import { buildMonsterAbilities, buildMonsterEnemies } from "./monsters/index.js";
import { buildFeats } from "./feats.js";
import { buildAdditionalGear } from "./additionalGear.js";
import { buildAdditionalWeapons } from "./additionalWeapons.js";
import { buildAdditionalAncestries } from "./additionalAncestries.js";
import { buildAdditionalSpellReferences } from "./additionalSpellReferences.js";

export function buildStarterCatalog(catalogVersion: string, digest: string): PublishContentCatalogInput {
  const refs = createStarterReferences(catalogVersion);
  return publishContentCatalogInputSchema.parse({
    idempotencyKey: "srd-5.1-starter-publication-v6",
    manifest: buildManifest(catalogVersion, digest),
    definitions: [
      ...buildRaces(refs),
      ...buildAdditionalAncestries(refs),
      ...buildBackgrounds(refs),
      ...buildClasses(refs),
      ...buildClassLevels(refs),
      ...buildSubclasses(refs),
      ...buildSkills(refs),
      ...buildAbilities(refs),
      ...buildMonsterAbilities(refs),
      ...buildSpells(refs),
      ...buildAdditionalSpellReferences(refs),
      ...buildItems(refs),
      ...buildAdditionalGear(refs),
      ...buildAdditionalWeapons(refs),
      ...buildMagicItems(refs),
      ...buildCurrencies(refs),
      ...buildEnemies(refs),
      ...buildMonsterEnemies(refs),
      ...buildFeats(refs),
    ],
  });
}
