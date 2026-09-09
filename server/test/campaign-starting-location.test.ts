import DatabaseDriver from "better-sqlite3";
import Fastify from "fastify";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import {
  CampaignStartingLocationAuthorizationError,
  CampaignStartingLocationConflictError,
  CampaignStartingLocationStaleError,
  CampaignStartingLocationUnavailableError,
  createRepository,
} from "../src/repo/index.js";
import { campaignStartingLocationHttpRoutes } from "../src/routes/rpg/v1/campaignStartingLocation.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };

function seedLocations() {
  const repo = createRepository();
  const campaign = repo.createCampaign(OWNER, { name: "Starting location" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "configure-rules" });
  const other = repo.createCampaign(OWNER, { name: "Other campaign" });
  const db = database(), at = new Date().toISOString();
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('harbor',?,NULL,'Rain Harbor','Public harbor','public',?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'harbor','')").run(campaign.id);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('tower',?,NULL,'Old Tower','Public tower','public',?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'tower','')").run(campaign.id);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('secret',?,NULL,'Secret Vault','Hidden','gm',?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'secret','')").run(campaign.id);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('other-place',?,NULL,'Other Place','Elsewhere','public',?)").run(other.id, at);
  db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'other-place','')").run(other.id);
  db.prepare("INSERT INTO principals VALUES('player','Player',0)").run();
  db.prepare("INSERT INTO campaign_memberships VALUES(?,'player','player',?)").run(campaign.id, at);
  db.prepare("INSERT INTO principals VALUES('campaign-gm','Campaign GM',0)").run();
  db.prepare("INSERT INTO campaign_memberships VALUES(?,'campaign-gm','gm',?)").run(campaign.id, at);
  db.close();
  return { repo, campaign, other };
}

describe("campaign starting location", () => {
  afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

  it("creates once, durably replays across workers and restart, and never relocates actors", () => {
    const { repo, campaign } = seedLocations();
    expect(repo.getCampaignStartingLocation(OWNER, campaign.id)).toEqual({ campaignId: campaign.id, revision: 1, startingLocation: null });
    const input = { locationId: "harbor", expectedRevision: 1, idempotencyKey: "designate-harbor" };
    const before = database();
    const actorLocationsBefore = (before.prepare("SELECT count(*) count FROM campaign_actor_locations_v28").get() as any).count;
    before.close();
    const result = repo.designateCampaignStartingLocation(OWNER, campaign.id, input);
    expect(result).toMatchObject({ campaignId: campaign.id, revision: 2,
      startingLocation: { locationId: "harbor", name: "Rain Harbor" },
      receipt: { idempotencyKey: input.idempotencyKey, revisionBefore: 1, revisionAfter: 2 } });
    const worker = createRepository();
    expect(worker.designateCampaignStartingLocation(OWNER, campaign.id, input)).toEqual(result);
    worker.close(); repo.close();
    const restarted = createRepository();
    expect(restarted.designateCampaignStartingLocation(OWNER, campaign.id, input)).toEqual(result);
    expect(restarted.getCampaignStartingLocation(OWNER, campaign.id)).toEqual({ campaignId: campaign.id, revision: 2,
      startingLocation: result.startingLocation });
    const inspect = database();
    expect((inspect.prepare("SELECT count(*) count FROM campaign_starting_locations_v51 WHERE campaign_id=?").get(campaign.id) as any).count).toBe(1);
    expect((inspect.prepare("SELECT count(*) count FROM campaign_actor_locations_v28").get() as any).count).toBe(actorLocationsBefore);
    expect((inspect.prepare("SELECT count(*) count FROM campaign_administration_receipts WHERE campaign_id=?").get(campaign.id) as any).count).toBe(1);
    inspect.close(); restarted.close();
  });

  it("accepts the same create-once designation and conflicts with a different location", () => {
    const { repo, campaign } = seedLocations();
    repo.designateCampaignStartingLocation(OWNER, campaign.id, { locationId: "harbor", expectedRevision: 1, idempotencyKey: "first" });
    const same = repo.designateCampaignStartingLocation("campaign-gm", campaign.id, { locationId: "harbor", expectedRevision: 2, idempotencyKey: "same-location" });
    expect(same.startingLocation.locationId).toBe("harbor");
    expect(() => repo.designateCampaignStartingLocation(OWNER, campaign.id,
      { locationId: "tower", expectedRevision: 3, idempotencyKey: "different-location" })).toThrow(CampaignStartingLocationConflictError);
    expect(repo.getCampaignStartingLocation(OWNER, campaign.id)?.startingLocation?.locationId).toBe("harbor");
    repo.close();
  });

  it("rejects unauthorized, private, wrong-campaign, stale, unready, and paused commands", () => {
    const { repo, campaign } = seedLocations();
    const input = { locationId: "harbor", expectedRevision: 1, idempotencyKey: "designation" };
    expect(() => repo.designateCampaignStartingLocation("player", campaign.id, input)).toThrow(CampaignStartingLocationAuthorizationError);
    expect(() => repo.designateCampaignStartingLocation(OWNER, campaign.id, { ...input, locationId: "secret" })).toThrow(CampaignStartingLocationUnavailableError);
    expect(() => repo.designateCampaignStartingLocation(OWNER, campaign.id, { ...input, locationId: "other-place" })).toThrow(CampaignStartingLocationUnavailableError);
    expect(() => repo.designateCampaignStartingLocation(OWNER, campaign.id, { ...input, expectedRevision: 0 })).toThrow(CampaignStartingLocationStaleError);
    const unready = repo.createCampaign(OWNER, { name: "No rules" });
    const db = database(), at = new Date().toISOString();
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('unready-place',?,NULL,'Unready','Unready','public',?)").run(unready.id, at);
    db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,'unready-place','')").run(unready.id); db.close();
    expect(() => repo.designateCampaignStartingLocation(OWNER, unready.id,
      { locationId: "unready-place", expectedRevision: 0, idempotencyKey: "unready" })).toThrow(CampaignStartingLocationConflictError);
    repo.requestCampaignSafetyAction(OWNER, campaign.id, { action: "pause", confirmed: true, expectedRevision: 1, idempotencyKey: "pause" });
    expect(() => repo.designateCampaignStartingLocation(OWNER, campaign.id,
      { ...input, expectedRevision: 2, idempotencyKey: "paused" })).toThrow(CampaignStartingLocationConflictError);
    repo.close();
  });

  it("keeps a prior designation when a later generated outline names another start", () => {
    const { repo, campaign } = seedLocations();
    repo.designateCampaignStartingLocation(OWNER, campaign.id, { locationId: "harbor", expectedRevision: 1, idempotencyKey: "manual-start" });
    const content = generatedCampaignContentProviderSchema.parse({
      outlines: [{ key: "later-opening", opening: "At the tower.", premise: "Climb.", startLocationKey: "generated-tower", visibility: "public" }],
      locations: [{ key: "generated-tower", name: "Generated Tower", description: "A generated tower.", visibility: "public", discoveries: [], hazards: [], hooks: [], factionKeys: [] }],
    });
    const context = repo.getCampaignGenerationContext(OWNER, campaign.id, [])!;
    const draft = repo.createGenerationDraft(OWNER, { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      kind: "content-pack", stagedContent: { kind: "campaign-content", requestDigest: "b".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
      validation: { valid: true, issues: [], validatedAt: new Date().toISOString() }, expectedCampaignRevision: 2, idempotencyKey: "later-draft" });
    repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
    repo.applyCampaignContentGenerationDraftAtomically(OWNER, { draftId: draft.draftId, expectedDraftRevision: 0,
      expectedCampaignRevision: 2, idempotencyKey: "later-apply", selectedArtifactKeys: ["later-opening", "generated-tower"] });
    expect(repo.getCampaignStartingLocation(OWNER, campaign.id)?.startingLocation).toMatchObject({ locationId: "harbor", name: "Rain Harbor" });
    expect(repo.getCampaignGeneratedFoundation(OWNER, campaign.id)?.opening?.startLocationKey).toBe("generated-tower");
    repo.close();
  });

  it("serves strict authoritative GET/POST responses and maps hidden authority to not-found", async () => {
    enable(); const { repo, campaign } = seedLocations();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const initial = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location` });
    expect(initial.statusCode, initial.body).toBe(200); expect(initial.json()).toEqual({ campaignId: campaign.id, revision: 1, startingLocation: null });
    const payload = { locationId: "harbor", expectedRevision: 1, idempotencyKey: "route-start" };
    for (const locationId of ["secret", "other-place"]) {
      const unavailable = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location-commands`,
        headers: { "content-type": "application/json" }, payload: { ...payload, locationId, idempotencyKey: `route-${locationId}` } });
      expect(unavailable.statusCode).toBe(404);
    }
    const stale = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location-commands`,
      headers: { "content-type": "application/json" }, payload: { ...payload, expectedRevision: 0, idempotencyKey: "route-stale" } });
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("RPG_CAMPAIGN_STARTING_LOCATION_STALE");
    const created = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location-commands`,
      headers: { "content-type": "application/json" }, payload });
    expect(created.statusCode, created.body).toBe(200); expect(created.json()).toMatchObject({ campaignId: campaign.id, revision: 2,
      startingLocation: { locationId: "harbor", name: "Rain Harbor" }, receipt: { idempotencyKey: "route-start", revisionBefore: 1, revisionAfter: 2 } });
    const replay = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location-commands`,
      headers: { "content-type": "application/json" }, payload });
    expect(replay.json()).toEqual(created.json());
    const strict = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/starting-location-commands`,
      headers: { "content-type": "application/json" }, payload: { ...payload, actorId: "actor" } });
    expect(strict.statusCode).toBe(400); await app.close();

    const hidden = Fastify({ logger: false });
    await hidden.register(campaignStartingLocationHttpRoutes, { prefix: "/api/rpg/v1", startingLocationRepositoryAccessor: () => ({
      getCampaignStartingLocation: () => { throw new CampaignStartingLocationAuthorizationError(); },
      designateCampaignStartingLocation: () => { throw new CampaignStartingLocationAuthorizationError(); },
    }) });
    const denied = await hidden.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/starting-location-commands",
      headers: { "content-type": "application/json" }, payload: { locationId: "harbor", expectedRevision: 0, idempotencyKey: "denied" } });
    expect(denied.statusCode).toBe(404); expect(denied.body).not.toContain("authority"); await hidden.close();
  });
});
