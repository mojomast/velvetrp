import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformTravelConflictError,
  classifyFreeformTravel,
  createSession,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Seeds one generated public location ("harbor") through the ordinary accept
 * path and places the actor there, so the free-form classifier has a generated
 * public source location to attach a connection to.
 */
function seedHarbor(f: Fixture): string {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{ key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public" }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero",
  });
  return locationId;
}

describe("freeform location classification", () => {
  it("bounds unknown destinations against known locations and malformed text", async () => {
    const f = await dmFixture();
    const harborId = seedHarbor(f);

    const unknown = f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the glassblower's district");
    expect(unknown.intent).toBe("materialize-location");
    if (unknown.intent === "materialize-location") {
      expect(unknown.candidates).toHaveLength(1);
      expect(unknown.candidates[0]!.visibility).toBe("public");
      expect(unknown.candidates[0]!.name.toLowerCase()).toContain("glassblower");
      expect(unknown.candidates[0]!.fromLocationId).toBe(harborId);
    }

    expect(f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the Rain Harbor"))
      .toMatchObject({ intent: "none", reason: "known-location", locationId: harborId });
    expect(f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look around the market"))
      .toMatchObject({ intent: "none", reason: "no-travel-intent" });
    expect(f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to ."))
      .toMatchObject({ intent: "none", reason: "empty-destination" });
    expect(f.repo.classifyFreeformTravelIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I go to ${"x".repeat(201)}`))
      .toMatchObject({ intent: "none", reason: "destination-too-long" });
    f.repo.close();
  });

  it("declines without a current location or a generated source artifact", () => {
    expect(classifyFreeformTravel({ identity: "i", text: "I go to the docks", currentLocation: null, locations: [] }))
      .toMatchObject({ intent: "none", reason: "no-current-location" });
    expect(classifyFreeformTravel({
      identity: "i", text: "I go to the docks", locations: [],
      currentLocation: { locationId: "manual-location", name: "Manual Harbor", visibility: "public", artifactKey: null },
    })).toMatchObject({ intent: "none", reason: "current-location-unmapped" });
  });
});

describe("freeform location materialization", () => {
  it("materializes a public location and connection with durable receipts", async () => {
    const f = await dmFixture();
    const harborId = seedHarbor(f);
    const result = f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the glassblower's district");
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized location");

    const db = openDb();
    const location = db.prepare("SELECT public_name,visibility FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
      .get(f.campaign.id, result.locationId) as { public_name: string; visibility: string };
    expect(location.visibility).toBe("public");
    expect(location.public_name.toLowerCase()).toContain("glassblower");
    expect(db.prepare(`SELECT from_location_id,to_location_id,visibility,route_state FROM campaign_location_connections_v28
      WHERE campaign_id=? AND connection_id=?`).get(f.campaign.id, result.connectionId))
      .toMatchObject({ from_location_id: harborId, to_location_id: result.locationId, visibility: "public", route_state: "open" });
    expect(db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?")
      .get(f.campaign.id, f.actorId, f.session.id)).toMatchObject({ location_id: result.locationId });
    expect(db.prepare("SELECT 1 FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id=? AND location_id=?")
      .get(f.campaign.id, f.actorId, result.locationId)).toBeTruthy();

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();
    // Durable world command + receipt + event.
    expect(db.prepare("SELECT 1 FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_id=? AND command_type='travel'")
      .get(f.campaign.id, f.session.id, result.world.commandId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM world_receipts_v28 WHERE campaign_id=? AND session_id=? AND command_id=?")
      .get(f.campaign.id, f.session.id, result.world.commandId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM world_events_v28 WHERE campaign_id=? AND session_id=? AND command_id=? AND event_type='travelled'")
      .get(f.campaign.id, f.session.id, result.world.commandId)).toBeTruthy();

    // Only public location/connection artifacts; no GM-only secrets and no fabricated mechanics.
    const kinds = (db.prepare("SELECT DISTINCT artifact_kind k FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND source_draft_id=?")
      .all(f.campaign.id, result.draftId) as Array<{ k: string }>).map((row) => row.k).sort();
    expect(kinds).toEqual(["connection", "location"]);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND source_draft_id=? AND visibility='gm'", f.campaign.id, result.draftId)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_npc_baseline_stats_v41")).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM encounter")).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the glassblower's district");
    const second = f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the glassblower's district");
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.locationId).toBe(first.locationId);
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.world.commandId).toBe(first.world.commandId);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?", f.campaign.id, first.locationId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_location_connections_v28 WHERE campaign_id=? AND connection_id=?", f.campaign.id, first.connectionId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_type='travel'", f.campaign.id, f.session.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id=? AND location_id=?", f.campaign.id, f.actorId, first.locationId)).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("fails closed with no candidate and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    expect(f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the Rain Harbor"))
      .toMatchObject({ status: "declined", reason: "known-location" });
    expect(f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-travel-intent" });
    expect(() => f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId,
      "I go to the glassblower's district", { candidateId: "ffc-not-a-real-candidate" })).toThrow(FreeformTravelConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-draft-%'", f.campaign.id)).toBe(0);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when movement fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // A second active session makes the world travel command fail closed
    // (ambiguous session) after the location/connection apply has run.
    const persona = f.repo.createCharacter({ name: "Second Hero", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const second = await createSession({ characterId: persona.id, title: "Second room" });
    f.repo.attachCampaignSession(OWNER, { campaignId: f.campaign.id, sessionId: second.id } as never);
    f.repo.transitionSession(second.id, "active", "Begin play");

    expect(() => f.repo.materializeFreeformTravel(OWNER, f.campaign.id, f.session.id, f.actorId, "I go to the glassblower's district"))
      .toThrow();

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='connection'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-draft-%'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=?", f.campaign.id, f.session.id)).toBe(1); // only the setup placement
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });
});
