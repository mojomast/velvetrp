import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderHttpError, ProviderTransportError } from "../src/provider/index.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { DM_PROVIDER_REJECTION_RETRY_BLOCKER, DM_PROVIDER_UNKNOWN_BLOCKER } from "../src/repo/campaignDmRepo.js";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
type Fixture = Awaited<ReturnType<typeof dmFixture>>;
const OWNER = "local-owner";
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

/** A deterministic unbilled rejection; every planning attempt is retried but cannot double-charge. */
const rejected = () => { throw new ProviderHttpError(400, "The `content[].thinking` in the thinking mode must be passed back to the API."); };

function aiFixture(): Promise<Fixture> {
  return dmFixture().then((f) => {
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "retry-ai" });
    return f;
  });
}

describe("campaign DM planning retry and reconcile", () => {
  it("retries a deterministic 4xx planning rejection a bounded number of times and settles a retriable blocked beat", async () => {
    const f = await aiFixture(); f.graph();
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "reject" });
    let calls = 0;
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies(async () => { calls += 1; return rejected(); }));
    // Every 400 is unbilled, so the bounded planning retry is safe; the fourth and final rejection settles the beat.
    expect(calls).toBe(4);
    const settled = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(settled.state).toBe("blocked");
    expect(settled.blockers).toContain(DM_PROVIDER_REJECTION_RETRY_BLOCKER);
    expect(settled.blockers).not.toContain(DM_PROVIDER_UNKNOWN_BLOCKER);
    // The rejected provider attempt stays durably reconcilable with its unbilled marker and original request.
    const db = database();
    expect(JSON.parse((db.prepare("SELECT response_json FROM dm_dispatches WHERE run_id=?").get(run.runId) as { response_json: string }).response_json))
      .toEqual({ failed: "unbilled-provider-rejection" });
    expect((db.prepare("SELECT count(*) n FROM dm_provider_requests WHERE run_id=?").get(run.runId) as { n: number }).n).toBe(1);
    db.close();
    // A failed beat is retryable: a fresh beat may be opened on the same room and can complete.
    const retry = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "reject-retry" });
    await orchestrateCampaignDmBeat(f.repo, OWNER, retry.runId, dmDependencies());
    expect(f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, retry.runId).state).toBe("completed");
    f.repo.close();
  });

  it("never retries an ambiguous 5xx and keeps the terminal unknown settlement", async () => {
    const f = await aiFixture(); f.graph();
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "server-error" });
    let calls = 0;
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies(async () => { calls += 1; throw new ProviderHttpError(503, "upstream returned HTTP 503"); }));
    expect(calls).toBe(1);
    const settled = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(settled.state).toBe("unknown");
    expect(settled.blockers).toContain(DM_PROVIDER_UNKNOWN_BLOCKER);
    f.repo.close();
  });

  it("treats a transport failure as retriable for dispatch but ambiguous for settlement", async () => {
    const f = await aiFixture(); f.graph();
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "transport" });
    let calls = 0;
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies(async () => { calls += 1; throw new ProviderTransportError("socket closed"); }));
    expect(calls).toBe(4);
    // A dropped connection may have billed a completion, so the run must not advertise a safe retry.
    const settled = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(settled.state).toBe("unknown");
    expect(settled.blockers).toContain(DM_PROVIDER_UNKNOWN_BLOCKER);
    f.repo.close();
  });

  it("settles a deterministic 4xx on a tool-result round as retriable without losing the grounded round", async () => {
    const f = await aiFixture(); f.graph();
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "grounded-reject" });
    const phases: string[] = [];
    const complete = async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      // Round 0 grounds through one read-only tool; the tool-result follow-up is rejected by a thinking upstream.
      if (input.messages.some((message) => message.role === "tool")) { phases.push("tool-result"); return rejected(); }
      phases.push("ground");
      return { message: { role: "assistant", content: null,
        toolCalls: [{ id: "ground-read", name: "read_public_world", arguments: "{}" }] },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } };
    };
    await orchestrateCampaignDmBeat(f.repo, OWNER, run.runId, dmDependencies(complete));
    expect(phases.filter((phase) => phase === "ground")).toHaveLength(1);
    expect(phases.filter((phase) => phase === "tool-result")).toHaveLength(4);
    const settled = f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId);
    expect(settled.state).toBe("blocked");
    expect(settled.blockers).toContain(DM_PROVIDER_REJECTION_RETRY_BLOCKER);
    const db = database();
    const round = db.prepare("SELECT status,response_json FROM dm_planning_rounds WHERE run_id=? AND round=1").get(run.runId) as
      { status: string; response_json: string };
    expect(round.status).toBe("unknown");
    expect(JSON.parse(round.response_json)).toEqual({ failed: "unbilled-provider-rejection" });
    db.close();
    f.repo.close();
  });
});

describe("campaign DM candidate breadth", () => {
  it("consumes an inherited declaration once so a later quiet beat does not re-offer it forever", async () => {
    const f = await dmFixture(true);
    seedHarbor(f);
    f.graph();
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "consume-ai" });
    heldTurn(f, "I walk to the glassblower's district.", "consume-turn");
    const first = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "consume-first" });
    // Drive the first beat to completion so the declaration is durably consumed by a committed run.
    await orchestrateCampaignDmBeat(f.repo, OWNER, first.runId, dmDependencies());
    expect(f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, first.runId).receipts.map(({ action }) => action)).toContain("materialize-location");
    const next = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "consume-second" });
    const work = f.repo.claimDmPlanning(OWNER, next.runId, "fake", "fake")!;
    expect((work.context as { declaration: unknown }).declaration).toBeNull();
    expect(work.candidates.some((candidate) => candidate.action.startsWith("materialize-"))).toBe(false);
    f.repo.close();
  });

  it("inherits the latest completed declaration for a continue beat so free-form materializations stay eligible", async () => {
    const f = await dmFixture(true);
    const harbor = seedHarbor(f);
    f.graph();
    f.repo.setDmControl(OWNER, f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "declared-ai" });
    heldTurn(f, "I walk to the glassblower's district.", "declared-turn");
    // No evidenceTurnId is supplied: the server inherits the recorded declaration of the latest turn.
    const run = f.repo.openDmBeat(OWNER, f.campaign.id, f.session.id, { intent: "continue", expectedModeRevision: 1, idempotencyKey: "declared-beat" });
    const work = f.repo.claimDmPlanning(OWNER, run.runId, "fake", "fake")!;
    const context = work.context as { evidence: unknown; declaration: { actorId: string; intent: string } | null };
    expect(context.evidence).toBeNull();
    expect(context.declaration).toMatchObject({ actorId: f.actorId, intent: "I walk to the glassblower's district." });
    const materialize = work.candidates.filter((candidate) => candidate.action === "materialize-location");
    expect(materialize).toHaveLength(1);
    expect(harbor).toBeTruthy();
    // A receipt-free declaration is never story evidence, and it must not add the evidence blocker.
    expect(f.repo.getDmRun(OWNER, f.campaign.id, f.session.id, run.runId).blockers).not.toContain("evidence-unavailable-or-already-used");
    f.repo.close();
  });
});

/** Seeds one generated public location ("harbor") and places the actor there, mirroring the freeform declaration test. */
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
    idempotencyKey: "breadth-seed",
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "breadth-seed-apply", selectedArtifactKeys: ["harbor"],
  });
  const db = database();
  const locationId = (db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
    WHERE campaign_id=? AND artifact_key='harbor'`).get(f.campaign.id) as { server_resource_id: string }).server_resource_id;
  db.close();
  f.repo.setActorLocation(OWNER, f.session.id, {
    type: "set_actor_location", campaignId: f.campaign.id, actorId: f.actorId, locationId,
    expectedRevision: 0, idempotencyKey: "breadth-place",
  });
  return locationId;
}

/** Settles an original turn's narration with zero receipts (a deterministic hold declaration). */
function heldTurn(f: Fixture, declaration: string, key: string): string {
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration,
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: key });
  const narrating = f.repo.updateAdventureTurnNarration(OWNER, { turnId: created.turnId, expectedTurnRevision: created.revision,
    expectedCampaignRevision: created.campaignRevision, idempotencyKey: `${key}:narrating`, narrationStatus: "in-progress" });
  f.repo.updateAdventureTurnNarration(OWNER, { turnId: created.turnId, expectedTurnRevision: narrating.revision,
    expectedCampaignRevision: created.campaignRevision, idempotencyKey: `${key}:completed`, narrationStatus: "completed",
    terminalState: "completed", fallbackNarration: "The scene holds. No movement or other campaign change is established." });
  return created.turnId;
}
