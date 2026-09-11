import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { DM_WORLD_TIME_STEP_MINUTES } from "../src/repo/campaignDmRepo.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
const select = (candidate: { candidateId: string; digest: string }) => ({ candidateId: candidate.candidateId, digest: candidate.digest });

async function transitionFixture() {
  const f = await dmFixture();
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "auto" });
  return f;
}

describe("world time and ambient transition beats", () => {
  it("advertises only exact transition candidates and records a bounded server-fixed time advance", async () => {
    const f = await transitionFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "time" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    expect(work.candidates.map(({ action }) => action).sort()).toEqual(["advance-time", "ambient-beat"]);
    const advance = work.candidates.find(({ action }) => action === "advance-time")!;
    expect(advance.label).toContain(String(DM_WORLD_TIME_STEP_MINUTES));

    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, select(advance), null);
    f.repo.executeDmBeat("local-owner", run.runId);

    const db = database();
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?").get(f.campaign.id, f.session.id))
      .toEqual({ elapsed_minutes: DM_WORLD_TIME_STEP_MINUTES });
    expect(db.prepare("SELECT minutes,elapsed_before,elapsed_after FROM dm_world_time_receipts WHERE run_id=?").get(run.runId))
      .toEqual({ minutes: DM_WORLD_TIME_STEP_MINUTES, elapsed_before: 0, elapsed_after: DM_WORLD_TIME_STEP_MINUTES });
    db.close();

    const committed = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(committed.receipts).toEqual([expect.objectContaining({ action: "advance-time" })]);
    const narration = f.repo.getDmNarrationWork("local-owner", run.runId)!;
    expect(narration.context).toMatchObject({ transition: true });
    const claim = f.repo.claimDmNarration("local-owner", run.runId, "fake", "fake", { messages: [] }, 100, 100)!;
    f.repo.settleDmNarration("local-owner", run.runId, claim, "A quiet lull settles over the road.", "ok");
    f.repo.getDmNarrationWork("local-owner", run.runId);
    const done = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(done.state).toBe("completed");
    expect(done.narration).toContain("A quiet lull settles over the road.");
    f.repo.close();
  });

  it("presents an ambient beat without mutating world or domain state", async () => {
    const f = await transitionFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "ambient" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    const ambient = work.candidates.find(({ action }) => action === "ambient-beat")!;
    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, select(ambient), null);
    f.repo.executeDmBeat("local-owner", run.runId);

    const db = database();
    expect(db.prepare("SELECT count(*) n FROM world_expeditions_v60").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM dm_world_time_receipts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM story_commands_v34").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM combat_commands_v27").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT domain_receipt_json FROM dm_receipts WHERE run_id=?").get(run.runId))
      .toEqual({ domain_receipt_json: JSON.stringify({ kind: "ambient-presentation", stateChanged: false }) });
    db.close();
    expect(f.repo.getDmNarrationWork("local-owner", run.runId)!.context).toMatchObject({ transition: true });
    f.repo.close();
  });

  it("executes an ordered transition composition once in sequence", async () => {
    const f = await transitionFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "both" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    const ambient = work.candidates.find(({ action }) => action === "ambient-beat")!;
    const advance = work.candidates.find(({ action }) => action === "advance-time")!;
    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, [select(ambient), select(advance)], null);
    f.repo.executeDmBeat("local-owner", run.runId);

    const db = database();
    expect(db.prepare("SELECT ordinal,action FROM dm_composition_receipts WHERE run_id=? ORDER BY ordinal").all(run.runId))
      .toEqual([{ ordinal: 0, action: "ambient-beat" }, { ordinal: 1, action: "advance-time" }]);
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?").get(f.campaign.id, f.session.id))
      .toEqual({ elapsed_minutes: DM_WORLD_TIME_STEP_MINUTES });
    db.close();
    f.repo.close();
  });

  it("blocks a transition selection whose recorded time revision has gone stale", async () => {
    const f = await transitionFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "stale" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    const advance = work.candidates.find(({ action }) => action === "advance-time")!;
    const db = database();
    db.prepare("INSERT INTO world_expeditions_v60(campaign_id,session_id,elapsed_minutes,camp_location_id,camp_command_id) VALUES(?,?,?,NULL,NULL)")
      .run(f.campaign.id, f.session.id, 15);
    db.close();
    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, select(advance), null);
    const blocked = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(blocked.state).toBe("blocked");
    expect(blocked.blockers).toContain("proposal-stale-request-new-beat");
    f.repo.close();
  });

  it("keeps pacing available while a revealed scene waits on the table", async () => {
    const f = await transitionFixture();
    f.graph();
    const first = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "pace-open" });
    const firstWork = f.repo.claimDmPlanning("local-owner", first.runId, "fake", "fake")!;
    const reveal = firstWork.candidates.find(({ action }) => action === "reveal-node")!;
    f.repo.settleDmPlanning("local-owner", first.runId, firstWork.claimId, select(reveal), null);
    f.repo.executeDmBeat("local-owner", first.runId);
    const firstClaim = f.repo.claimDmNarration("local-owner", first.runId, "fake", "fake", { messages: [] }, 100, 100)!;
    f.repo.settleDmNarration("local-owner", first.runId, firstClaim, "The gate stands open. What do you do?", "ok");
    f.repo.getDmNarrationWork("local-owner", first.runId);

    const next = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "continue", expectedModeRevision: 1, idempotencyKey: "pace-continue" });
    const work = f.repo.claimDmPlanning("local-owner", next.runId, "fake", "fake")!;
    // The only blocker is table-wait, so the world may still pace rather than dead-lock.
    expect(f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, next.runId).blockers)
      .toContain("scene-resolution-requires-gm-binding-or-human-adjudication");
    expect(work.candidates.map(({ action }) => action)).toEqual(expect.arrayContaining(["advance-time", "ambient-beat"]));
    f.repo.close();
  });

  it("narrates a transition beat without a question through the orchestrator", async () => {
    const f = await transitionFixture();
    const complete = vi.fn(async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion === "campaign-dm-narration-v1") return {
        message: { role: "assistant", content: null, toolCalls: [{ id: "scene", name: "submit_dm_scene",
          arguments: JSON.stringify({ atmosphere: "A hush falls over the empty road.", dialogue: [] }) }] },
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }, model: { requestedModel: "fake-dm", responseModel: "fake-dm" },
      };
      const data = JSON.parse(input.messages[1]!.content as string) as { candidates: { candidateId: string; digest: string; action: string }[] };
      const chosen = data.candidates.find(({ action }) => action === "advance-time")!;
      return { message: { role: "assistant", content: null, toolCalls: [{ id: "choice", name: "select_dm_beat",
        arguments: JSON.stringify({ selection: { candidateId: chosen.candidateId, digest: chosen.digest } }) }] },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } };
    });
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "orchestrated" });
    await orchestrateCampaignDmBeat(f.repo, "local-owner", run.runId, dmDependencies(complete));
    const done = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(done.state).toBe("completed");
    expect(done.receipts[0]?.action).toBe("advance-time");
    expect(done.narration).toContain("A hush falls over the empty road.");
    expect(done.narration!.trim().endsWith("?")).toBe(false);
    f.repo.close();
  });
});
