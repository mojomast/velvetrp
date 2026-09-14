import {
  publishContentCatalogInputSchema,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import { buildManifest } from "./manifest.js";
import { createStarterReferences } from "./references.js";
import { buildRaces } from "./races.js";
import { buildBackgrounds } from "./backgrounds.js";
import { buildClasses } from "./classes.js";
import { buildClassLevels } from "./classLevels.js";
import { buildSkills } from "./skills.js";
import { buildAbilities } from "./abilities.js";
import { buildSpells } from "./spells.js";
import { buildItems } from "./items.js";
import { buildCurrencies } from "./currencies.js";
import { buildEnemies } from "./enemies.js";
import { buildFeats } from "./feats.js";

export function buildStarterCatalog(catalogVersion: string, digest: string): PublishContentCatalogInput {
  const refs = createStarterReferences(catalogVersion);
  return publishContentCatalogInputSchema.parse({
    idempotencyKey: "srd-5.1-starter-publication-v5",
    manifest: buildManifest(catalogVersion, digest),
    definitions: [
      ...buildRaces(refs),
      ...buildBackgrounds(refs),
      ...buildClasses(refs),
      ...buildClassLevels(refs),
      ...buildSkills(refs),
      ...buildAbilities(refs),
      ...buildSpells(refs),
      ...buildItems(refs),
      ...buildCurrencies(refs),
      ...buildEnemies(refs),
      ...buildFeats(refs),
    ],
  });
}
