import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { z } from "zod";
import {
  economyCommandSchema,
  itemCatalogReferenceSchema,
  resourceIdSchema,
  takeShortRestCommandSchema,
  worldVisibleLocationHttpSchema,
} from "@velvet/contracts";
import { buildApp } from "../../server/src/app.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../../server/src/repo/index.js";
import {
  createDeterministicE2ERepository,
  DeterministicE2EFixtureAuthorizationError,
  DeterministicE2EFixtureConflictError,
  DeterministicE2EFixtureStaleError,
} from "../../server/src/repo/testing/deterministicE2EFixtureRepo.js";
import type { RandomNumberGenerator } from "../../server/src/runtime.js";

// This dependency exists only in the isolated disposable E2E server. Keep the
// expected call range explicit so a mechanics change cannot silently consume a
// different deterministic sequence or weaken production randomness.
const reviewedDiceRng: RandomNumberGenerator = {
  integer(minInclusive, maxExclusive) {
    if (minInclusive === 1 && maxExclusive === 3) return 2;
    if (minInclusive === 1 && maxExclusive === 5) return 1;
    if (minInclusive === 1 && maxExclusive === 21) return 10;
    if (minInclusive === 0 && maxExclusive === 1000001) return 0;
    throw new Error(`unexpected E2E RNG range [${minInclusive}, ${maxExclusive})`);
  },
};

const dataDir = process.env.VELVET_DATA_DIR;
if (!dataDir) throw new Error("VELVET_DATA_DIR is required for deterministic E2E");

// M2.2 membership commands require a principal other than the fixed local owner.
// Initialize the disposable database before adding the fixture principal.
const setupRepository = createRepository({ dataDir, rng: reviewedDiceRng });
setupRepository.close();
const db = new DatabaseDriver(path.join(dataDir, "velvet.sqlite"));
db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
  .run("e2e-membership-principal", "E2E membership principal");
db.close();

// The app lazily owns this seeded instance for its lifetime; E2E lookups share it.
const { repository, fixtures } = createDeterministicE2ERepository({ dataDir, rng: reviewedDiceRng });
let repositoryOwnedByRpgPlugin = false;
const campaignRepositoryFactory = () => {
  repositoryOwnedByRpgPlugin = true;
  return repository;
};

const port = Number(process.env.PORT ?? 18787);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp({
  campaignRepositoryFactory,
});
// The RPG plugin closes the repository after its lazy accessor takes ownership.
// Close the eager fixture repository here when no RPG route initialized it.
app.addHook("onClose", async () => {
  if (!repositoryOwnedByRpgPlugin) repository.close();
});

const materialize = (reply: { code(status: number): { send(body?: unknown): unknown } }, operation: () => void) => {
  try {
    operation();
    return reply.code(204).send();
  } catch (error) {
    if (error instanceof DeterministicE2EFixtureAuthorizationError) {
      return reply.code(404).send({ error: "E2E fixture target unavailable" });
    }
    if (error instanceof DeterministicE2EFixtureStaleError || error instanceof DeterministicE2EFixtureConflictError) {
      return reply.code(409).send({ error: error.message });
    }
    throw error;
  }
};

const fixtureTargetBodySchema = takeShortRestCommandSchema.omit({ type: true, idempotencyKey: true });
const waylampFixtureBodySchema = fixtureTargetBodySchema.extend({ entryId: resourceIdSchema });
const pinnedItemExecutionBodySchema = z.object({ campaignId: resourceIdSchema, item: itemCatalogReferenceSchema }).strict();
const consumableEntryFixtureBodySchema = fixtureTargetBodySchema.extend({
  entryId: resourceIdSchema, item: itemCatalogReferenceSchema,
});
const campaignLocationFixtureBodySchema = worldVisibleLocationHttpSchema.extend({ campaignId: resourceIdSchema })
  .refine((location) => location.parentLocationId !== location.locationId, { path: ["parentLocationId"] });
const travelFixtureBodySchema=z.object({campaignId:resourceIdSchema,sessionId:resourceIdSchema,actorId:resourceIdSchema,
  originLocationId:resourceIdSchema,destinationLocationId:resourceIdSchema,connectionId:resourceIdSchema,
  originName:z.string().trim().min(1).max(200),destinationName:z.string().trim().min(1).max(200)}).strict();

// This route exposes the one internal linkage fixture adapters need without
// widening the public finalization response.
app.get("/api/__e2e/campaigns/:campaignId/characters/:characterId/actor", async (request, reply) => {
  const params = request.params as { campaignId?: unknown; characterId?: unknown };
  const campaignId = resourceIdSchema.safeParse(params.campaignId);
  const characterId = resourceIdSchema.safeParse(params.characterId);
  if (!campaignId.success || !characterId.success || Object.keys(request.query as Record<string, unknown>).length > 0) {
    return reply.code(400).send({ error: "invalid E2E campaign character lookup request" });
  }
  const character = repository.getCampaignCharacter("local-owner", campaignId.data, characterId.data);
  if (!character
    || character.projection.campaignCharacter.id !== characterId.data
    || character.projection.campaignCharacter.campaignId !== campaignId.data
    || character.projection.actor.campaignCharacterId !== characterId.data
    || character.projection.actor.campaignId !== campaignId.data) {
    return reply.code(404).send({ error: "E2E campaign character unavailable" });
  }
  return reply.send({ actorId: character.projection.actor.id });
});

// This route is available only on the disposable deterministic E2E server. It
// materializes one reviewed catalog item after proving the actor is visible.
app.post("/api/__e2e/materialize-waylamp", async (request, reply) => {
  const body = waylampFixtureBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid E2E Waylamp materialization request" });
  }
  return materialize(reply, () => fixtures.materializeWaylamp({
    principalId: "local-owner", ...body.data,
  }));
});

app.post("/api/__e2e/materialize-pinned-item-execution", async (request, reply) => {
  const body = pinnedItemExecutionBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid E2E pinned item execution request" });
  }
  return materialize(reply, () => fixtures.materializePinnedItemExecution({
    principalId: "local-owner", ...body.data,
  }));
});

app.post("/api/__e2e/materialize-consumable-entry", async (request, reply) => {
  const body = consumableEntryFixtureBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid E2E consumable entry materialization request" });
  }
  return materialize(reply, () => fixtures.materializeConsumableEntry({
    principalId: "local-owner", ...body.data,
  }));
});

// This fixture bypasses no production command: it creates the depleted,
// explicitly short-rest-bound state that finalized character construction does
// not otherwise provide.
app.post("/api/__e2e/materialize-short-rest-resource", async (request, reply) => {
  const body = fixtureTargetBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid E2E short-rest resource materialization request" });
  }
  return materialize(reply, () => fixtures.materializeShortRestFocus({
    principalId: "local-owner", ...body.data,
  }));
});

// This reviewed fixture creates the pinned catalog identities and the minimum
// durable economy state required to exercise quote and purchase commands.
app.post("/api/__e2e/materialize-economy-fixture", async (request, reply) => {
  const body = fixtureTargetBodySchema.safeParse(request.body);
  if (!body.success) {
    return reply.code(400).send({ error: "invalid E2E economy materialization request" });
  }
  return materialize(reply, () => fixtures.materializeEconomyGraph({
    principalId: "local-owner", ...body.data,
  }));
});

// Public locations are materialized only by this disposable server and remain
// visible through the normal repository-backed world projection.
app.post("/api/__e2e/materialize-campaign-location", async (request, reply) => {
  const body = campaignLocationFixtureBodySchema.safeParse(request.body);
  if (!body.success || Object.keys(request.query as Record<string, unknown>).length > 0) {
    return reply.code(400).send({ error: "invalid E2E campaign location materialization request" });
  }
  return materialize(reply, () => fixtures.materializeCampaignLocation(body.data));
});

// Creates prerequisites only; candidate issuance, provider selection, travel,
// receipt linking, and world revision mutation all use production paths.
app.post("/api/__e2e/materialize-travel-prerequisite",async(request,reply)=>{
  const body=travelFixtureBodySchema.safeParse(request.body);
  if(!body.success||Object.keys(request.query as Record<string,unknown>).length>0)return reply.code(400).send({error:"invalid E2E travel prerequisite"});
  return materialize(reply,()=>fixtures.materializeTravelPrerequisite(body.data));
});

// Read-only, disposable evidence for exact-once assertions. All three known
// identities must bind the same production turn before bounded counts return.
app.get("/api/__e2e/campaigns/:campaignId/turns/:turnId/actors/:actorId/travel-evidence",async(request,reply)=>{
  const params=request.params as Record<string,unknown>,campaignId=resourceIdSchema.safeParse(params.campaignId),
    turnId=resourceIdSchema.safeParse(params.turnId),actorId=resourceIdSchema.safeParse(params.actorId);
  if(!campaignId.success||!turnId.success||!actorId.success||Object.keys(request.query as Record<string,unknown>).length)
    return reply.code(400).send({error:"invalid E2E travel evidence request"});
  const evidenceDb=new DatabaseDriver(path.join(dataDir,"velvet.sqlite"),{readonly:true});
  try{const turn=evidenceDb.prepare("SELECT 1 FROM adventure_turns WHERE id=? AND campaign_id=? AND actor_id=?").get(turnId.data,campaignId.data,actorId.data);
    if(!turn)return reply.code(404).send({error:"E2E travel evidence unavailable"});
    const counts=evidenceDb.prepare(`SELECT
      (SELECT count(*) FROM exact_candidate_executions_v47 WHERE campaign_id=? AND turn_id=? AND actor_id=?) executions,
      (SELECT count(*) FROM exact_candidate_provider_bindings_v48 WHERE campaign_id=? AND turn_id=?) bindings,
      (SELECT count(*) FROM world_commands_v28 command JOIN exact_candidate_executions_v47 execution
        ON execution.campaign_id=command.campaign_id AND execution.world_command_id=command.command_id
        WHERE command.campaign_id=? AND execution.turn_id=? AND command.command_type='travel') commands,
      (SELECT count(*) FROM world_events_v28 event JOIN exact_candidate_executions_v47 execution
        ON execution.campaign_id=event.campaign_id AND execution.world_command_id=event.command_id
        WHERE event.campaign_id=? AND execution.turn_id=? AND event.event_type='travelled') events`)
      .get(campaignId.data,turnId.data,actorId.data,campaignId.data,turnId.data,campaignId.data,turnId.data,
        campaignId.data,turnId.data) as Record<string,number>;
    const world=evidenceDb.prepare(`SELECT command.expected_revision revisionBefore,command.resulting_revision revisionAfter,
      position.state_revision actorRevision,position.location_id locationId
      FROM exact_candidate_provider_bindings_v48 binding JOIN world_commands_v28 command
        ON command.campaign_id=binding.campaign_id AND command.command_id=binding.world_command_id
      JOIN campaign_actor_locations_v28 position ON position.campaign_id=binding.campaign_id AND position.actor_id=?
      WHERE binding.campaign_id=? AND binding.turn_id=?`).get(actorId.data,campaignId.data,turnId.data) as Record<string,unknown>|undefined;
    return reply.send({...counts,...world});
  }finally{evidenceDb.close();}
});

// Production economy HTTP routes are intentionally outside this milestone.
// These adapters expose only the disposable server's repository-backed flow.
app.get("/api/__e2e/economy/campaigns/:campaignId/actors/:actorId/wallet", async (request, reply) => {
  const params = request.params as { campaignId?: unknown; actorId?: unknown };
  const campaignId = resourceIdSchema.safeParse(params.campaignId);
  const actorId = resourceIdSchema.safeParse(params.actorId);
  if (!campaignId.success || !actorId.success) {
    return reply.code(400).send({ error: "invalid E2E wallet lookup request" });
  }
  const wallet = repository.getWallet("local-owner", campaignId.data, actorId.data);
  return wallet ? reply.send({ wallet }) : reply.code(404).send({ error: "wallet unavailable" });
});

app.get("/api/__e2e/economy/campaigns/:campaignId/shops/:shopId", async (request, reply) => {
  const params = request.params as { campaignId?: unknown; shopId?: unknown };
  const campaignId = resourceIdSchema.safeParse(params.campaignId);
  const shopId = resourceIdSchema.safeParse(params.shopId);
  if (!campaignId.success || !shopId.success) {
    return reply.code(400).send({ error: "invalid E2E shop lookup request" });
  }
  const shop = repository.getShop("local-owner", campaignId.data, shopId.data);
  return shop ? reply.send({ shop }) : reply.code(404).send({ error: "shop unavailable" });
});

app.post("/api/__e2e/economy/commands", async (request, reply) => {
  const command = economyCommandSchema.safeParse(request.body);
  if (!command.success) return reply.code(400).send({ error: "invalid E2E economy command" });
  return reply.send(repository.mutateEconomy("local-owner", command.data));
});

// The production HTTP adapter for rest is intentionally outside M2.7. This
// disposable adapter still exercises the authoritative repository command.
app.post("/api/__e2e/take-short-rest", async (request, reply) => {
  const command = takeShortRestCommandSchema.safeParse(request.body);
  if (!command.success) {
    return reply.code(400).send({ error: "invalid E2E short-rest command" });
  }
  return reply.code(200).send(repository.takeRest("local-owner", command.data));
});

app.listen({ port, host }).then(() => {
  app.log.info(`isolated deterministic E2E server listening on http://${host}:${port}`);
}).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
