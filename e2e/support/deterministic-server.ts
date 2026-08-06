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
const glimmer = {
  kind: "currency" as const,
  packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
  definitionId: "velvet:mechanics:currency:glimmer",
};
const economyFixture = { currencyCode: "GLM", shopId: "e2e-waylamp-shop", stockId: "e2e-waylamp-stock" };

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

// This fixture bypasses no production command: it creates the depleted,
// explicitly short-rest-bound state that finalized character construction does
// not otherwise provide.
app.post("/api/__e2e/materialize-short-rest-resource", async (request, reply) => {
  const body = request.body as { campaignId?: unknown; actorId?: unknown; expectedRevision?: unknown };
  if (typeof body.campaignId !== "string" || typeof body.actorId !== "string" || typeof body.expectedRevision !== "number") {
    return reply.code(400).send({ error: "invalid E2E short-rest resource materialization request" });
  }
  const materializer = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    const snapshot = materializer.getActorResourceSnapshot("local-owner", body.campaignId, body.actorId);
    if (!snapshot || snapshot.revision !== body.expectedRevision) return reply.code(409).send({ error: "stale or unavailable E2E actor" });
    const fixtureDb = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
    try {
      fixtureDb.pragma("foreign_keys = ON");
      fixtureDb.transaction(() => {
        fixtureDb.prepare("INSERT INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?, 'focus',1,4)")
          .run(body.campaignId, body.actorId);
        fixtureDb.prepare("INSERT INTO rpg_actor_resource_bindings_v25(campaign_id,actor_id,resource_name,binding_key,binding_json) VALUES(?,?, 'focus','ability',?)")
          .run(body.campaignId, body.actorId, JSON.stringify({ kind: "ability", recovery: "short-rest" }));
      })();
    } finally {
      fixtureDb.close();
    }
    return reply.code(204).send();
  } finally {
    materializer.close();
  }
});

// This reviewed fixture creates the pinned catalog identities and the minimum
// durable economy state required to exercise quote and purchase commands.
app.post("/api/__e2e/materialize-economy-fixture", async (request, reply) => {
  const body = request.body as { campaignId?: unknown; actorId?: unknown; expectedRevision?: unknown };
  if (typeof body.campaignId !== "string" || typeof body.actorId !== "string" || typeof body.expectedRevision !== "number") {
    return reply.code(400).send({ error: "invalid E2E economy materialization request" });
  }
  const materializer = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    const snapshot = materializer.getActorInventorySnapshot("local-owner", body.campaignId, body.actorId);
    if (!snapshot || snapshot.revision !== body.expectedRevision) return reply.code(409).send({ error: "stale or unavailable E2E actor" });
    const fixtureDb = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
    try {
      fixtureDb.pragma("foreign_keys = ON");
      fixtureDb.transaction(() => {
        for (const definition of [waylamp, glimmer]) {
          fixtureDb.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)")
            .run(body.campaignId, definition.packId, definition.packVersion, definition.kind, definition.definitionId);
        }
        fixtureDb.prepare("INSERT INTO rpg_currency_references_v25(campaign_id,currency_code,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?,?)")
          .run(body.campaignId, economyFixture.currencyCode, glimmer.packId, glimmer.packVersion, glimmer.kind, glimmer.definitionId);
        fixtureDb.prepare("INSERT INTO rpg_wallets_v25(campaign_id,actor_id,currency_code,balance_minor,updated_at) VALUES(?,?,?,?,?)")
          .run(body.campaignId, body.actorId, economyFixture.currencyCode, 20, "2035-01-01T00:00:00.000Z");
        fixtureDb.prepare("INSERT INTO rpg_shop_definitions_v25(shop_id,campaign_id,name,created_at) VALUES(?,?,?,?)")
          .run(economyFixture.shopId, body.campaignId, "E2E Waylamp Shop", "2035-01-01T00:00:00.000Z");
        fixtureDb.prepare("INSERT INTO rpg_shop_stock_v25(stock_id,campaign_id,shop_id,item_pack_id,item_pack_version,item_kind,item_definition_id,available_quantity,unit_price_minor,currency_code) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(economyFixture.stockId, body.campaignId, economyFixture.shopId, waylamp.packId, waylamp.packVersion, waylamp.kind, waylamp.definitionId, 2, 8, economyFixture.currencyCode);
      })();
    } finally {
      fixtureDb.close();
    }
    return reply.code(204).send();
  } finally {
    materializer.close();
  }
});

// Production economy HTTP routes are intentionally outside this milestone.
// These adapters expose only the disposable server's repository-backed flow.
app.get("/api/__e2e/economy/campaigns/:campaignId/actors/:actorId/wallet", async (request, reply) => {
  const { campaignId, actorId } = request.params as { campaignId: string; actorId: string };
  const economy = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    const wallet = economy.getWallet("local-owner", campaignId, actorId);
    return wallet ? reply.send({ wallet }) : reply.code(404).send({ error: "wallet unavailable" });
  } finally {
    economy.close();
  }
});

app.get("/api/__e2e/economy/campaigns/:campaignId/shops/:shopId", async (request, reply) => {
  const { campaignId, shopId } = request.params as { campaignId: string; shopId: string };
  const economy = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    const shop = economy.getShop("local-owner", campaignId, shopId);
    return shop ? reply.send({ shop }) : reply.code(404).send({ error: "shop unavailable" });
  } finally {
    economy.close();
  }
});

app.post("/api/__e2e/economy/commands", async (request, reply) => {
  const economy = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    return reply.send(economy.mutateEconomy("local-owner", request.body as never));
  } finally {
    economy.close();
  }
});

// The production HTTP adapter for rest is intentionally outside M2.7. This
// disposable adapter still exercises the authoritative repository command.
app.post("/api/__e2e/take-short-rest", async (request, reply) => {
  const command = request.body as { type?: unknown; campaignId?: unknown; actorId?: unknown; expectedRevision?: unknown; idempotencyKey?: unknown };
  if (command.type !== "take_short_rest" || typeof command.campaignId !== "string" || typeof command.actorId !== "string" || typeof command.expectedRevision !== "number" || typeof command.idempotencyKey !== "string") {
    return reply.code(400).send({ error: "invalid E2E short-rest command" });
  }
  const restRepository = createRepository({ dataDir, rng: reviewedDiceRng });
  try {
    return reply.code(200).send(restRepository.takeRest("local-owner", command as {
      type: "take_short_rest"; campaignId: string; actorId: string; expectedRevision: number; idempotencyKey: string;
    }));
  } finally {
    restRepository.close();
  }
});

app.listen({ port, host }).then(() => {
  app.log.info(`isolated deterministic E2E server listening on http://${host}:${port}`);
}).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
