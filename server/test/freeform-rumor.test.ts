import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformRumorConflictError,
  classifyFreeformRumor,
  deriveFreeformRumorSubject,
  parseFreeformRumorDeclaration,
  selectFreeformRumorTemplate,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const RUMOR_DECLARATION = "I listen for gossip about the salt witch";
const LISTEN_DECLARATION = "I ask around for the local gossip";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Seeds one generated public location ("harbor") with one referenced public
 * faction ("tidewatch") through the ordinary accept path and places the actor
 * there, so the free-form rumor classifier has public canon to ground the
 * hearsay in and to attribute it to.
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
    idempotencyKey: "freeform-rumor-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-rumor-seed-apply", selectedArtifactKeys: ["harbor", "tidewatch"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-rumor",
  });
  return locationId;
}

describe("freeform rumor classification", () => {
  it("bounds listening declarations and known canon against public canon", async () => {
    const f = await dmFixture();
    seedHarbor(f);

    const unknown = f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    expect(unknown.intent).toBe("materialize-rumor");
    if (unknown.intent === "materialize-rumor") {
      expect(unknown.subject).toBe("salt witch");
      expect(unknown.candidates).toHaveLength(1);
      const candidate = unknown.candidates[0]!;
      expect(candidate.visibility).toBe("public");
      expect(candidate.subject).toBe("salt witch");
      expect(candidate.templateId).toBe("wild-talk");
      expect(candidate.locationKey).toBe("harbor");
      // The claim is attributed to a public source; the GM-only truth is separate.
      expect(candidate.source).toBe("Tidewatch");
      expect(candidate.publicText).toContain("Rain Harbor");
      expect(candidate.publicText).toContain("Tidewatch");
      expect(candidate.gmTruth).toContain("Tidewatch");
      expect(candidate.publicText).not.toContain(candidate.gmTruth);
    }

    // A bare listening declaration derives its bounded subject from public canon.
    const bare = f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, LISTEN_DECLARATION);
    expect(bare).toMatchObject({ intent: "materialize-rumor", subject: "Tidewatch" });
    if (bare.intent === "materialize-rumor") {
      expect(bare.candidates[0]!.source).toBe("travellers passing through Rain Harbor");
    }

    expect(f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look around the market"))
      .toMatchObject({ intent: "none", reason: "no-rumor-intent" });
    expect(f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I listen for gossip about the"))
      .toMatchObject({ intent: "none", reason: "empty-subject" });
    expect(f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I listen for gossip about ${"x".repeat(161)}`))
      .toMatchObject({ intent: "none", reason: "subject-too-long" });

    // After the hearsay is committed, the same subject is known canon.
    f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    expect(f.repo.classifyFreeformRumorIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask around for rumors about the salt witch"))
      .toMatchObject({ intent: "none", reason: "known-rumor", title: "salt witch" });
    f.repo.close();
  });

  it("declines without a current location or a generated source artifact", () => {
    expect(classifyFreeformRumor({ identity: "i", text: RUMOR_DECLARATION, currentLocation: null, knownRumorTitles: [] }))
      .toMatchObject({ intent: "none", reason: "no-current-location" });
    expect(classifyFreeformRumor({
      identity: "i", text: RUMOR_DECLARATION, knownRumorTitles: [],
      currentLocation: { locationId: "manual-location", name: "Manual Harbor", visibility: "public", artifactKey: null },
    })).toMatchObject({ intent: "none", reason: "current-location-unmapped" });
    // Parser, template selection and canon derivation are pure and deterministic.
    expect(parseFreeformRumorDeclaration("I listen for gossip about the drowned bell")).toMatchObject({ kind: "subject", subject: "drowned bell" });
    expect(parseFreeformRumorDeclaration("what are people saying about the salt witch")).toMatchObject({ kind: "subject", subject: "salt witch" });
    expect(parseFreeformRumorDeclaration("word on the pale tide")).toMatchObject({ kind: "subject", subject: "pale tide" });
    expect(parseFreeformRumorDeclaration("I ask around for the local gossip")).toMatchObject({ kind: "listen" });
    expect(parseFreeformRumorDeclaration("I sit quietly")).toMatchObject({ kind: "none", reason: "no-rumor-intent" });
    expect(selectFreeformRumorTemplate("the market prices").id).toBe("market-talk");
    expect(selectFreeformRumorTemplate("the salt witch").id).toBe("wild-talk");
    expect(selectFreeformRumorTemplate("a quiet nothing").id).toBe("local");
    expect(deriveFreeformRumorSubject({ locationId: "l", name: "Rain Harbor", visibility: "public", artifactKey: "harbor", factionNames: ["Tidewatch"] })).toBe("Tidewatch");
    expect(deriveFreeformRumorSubject({ locationId: "l", name: "Rain Harbor", visibility: "public", artifactKey: "harbor", factionNames: [] })).toBe("Rain Harbor");
  });
});

describe("freeform rumor materialization", () => {
  it("materializes one public hearsay artifact with a durable receipt", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized rumor");

    const db = openDb();
    // The public hearsay artifact is accepted, public, and server-resourced.
    const hearsay = db.prepare(`SELECT artifact_key,visibility,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'`).get(f.campaign.id) as
      { artifact_key: string; visibility: string; server_resource_id: string; canonical_json: string };
    expect(hearsay.visibility).toBe("public");
    expect(hearsay.server_resource_id).toBe(result.rumorId);
    const hearsayValue = JSON.parse(hearsay.canonical_json) as { title: string; summary: string; locationKeys: string[] };
    expect(hearsayValue.title).toBe("Hearsay: salt witch");
    expect(hearsayValue.summary).toBe(result.candidate.publicText);
    expect(hearsayValue.locationKeys).toEqual(["harbor"]);

    // Exactly one public hearsay artifact and no story graph.
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='clue'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM story_nodes_v34 WHERE campaign_id=?", f.campaign.id)).toBe(0);

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("keeps the GM-only truth out of the public hearsay artifact", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const result = f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    if (result.status !== "materialized") throw new Error("expected a materialized rumor");
    expect(result.gmTruthArtifactKey).toBeTruthy();

    const db = openDb();
    const artifacts = db.prepare(`SELECT artifact_kind,visibility,artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY visibility`).all(f.campaign.id, result.draftId) as
      Array<{ artifact_kind: string; visibility: string; artifact_key: string; canonical_json: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`).sort()).toEqual(["lore:gm", "lore:public"]);

    const gm = artifacts.find((row) => row.visibility === "gm")!;
    const gmValue = JSON.parse(gm.canonical_json) as { title: string; summary: string };
    expect(gmValue.title).toContain("GM-only");
    expect(gmValue.summary.trim().length).toBeGreaterThan(0);

    // The GM-only truth text and key never appear in the public artifact.
    const publicArtifact = artifacts.find((row) => row.visibility === "public")!;
    expect(publicArtifact.canonical_json).not.toContain(gmValue.summary);
    expect(publicArtifact.canonical_json).not.toContain(gm.artifact_key);
    expect(publicArtifact.canonical_json.toLowerCase()).not.toContain("gm-only");
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    const second = f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.rumorId).toBe(first.rumorId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.gmTruthArtifactKey).toBe(first.gmTruthArtifactKey);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='gm'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-rumor-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("fails closed with no compatible declaration and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION);
    expect(f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-rumor-intent" });
    expect(() => f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, "I listen for gossip about the pale tide", { candidateId: "ffr-not-a-real-candidate" }))
      .toThrow(FreeformRumorConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore' AND visibility='public'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-rumor-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when the apply fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // Inject a durable failure when the separate GM-only truth artifact is
    // accepted; the public hearsay is already staged, so the outer transaction
    // must leave nothing behind.
    const db = openDb();
    db.exec(`CREATE TRIGGER freeform_rumor_inject_failure BEFORE INSERT ON campaign_generation_accepted_artifacts_v52
      WHEN NEW.artifact_kind='lore' AND NEW.visibility='gm' BEGIN SELECT RAISE(ABORT,'injected freeform rumor failure'); END;`);
    expect(() => f.repo.materializeFreeformRumor(OWNER, f.campaign.id, f.session.id, f.actorId, RUMOR_DECLARATION))
      .toThrow();
    db.exec("DROP TRIGGER freeform_rumor_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-rumor-draft-%'", f.campaign.id)).toBe(0);
    // Only the seed's own content command survives; the injected failure rolled the rumor command back too.
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });
});
