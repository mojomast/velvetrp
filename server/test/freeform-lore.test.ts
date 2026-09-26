import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformLoreConflictError,
  classifyFreeformLore,
  parseFreeformLoreSubject,
  selectFreeformLoreTemplate,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const LORE_DECLARATION = "I recall the legend of the salt witch";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Seeds one generated public location ("harbor") with one referenced public
 * faction ("tidewatch") through the ordinary accept path and places the actor
 * there, so the free-form classifier has public canon to anchor a clue to and to
 * fill its templates from.
 */
function seedHarbor(f: Fixture): string {
  const content = generatedCampaignContentProviderSchema.parse({
    locations: [{
      key: "harbor", name: "Rain Harbor", description: "A public harbor under grey rain.", visibility: "public",
      factionKeys: ["tidewatch"],
    }],
    factions: [{
      key: "tidewatch", name: "Tidewatch", description: "The harbor's public watch.", visibility: "public",
      gmNotes: "SECRET_TIDEWATCH_GOALS",
    }],
  });
  const context = f.repo.getCampaignGenerationContext(OWNER, f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft(OWNER, {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "c".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision,
    idempotencyKey: "freeform-lore-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-lore-seed-apply", selectedArtifactKeys: ["harbor", "tidewatch"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-lore",
  });
  return locationId;
}

describe("freeform lore classification", () => {
  it("bounds declarations and known lore against public canon", async () => {
    const f = await dmFixture();
    seedHarbor(f);

    const unknown = f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    expect(unknown.intent).toBe("materialize-lore");
    if (unknown.intent === "materialize-lore") {
      expect(unknown.candidates).toHaveLength(1);
      expect(unknown.candidates[0]!.visibility).toBe("public");
      expect(unknown.candidates[0]!.title).toBe("salt witch");
      expect(unknown.candidates[0]!.templateId).toBe("legend");
      expect(unknown.candidates[0]!.locationKey).toBe("harbor");
      // Public canon fills the template text; the GM-only truth is separate.
      expect(unknown.candidates[0]!.publicText).toContain("Rain Harbor");
      expect(unknown.candidates[0]!.gmSecret).toContain("Tidewatch");
      expect(unknown.candidates[0]!.publicText).not.toContain(unknown.candidates[0]!.gmSecret);
    }

    expect(f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look around the market"))
      .toMatchObject({ intent: "none", reason: "no-lore-intent" });
    expect(f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I recall the legend of ."))
      .toMatchObject({ intent: "none", reason: "empty-subject" });
    expect(f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I recall the legend of ${"x".repeat(161)}`))
      .toMatchObject({ intent: "none", reason: "subject-too-long" });

    // After the clue is committed, the same subject is known canon.
    f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    expect(f.repo.classifyFreeformLoreIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I remember the legend of the salt witch"))
      .toMatchObject({ intent: "none", reason: "known-lore", title: "salt witch" });
    f.repo.close();
  });

  it("declines without a current location or a generated source artifact", () => {
    expect(classifyFreeformLore({ identity: "i", text: LORE_DECLARATION, currentLocation: null, knownLoreTitles: [] }))
      .toMatchObject({ intent: "none", reason: "no-current-location" });
    expect(classifyFreeformLore({
      identity: "i", text: LORE_DECLARATION, knownLoreTitles: [],
      currentLocation: { locationId: "manual-location", name: "Manual Harbor", visibility: "public", artifactKey: null },
    })).toMatchObject({ intent: "none", reason: "current-location-unmapped" });
    // Parser and template selection are pure and deterministic.
    expect(parseFreeformLoreSubject("I recall the legend of the drowned bell")).toMatchObject({ ok: true, subject: "drowned bell" });
    expect(parseFreeformLoreSubject("I ask about the old rumor of the salt witch")).toMatchObject({ ok: true, subject: "salt witch" });
    expect(selectFreeformLoreTemplate("the founding of Rain Harbor").id).toBe("local-history");
    expect(selectFreeformLoreTemplate("the salt witch").id).toBe("legend");
    expect(selectFreeformLoreTemplate("a quiet nothing").id).toBe("local");
  });
});

describe("freeform lore materialization", () => {
  it("materializes a public clue with a public source node and a durable receipt", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized clue");

    const db = openDb();
    // The public clue artifact is accepted, public, and server-resourced.
    const clue = db.prepare(`SELECT artifact_key,visibility,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='clue'`).get(f.campaign.id) as { artifact_key: string; visibility: string; server_resource_id: string; canonical_json: string };
    expect(clue.visibility).toBe("public");
    expect(clue.server_resource_id).toBe(result.clueId);

    // Its public source node is a real story node with hidden initial state.
    const node = db.prepare(`SELECT visibility,server_resource_id FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='story-node'`).get(f.campaign.id) as { visibility: string; server_resource_id: string };
    expect(node.visibility).toBe("public");
    expect(node.server_resource_id).toBe(result.sourceStoryNodeId);
    expect(db.prepare("SELECT status FROM story_node_state_v34 WHERE campaign_id=? AND node_id=?")
      .get(f.campaign.id, result.sourceStoryNodeId)).toMatchObject({ status: "hidden" });

    // The clue is bound to its public source through the story graph, with no hidden anchor.
    const storyClue = db.prepare("SELECT clue_id,reveal_threshold FROM story_clues_v34 WHERE campaign_id=? AND clue_id=?")
      .get(f.campaign.id, result.clueId) as { clue_id: string; reveal_threshold: number };
    expect(storyClue.reveal_threshold).toBe(1);
    expect(db.prepare("SELECT source_kind,target_id FROM story_clue_sources_v34 WHERE campaign_id=? AND clue_id=?")
      .get(f.campaign.id, result.clueId)).toMatchObject({ source_kind: "node", target_id: result.sourceStoryNodeId });
    expect(countOf(db, "SELECT count(*) n FROM story_nodes_v34 WHERE campaign_id=?", f.campaign.id)).toBe(1);

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("keeps the GM-only truth out of the public clue and its public source node", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    if (result.status !== "materialized") throw new Error("expected a materialized clue");
    expect(result.gmSecretArtifactKey).toBeTruthy();

    const db = openDb();
    const artifacts = db.prepare(`SELECT artifact_kind,visibility,artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, result.draftId) as Array<{ artifact_kind: string; visibility: string; artifact_key: string; canonical_json: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`).sort()).toEqual(["clue:public", "lore:gm", "story-node:public"]);

    const gm = artifacts.find((row) => row.visibility === "gm")!;
    const gmValue = JSON.parse(gm.canonical_json) as { title: string; summary: string };
    expect(gmValue.title).toContain("GM-only");
    expect(gmValue.summary.trim().length).toBeGreaterThan(0);

    // The GM-only truth text and key never appear in either public artifact.
    for (const row of artifacts.filter((value) => value.visibility === "public")) {
      expect(row.canonical_json).not.toContain(gmValue.summary);
      expect(row.canonical_json).not.toContain(gm.artifact_key);
      expect(row.canonical_json.toLowerCase()).not.toContain("gm-only");
    }
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    const second = f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.clueId).toBe(first.clueId);
    expect(second.sourceStoryNodeId).toBe(first.sourceStoryNodeId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.gmSecretArtifactKey).toBe(first.gmSecretArtifactKey);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='clue'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='story-node'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-lore-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM story_clues_v34 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("fails closed with no compatible declaration and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION);
    expect(f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-lore-intent" });
    expect(() => f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, "I recall the legend of the pale tide", { candidateId: "ffl-not-a-real-candidate" }))
      .toThrow(FreeformLoreConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='clue'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-lore-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when the apply fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // Inject a durable failure when the separate GM-only truth artifact is
    // accepted; the public node and clue are already staged, so the outer
    // transaction must leave nothing behind.
    const db = openDb();
    db.exec(`CREATE TRIGGER freeform_lore_inject_failure BEFORE INSERT ON campaign_generation_accepted_artifacts_v52
      WHEN NEW.artifact_kind='lore' BEGIN SELECT RAISE(ABORT,'injected freeform lore failure'); END;`);
    expect(() => f.repo.materializeFreeformLore(OWNER, f.campaign.id, f.session.id, f.actorId, LORE_DECLARATION))
      .toThrow();
    db.exec("DROP TRIGGER freeform_lore_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind IN ('clue','story-node','lore')", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM story_clues_v34 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM story_nodes_v34 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-lore-draft-%'", f.campaign.id)).toBe(0);
    // Only the seed's own content command survives; the injected failure rolled the clue command back too.
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });
});
