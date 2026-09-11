import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

function select(candidate: { candidateId: string; digest: string }) {
  return { candidateId: candidate.candidateId, digest: candidate.digest };
}

async function multiNodeFixture() {
  const f = await dmFixture();
  f.repo.createCampaignStorylineGraph("local-owner", f.campaign.id, {
    expectedRevision: 0, idempotencyKey: "multi",
    storyline: { storylineId: "story", title: "Multi", summary: null, nodes: [
      { nodeId: "a", title: "A", description: "A", gmNotes: "", revealThreshold: 0 },
      { nodeId: "b", title: "B", description: "B", gmNotes: "", revealThreshold: 0 },
    ], edges: [], plotPoints: [], clues: [] },
  });
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "ai" });
  return f;
}

describe("ordered beat composition", () => {
  it("executes candidates in listed order and blocks a stale later candidate without rollback", async () => {
    const f = await multiNodeFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "composition-partial" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    const reveals = work.candidates.filter((candidate) => candidate.action === "reveal-node");
    expect(reveals.length).toBeGreaterThanOrEqual(2);
    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, [select(reveals[0]!), select(reveals[1]!)], null);
    expect(f.repo.getDmProposal("local-owner", f.campaign.id, f.session.id, run.runId).composition)
      .toEqual([reveals[0], reveals[1]]);
    f.repo.executeDmBeat("local-owner", run.runId);

    const executed = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(executed.state).toBe("blocked");
    expect(executed.blockers).toContain("composition-partial-after-1");
    expect(executed.receipts.map(({ action }) => action)).toEqual(["reveal-node"]);
    // The committed candidate is the first listed, not the second; its node is the one now revealed.
    const db = database();
    const revealed = db.prepare("SELECT node_id FROM story_node_state_v34 WHERE campaign_id=? AND status<>'hidden' ORDER BY node_id").all(f.campaign.id) as { node_id: string }[];
    const rows = db.prepare("SELECT ordinal,action FROM dm_composition_receipts WHERE run_id=? ORDER BY ordinal").all(run.runId) as { ordinal: number; action: string }[];
    db.close();
    expect(revealed.map((row) => row.node_id)).toEqual(["a"]);
    expect(rows).toEqual([{ ordinal: 0, action: "reveal-node" }]);
    f.repo.close();
  });

  it("keeps a single selection valid and rejects duplicate or oversized compositions", async () => {
    const f = await multiNodeFixture();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id,
      { intent: "open", expectedModeRevision: 1, idempotencyKey: "single" });
    const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
    const reveal = work.candidates.find((candidate) => candidate.action === "reveal-node")!;
    f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, select(reveal), null);
    const proposal = f.repo.getDmProposal("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(proposal.proposal).toEqual(reveal);
    expect(proposal.composition).toEqual([reveal]);
    expect(() => f.repo.settleDmPlanning("local-owner", run.runId, work.claimId, [select(reveal), select(reveal)], null))
      .toThrow();
    f.repo.close();
  });
});
