import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { enableHumanPlayerTravel, seedLivingWorld } from "./fixtures/livingWorld.js";
import { HUMAN_LEAK_MARKERS, HUMAN_PLAYER_DECLARATIONS, gradePlayerTurn } from "./fixtures/humanPlayer.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT; });

const headers = { "content-type": "application/json" };
const narration = (): ProviderCompletionResult => ({ message: { role: "assistant", content: null, toolCalls: [{ id: "narrate",
  name: "submit_adventure_narration", arguments: JSON.stringify({ narration: "The market waits, indifferent to the request." }) }] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "human-fake", responseModel: "human-fake" } });
const noTool = (): ProviderCompletionResult => ({ message: { role: "assistant", content: "No action is warranted.", toolCalls: [] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "human-fake", responseModel: "human-fake" } });

function candidateOptions(input: ProviderCompletionInput): Array<{ toolName: string; arguments: unknown; label: { target: string | null } }> {
  const message = input.messages.find((entry) => typeof entry.content === "string" && entry.content.startsWith("UNTRUSTED CURRENT EXACT CANDIDATE TABLE"));
  if (!message || typeof message.content !== "string") throw new Error("candidate table is unavailable");
  return JSON.parse(message.content.slice(message.content.indexOf("{"))).candidateOptions;
}

function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE frame has no data");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}

async function harness() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
  const f = await dmFixture();
  const counter = { calls: 0 };
  const inputs: ProviderCompletionInput[] = [];
  // The adventure deadline is computed against the fixture clock; the default real-time clock overflows AbortSignal.timeout.
  const dependencies = { ...dmDependencies(async (input: ProviderCompletionInput) => { counter.calls += 1; inputs.push(input);
    return input.promptVersion === "adventure-narration-v1" ? narration() : noTool(); }), now: () => f.options.clock.now() };
  const app = buildApp({ campaignRepositoryFactory: () => f.repo, adventureAgentDependencies: dependencies });
  const revision = async () => (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${f.campaign.id}/administration` })).json().campaign.revision as number;
  return { f, app, counter, inputs, revision };
}

describe("simulated human player input through the real adventure-turn route", () => {
  it("accepts every messy declaration, echoes it exactly, and never leaks, crashes, or invents mechanics", async () => {
    const { f, app, counter, inputs, revision } = await harness();
    try {
      for (const [index, entry] of HUMAN_PLAYER_DECLARATIONS.entries()) {
        const before = counter.calls;
        const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: f.campaign.id, sessionId: f.session.id, actorId: f.actorId, declaration: entry.declaration,
          expectedRevision: await revision(), idempotencyKey: `human-${entry.id}-${index}` } });
        expect(response.statusCode, `${entry.id} status: ${response.body.slice(0, 200)}`).toBe(200);
        const events = streamEvents(response.body);
        const terminal = events.at(-1);
        if (!terminal || terminal.type !== "terminal") throw new Error(`${entry.id} did not terminate`);
        expect(terminal.payload.turn.declaration, `${entry.id} declaration`).toBe(entry.declaration.trim());
        // Leakage is about produced narration/receipts, never the player's own echoed declaration.
        const produced = `${terminal.payload.narrationStatus?.text ?? ""} ${JSON.stringify(terminal.payload.receipts)}`;
        const leaked = HUMAN_LEAK_MARKERS.find((marker) => produced.toLowerCase().includes(marker.toLowerCase())) ?? null;
        const failures = gradePlayerTurn({ declaration: terminal.payload.turn.declaration, state: terminal.payload.turn.state,
          leaked, calls: counter.calls - before, committed: terminal.payload.receipts.length > 0, expectedNoMechanics: true });
        expect(failures, `${entry.id}: ${entry.declaration}`).toEqual([]);
      }
      // Every declaration must reach the planner (a clock/deadline bug once skipped it silently).
      expect(inputs.filter((input) => input.promptVersion === "adventure-planning-v1").length).toBeGreaterThan(0);
      // A forced narration tool_choice must disable reasoning or a reasoning model rejects the call.
      const narrationInputs = inputs.filter((input) => input.promptVersion === "adventure-narration-v1");
      expect(narrationInputs.length).toBeGreaterThan(0);
      for (const input of narrationInputs) expect(input.bodyOverrides).toMatchObject({ reasoning_effort: "none" });
    } finally { await app.close(); f.repo.close(); }
  });

  it("rejects empty, whitespace, and oversize declarations before dispatch", async () => {
    const { f, app, counter, revision } = await harness();
    try {
      for (const declaration of ["", "   ", "\n\t ", "x".repeat(8_001)]) {
        const before = counter.calls;
        const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
          campaignId: f.campaign.id, sessionId: f.session.id, actorId: f.actorId, declaration,
          expectedRevision: await revision(), idempotencyKey: "human-reject" } });
        expect(response.statusCode, JSON.stringify(declaration.slice(0, 20))).toBe(400);
        expect(counter.calls).toBe(before);
      }
    } finally { await app.close(); f.repo.close(); }
  });

  it("replays the same human declaration idempotently without a second provider call", async () => {
    const { f, app, counter, revision } = await harness();
    try {
      const payload = { campaignId: f.campaign.id, sessionId: f.session.id, actorId: f.actorId,
        declaration: "i lok aroudn teh markt", expectedRevision: await revision(), idempotencyKey: "human-idem" };
      const first = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload });
      expect(first.statusCode, first.body).toBe(200);
      const before = counter.calls;
      const replay = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.headers["x-adventure-turn-id"]).toBe(first.headers["x-adventure-turn-id"]);
      expect(counter.calls).toBe(before);
    } finally { await app.close(); f.repo.close(); }
  });

  it("selects the exact travel candidate a sloppy human request names", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    const f = await dmFixture();
    seedLivingWorld(f, 800);
    enableHumanPlayerTravel(f, 800);
    const dependencies: AdventureAgentDependencies = { ...dmDependencies(async (input: ProviderCompletionInput) => {
      if (input.promptVersion === "adventure-narration-v1") return narration();
      const selected = candidateOptions(input).find((candidate) => candidate.toolName === "exact_actor_travel.select" && candidate.label.target === "s800 Docks");
      if (!selected) return noTool();
      return { message: { role: "assistant", content: null, toolCalls: [{ id: "travel", name: selected.toolName, arguments: JSON.stringify(selected.arguments) }] },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "human-fake", responseModel: "human-fake" } };
    }), now: () => f.options.clock.now() };
    const app = buildApp({ campaignRepositoryFactory: () => f.repo, adventureAgentDependencies: dependencies });
    try {
      const revision = (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${f.campaign.id}/administration` })).json().campaign.revision as number;
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId: f.campaign.id, sessionId: f.session.id, actorId: f.actorId, declaration: "i wanna go to teh docks",
        expectedRevision: revision, idempotencyKey: "human-travel" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(streamEvents(response.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done" } });
      const world = f.repo.getCampaignWorld("local-owner", f.campaign.id)!;
      expect(world.currentLocations.find((location) => location.actorId === f.actorId)?.locationId).toBe("s800-docks");
    } finally { await app.close(); f.repo.close(); }
  });
});
