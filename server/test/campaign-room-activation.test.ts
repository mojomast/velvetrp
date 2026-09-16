import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG, WorldConflictError } from "../src/repo/index.js";
import { CampaignRoomActivationConflictError, CampaignRoomActivationUnavailableError } from "../src/repo/campaignRoomActivationRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const db = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const content = generatedCampaignContentProviderSchema.parse({
  outlines: [{ key: "opening", opening: "Rain falls.", premise: "Find the lantern.", startLocationKey: "gate", visibility: "public" }],
  locations: [{ key: "gate", name: "Rain Gate", description: "An old gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
  npcs: [{ key: "guide", name: "Mara", archetype: "Guide", description: "A patient guide.", visibility: "public", locationKey: "gate", factionKeys: [], privateGoals: "Private test goal" }],
});

async function seed(order: "characters-first" | "room-first" | "already-active" = "characters-first", applyContent = true) {
  const repo = createRepository();
  const campaign = repo.createCampaign(OWNER, { name: "Activation" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "catalog" });
  const personas = ["Aster", "Noor"].map(name => repo.createCharacter({ name, age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true }));
  const room = await createSession({ characterIds: personas.map(persona => persona.id), title: "Rain Road" });
  const attach = () => repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: room.id });
  if (order !== "characters-first") attach();
  if (order === "already-active") repo.transitionSession(room.id, "active", "existing scene");
  const hydrate = () => {
    const context = repo.getCampaignGenerationContext(OWNER, campaign.id, [])!;
    const draft = repo.createGenerationDraft(OWNER, { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      kind: "content-pack", stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
      expectedCampaignRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: "content" });
    repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    repo.applyCampaignContentGenerationDraftAtomically(OWNER, { draftId: draft.draftId, expectedDraftRevision: 0,
      expectedCampaignRevision: draft.campaignRevision, idempotencyKey: "apply-content", selectedArtifactKeys: ["opening", "gate", "guide"] });
  };
  if (applyContent) hydrate();
  const definition = <K extends "race" | "background" | "class">(kind: K, id: string) => ({
    ...SRD_5_1_STARTER_CATALOG.definitions.find(value => value.reference.kind === kind && value.reference.definitionId === id)!.reference, kind });
  const actors = personas.map((persona, index) => {
    const { draft } = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
      allocation: { method: "standard-array", scores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 } }, idempotencyKey: `draft-${index}` });
    const selected = repo.updateCharacterDraft(OWNER, draft.id, { expectedRevision: 0, idempotencyKey: `select-${index}`,
      selections: { race: definition("race", "srd-5.1:race:human"), background: definition("background", "srd-5.1:background:acolyte"),
        class: definition("class", "srd-5.1:class:fighter"), starterGrant: "kit" } });
    repo.finalizeCharacterDraft(OWNER, draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `finalize-${index}` });
    return persona.id;
  });
  if (order === "characters-first") attach();
  const administration = repo.getCampaignAdministration(OWNER, campaign.id)!;
  repo.updateCampaignAdministration(OWNER, campaign.id, { expectedRevision: administration.revision, status: "published", idempotencyKey: "publish" });
  const readiness = () => repo.getCampaignRoomActivationReadiness(OWNER, campaign.id, room.id);
  const input = { expectedRevision: readiness().expectedRevision, idempotencyKey: "activate" };
  return { repo, campaignId: campaign.id, roomId: room.id, actors, hydrate, readiness, input };
}

function counts() {
  const database = db();
  try {
    return Object.fromEntries(["consent_events", "campaign_actor_locations_v28", "campaign_location_discoveries_v28", "npc_presence_commands_v43",
      "npc_presence_events_v43", "npc_presence_receipts_v43", "messages"].map(table => [table, (database.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
  } finally { database.close(); }
}

describe("campaign room activation", () => {
  afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; vi.restoreAllMocks(); });

  it.each(["characters-first", "room-first", "already-active"] as const)("atomically starts %s setup and replays across workers/restart", async order => {
    const seedState = await seed(order);
    const { repo, campaignId, roomId, input } = seedState;
    const before = counts();
    const worldBefore = repo.getCampaignWorld(OWNER, campaignId);
    expect(seedState.readiness()).toMatchObject({ ready: true, active: order === "already-active" });
    const result = repo.activateCampaignRoom(OWNER, campaignId, roomId, input);
    expect(result.readiness).toMatchObject({ ready: true, active: true, blockers: [] });
    expect(result.receipt.activated).toBe(order !== "already-active");
    expect(result.receipt.placedActorIds).toHaveLength(order === "already-active" ? 0 : 2);
    expect(result.receipt.reconciledNpcCount).toBe(order === "already-active" ? 0 : 1);
    const after = counts();
    expect(after.consent_events).toBe(before.consent_events! + 1);
    expect(after.messages).toBe(before.messages);
    expect(after.campaign_actor_locations_v28).toBe(2);
    expect(after.npc_presence_commands_v43).toBe(1);
    expect(repo.getCampaignPlayBootstrap(OWNER, campaignId, roomId)?.session.adventureEligible).toBe(true);
    if (order === "already-active") expect(repo.getCampaignWorld(OWNER, campaignId)).toEqual(worldBefore);
    const worker = createRepository();
    expect(worker.activateCampaignRoom(OWNER, campaignId, roomId, input)).toEqual(result);
    worker.close(); repo.close();
    const restarted = createRepository();
    expect(restarted.activateCampaignRoom(OWNER, campaignId, roomId, input)).toEqual(result);
    expect(counts()).toEqual(after);
    expect(() => restarted.activateCampaignRoom(OWNER, campaignId, roomId, { ...input, expectedRevision: input.expectedRevision + 1 })).toThrow(CampaignRoomActivationConflictError);
    expect(JSON.stringify(result)).not.toMatch(/privateGoals|Private test goal|principalId|controller/);
    restarted.close();
  });

  it("scopes the campaign world read to a requested room and fails closed without one", async () => {
    const { repo, campaignId, roomId, actors } = await seed();
    const other = await createSession({ characterId: actors[0]!, title: "Second room" });
    repo.attachCampaignSession(OWNER, { campaignId, sessionId: other.id });
    expect(() => repo.getCampaignWorld(OWNER, campaignId)).toThrow(WorldConflictError);
    expect(repo.getCampaignWorld(OWNER, campaignId, roomId)?.sessionId).toBe(roomId);
    expect(repo.getCampaignWorld(OWNER, campaignId, other.id)?.sessionId).toBe(other.id);
    expect(repo.getCampaignWorld(OWNER, campaignId, "not-attached")).toBeNull();
    repo.close();
  });

  it("reports missing start without writes, then accepts content supplied after characters and attachment", async () => {
    const { repo, campaignId, roomId, input, hydrate, readiness } = await seed("characters-first", false);
    const before = counts();
    expect(readiness().blockers).toContain("starting-location-required");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before);
    hydrate();
    expect(repo.activateCampaignRoom(OWNER, campaignId, roomId, input).receipt.placedActorIds).toHaveLength(2);
    repo.close();
  });

  it("rejects wrong rooms and player/observer authority, and binds replay to the original principal", async () => {
    const { repo, campaignId, roomId, input } = await seed();
    const database = db();
    for (const [principal, role] of [["gm", "gm"], ["player", "player"], ["observer", "observer"]]) {
      database.prepare("INSERT INTO principals VALUES(?,?,0)").run(principal, principal);
      database.prepare("INSERT INTO campaign_memberships VALUES(?,?,?,?)").run(campaignId, principal, role, new Date().toISOString());
    }
    database.close();
    const before = counts();
    for (const principal of ["outsider", "player", "observer"]) {
      expect(() => repo.getCampaignRoomActivationReadiness(principal, campaignId, roomId)).toThrow(CampaignRoomActivationUnavailableError);
      expect(() => repo.activateCampaignRoom(principal, campaignId, roomId, input)).toThrow(CampaignRoomActivationUnavailableError);
    }
    expect(() => repo.activateCampaignRoom(OWNER, "missing", roomId, input)).toThrow(CampaignRoomActivationUnavailableError);
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, "wrong-room", input)).toThrow(CampaignRoomActivationUnavailableError);
    expect(counts()).toEqual(before);
    repo.activateCampaignRoom("gm", campaignId, roomId, input);
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    const audit = db();
    expect(audit.prepare("SELECT principal_id FROM npc_presence_commands_v43").get()).toEqual({ principal_id: "gm" });
    audit.close(); repo.close();
  });

  it("preserves a placed actor and an explicit NPC presence decision while settling pending initialization", async () => {
    const { repo, campaignId, roomId, input, readiness } = await seed();
    const database = db();
    const at = new Date().toISOString();
    const actorId = readiness().actorIds[0]!;
    database.prepare("INSERT INTO campaign_locations_v28 VALUES('other-location',?,NULL,'Other place','Elsewhere','public',?)").run(campaignId, at);
    database.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'other-location','')").run(campaignId);
    database.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'other-location',?,7,?)").run(campaignId, actorId, roomId, at);
    database.close();
    const result = repo.activateCampaignRoom(OWNER, campaignId, roomId, input);
    expect(result.receipt.placedActorIds).not.toContain(actorId);
    const inspect = db();
    expect(inspect.prepare("SELECT location_id,state_revision,updated_at FROM campaign_actor_locations_v28 WHERE actor_id=?").get(actorId))
      .toEqual({ location_id: "other-location", state_revision: 7, updated_at: at });
    // A pending generated intent must not overwrite an already established presence.
    inspect.prepare("UPDATE generated_npc_placement_intents_v52 SET state='pending',session_id=NULL,reconciled_at=NULL WHERE campaign_id=?").run(campaignId);
    const npc = inspect.prepare("SELECT npc_id FROM campaign_npc_presence_v43 WHERE campaign_id=?").get(campaignId) as { npc_id: string };
    inspect.close();
    repo.mutateNpcPresence(OWNER, { campaignId, sessionId: roomId, npcId: npc.npc_id, expectedRevision: 1,
      idempotencyKey: "explicit-npc-move", mutation: { kind: "move", locationId: "other-location" } });
    const before = counts();
    expect(repo.activateCampaignRoom(OWNER, campaignId, roomId, { ...input, idempotencyKey: "reconcile-existing" }).receipt.reconciledNpcCount).toBe(1);
    const final = db();
    expect(final.prepare("SELECT location_id FROM campaign_npc_presence_v43 WHERE campaign_id=?").get(campaignId)).toEqual({ location_id: "other-location" });
    expect(final.prepare("SELECT state FROM generated_npc_placement_intents_v52 WHERE campaign_id=?").get(campaignId)).toEqual({ state: "placed" });
    final.close();
    expect(counts().npc_presence_commands_v43).toBe(before.npc_presence_commands_v43);
    repo.close();
  });

  it("blocks actors placed in a different room and unfinalized participants without relocation", async () => {
    const { repo, campaignId, roomId, input, readiness, actors } = await seed();
    const other = await createSession({ characterId: actors[0]!, title: "Prior room" });
    repo.attachCampaignSession(OWNER, { campaignId, sessionId: other.id });
    const database = db();
    const start = database.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?").get(campaignId) as { location_id: string };
    database.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaignId, readiness().actorIds[0], start.location_id, other.id, new Date().toISOString());
    database.close();
    const before = counts();
    expect(readiness().blockers).toContain("actor-in-other-room");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before);
    const persona = repo.createCharacter({ name: "Not finalized", age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true });
    const missing = await createSession({ characterId: persona.id, title: "Incomplete room" });
    repo.attachCampaignSession(OWNER, { campaignId, sessionId: missing.id });
    expect(repo.getCampaignRoomActivationReadiness(OWNER, campaignId, missing.id).blockers).toContain("participants-not-ready");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, missing.id, input)).toThrow(CampaignRoomActivationConflictError);
    repo.close();
  });

  it("rejects stale initial revisions and non-published campaigns", async () => {
    const { repo, campaignId, roomId, input } = await seed();
    const before = counts();
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, { ...input, expectedRevision: input.expectedRevision - 1 })).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before);
    repo.updateCampaignAdministration(OWNER, campaignId, { status: "paused", expectedRevision: input.expectedRevision, idempotencyKey: "pause-campaign" });
    expect(repo.getCampaignRoomActivationReadiness(OWNER, campaignId, roomId).blockers).toContain("campaign-not-published");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before); repo.close();
  });

  it.each(["closed", "paused", "cooldown"])("does not resume a %s room", async state => {
    const { repo, campaignId, roomId, input } = await seed();
    repo.transitionSession(roomId, state as "closed", "test-stop");
    const before = counts();
    expect(repo.getCampaignRoomActivationReadiness(OWNER, campaignId, roomId).blockers).toContain("room-not-startable");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before); repo.close();
  });

  it("rejects safety pause and another active room without changing safety or pins", async () => {
    const { repo, campaignId, roomId, input, actors } = await seed();
    repo.requestCampaignSafetyAction(OWNER, campaignId, { action: "pause", confirmed: true, expectedRevision: input.expectedRevision, idempotencyKey: "pause" });
    const before = counts();
    expect(repo.getCampaignRoomActivationReadiness(OWNER, campaignId, roomId).blockers).toContain("safety-paused");
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(counts()).toEqual(before);
    const other = await createSession({ characterId: actors[0]!, title: "Other" });
    repo.attachCampaignSession(OWNER, { campaignId, sessionId: other.id });
    repo.transitionSession(other.id, "active", "other scene");
    expect(repo.getCampaignRoomActivationReadiness(OWNER, campaignId, roomId).blockers).toContain("ambiguous-room");
    const pins = repo.resolveCampaignCatalog(OWNER, campaignId);
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow(CampaignRoomActivationConflictError);
    expect(repo.resolveCampaignCatalog(OWNER, campaignId)).toEqual(pins); repo.close();
  });

  it("rolls back activation, placements, and NPC events when consent receipt persistence fails", async () => {
    const { repo, campaignId, roomId, input } = await seed();
    const database = db();
    // Force a collision in the final insert without changing the schema.
    const { createHash } = await import("node:crypto");
    const commandId = `room-activation:${createHash("sha256").update(JSON.stringify([campaignId, roomId, input.idempotencyKey])).digest("hex").slice(0, 48)}`;
    database.prepare("INSERT INTO consent_events VALUES(?,?,100,?,'other-scope',1,'collision')").run(commandId, roomId, new Date().toISOString());
    database.close();
    const before = counts();
    expect(() => repo.activateCampaignRoom(OWNER, campaignId, roomId, input)).toThrow();
    expect(repo.getSession(roomId)?.state).toBe("setup");
    expect(counts()).toEqual(before); repo.close();
  });

  it("serves strict provider-free trusted-local HTTP and coalesces two workers", async () => {
    const { repo, campaignId, roomId, input } = await seed();
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    const complete = vi.fn(() => { throw new Error("provider must not run"); });
    vi.stubGlobal("fetch", complete);
    const worker = createRepository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const second = buildApp({ campaignRepositoryFactory: () => worker });
    const base = `/api/rpg/v1/campaigns/${campaignId}/rooms/${roomId}`;
    try {
      const get = await app.inject({ method: "GET", url: `${base}/activation-readiness` });
      expect(get.statusCode, get.body).toBe(200); expect(get.json().ready).toBe(true);
      const post = { method: "POST" as const, url: `${base}/activation-commands`, headers: { "content-type": "application/json" }, payload: input };
      for (const field of ["principalId", "role", "actorId", "locationId"]) {
        expect((await app.inject({ ...post, payload: { ...input, [field]: "forged" } })).statusCode).toBe(400);
      }
      expect((await app.inject({ ...post, url: `${post.url}?role=gm` })).statusCode).toBe(400);
      const results = await Promise.all([app.inject(post), second.inject(post)]);
      for (const result of results) { expect(result.statusCode, result.body).toBe(200); expect(result.headers["cache-control"]).toContain("no-store"); }
      expect(results[0]!.json()).toEqual(results[1]!.json());
      expect(counts().npc_presence_commands_v43).toBe(1);
      expect(complete).not.toHaveBeenCalled();
      delete process.env.FEATURE_RPG_CAMPAIGN;
      expect((await app.inject(post)).statusCode).toBe(404);
    } finally { vi.unstubAllGlobals(); await app.close(); await second.close(); }
  });
});
