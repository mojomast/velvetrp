import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformFactionConflictError,
  classifyFreeformFaction,
  parseFreeformFactionReference,
  selectFreeformFactionArchetype,
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
 * public source place for the public faction description.
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
    idempotencyKey: "freeform-faction-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-faction-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-faction",
  });
  return locationId;
}

describe("freeform faction classification", () => {
  it("bounds known factions, faction-less declarations and malformed text", async () => {
    const f = await dmFixture();
    const harborId = seedHarbor(f);

    const unknown = f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    expect(unknown.intent).toBe("materialize-faction");
    if (unknown.intent === "materialize-faction") {
      expect(unknown.candidates).toHaveLength(1);
      expect(unknown.candidates[0]!.visibility).toBe("public");
      expect(unknown.candidates[0]!.name.toLowerCase()).toContain("guild");
      expect(unknown.candidates[0]!.archetype).toBe("Guild");
      expect(unknown.candidates[0]!.description).toContain("Rain Harbor");
      expect(unknown.candidates[0]!.gmAgenda.trim().length).toBeGreaterThan(0);
    }

    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look around the market"))
      .toMatchObject({ intent: "none", reason: "no-faction-intent" });
    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the road"))
      .toMatchObject({ intent: "none", reason: "not-a-faction" });
    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for ."))
      .toMatchObject({ intent: "none", reason: "empty-name" });
    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I look for the ${"x".repeat(201)} guild`))
      .toMatchObject({ intent: "none", reason: "name-too-long" });

    // After the faction is committed, the same declaration is a duplicate.
    f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I search for the local thieves' guild"))
      .toMatchObject({ intent: "none", reason: "known-faction", factionName: "local thieves' guild" });
    expect(harborId).toBeTruthy();
    f.repo.close();
  });

  it("declines without faction intent and bounds a pure classification", () => {
    expect(classifyFreeformFaction({ identity: "i", text: "I sit quietly", knownFactions: [] }))
      .toMatchObject({ intent: "none", reason: "no-faction-intent" });
    expect(classifyFreeformFaction({ identity: "i", text: "I look for the road", knownFactions: [] }))
      .toMatchObject({ intent: "none", reason: "not-a-faction" });
    // Parser and archetype selection are pure and deterministic.
    expect(parseFreeformFactionReference("I ask about the Order of the Silent Bell")).toMatchObject({ ok: true, name: "Order of the Silent Bell" });
    expect(parseFreeformFactionReference("Is there a thieves' guild here?")).toMatchObject({ ok: true, name: "thieves' guild" });
    expect(selectFreeformFactionArchetype("the ironworkers guild").id).toBe("guild");
    expect(selectFreeformFactionArchetype("a vague thing").id).toBe("unlisted");
  });
});

describe("freeform faction materialization", () => {
  it("materializes a public faction with a durable receipt and a separate GM-only agenda artifact", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized faction");

    const db = openDb();
    expect(db.prepare("SELECT public_name,visibility FROM campaign_factions_v28 WHERE campaign_id=? AND faction_id=?")
      .get(f.campaign.id, result.factionId)).toMatchObject({ visibility: "public" });
    expect((db.prepare("SELECT public_name FROM campaign_factions_v28 WHERE campaign_id=? AND faction_id=?")
      .get(f.campaign.id, result.factionId) as { public_name: string }).public_name.toLowerCase()).toContain("guild");

    // The public faction leaves the private state empty; the true agenda is a separate GM artifact.
    expect(db.prepare("SELECT gm_notes FROM campaign_faction_private_state_v28 WHERE campaign_id=? AND faction_id=?")
      .get(f.campaign.id, result.factionId)).toMatchObject({ gm_notes: "" });

    const metadata = db.prepare("SELECT public_state_json,private_state_json FROM campaign_faction_metadata_v32 WHERE campaign_id=? AND faction_id=?")
      .get(f.campaign.id, result.factionId) as { public_state_json: string; private_state_json: string };
    expect(metadata.public_state_json).toContain("A public trade guild of Rain Harbor");

    // Durable world narrative command/receipt/event.
    expect(db.prepare("SELECT 1 FROM world_narrative_commands_v32 WHERE campaign_id=? AND resource_id=? AND command_type='create_faction'")
      .get(f.campaign.id, result.factionId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM world_narrative_events_v32 WHERE campaign_id=? AND event_type='faction_created'")
      .get(f.campaign.id)).toBeTruthy();

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();

    // Exactly one public faction artifact and one separate GM-only agenda artifact.
    const artifacts = db.prepare(`SELECT artifact_kind,visibility,artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, result.draftId) as Array<{ artifact_kind: string; visibility: string; artifact_key: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`)).toEqual(["faction:public", "lore:gm"]);
    expect(result.gmAgendaArtifactKey).toBeTruthy();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("keeps the true agenda out of the public faction artifact and fabricates no mechanics", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const db = openDb();
    // Baseline counts of every mechanics table this module must not touch.
    const counts = (): Record<string, number> => ({
      classes: countOf(db, "SELECT count(*) n FROM rpg_character_classes"),
      progression: countOf(db, "SELECT count(*) n FROM character_progression_v23"),
      pending: countOf(db, "SELECT count(*) n FROM character_progression_pending_snapshots_v24"),
      encounters: countOf(db, "SELECT count(*) n FROM encounter"),
    });
    const before = counts();
    const result = f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    if (result.status !== "materialized") throw new Error("expected a materialized faction");

    const factionArtifact = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='faction' AND server_resource_id=?`).get(f.campaign.id, result.factionId) as { canonical_json: string };
    const gmArtifact = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_key=? AND visibility='gm'`).get(f.campaign.id, result.gmAgendaArtifactKey!) as { canonical_json: string };
    const publicValue = JSON.parse(factionArtifact.canonical_json) as Record<string, unknown>;
    const gmValue = JSON.parse(gmArtifact.canonical_json) as { summary: string };
    expect(publicValue).not.toHaveProperty("gmNotes");
    expect(publicValue).not.toHaveProperty("gmAgenda");
    expect(gmValue.summary.trim().length).toBeGreaterThan(0);
    // The GM-only agenda text must not appear anywhere in the public artifact.
    expect(factionArtifact.canonical_json).not.toContain(gmValue.summary);
    expect(factionArtifact.canonical_json.toLowerCase()).not.toContain("gm-only");

    expect(counts()).toEqual(before);
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    const second = f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild");
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.factionId).toBe(first.factionId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.gmAgendaArtifactKey).toBe(first.gmAgendaArtifactKey);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_factions_v28 WHERE campaign_id=? AND faction_id=?", f.campaign.id, first.factionId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-faction-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND source_draft_id=?", f.campaign.id, first.draftId)).toBe(2);
    db.close();
    f.repo.close();
  });

  it("fails closed with no candidate and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the mages guild");
    // A second declaration of the same faction is bounded by classification.
    expect(f.repo.classifyFreeformFactionIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I search for the mages guild"))
      .toMatchObject({ intent: "none", reason: "known-faction" });
    expect(f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-faction-intent" });
    expect(() => f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the smiths guild", { candidateId: "fff-not-a-real-candidate" }))
      .toThrow(FreeformFactionConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_factions_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-faction-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when the apply fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // Inject a durable failure after the faction rows are staged but before the
    // draft commits; the outer transaction must leave nothing behind.
    const db = openDb();
    db.exec(`CREATE TRIGGER freeform_faction_inject_failure BEFORE INSERT ON campaign_generation_accepted_artifacts_v52
      WHEN NEW.artifact_kind='lore' BEGIN SELECT RAISE(ABORT,'injected freeform faction failure'); END;`);
    expect(() => f.repo.materializeFreeformFaction(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for the local thieves' guild"))
      .toThrow();
    db.exec("DROP TRIGGER freeform_faction_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM campaign_factions_v28 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-faction-draft-%'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='faction'", f.campaign.id)).toBe(0);
    // Only the seed's own content command survives; the injected failure rolled the faction command back too.
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });
});
