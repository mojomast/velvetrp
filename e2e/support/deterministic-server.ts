import { buildApp } from "../../server/src/app.js";
import { createRepository } from "../../server/src/repo/index.js";
import type { RandomNumberGenerator } from "../../server/src/runtime.js";

// This dependency exists only in the isolated disposable E2E server. Keep the
// expected call range explicit so a mechanics change cannot silently consume a
// different deterministic sequence or weaken production randomness.
const reviewedDiceRng: RandomNumberGenerator = {
  integer(minInclusive, maxExclusive) {
    if (minInclusive !== 1 || maxExclusive !== 3) {
      throw new Error(`unexpected E2E dice RNG range [${minInclusive}, ${maxExclusive})`);
    }
    return 2;
  },
};

const dataDir = process.env.VELVET_DATA_DIR;
if (!dataDir) throw new Error("VELVET_DATA_DIR is required for deterministic E2E");

const port = Number(process.env.PORT ?? 18787);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp({
  campaignRepositoryFactory: () => createRepository({ dataDir, rng: reviewedDiceRng }),
});

app.listen({ port, host }).then(() => {
  app.log.info(`isolated deterministic E2E server listening on http://${host}:${port}`);
}).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
