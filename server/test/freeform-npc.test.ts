import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformNpcConflictError,
  classifyFreeformNpc,
  createSession,
  parseFreeformNpcAddress,
  selectFreeformNpcArchetype,
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
 * public source location to place an ad-hoc NPC in.
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
    idempotencyKey: "freeform-npc-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-npc-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-npc",
  });
  return locationId;
}

describe("freeform npc classification", () => {
  it("bounds known and duplicate names against the public roster and malformed text", async () => {
    const f = await dmFixture();
    const harborId = seedHarbor(f);

    const unknown = f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    expect(unknown.intent).toBe("materialize-npc");
    if (unknown.intent === "materialize-npc") {
      expect(unknown.candidates).toHaveLength(1);
      expect(unknown.candidates[0]!.visibility).toBe("public");
      expect(unknown.candidates[0]!.name.toLowerCase()).toContain("glassblower");
      expect(unknown.candidates[0]!.archetype).toBe("Artisan");
      expect(unknown.candidates[0]!.locationKey).toBe("harbor");
    }

    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look around the market"))
      .toMatchObject({ intent: "none", reason: "no-npc-intent" });
    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask about the road"))
      .toMatchObject({ intent: "none", reason: "no-npc-intent" });
    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I greet ."))
      .toMatchObject({ intent: "none", reason: "empty-name" });
    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I ask ${"x".repeat(201)}`))
      .toMatchObject({ intent: "none", reason: "name-too-long" });

    // After the persona is committed, the same declaration is a duplicate.
    f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I speak with the glassblower"))
      .toMatchObject({ intent: "none", reason: "known-npc", npcName: "glassblower" });
    expect(harborId).toBeTruthy();
    f.repo.close();
  });

  it("declines without a current location or a generated source artifact", () => {
    expect(classifyFreeformNpc({ identity: "i", text: "I ask the glassblower", currentLocation: null, knownNpcs: [] }))
      .toMatchObject({ intent: "none", reason: "no-current-location" });
    expect(classifyFreeformNpc({
      identity: "i", text: "I ask the glassblower", knownNpcs: [],
      currentLocation: { locationId: "manual-location", name: "Manual Harbor", visibility: "public", artifactKey: null },
    })).toMatchObject({ intent: "none", reason: "current-location-unmapped" });
    // Parser and archetype selection are pure and deterministic.
    expect(parseFreeformNpcAddress("I tell the guard to open the gate")).toMatchObject({ ok: true, name: "guard" });
    expect(selectFreeformNpcArchetype("the blacksmith").id).toBe("artisan");
    expect(selectFreeformNpcArchetype("a wandering nobody").id).toBe("bystander");
  });
});

describe("freeform npc materialization", () => {
  it("materializes a public persona with a durable receipt and a separate GM-only goals artifact", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized NPC");

    const db = openDb();
    const npc = db.prepare("SELECT public_name,speech_control,persona_id FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?")
      .get(f.campaign.id, result.npcId) as { public_name: string; speech_control: string; persona_id: string };
    expect(npc.public_name.toLowerCase()).toContain("glassblower");
    expect(npc.speech_control).toBe("manual");
    // A fictional persona only: no player-character identity, credentials or permissions.
    expect(db.prepare("SELECT name,archetype,fictional_confirmed,is_real_person FROM characters WHERE id=?").get(npc.persona_id))
      .toMatchObject({ archetype: "Artisan", fictional_confirmed: 1, is_real_person: 0 });
    expect(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, result.npcId)).toBeUndefined();

    // Public persona metadata vs. GM-only private state.
    const metadata = db.prepare("SELECT public_state_json,private_state_json FROM campaign_npc_metadata_v32 WHERE campaign_id=? AND npc_id=?")
      .get(f.campaign.id, result.npcId) as { public_state_json: string; private_state_json: string };
    expect((JSON.parse(metadata.public_state_json) as { name?: string }).name?.toLowerCase()).toContain("glassblower");
    expect(metadata.private_state_json).toContain("goals");

    // The personality is placed present in the single active room.
    expect(db.prepare(`SELECT state,location_id FROM campaign_npc_presence_v43
      WHERE campaign_id=? AND session_id=? AND npc_id=?`).get(f.campaign.id, f.session.id, result.npcId))
      .toMatchObject({ state: "present" });

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();

    // Exactly one public npc artifact and one separate GM-only goals artifact.
    const artifacts = db.prepare(`SELECT artifact_kind,visibility,artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, result.draftId) as Array<{ artifact_kind: string; visibility: string; artifact_key: string; canonical_json: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`)).toEqual(["lore:gm", "npc:public"]);
    expect(result.gmGoalsArtifactKey).toBeTruthy();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("keeps GM-only goals out of the public persona artifact and fabricates no stats", async () => {
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
    const result = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    if (result.status !== "materialized") throw new Error("expected a materialized NPC");

    const npcArtifact = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='npc' AND server_resource_id=?`).get(f.campaign.id, result.npcId) as { canonical_json: string };
    const gmArtifact = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_key=? AND visibility='gm'`).get(f.campaign.id, result.gmGoalsArtifactKey!) as { canonical_json: string };
    const publicValue = JSON.parse(npcArtifact.canonical_json) as Record<string, unknown>;
    const gmValue = JSON.parse(gmArtifact.canonical_json) as { summary: string };
    expect(publicValue).not.toHaveProperty("privateGoals");
    expect(gmValue.summary.trim().length).toBeGreaterThan(0);
    // The GM-only goals text must not appear anywhere in the public artifact.
    expect(npcArtifact.canonical_json).not.toContain(gmValue.summary);
    expect(npcArtifact.canonical_json.toLowerCase()).not.toContain("gm-only");

    // No fabricated mechanics: only the fixed deterministic baseline, no class levels or progression.
    expect(db.prepare(`SELECT body,mind,presence,source FROM campaign_npc_baseline_stats_v41 WHERE campaign_id=? AND npc_id=?`)
      .get(f.campaign.id, result.npcId))
      .toMatchObject({ body: 10, mind: 10, presence: 10, source: "generated-deterministic-baseline" });
    expect(counts()).toEqual(before);
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    const second = f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road");
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.npcId).toBe(first.npcId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.gmGoalsArtifactKey).toBe(first.gmGoalsArtifactKey);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?", f.campaign.id, first.npcId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND source_draft_id=?", f.campaign.id, first.draftId)).toBe(2);
    db.close();
    f.repo.close();
  });

  it("fails closed with no candidate and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I greet Elara");
    // A second declaration of the same person is bounded by classification.
    expect(f.repo.classifyFreeformNpcIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I talk to Elara"))
      .toMatchObject({ intent: "none", reason: "known-npc" });
    expect(f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-npc-intent" });
    expect(() => f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I speak with the blacksmith", { candidateId: "ffn-not-a-real-candidate" }))
      .toThrow(FreeformNpcConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when the apply fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // Inject a durable failure after the persona rows are staged but before the
    // draft commits; the outer transaction must leave nothing behind.
    const db = openDb();
    db.exec(`CREATE TRIGGER freeform_npc_inject_failure BEFORE INSERT ON campaign_generation_accepted_artifacts_v52
      WHEN NEW.artifact_kind='lore' BEGIN SELECT RAISE(ABORT,'injected freeform npc failure'); END;`);
    expect(() => f.repo.materializeFreeformNpc(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road"))
      .toThrow();
    db.exec("DROP TRIGGER freeform_npc_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-npc-draft-%'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='npc'", f.campaign.id)).toBe(0);
    // Only the seed's own content command survives; the injected failure rolled the NPC command back too.
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM characters WHERE name='glassblower'")).toBe(0);
    db.close();
    f.repo.close();
  });
});
