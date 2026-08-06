import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { buildApp } from "../../server/src/app.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";
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

// M2.2 membership commands require a principal other than the fixed local owner.
// Seed it before the app lazily opens its repository against this disposable DB.
const repository = createRepository({ dataDir, rng: reviewedDiceRng });
repository.close();
const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
  .run("e2e-membership-principal", "E2E membership principal");
db.close();

const port = Number(process.env.PORT ?? 18787);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp({
  campaignRepositoryFactory: () => createRepository({ dataDir, rng: reviewedDiceRng }),
});

const waylamp = {
  kind: "item" as const,
  packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
  definitionId: "velvet:mechanics:item:waylamp",
};

// This route is available only on the disposable deterministic E2E server. It
// materializes one reviewed catalog item after proving the actor is visible.
app.post("/api/__e2e/materialize-waylamp", async (request, reply) => {
  const body = request.body as { campaignId?: unknown; actorId?: unknown; entryId?: unknown; expectedRevision?: unknown };
  if (typeof body.campaignId !== "string" || typeof body.actorId !== "string" || typeof body.entryId !== "string" || typeof body.expectedRevision !== "number") {
    return reply.code(400).send({ error: "invalid E2E Waylamp materialization request" });
  }
  const materializer = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    const snapshot = materializer.getActorInventorySnapshot("local-owner", body.campaignId, body.actorId);
    if (!snapshot || snapshot.revision !== body.expectedRevision) return reply.code(409).send({ error: "stale or unavailable E2E actor" });
    const fixtureDb = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
    try {
      fixtureDb.pragma("foreign_keys = ON");
      fixtureDb.transaction(() => {
        fixtureDb.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'item',?)")
          .run(body.campaignId, waylamp.packId, waylamp.packVersion, waylamp.definitionId);
        fixtureDb.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'instanced',1,?,NULL,0,?)")
          .run(body.entryId, body.campaignId, body.actorId, waylamp.packId, waylamp.packVersion, waylamp.definitionId, body.entryId, "2035-01-01T00:00:00.000Z");
      })();
    } finally {
      fixtureDb.close();
    }
    return reply.code(204).send();
  } finally {
    materializer.close();
  }
});

app.listen({ port, host }).then(() => {
  app.log.info(`isolated deterministic E2E server listening on http://${host}:${port}`);
}).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
