import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG, type Repository } from "../src/repo/index.js";
import { CampaignRoomParticipantConflictError, CampaignRoomParticipantUnavailableError } from "../src/repo/campaignRoomParticipantRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const db = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const content = generatedCampaignContentProviderSchema.parse({
  outlines: [{ key: "opening", opening: "Rain falls.", premise: "Find the lantern.", startLocationKey: "gate", visibility: "public" }],
  locations: [{ key: "gate", name: "Rain Gate", description: "An old gate.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
  npcs: [{ key: "guide", name: "Mara", archetype: "Guide", description: "A patient guide.", visibility: "public", locationKey: "gate", factionKeys: [], privateGoals: "Private test goal" }],
});

const definition = <K extends "race" | "background" | "class">(kind: K, id: string) => ({
  ...SRD_5_1_STARTER_CATALOG.definitions.find(value => value.reference.kind === kind && value.reference.definitionId === id)!.reference, kind });

function finalizePersona(repo: Repository, campaignId: string, personaId: string, suffix: string): string {
  const { draft } = repo.createCharacterDraft(OWNER, campaignId, { personaId, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 } }, idempotencyKey: `draft-${suffix}` });
  const selected = repo.updateCharacterDraft(OWNER, draft.id, { expectedRevision: 0, idempotencyKey: `select-${suffix}`,
    selections: { race: definition("race", "srd-5.1:race:human"), background: definition("background", "srd-5.1:background:acolyte"),
      class: definition("class", "srd-5.1:class:fighter"), starterGrant: "kit" } });
  return repo.finalizeCharacterDraft(OWNER, draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `finalize-${suffix}` }).receipt.campaignCharacterId;
}

async function seed() {
  const repo = createRepository();
  const campaign = repo.createCampaign(OWNER, { name: "Participants" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "catalog" });
  const personas = ["Aster", "Noor"].map(name => repo.createCharacter({ name, age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true }));
  const room = await createSession({ characterIds: personas.map(persona => persona.id), title: "Rain Road" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: room.id });
  const context = repo.getCampaignGenerationContext(OWNER, campaign.id, [])!;
  const draft = repo.createGenerationDraft(OWNER, { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    kind: "content-pack", stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
    expectedCampaignRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: "content" });
  repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  repo.applyCampaignContentGenerationDraftAtomically(OWNER, { draftId: draft.draftId, expectedDraftRevision: 0,
    expectedCampaignRevision: draft.campaignRevision, idempotencyKey: "apply-content", selectedArtifactKeys: ["opening", "gate", "guide"] });
  const campaignCharacterIds = personas.map((persona, index) => finalizePersona(repo, campaign.id, persona.id, String(index)));
  const administration = repo.getCampaignAdministration(OWNER, campaign.id)!;
  repo.updateCampaignAdministration(OWNER, campaign.id, { expectedRevision: administration.revision, status: "published", idempotencyKey: "publish" });
  const activation = { expectedRevision: repo.getCampaignRoomActivationReadiness(OWNER, campaign.id, room.id).expectedRevision, idempotencyKey: "activate" };
  repo.activateCampaignRoom(OWNER, campaign.id, room.id, activation);
  return { repo, campaignId: campaign.id, roomId: room.id, campaignCharacterIds, activation };
}

describe("campaign room participant join", () => {
  afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; vi.restoreAllMocks(); });

  it("adds a finalized character to an active room and replays idempotently across workers", async () => {
    const { repo, campaignId, roomId, campaignCharacterIds } = await seed();
    const third = repo.createCharacter({ name: "Ilan", age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true });
    const campaignCharacterId = finalizePersona(repo, campaignId, third.id, "third");
    const before = repo.getCampaignPlayBootstrap(OWNER, campaignId, roomId)!;
    expect(before.playableActors).toHaveLength(2);

    const input = { campaignCharacterId, expectedRevision: before.expectedRevision, idempotencyKey: "join" };
    const result = repo.addCampaignRoomParticipant(OWNER, campaignId, roomId, input);
    expect(result.position).toBe(2);
    expect(result.campaignCharacterId).toBe(campaignCharacterId);
    expect(result.revision).toBe(before.expectedRevision);
    expect(result.receipt.idempotencyKey).toBe("join");

    const after = repo.getCampaignPlayBootstrap(OWNER, campaignId, roomId)!;
    expect(after.playableActors).toHaveLength(3);
    expect(after.playableActors.map(actor => actor.actorId)).toContain(result.actorId);
    expect(after.session.adventureEligible).toBe(true);

    repo.close();
    const worker = createRepository();
    expect(worker.addCampaignRoomParticipant(OWNER, campaignId, roomId, input)).toEqual(result);
    expect(() => worker.addCampaignRoomParticipant(OWNER, campaignId, roomId, { ...input, expectedRevision: input.expectedRevision + 1 }))
      .toThrow(CampaignRoomParticipantConflictError);
    worker.close();
  });

  it("rejects authority, duplicate membership, archived campaigns, and actors placed in another room", async () => {
    const { repo, campaignId, roomId } = await seed();
    const database = db();
    for (const [principal, role] of [["gm", "gm"], ["player", "player"], ["observer", "observer"]]) {
      database.prepare("INSERT INTO principals VALUES(?,?,0)").run(principal, principal);
      database.prepare("INSERT INTO campaign_memberships VALUES(?,?,?,?)").run(campaignId, principal, role, new Date().toISOString());
    }
    database.close();
    const revision = repo.getCampaignPlayBootstrap(OWNER, campaignId, roomId)!.expectedRevision;
    const outsider = repo.createCharacter({ name: "Ilan", age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true });
    const outsiderCampaignCharacterId = finalizePersona(repo, campaignId, outsider.id, "outsider");
    for (const principal of ["outsider", "player", "observer"]) {
      expect(() => repo.addCampaignRoomParticipant(principal, campaignId, roomId, { campaignCharacterId: outsiderCampaignCharacterId, expectedRevision: revision, idempotencyKey: "x" }))
        .toThrow(CampaignRoomParticipantUnavailableError);
    }
    const input = { campaignCharacterId: outsiderCampaignCharacterId, expectedRevision: revision, idempotencyKey: "join" };
    repo.addCampaignRoomParticipant(OWNER, campaignId, roomId, input);
    expect(() => repo.addCampaignRoomParticipant("gm", campaignId, roomId, { ...input, idempotencyKey: "join-dup" }))
      .toThrow(CampaignRoomParticipantConflictError);

    // A different finalized character whose actor is placed in another room cannot join.
    const placedPersona = repo.createCharacter({ name: "Tove", age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true });
    const placedCampaignCharacterId = finalizePersona(repo, campaignId, placedPersona.id, "placed");
    const other = await createSession({ characterId: placedPersona.id, title: "Other room" });
    repo.attachCampaignSession(OWNER, { campaignId, sessionId: other.id });
    const inspect = db();
    const placedActor = inspect.prepare("SELECT id FROM campaign_actors WHERE campaign_id=? AND campaign_character_id=?")
      .get(campaignId, placedCampaignCharacterId) as { id: string };
    const start = inspect.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?").get(campaignId) as { location_id: string };
    inspect.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)")
      .run(campaignId, placedActor.id, start.location_id, other.id, new Date().toISOString());
    inspect.close();
    expect(() => repo.addCampaignRoomParticipant(OWNER, campaignId, roomId, { campaignCharacterId: placedCampaignCharacterId, expectedRevision: revision, idempotencyKey: "join-placed" }))
      .toThrow(CampaignRoomParticipantConflictError);

    const archive = db();
    archive.prepare("UPDATE campaigns SET lifecycle_status='archived' WHERE id=?").run(campaignId);
    archive.close();
    expect(() => repo.addCampaignRoomParticipant(OWNER, campaignId, roomId, { campaignCharacterId: outsiderCampaignCharacterId, expectedRevision: revision, idempotencyKey: "join-archived" }))
      .toThrow(CampaignRoomParticipantConflictError);
    repo.close();
  });

  it("serves strict provider-free trusted-local HTTP and rejects forged fields", async () => {
    const { repo, campaignId, roomId } = await seed();
    const third = repo.createCharacter({ name: "Ilan", age: 30, archetype: "Explorer", boundaries: "", fictionalConfirmed: true });
    const campaignCharacterId = finalizePersona(repo, campaignId, third.id, "third");
    const revision = repo.getCampaignPlayBootstrap(OWNER, campaignId, roomId)!.expectedRevision;
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    const complete = vi.fn(() => { throw new Error("provider must not run"); });
    vi.stubGlobal("fetch", complete);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const url = `/api/rpg/v1/campaigns/${campaignId}/rooms/${roomId}/participant-commands`;
    const payload = { campaignCharacterId, expectedRevision: revision, idempotencyKey: "join-http" };
    try {
      const post = { method: "POST" as const, url, headers: { "content-type": "application/json" }, payload };
      for (const field of ["principalId", "role", "actorId", "characterId"]) {
        expect((await app.inject({ ...post, payload: { ...payload, [field]: "forged" } })).statusCode).toBe(400);
      }
      expect((await app.inject({ ...post, url: `${url}?role=gm` })).statusCode).toBe(400);
      const result = await app.inject(post);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.headers["cache-control"]).toContain("no-store");
      expect(result.json().campaignCharacterId).toBe(campaignCharacterId);
      expect(complete).not.toHaveBeenCalled();
      delete process.env.FEATURE_RPG_CAMPAIGN;
      expect((await app.inject(post)).statusCode).toBe(404);
    } finally { vi.unstubAllGlobals(); await app.close(); repo.close(); }
  });
});
