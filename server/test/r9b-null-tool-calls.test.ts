// Approved tests for round 9b: the live OpenCode Go upstream now answers a deliberate no-tool-call
// hold with `"tool_calls": null` (plus `name` and `reasoning_content` keys). The adapter must treat a
// null tool_calls exactly like an absent one, so planner holds stop failing as ProviderProtocolError
// (103 of 194 round-9 turns lost their planner this way, mostly on 20k+ token prompts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { completeWithProvider, ProviderProtocolError } from "../src/provider/openAiCompatibleCompletion.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { getPromptPreset } from "../src/presets.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  vi.unstubAllGlobals();
  clearR8Flags();
  closeRepo();
});

const LOOPBACK = "http://127.0.0.1:8799/v1";
const TOOL = { name: "exact_srd_check.select", parameters: { type: "object", additionalProperties: false } };

function liveShape(message: Record<string, unknown>, finish = "stop") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-r9b",
      model: "deepseek-v4.1-flash",
      choices: [{ index: 0, finish_reason: finish, message }],
      usage: { prompt_tokens: 23144, completion_tokens: 188, total_tokens: 23332 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function request(overrides: Partial<ProviderCompletionInput> = {}): ProviderCompletionInput {
  return {
    provider: {
      ...defaultProviderSettings(),
      baseUrl: LOOPBACK,
      model: "deepseek-v4.1-flash",
      apiKey: "test-key",
      requestTimeoutSeconds: 5,
    },
    harness: defaultHarnessSettings(),
    preset: getPromptPreset("default"),
    messages: [{ role: "user", content: "I ask Hen who keeps the gauges." }],
    tools: [TOOL],
    toolChoice: "auto",
    parallelToolCalls: false,
    bodyOverrides: { reasoning_effort: "none" },
    ...overrides,
  } as ProviderCompletionInput;
}

const HOLD = {
  role: "assistant",
  content: "No tool call — a plain question to a present NPC is conversation, not a check.",
  name: "",
  reasoning_content: "",
  tool_calls: null,
};

describe("round 9b: null tool_calls is a no-tool-call hold", () => {
  it("accepts the live hold shape (tool_calls: null) as content with no tool calls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape(HOLD)));
    const result = await completeWithProvider(request());
    expect(result.message.content).toBe(HOLD.content);
    expect(result.message.toolCalls ?? []).toEqual([]);
  });

  it("accepts a null tool_calls hold on a 23k+ token prompt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape(HOLD)));
    const big = "Cast: Hen, keeper of the gauge-rod. ".repeat(2_600); // ~94 KB, well over 23k tokens
    expect(big.length).toBeGreaterThan(92_000);
    const result = await completeWithProvider(
      request({
        messages: [
          { role: "system", content: big },
          { role: "user", content: "I ask Hen who keeps the gauges." },
        ],
      }),
    );
    expect(result.message.content).toBe(HOLD.content);
    expect(result.message.toolCalls ?? []).toEqual([]);
  });

  it("still accepts an empty tool_calls array with content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape({ ...HOLD, tool_calls: [] })));
    const result = await completeWithProvider(request());
    expect(result.message.content).toBe(HOLD.content);
    expect(result.message.toolCalls ?? []).toEqual([]);
  });

  it("still parses real tool calls in the live shape", async () => {
    const call = {
      id: "call-1",
      type: "function",
      function: { name: "exact_srd_check_select", arguments: '{"candidateId":"c","digest":"d"}' },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(liveShape({ ...HOLD, content: "", tool_calls: [call] }, "tool_calls")),
    );
    const result = await completeWithProvider(request());
    expect(result.message.toolCalls?.map((entry) => entry.name)).toEqual(["exact_srd_check.select"]);
  });

  it("keeps rejecting a null tool_calls with no content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape({ ...HOLD, content: null })));
    await expect(completeWithProvider(request())).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("keeps rejecting a null tool_calls when a tool call is required", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape(HOLD)));
    await expect(completeWithProvider(request({ toolChoice: "required" }))).rejects.toThrow(/required tool call/);
  });

  it("keeps rejecting a non-array, non-null tool_calls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape({ ...HOLD, tool_calls: "exact_srd_check_select" })));
    await expect(completeWithProvider(request())).rejects.toThrow(/tool_calls must be an array/);
  });

  it("keeps rejecting an undeclared tool name", async () => {
    const call = { id: "call-2", type: "function", function: { name: "campaign_context_read", arguments: "{}" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape({ ...HOLD, tool_calls: [call] }, "tool_calls")));
    await expect(completeWithProvider(request())).rejects.toThrow(/undeclared tool/);
  });
});

describe("round 9b: planner holds over HTTP with the live response shape", () => {
  function liveProvider() {
    const outcomes: string[] = [];
    const dependencies: AdventureAgentDependencies = {
      complete: async (input: ProviderCompletionInput): Promise<ProviderCompletionResult> => {
        const names = (input.tools ?? []).map((tool) => tool.name);
        if (names.includes("submit_adventure_narration")) {
          return {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: "r9b-narration",
                  name: "submit_adventure_narration",
                  arguments: JSON.stringify({ narration: "Hen turns the gauge-rod over and answers." }),
                },
              ],
            },
            usage: null,
            model: { requestedModel: "test", responseModel: "test" },
          } as ProviderCompletionResult;
        }
        const padding = {
          role: "system" as const,
          content: "Recall: the bells, the gauges, the Register. ".repeat(2_200),
        };
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(liveShape(HOLD)));
        try {
          const result = await completeWithProvider({
            ...input,
            messages: [padding, ...input.messages],
            provider: { ...input.provider, baseUrl: LOOPBACK, apiKey: "test-key", requestTimeoutSeconds: 5 },
          });
          outcomes.push("ok");
          return result;
        } catch (error) {
          outcomes.push((error as Error).name);
          throw error;
        } finally {
          vi.unstubAllGlobals();
        }
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "deepseek-v4.1-flash" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date(),
    };
    return { dependencies, outcomes };
  }

  it("a non-mechanical declaration narrates from the planner hold instead of a protocol failure", async () => {
    enableR8Flags();
    const live = liveProvider();
    const app = buildApp({ adventureAgentDependencies: live.dependencies });
    const ids = await startQuickAdventure(app);
    const turn = await playR8Turn(app, ids, "I look around the square.");
    expect(live.outcomes.length).toBeGreaterThan(0);
    expect(live.outcomes).toEqual(live.outcomes.map(() => "ok"));
    expect(turn.turn.state).toBe("completed");
  });

  it("the conditional potion still proposes the consume when the planner holds with tool_calls: null", async () => {
    enableR8Flags();
    const live = liveProvider();
    const app = buildApp({ adventureAgentDependencies: live.dependencies });
    const ids = await startQuickAdventure(app);
    const boot = await app.inject({
      method: "GET",
      url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
    });
    const streamed = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      payload: {
        campaignId: ids.campaignId,
        sessionId: ids.sessionId,
        actorId: ids.actorId,
        declaration: "I drink a healing potion if I have one.",
        expectedRevision: boot.json().expectedRevision,
        idempotencyKey: `r9b-potion-${Math.random()}`,
      },
    });
    expect(streamed.statusCode, streamed.body.slice(0, 800)).toBe(200);
    expect(live.outcomes).toEqual(live.outcomes.map(() => "ok"));
    expect(streamed.body).toContain("confirmation_required");
    expect(streamed.body).toContain("inventory_item_consume");
  });
});
