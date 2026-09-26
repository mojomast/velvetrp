import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  FreeformQuestConflictError,
  MAX_FREEFORM_QUEST_OBJECTIVES,
  classifyFreeformQuest,
  parseFreeformQuestLead,
  selectFreeformQuestTemplate,
} from "../src/repo/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const QUEST_DECLARATION = "I ask around for work";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const openDb = (): DatabaseDriver.Database => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const countOf = (db: DatabaseDriver.Database, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Seeds one generated public location ("harbor") through the ordinary accept
 * path and places the actor there, so the free-form classifier has a generated
 * public source location to anchor an ad-hoc quest to.
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
    idempotencyKey: "freeform-quest-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "freeform-quest-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = openDb();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "place-hero-quest",
  });
  return locationId;
}

describe("freeform quest classification", () => {
  it("bounds declarations and known work against public canon", async () => {
    const f = await dmFixture();
    seedHarbor(f);

    const unknown = f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    expect(unknown.intent).toBe("materialize-quest");
    if (unknown.intent === "materialize-quest") {
      expect(unknown.candidates).toHaveLength(1);
      const candidate = unknown.candidates[0]!;
      expect(candidate.visibility).toBe("public");
      expect(candidate.templateId).toBe("labor");
      expect(candidate.title).toContain("Rain Harbor");
      expect(candidate.locationKey).toBe("harbor");
      // A small bounded set of public objectives, chained by dependency.
      expect(candidate.objectives.length).toBeGreaterThan(0);
      expect(candidate.objectives.length).toBeLessThanOrEqual(MAX_FREEFORM_QUEST_OBJECTIVES);
      expect(candidate.objectives.every((objective) => objective.visibility === "public")).toBe(true);
      expect(candidate.objectives[0]!.dependencyObjectiveKeys).toEqual([]);
      expect(candidate.objectives[1]!.dependencyObjectiveKeys).toEqual([candidate.objectives[0]!.key]);
      // The single reward is explicitly inert.
      expect(candidate.reward).toMatchObject({ kind: "custom", amount: null, visibility: "public" });
      expect(candidate.gmTwist.length).toBeGreaterThan(0);
    }

    expect(f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ intent: "none", reason: "no-quest-intent" });
    expect(f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I ask the glassblower about the road"))
      .toMatchObject({ intent: "none", reason: "no-quest-intent" });
    expect(f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, `I ask for ${"x".repeat(201)} work`))
      .toMatchObject({ intent: "none", reason: "lead-too-long" });

    // After the quest is committed, a request that selects the same title is known work.
    f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    expect(f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, "I look for work"))
      .toMatchObject({ intent: "none", reason: "known-quest" });
    f.repo.close();
  });

  it("declines without a current location or a generated source artifact", () => {
    expect(classifyFreeformQuest({ identity: "i", text: QUEST_DECLARATION, currentLocation: null, knownQuestTitles: [] }))
      .toMatchObject({ intent: "none", reason: "no-current-location" });
    expect(classifyFreeformQuest({
      identity: "i", text: QUEST_DECLARATION, knownQuestTitles: [],
      currentLocation: { locationId: "manual-location", name: "Manual Harbor", visibility: "public", artifactKey: null },
    })).toMatchObject({ intent: "none", reason: "current-location-unmapped" });
    // Parser and template selection are pure and deterministic.
    expect(parseFreeformQuestLead("any leads?")).toMatchObject({ ok: true });
    expect(parseFreeformQuestLead("I need an escort job")).toMatchObject({ ok: true });
    expect(parseFreeformQuestLead("I look around the market")).toMatchObject({ ok: false, reason: "no-quest-intent" });
    expect(selectFreeformQuestTemplate("an escort contract").id).toBe("escort");
    expect(selectFreeformQuestTemplate("a courier delivery").id).toBe("delivery");
    expect(selectFreeformQuestTemplate("work").id).toBe("labor");
    expect(selectFreeformQuestTemplate("something vague").id).toBe("general");
  });
});

describe("freeform quest materialization", () => {
  it("materializes a public quest with public objectives and a durable receipt", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const classification = f.repo.classifyFreeformQuestIntent(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    if (classification.intent !== "materialize-quest") throw new Error("expected a materialization classification");
    const expectedObjectives = classification.candidates[0]!.objectives.length;

    const result = f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    expect(result.status).toBe("materialized");
    if (result.status !== "materialized") throw new Error("expected a materialized quest");

    const db = openDb();
    // The accepted quest artifact is public and server-resourced.
    const quest = db.prepare(`SELECT visibility,server_resource_id FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='quest'`).get(f.campaign.id) as { visibility: string; server_resource_id: string };
    expect(quest.visibility).toBe("public");
    expect(quest.server_resource_id).toBe(result.questId);

    // The quest domain rows are written through the generation apply.
    expect(db.prepare("SELECT title,status FROM quests WHERE campaign_id=? AND id=?")
      .get(f.campaign.id, result.questId)).toMatchObject({ status: "open" });
    expect(db.prepare("SELECT visibility FROM quest_definitions_v33 WHERE campaign_id=? AND quest_id=?")
      .get(f.campaign.id, result.questId)).toMatchObject({ visibility: "public" });
    expect(countOf(db, "SELECT count(*) n FROM quest_objectives_v33 WHERE campaign_id=? AND quest_id=?", f.campaign.id, result.questId)).toBe(expectedObjectives);
    expect(countOf(db, "SELECT count(*) n FROM quest_objective_progress_v33 WHERE campaign_id=? AND quest_id=?", f.campaign.id, result.questId)).toBe(expectedObjectives);
    expect(countOf(db, "SELECT count(*) n FROM quest_objective_dependencies_v33 WHERE campaign_id=? AND quest_id=?", f.campaign.id, result.questId)).toBe(expectedObjectives - 1);
    expect(db.prepare("SELECT kind,amount FROM quest_rewards WHERE campaign_id=? AND quest_id=?")
      .get(f.campaign.id, result.questId)).toMatchObject({ kind: "custom", amount: null });

    // Durable campaign-content command + receipt.
    expect(result.contentReceiptId).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?").get(f.campaign.id, result.draftId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM campaign_content_receipts_v42 WHERE receipt_id=? AND draft_id=?")
      .get(result.contentReceiptId, result.draftId)).toBeTruthy();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
    f.repo.close();
  });

  it("keeps the GM-only twist out of the public quest and fabricates no mechanics", async () => {
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
    const result = f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    if (result.status !== "materialized") throw new Error("expected a materialized quest");
    expect(result.gmTwistArtifactKey).toBeTruthy();

    const artifacts = db.prepare(`SELECT artifact_kind,visibility,artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? ORDER BY artifact_kind`).all(f.campaign.id, result.draftId) as Array<{ artifact_kind: string; visibility: string; artifact_key: string; canonical_json: string }>;
    expect(artifacts.map((row) => `${row.artifact_kind}:${row.visibility}`)).toEqual(["lore:gm", "quest:public"]);

    const publicQuest = artifacts.find((row) => row.visibility === "public")!;
    const gm = artifacts.find((row) => row.visibility === "gm")!;
    const gmValue = JSON.parse(gm.canonical_json) as { summary: string };
    const publicValue = JSON.parse(publicQuest.canonical_json) as { objectives: Array<{ visibility: string }>; rewards: Array<{ kind: string; amount: unknown }> };
    expect(gmValue.summary.trim().length).toBeGreaterThan(0);
    expect(publicQuest.canonical_json).not.toContain(gmValue.summary);
    expect(publicQuest.canonical_json).not.toContain(gm.artifact_key);
    expect(publicQuest.canonical_json.toLowerCase()).not.toContain("gm-only");
    expect(publicValue.objectives.every((objective) => objective.visibility === "public")).toBe(true);
    expect(publicValue.rewards).toEqual([expect.objectContaining({ kind: "custom", amount: null })]);

    // No fabricated mechanics: no class levels, progression or encounters.
    expect(counts()).toEqual(before);
    db.close();
    f.repo.close();
  });

  it("converges exactly once on replay", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    const first = f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    const second = f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    expect(first.status).toBe("materialized");
    expect(second.status).toBe("materialized");
    if (first.status !== "materialized" || second.status !== "materialized") throw new Error("expected materializations");
    expect(second.questId).toBe(first.questId);
    expect(second.draftId).toBe(first.draftId);
    expect(second.contentReceiptId).toBe(first.contentReceiptId);
    expect(second.gmTwistArtifactKey).toBe(first.gmTwistArtifactKey);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=? AND id=?", f.campaign.id, first.questId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='quest'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind='lore'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-quest-draft-%'", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=? AND draft_id=?", f.campaign.id, first.draftId)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM quest_domain_commands_v33 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("fails closed with no compatible declaration and refuses an unknown candidate", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION);
    expect(f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, "I sit quietly"))
      .toMatchObject({ status: "declined", reason: "no-quest-intent" });
    expect(() => f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, "I want steady work", { candidateId: "ffq-not-a-real-candidate" }))
      .toThrow(FreeformQuestConflictError);

    const db = openDb();
    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=?", f.campaign.id)).toBe(1);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-quest-draft-%'", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });

  it("rolls the whole materialization back when the apply fails", async () => {
    const f = await dmFixture();
    seedHarbor(f);
    // Inject a durable failure when the separate GM-only twist artifact is
    // accepted; the public quest rows are already staged, so the outer
    // transaction must leave nothing behind.
    const db = openDb();
    db.exec(`CREATE TRIGGER freeform_quest_inject_failure BEFORE INSERT ON campaign_generation_accepted_artifacts_v52
      WHEN NEW.artifact_kind='lore' BEGIN SELECT RAISE(ABORT,'injected freeform quest failure'); END;`);
    expect(() => f.repo.materializeFreeformQuest(OWNER, f.campaign.id, f.session.id, f.actorId, QUEST_DECLARATION))
      .toThrow();
    db.exec("DROP TRIGGER freeform_quest_inject_failure");

    expect(countOf(db, "SELECT count(*) n FROM quests WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM quest_objectives_v33 WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM quest_rewards WHERE campaign_id=?", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_kind IN ('quest','lore')", f.campaign.id)).toBe(0);
    expect(countOf(db, "SELECT count(*) n FROM generation_drafts WHERE campaign_id=? AND idempotency_key LIKE 'ff-quest-draft-%'", f.campaign.id)).toBe(0);
    // Only the seed's own content command survives; the injected failure rolled the quest command back too.
    expect(countOf(db, "SELECT count(*) n FROM campaign_content_commands_v42 WHERE campaign_id=?", f.campaign.id)).toBe(1);
    db.close();
    f.repo.close();
  });
});
