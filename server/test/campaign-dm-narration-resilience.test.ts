import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../src/provider/index.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { dmNarrationMessages, validDmScene } from "../src/agent/dmNarration.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

async function prepare() {
  const f = await dmFixture();
  f.graph();
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "auto" });
  const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "open" });
  return { ...f, run };
}

describe("campaign DM narration provider resilience", () => {
  it("dispatches the single narration tool with auto choice and reasoning disabled", async () => {
    const f = await prepare();
    const narrationInputs: ProviderCompletionInput[] = [];
    const complete = async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion === "campaign-dm-narration-v1") narrationInputs.push(structuredClone(input));
      return dmCompletion(input);
    };
    await orchestrateCampaignDmBeat(f.repo, "local-owner", f.run.runId, dmDependencies(complete));
    const result = f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, f.run.runId);
    expect(result.narration).not.toBe(result.receipts[0]!.summary);
    expect(narrationInputs).toHaveLength(1);
    const input = narrationInputs[0]!;
    // A thinking-mode upstream rejects a forced named tool choice; one advertised tool with `auto` is
    // accepted everywhere and the orchestrator still requires that exact single call.
    expect(input.toolChoice).toBe("auto");
    expect(input.tools).toHaveLength(1);
    expect(input.tools![0]!.name).toBe("submit_dm_scene");
    expect(input.bodyOverrides).toMatchObject({ reasoning_effort: "none" });
    const db = database();
    expect(db.prepare("SELECT source,outcome_code FROM dm_narration_dispatches").get()).toEqual({ source: "provider-assisted", outcome_code: "ok" });
    db.close(); f.repo.close();
  });

  it("retries exactly once on a pre-dispatch 400 and still seals provider-assisted prose", async () => {
    const f = await prepare();
    let narrationCalls = 0;
    const complete = async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion !== "campaign-dm-narration-v1") return dmCompletion(input);
      narrationCalls += 1;
      if (narrationCalls === 1) throw new ProviderHttpError(400, "Thinking mode does not support this tool_choice");
      return dmCompletion(input);
    };
    await orchestrateCampaignDmBeat(f.repo, "local-owner", f.run.runId, dmDependencies(complete));
    expect(narrationCalls).toBe(2);
    const db = database();
    expect(db.prepare("SELECT source,outcome_code FROM dm_narration_dispatches").get()).toEqual({ source: "provider-assisted", outcome_code: "ok" });
    db.close(); f.repo.close();
  });

  it("never retries an ambiguous 5xx and settles deterministic fallback", async () => {
    const f = await prepare();
    let narrationCalls = 0;
    const complete = async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion !== "campaign-dm-narration-v1") return dmCompletion(input);
      narrationCalls += 1;
      throw new ProviderHttpError(503, "upstream returned HTTP 503");
    };
    await orchestrateCampaignDmBeat(f.repo, "local-owner", f.run.runId, dmDependencies(complete));
    expect(narrationCalls).toBe(1);
    const db = database();
    expect(db.prepare("SELECT source FROM dm_narration_dispatches").get()).toEqual({ source: "deterministic-fallback" });
    db.close(); f.repo.close();
  });

  it("states the complete-scene word budget so the model cannot overflow the validator", () => {
    const system = dmNarrationMessages({ cast: [], players: [] }, "fallback")[0]!.content as string;
    expect(system).toContain("complete scene");
    expect(system).toContain("under 180 words");
    expect(system).toContain("atmosphere at most 110 words");
  });

  it("keeps an ambient door movement but still rejects an opening or closing state change", () => {
    const normal = { cast: [], players: [] };
    expect(validDmScene("The inn door swings in the draft. What do you do?", normal)).toBe(true);
    expect(validDmScene("The door swung open. What do you do?", normal)).toBe(false);
    expect(validDmScene("The gate opens. Do you approach?", normal)).toBe(false);
    expect(validDmScene("The chest is open. What do you do?", normal)).toBe(false);
  });
});
