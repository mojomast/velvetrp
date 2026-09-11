import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema, type CampaignDmCandidate } from "@velvet/contracts";
import { validDmScene } from "../../src/agent/dmNarration.js";
import { DM_WORLD_TIME_STEP_MINUTES } from "../../src/repo/campaignDmRepo.js";
import { dmFixture } from "../fixtures/dmCampaign.js";
import { useTmpDataDir } from "../helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
/** Byte-identical authority string reused across leakage and injection cases. */
const DIRECTOR_SECRET = "SECRET_GM_ONLY:the-mayor-is-the-traitor";
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
const rubric = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/dm-evals/director-rubric.v1.json", import.meta.url)), "utf8")) as {
  version: string; dimensions: Array<{ id: string; description: string; anchors: { pass: string; fail: string } }>;
};

type Fixture = Awaited<ReturnType<typeof dmFixture>>;
const select = (candidate: { candidateId: string; digest: string }) => ({ candidateId: candidate.candidateId, digest: candidate.digest });

/** Deterministic candidate-choice oracle: build a state, then read the exact advertised action set. */
function plan(f: Fixture, key: string) {
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: `${key}-ai` });
  const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: key });
  const work = f.repo.claimDmPlanning("local-owner", run.runId, "eval", "eval");
  const candidates = work?.candidates ?? [];
  return { run, work, candidates, actions: [...new Set(candidates.map((candidate) => candidate.action as CampaignDmCandidate["action"]))].sort() };
}

async function gmOnlyFixture(key: string) {
  const f = await dmFixture();
  const content = generatedCampaignContentProviderSchema.parse({
    storyNodes: [{ key: "secret", title: "SECRET_TITLE", description: DIRECTOR_SECRET, visibility: "gm" }],
  });
  const context = f.repo.getCampaignGenerationContext("local-owner", f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft("local-owner", {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: `${key}-draft`,
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically("local-owner", {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: `${key}-accept`, selectedArtifactKeys: ["secret"],
  });
  return f;
}

describe("deterministic director candidate-choice oracle", () => {
  it("advertises only the legal exact action set for each state", async () => {
    const empty = await dmFixture();
    expect(plan(empty, "oracle-empty").actions).toEqual(["advance-time", "ambient-beat"]);
    empty.repo.close();

    const graph = await dmFixture();
    graph.graph();
    expect(plan(graph, "oracle-graph").actions).toEqual(["advance-time", "ambient-beat", "reveal-node"]);
    graph.repo.close();

    const prepared = await dmFixture();
    prepared.prepare();
    // An open encounter suppresses pacing transitions; only the exact encounter action is offered.
    expect(plan(prepared, "oracle-prepared").actions).toEqual(["encounter-start"]);
    prepared.repo.close();

    const hidden = await gmOnlyFixture("oracle-hidden");
    const hiddenPlan = plan(hidden, "oracle-hidden-plan");
    expect(hiddenPlan.actions).toEqual([]);
    expect(hidden.repo.getDmRun("local-owner", hidden.campaign.id, hidden.session.id, hiddenPlan.run.runId).blockers)
      .toContain("story-public-rendering-required");
    hidden.repo.close();
  });

  it("commits an ordered transition composition with exact receipt fidelity", async () => {
    const f = await dmFixture();
    const { run, work, candidates } = plan(f, "receipt-fidelity");
    const ambient = candidates.find((candidate) => candidate.action === "ambient-beat")!;
    const advance = candidates.find((candidate) => candidate.action === "advance-time")!;
    f.repo.settleDmPlanning("local-owner", run.runId, work!.claimId, [select(ambient), select(advance)], null);
    f.repo.executeDmBeat("local-owner", run.runId);

    const committed = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId);
    expect(committed.receipts.map(({ action }) => action)).toEqual(["ambient-beat", "advance-time"]);
    const db = database();
    expect(db.prepare("SELECT action FROM dm_composition_receipts WHERE run_id=? ORDER BY ordinal").all(run.runId))
      .toEqual([{ action: "ambient-beat" }, { action: "advance-time" }]);
    expect(db.prepare("SELECT count(*) n FROM dm_world_time_receipts WHERE run_id=?").get(run.runId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?").get(f.campaign.id, f.session.id))
      .toEqual({ elapsed_minutes: DM_WORLD_TIME_STEP_MINUTES });
    db.close();
    expect(f.repo.getDmNarrationWork("local-owner", run.runId)!.context).toMatchObject({ transition: true });
    f.repo.close();
  });

  it("keeps GM-only story text out of every public surface and authority string byte-identical", async () => {
    const f = await gmOnlyFixture("leakage");
    const { run, candidates } = plan(f, "leakage-plan");
    expect(candidates).toEqual([]);
    const publicRun = JSON.stringify(f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId));
    const history = JSON.stringify(f.repo.getDmHistory("local-owner", f.campaign.id, f.session.id));
    expect(publicRun).not.toContain("SECRET_");
    expect(history).not.toContain("SECRET_");
    expect(publicRun).not.toContain(DIRECTOR_SECRET);
    f.repo.close();
  });
});

describe("director rubric fixtures and predeclared rates", () => {
  it("freezes the rubric corpus digest and the authority string", () => {
    expect(rubric.version).toBe("v1");
    expect(createHash("sha256").update(canonical(rubric)).digest("hex"))
      .toBe("7044aeb5e6fd11a0010f97a4bc1ad77fc32653f7407559b15c894a8b8af2c274");
    expect(DIRECTOR_SECRET).toBe("SECRET_GM_ONLY:the-mayor-is-the-traitor");
  });

  it("declares every rubric dimension passing at baseline with a discriminating fail anchor", () => {
    const rates: Record<string, number> = {};
    for (const dimension of rubric.dimensions) {
      // The pass anchor must survive the real narration heuristic; the fail anchor must be rejected.
      const pass = validDmScene(`${dimension.anchors.pass} What do you do?`);
      const fail = validDmScene(`${dimension.anchors.fail} What do you do?`);
      rates[dimension.id] = pass && !fail ? 1 : 0;
      expect(pass, `${dimension.id} pass anchor`).toBe(true);
      expect(fail, `${dimension.id} fail anchor`).toBe(false);
    }
    expect(rates).toEqual({ "receipt-fidelity": 1, attribution: 1, "no-coercion": 1, leakage: 1, pacing: 1 });
  });
});
