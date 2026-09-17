import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { DM_SCENE_DESCRIPTION_PREFIX } from "../src/agent/dmNarration.js";
import { defaultSystemOneSettings } from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import { narrationReflectionKey } from "../src/agent/systemOneNarration.js";
import type { SystemOneDirectorDependency } from "../src/agent/systemOneDirector.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

const director = (caller: SystemOneDirectorDependency["caller"]): SystemOneDirectorDependency => ({
  settings: { ...defaultSystemOneSettings(), enabled: true, shadow: true, apiKey: "test-key" },
  caller,
});

async function openForShadow() {
  const fixture = await dmFixture();
  fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "narration-shadow-ai" });
  const run = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id,
    { intent: "open", expectedModeRevision: 1, idempotencyKey: "narration-shadow-open" });
  return { fixture, run };
}

async function runBeat(getSystemOneDirector?: AdventureAgentDependencies["getSystemOneDirector"]) {
  const { fixture, run } = await openForShadow();
  await orchestrateCampaignDmBeat(fixture.repo, "local-owner", run.runId, {
    ...dmDependencies(), ...(getSystemOneDirector ? { getSystemOneDirector } : {}),
  });
  const result = fixture.repo.getDmRun("local-owner", fixture.campaign.id, fixture.session.id, run.runId);
  return { fixture, run, result };
}

function narrationVerificationRows() {
  const db = database();
  const rows = db.prepare("SELECT lane,shadow,fallback_used,provider,confidence_band,turn_id,state_json,questions_json,selection_json FROM system_one_decisions_v1 WHERE lane='narration-verification'").all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

describe("System One narration verification shadow lane", () => {
  it("records exactly one narration-verification decision for the produced narration", async () => {
    const caller = createFakeSystemOneCaller();
    const { fixture, run, result } = await runBeat(async () => director(caller));
    fixture.repo.close();

    expect(result.narration).toBeTruthy();
    // One planning Director shadow plus one narration verification call.
    expect(caller.calls).toHaveLength(2);
    const narrationCall = caller.calls.find((call) => narrationReflectionKey(0) in call.questions)!;
    expect(narrationCall).toBeDefined();

    const rows = narrationVerificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: "narration-verification", shadow: 1, fallback_used: 1, provider: "typesafe", turn_id: run.runId });
    expect(rows[0]!.confidence_band).toBeTruthy();

    const state = JSON.parse(rows[0]!.state_json as string) as { narration: string; committed_facts: string[]; declared_boundaries: string[] };
    // The recorded candidate is the produced scene, verbatim, and committed receipts are embedded as facts.
    expect(result.narration).toContain(state.narration.trim());
    expect(state.declared_boundaries).toEqual([]);
    expect(state.committed_facts.length).toBeGreaterThan(0);
    expect(rows[0]!.questions_json).toContain(state.committed_facts[0]);
    // The state the caller reasoned over is exactly the persisted projection.
    expect(narrationCall.state).toEqual(state);
    expect(rows[0]!.selection_json).toBeTruthy();
  });

  it("leaves the produced narration byte-identical to a run without the hook", async () => {
    const baseline = await runBeat();
    const baselineNarration = baseline.result.narration;
    baseline.fixture.repo.close();
    expect(baselineNarration).toBeTruthy();

    makeTmpDataDir();
    const { fixture, run, result } = await runBeat(async () => director(createFakeSystemOneCaller()));
    fixture.repo.close();

    expect(result.narration).toBe(baselineNarration);
    expect(result.narration).toContain(DM_SCENE_DESCRIPTION_PREFIX);
    expect(narrationVerificationRows()).toHaveLength(1);
    expect(run.runId).toBeTruthy();
  });

  it("swallows a throwing caller and still produces the same narration", async () => {
    const baseline = await runBeat();
    const baselineNarration = baseline.result.narration;
    baseline.fixture.repo.close();

    makeTmpDataDir();
    const { fixture, result } = await runBeat(async () => director(createFakeSystemOneCaller({ failWith: new Error("narration shadow endpoint down") })));
    fixture.repo.close();

    expect(result.narration).toBe(baselineNarration);
    expect(narrationVerificationRows()).toHaveLength(0);
  });

  it("stays inert when no shadow hook is injected", async () => {
    const { fixture } = await runBeat();
    fixture.repo.close();
    expect(narrationVerificationRows()).toHaveLength(0);
  });
});
