import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { calculateCatalogDigest } from "../repo/contentCatalog/index.js";
import { buildStarterCatalog, deepFreeze } from "./srdStarter/index.js";

const draft = buildStarterCatalog("1.0.0+000000000000", "0".repeat(64));
const digest = calculateCatalogDigest(draft);
if (!SRD_5_1_STARTER_IDENTITY.packVersion.endsWith(digest.slice(0, 12))) {
  throw new Error(`SRD starter contract identity must end in ${digest.slice(0, 12)}`);
}

export const SRD_5_1_STARTER_CATALOG = deepFreeze(buildStarterCatalog(SRD_5_1_STARTER_IDENTITY.packVersion, digest));
