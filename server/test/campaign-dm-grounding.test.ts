import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CAMPAIGN_RECALL_MAX_BYTES } from "../src/repo/campaign/campaignRecallReadRepo.js";
import { CampaignDmUnavailableError } from "../src/repo/campaignDmRepo.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { dmReadToolSchemas, parseDmReadCall } from "../src/agent/dmReadTools.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

function readResult(name: string, args: object, id: string): ProviderCompletionResult {
  return { message: { role: "assistant", content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } };
}

describe("dm read tool registry", () => {
  it("advertises exactly four closed tools with strict schemas", () => {
    const schemas = dmReadToolSchemas();
    expect(schemas.map(({ name }) => name)).toEqual(["read_campaign_recall", "read_quest_summary", "read_public_world", "read_present_npcs"]);
    const recall = schemas[0]!;
    const parameters = recall.parameters as { additionalProperties: boolean; required: string[]; properties: { topic: { enum: string[] } } };
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.required).toEqual(["topic"]);
    expect(parameters.properties.topic.enum).toEqual(["current-scene", "recent-outcomes", "public-locations", "present-cast"]);
    for (const tool of schemas.slice(1)) expect((tool.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("rejects unknown tools, extra fields, bad topics and free text", () => {
    expect(() => parseDmReadCall("read_secret", {})).toThrow();
    expect(() => parseDmReadCall("read_campaign_recall", { topic: "current-scene", query: "free text" })).toThrow();
    expect(() => parseDmReadCall("read_campaign_recall", { topic: "everything" })).toThrow();
    expect(() => parseDmReadCall("read_campaign_recall", "current-scene")).toThrow();
    expect(() => parseDmReadCall("read_campaign_recall", {})).toThrow();
    expect(() => parseDmReadCall("read_quest_summary", { query: "free text" })).toThrow();
    expect(() => parseDmReadCall("read_public_world", { topic: "current-scene" })).toThrow();
    expect(parseDmReadCall("read_campaign_recall", { topic: "present-cast" })).toEqual({ tool: "read_campaign_recall", topic: "present-cast" });
    expect(parseDmReadCall("read_present_npcs", {})).toEqual({ tool: "read_present_npcs" });
  });
});

describe("bounded planning grounding", () => {
  it("returns bounded read-only results for all four tools and rejects unauthorized callers", async () => {
    const f = await dmFixture(); f.graph();
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 0, idempotencyKey: "grounding" });
    const db = database();
    db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,?)")
      .run("loc-a", f.campaign.id, "Harbor", "A foggy harbor", "public", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,?)")
      .run("loc-b", f.campaign.id, "Market", "A busy market", "public", "2036-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,?)")
      .run("loc-secret", f.campaign.id, "SECRET_VAULT", "GM only", "gm", "2036-01-01T00:00:00.000Z");
    db.prepare(`INSERT INTO campaign_location_connections_v28(connection_id,campaign_id,from_location_id,to_location_id,visibility,route_state,requirement_kind,required_faction_id,minimum_reputation,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run("conn-a", f.campaign.id, "loc-a", "loc-b", "public", "open", "none", null, null, "2036-01-01T00:00:00.000Z");

    const before = {
      run: db.prepare("SELECT revision FROM dm_runs WHERE run_id=?").get(run.runId),
      rounds: db.prepare("SELECT count(*) n FROM dm_planning_rounds").get(),
      usage: db.prepare("SELECT count(*) n FROM dm_review_provider_usage").get(),
      dispatches: db.prepare("SELECT count(*) n FROM dm_dispatches").get(),
      requests: db.prepare("SELECT count(*) n FROM dm_provider_requests").get(),
      locations: db.prepare("SELECT count(*) n FROM campaign_locations_v28").get(),
    };

    const recall = f.repo.readDmPlanningGrounding("local-owner", run.runId, { tool: "read_campaign_recall", topic: "current-scene" });
    expect(recall).toMatchObject({ tool: "read_campaign_recall" });
    expect(Buffer.byteLength(JSON.stringify(recall.data), "utf8")).toBeLessThanOrEqual(CAMPAIGN_RECALL_MAX_BYTES);
    expect(Buffer.byteLength(recall.summary, "utf8")).toBeLessThanOrEqual(6000);
    const quests = f.repo.readDmPlanningGrounding("local-owner", run.runId, { tool: "read_quest_summary" });
    expect(Array.isArray(quests.data)).toBe(true);
    const world = f.repo.readDmPlanningGrounding("local-owner", run.runId, { tool: "read_public_world" });
    const worldData = world.data as { locations: { name: string }[]; connections: unknown[] };
    expect(worldData.locations.map(({ name }) => name)).toEqual(["Harbor", "Market"]);
    expect(worldData.locations.some(({ name }) => name.includes("SECRET"))).toBe(false);
    expect(worldData.connections).toHaveLength(1);
    const npcs = f.repo.readDmPlanningGrounding("local-owner", run.runId, { tool: "read_present_npcs" });
    expect(Array.isArray(npcs.data)).toBe(true);

    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('stranger','Stranger',0)").run();
    expect(() => f.repo.readDmPlanningGrounding("stranger", run.runId, { tool: "read_public_world" })).toThrow(CampaignDmUnavailableError);

    expect({
      run: db.prepare("SELECT revision FROM dm_runs WHERE run_id=?").get(run.runId),
      rounds: db.prepare("SELECT count(*) n FROM dm_planning_rounds").get(),
      usage: db.prepare("SELECT count(*) n FROM dm_review_provider_usage").get(),
      dispatches: db.prepare("SELECT count(*) n FROM dm_dispatches").get(),
      requests: db.prepare("SELECT count(*) n FROM dm_provider_requests").get(),
      locations: db.prepare("SELECT count(*) n FROM campaign_locations_v28").get(),
    }).toEqual(before);
    db.close(); f.repo.close();
  });
});

describe("grounded director planning loop", () => {
  it("executes a read round in parallel, settles the beat on the next round and records the round", async () => {
    const f = await dmFixture(); f.graph();
    f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "ai" });
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "grounded" });
    const planning: ProviderCompletionInput[] = [];
    const complete = vi.fn(async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion === "campaign-dm-narration-v1") return dmCompletion(input);
      planning.push(input);
      if (planning.length === 1) {
        expect(input.tools?.some(({ name }) => name === "read_campaign_recall")).toBe(true);
        expect(input.toolChoice).toBe("auto");
        return readResult("read_campaign_recall", { topic: "current-scene" }, "read-1");
      }
      expect(JSON.stringify(input.messages)).toContain("read_campaign_recall");
      expect(JSON.stringify(input.messages)).toContain("current-scene");
      return dmCompletion(input, "reveal-node");
    });
    await orchestrateCampaignDmBeat(f.repo, "local-owner", run.runId, dmDependencies(complete));
    expect(planning).toHaveLength(2);
    expect(complete.mock.calls.filter(([input]) => input.promptVersion === "campaign-dm-narration-v1")).toHaveLength(1);
    expect(f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId).state).toBe("completed");
    const db = database();
    const rounds = db.prepare("SELECT round,status,response_json FROM dm_planning_rounds WHERE run_id=? ORDER BY round").all(run.runId) as { round: number; status: string; response_json: string }[];
    expect(rounds.map(({ round }) => round)).toEqual([1]);
    expect(rounds[0]!.status).toBe("settled");
    expect(rounds[0]!.response_json).toContain("selection");
    db.close(); f.repo.close();
  });

  it("forces select_dm_beat on the third planning call and never makes a fourth", async () => {
    const f = await dmFixture(); f.graph();
    f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "ai" });
    const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: "forced" });
    const planning: ProviderCompletionInput[] = [];
    const complete = vi.fn(async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
      if (input.promptVersion === "campaign-dm-narration-v1") return dmCompletion(input);
      planning.push(input);
      if (planning.length === 1) return readResult("read_public_world", {}, "read-1");
      if (planning.length === 2) return readResult("read_present_npcs", {}, "read-2");
      expect(input.toolChoice).toEqual({ name: "select_dm_beat" });
      return dmCompletion(input, "reveal-node");
    });
    await orchestrateCampaignDmBeat(f.repo, "local-owner", run.runId, dmDependencies(complete));
    expect(planning).toHaveLength(3);
    expect(complete.mock.calls.filter(([input]) => input.promptVersion === "campaign-dm-v1")).toHaveLength(3);
    expect(complete.mock.calls.filter(([input]) => input.promptVersion === "campaign-dm-narration-v1")).toHaveLength(1);
    expect(f.repo.getDmRun("local-owner", f.campaign.id, f.session.id, run.runId).state).toBe("completed");
    const db = database();
    const rounds = db.prepare("SELECT round,status FROM dm_planning_rounds WHERE run_id=? ORDER BY round").all(run.runId) as { round: number; status: string }[];
    expect(rounds).toEqual([{ round: 1, status: "settled" }, { round: 2, status: "settled" }]);
    db.close(); f.repo.close();
  });
});
