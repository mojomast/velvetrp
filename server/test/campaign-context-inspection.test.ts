import DatabaseDriver from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignContextInspectionUnavailableError, createCampaignContextInspectionReadRepository } from "../src/repo/campaign/campaignContextInspectionReadRepo.js";
import { closeRepo } from "../src/repo/index.js";
import { createSettledDmDispatches, dmFixture } from "./fixtures/dmCampaign.js";
import { createMemoryEvalFixture } from "./fixtures/memory-evals/fixture.js";

const directories: string[] = [];
afterEach(() => { closeRepo(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); delete process.env.VELVET_DATA_DIR; });

describe("campaign context inspection planning reader", () => {
  it("binds one exact persisted planning claim without reading payloads or mutating storage", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "velvet-context-inspection-")); directories.push(directory); process.env.VELVET_DATA_DIR = directory;
    const fixture = await createMemoryEvalFixture(directory);
    const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
    const claim = db.prepare(`SELECT claim.claim_id id FROM agent_provider_dispatch_claims_v39 claim
      JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
      JOIN adventure_turns turn ON turn.id=context.turn_id WHERE turn.campaign_id=? ORDER BY claim.claimed_at DESC LIMIT 1`).get(fixture.campaign.id) as { id: string };
    const reader = createCampaignContextInspectionReadRepository(db), identity = { campaignId: fixture.campaign.id, sessionId: fixture.session.id, lane: "adventure-planning" as const, dispatchId: claim.id };
    const before = db.pragma("data_version", { simple: true });
    const inspected = reader.inspectCampaignContext("local-owner", identity);
    expect(inspected).toMatchObject({ availability: "available", identity, dispatch: { recordedPhase: "planned", settlement: "settled" }, recallHits: [] });
    if (inspected.availability !== "available") throw new Error("inspection unavailable");
    expect(inspected.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "included", label: "Decision identity" }),
      expect.objectContaining({ status: "included", label: "Historical recall" }),
      expect.objectContaining({ status: "withheld", reason: "private-source" }),
    ]));
    expect(JSON.stringify(inspected)).not.toMatch(/candidateId|digest|request_json|context_json|cedarlight/);
    expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThanOrEqual(24 * 1024);
    expect(db.pragma("data_version", { simple: true })).toBe(before);
    expect(db.prepare("SELECT source_label FROM campaign_context_inspection_sources_v61 WHERE dispatch_id=? ORDER BY source_order").all(claim.id)).toEqual([
      { source_label: "Decision identity" }, { source_label: "Campaign context" }, { source_label: "Historical recall" }, { source_label: "Provider tool registry" },
    ]);
    expect(reader.inspectCampaignContext("local-owner", { ...identity, dispatchId: "missing-dispatch" })).toMatchObject({ availability: "unavailable", reason: "dispatch-not-found" });
    expect(reader.inspectCampaignContext("local-owner", { ...identity, lane: "adventure-narration" })).toMatchObject({ availability: "unavailable", reason: "dispatch-not-found" });
    expect(reader.inspectCampaignContext("local-owner", { ...identity, lane: "director-planning" })).toMatchObject({ availability: "unavailable", reason: "dispatch-not-found" });
    expect(reader.inspectCampaignContext("not-a-member", identity)).toMatchObject({ availability: "unavailable", reason: "access-revoked" });
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run("inspection-gm", "Inspection GM");
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run("inspection-player", "Inspection player");
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) SELECT id,?,?,updated_at FROM campaigns WHERE id=?")
      .run("inspection-gm", "gm", fixture.campaign.id);
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) SELECT id,?,?,updated_at FROM campaigns WHERE id=?")
      .run("inspection-player", "player", fixture.campaign.id);
    const planningSource = db.prepare(`SELECT turn.id FROM adventure_turns turn
      JOIN agent_provider_contexts_v39 context ON context.campaign_id=turn.campaign_id AND context.turn_id=turn.id
      WHERE turn.campaign_id=? ORDER BY context.round_number,context.context_id LIMIT 1`).get(fixture.campaign.id) as { id: string };
    const planningReferences = reader.resolveCampaignContextInspectionDispatchReferences("inspection-gm", {
      campaignId: fixture.campaign.id, sessionId: fixture.session.id,
      source: { kind: "adventure-turn", sourceId: planningSource.id },
    });
    expect(planningReferences.identity.source).toEqual({ kind: "adventure-turn", sourceId: planningSource.id });
    expect(planningReferences.references.length).toBeGreaterThan(0);
    expect(planningReferences.references.every(reference => reference.lane === "adventure-planning")).toBe(true);
    const expectedPlanning = db.prepare(`SELECT claim.claim_id dispatchId FROM agent_provider_dispatch_claims_v39 claim
      JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
      WHERE claim.campaign_id=? AND claim.turn_id=? ORDER BY context.round_number,claim.claim_id LIMIT 6`)
      .all(fixture.campaign.id, planningSource.id) as Array<{ dispatchId: string }>;
    expect(planningReferences.references).toEqual(expectedPlanning.map(row => ({ lane: "adventure-planning", dispatchId: row.dispatchId })));
    expect(reader.resolveCampaignContextInspectionDispatchReferences("local-owner", {
      campaignId: fixture.campaign.id, sessionId: fixture.session.id,
      source: { kind: "adventure-turn", sourceId: fixture.sourceIds["holdout:passage"]! },
    }).references).toEqual([]);
    expect(() => reader.resolveCampaignContextInspectionDispatchReferences("inspection-player", planningReferences.identity))
      .toThrow(CampaignContextInspectionUnavailableError);
    expect(() => reader.resolveCampaignContextInspectionDispatchReferences("local-owner", {
      ...planningReferences.identity, source: { kind: "adventure-turn", sourceId: "missing-turn" },
    })).toThrow(CampaignContextInspectionUnavailableError);
    const director = await dmFixture();
    const directorRun = await createSettledDmDispatches(director);
    const planning = db.prepare("SELECT claim_id id FROM dm_dispatches WHERE run_id=?").get(directorRun.runId) as { id: string };
    const narrated = db.prepare("SELECT claim_id id FROM dm_narration_dispatches WHERE run_id=?").get(directorRun.runId) as { id: string };
    const directorReferences = reader.resolveCampaignContextInspectionDispatchReferences("local-owner", {
      campaignId: director.campaign.id, sessionId: director.session.id,
      source: { kind: "director-run", sourceId: directorRun.runId },
    });
    expect(directorReferences.references).toEqual([
      { lane: "director-planning", dispatchId: planning.id },
      { lane: "director-narration", dispatchId: narrated.id },
    ]);
    for (const laneIdentity of [{ campaignId: director.campaign.id, sessionId: director.session.id, lane: "director-planning" as const, dispatchId: planning.id }, { campaignId: director.campaign.id, sessionId: director.session.id, lane: "director-narration" as const, dispatchId: narrated.id }, { ...identity, lane: "adventure-narration" as const, dispatchId: fixture.narrationDispatchId }]) {
      const version = db.pragma("data_version", { simple: true });
      const result = reader.inspectCampaignContext("local-owner", laneIdentity);
      expect(result).toMatchObject({ availability: "available", identity: laneIdentity, recallHits: [] });
      if (result.availability !== "available") throw new Error("inspection unavailable");
      expect(result.sections.at(-1)).toMatchObject({ status: "withheld", reason: "private-source" });
      expect(db.pragma("data_version", { simple: true })).toBe(version);
    }
    const fallbackTurn = fixture.repo.createAdventureTurn("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id,
      timelineId: fixture.repo.getCampaign("local-owner", fixture.campaign.id)!.activeTimelineId, actorId: fixture.actors.aster,
      declaration: "I wait for an uncertain narration.", expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "inspection:unknown-narration" });
    fixture.repo.updateAdventureTurnNarration("local-owner", { turnId: fallbackTurn.turnId, expectedTurnRevision: fallbackTurn.revision,
      expectedCampaignRevision: fallbackTurn.campaignRevision, idempotencyKey: "inspection:unknown-narration:start", narrationStatus: "in-progress" });
    const fallbackClaim = fixture.repo.claimNarrationProviderDispatch("local-owner", { turnId: fallbackTurn.turnId, callId: "inspection-unknown",
      provider: "fake", model: "fake", fallbackNarration: "Fallback.", leaseMs: 60_000, context: {}, request: {} });
    if (fallbackClaim.state !== "claimed") throw new Error("fallback dispatch unavailable");
    fixture.repo.settleNarrationProviderDispatch("local-owner", { turnId: fallbackTurn.turnId, callId: "inspection-unknown", claimId: fallbackClaim.claimId,
      source: "deterministic-fallback", narration: "Fallback.", outcomeCode: "narration-failed-estimated", promptTokens: null, completionTokens: null });
    expect(reader.inspectCampaignContext("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id,
      lane: "adventure-narration", dispatchId: fallbackClaim.claimId })).toMatchObject({ availability: "available",
      dispatch: { certainty: "provider-outcome-unknown", settlement: "settled" } });
    director.repo.close();
    db.close(); fixture.repo.close();
  });

  it.each(["revoked", "omit"] as const)("materializes %s provenance at dispatch creation without mutating immutable sidecars", async mode => {
    const directory = mkdtempSync(path.join(tmpdir(), `velvet-context-inspection-${mode}-`)); directories.push(directory);
    process.env.VELVET_DATA_DIR = directory;
    const fixture = await createMemoryEvalFixture(directory, mode);
    const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
    const reader = createCampaignContextInspectionReadRepository(db);
    const rows = db.prepare(`SELECT claim.claim_id planning_id,
      (SELECT dispatch.claim_id FROM adventure_narration_dispatches_v60 dispatch
        JOIN adventure_turns narrated ON narrated.id=dispatch.turn_id
        WHERE narrated.campaign_id=turn.campaign_id ORDER BY dispatch.claimed_at DESC LIMIT 1) narration_id
      FROM agent_provider_dispatch_claims_v39 claim
      JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
      JOIN adventure_turns turn ON turn.id=context.turn_id
      WHERE turn.campaign_id=? ORDER BY claim.claimed_at DESC LIMIT 1`).get(fixture.campaign.id) as { planning_id: string; narration_id: string };
    const expectedReason = mode === "revoked" ? "current-visibility-revoked" : "provenance-not-recorded";
    for (const identity of [
      { campaignId: fixture.campaign.id, sessionId: fixture.session.id, lane: "adventure-planning" as const, dispatchId: rows.planning_id },
      { campaignId: fixture.campaign.id, sessionId: fixture.session.id, lane: "adventure-narration" as const, dispatchId: rows.narration_id },
    ]) {
      const before = db.pragma("data_version", { simple: true });
      const result = reader.inspectCampaignContext("local-owner", identity);
      if (mode === "revoked") expect(result).toMatchObject({ availability: "available", sections: [{ status: "withheld", reason: expectedReason }] });
      else expect(result).toMatchObject({ availability: "unavailable", reason: expectedReason });
      expect(db.pragma("data_version", { simple: true })).toBe(before);
    }
    db.close(); fixture.repo.close(); closeRepo();

    const directorDirectory = mkdtempSync(path.join(tmpdir(), `velvet-context-inspection-director-${mode}-`)); directories.push(directorDirectory);
    process.env.VELVET_DATA_DIR = directorDirectory;
    const director = await dmFixture(false, { dataDir: directorDirectory, contextInspectionProvenance: mode });
    const run = await createSettledDmDispatches(director);
    const directorDb = new DatabaseDriver(path.join(directorDirectory, "velvet.sqlite"));
    const directorReader = createCampaignContextInspectionReadRepository(directorDb);
    const dispatches = directorDb.prepare(`SELECT planning.claim_id planning_id,narration.claim_id narration_id
      FROM dm_dispatches planning JOIN dm_narration_dispatches narration USING(run_id) WHERE planning.run_id=?`).get(run.runId) as { planning_id: string; narration_id: string };
    for (const identity of [
      { campaignId: director.campaign.id, sessionId: director.session.id, lane: "director-planning" as const, dispatchId: dispatches.planning_id },
      { campaignId: director.campaign.id, sessionId: director.session.id, lane: "director-narration" as const, dispatchId: dispatches.narration_id },
    ]) {
      const before = directorDb.pragma("data_version", { simple: true });
      const result = directorReader.inspectCampaignContext("local-owner", identity);
      if (mode === "revoked") expect(result).toMatchObject({ availability: "available", sections: [{ status: "withheld", reason: expectedReason }] });
      else expect(result).toMatchObject({ availability: "unavailable", reason: expectedReason });
      expect(directorDb.pragma("data_version", { simple: true })).toBe(before);
    }
    directorDb.close(); director.repo.close();
  });
});
