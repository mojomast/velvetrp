import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptCompletionBodyForKnownEndpoint, completeWithProvider } from "../src/provider/openAiCompatibleCompletion.js";
import { isAuthorizedHttpProviderBaseUrl } from "../src/provider/providerTransport.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { getPromptPreset } from "../src/presets.js";
import type { ProviderSettings } from "../src/types.js";

const ROUTER = "http://100.72.41.9:8787/v1";
const LOOPBACK = "http://127.0.0.1:8799/v1";

function settings(baseUrl: string, model = "deepseek-v4-flash"): ProviderSettings {
  return { ...defaultProviderSettings(), baseUrl, model, apiKey: "test-key", requestTimeoutSeconds: 5 };
}

function forcedRequest(baseUrl: string, model?: string) {
  return {
    provider: settings(baseUrl, model),
    harness: defaultHarnessSettings(),
    preset: getPromptPreset("default"),
    messages: [{ role: "user" as const, content: "Pick a beat." }],
    tools: [{ name: "select_dm_beat", parameters: { type: "object", additionalProperties: false } }],
    toolChoice: { name: "select_dm_beat" } as const,
    bodyOverrides: { reasoning_effort: "none" as const },
  };
}

function stubFetch(content = "Held for a player choice.") {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "deepseek-v4-flash", tool_choice: { type: "function", function: { name: "select_dm_beat" } },
    reasoning_effort: "none", ...overrides };
}

describe("authorized live-validation endpoint detection", () => {
  it("matches the exact router URL and rejects everything else", () => {
    expect(isAuthorizedHttpProviderBaseUrl(ROUTER)).toBe(true);
    expect(isAuthorizedHttpProviderBaseUrl(`${ROUTER}/`)).toBe(true);
    expect(isAuthorizedHttpProviderBaseUrl("http://100.72.41.9:8787/v2")).toBe(false);
    expect(isAuthorizedHttpProviderBaseUrl("https://100.72.41.9:8787/v1")).toBe(false);
    expect(isAuthorizedHttpProviderBaseUrl(LOOPBACK)).toBe(false);
    expect(isAuthorizedHttpProviderBaseUrl("not-a-url")).toBe(false);
  });
});

describe("known thinking-endpoint tool_choice adaptation", () => {
  it("downgrades a forced named choice to auto when reasoning is off", () => {
    const request = body();
    expect(adaptCompletionBodyForKnownEndpoint(request, ROUTER)).toBe("auto");
    expect(request.tool_choice).toBe("auto");
    // The caller's reasoning-off signal is preserved on the wire.
    expect(request.reasoning_effort).toBe("none");
  });

  it("downgrades required to auto when reasoning is off", () => {
    const request = body({ tool_choice: "required" });
    expect(adaptCompletionBodyForKnownEndpoint(request, ROUTER)).toBe("auto");
    expect(request.tool_choice).toBe("auto");
  });

  it("leaves auto and none untouched", () => {
    const auto = body({ tool_choice: "auto" });
    expect(adaptCompletionBodyForKnownEndpoint(auto, ROUTER)).toBeUndefined();
    expect(auto.tool_choice).toBe("auto");
    const none = body({ tool_choice: "none" });
    expect(adaptCompletionBodyForKnownEndpoint(none, ROUTER)).toBeUndefined();
    expect(none.tool_choice).toBe("none");
  });

  it("does not adapt a different model on the same endpoint", () => {
    const request = body({ model: "gpt-6-astra" });
    expect(adaptCompletionBodyForKnownEndpoint(request, ROUTER)).toBeUndefined();
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "select_dm_beat" } });
  });

  it("does not adapt when reasoning was not requested off (capability preflight path)", () => {
    const request = body({ tool_choice: "required", reasoning_effort: undefined });
    delete request.reasoning_effort;
    expect(adaptCompletionBodyForKnownEndpoint(request, ROUTER)).toBeUndefined();
    expect(request.tool_choice).toBe("required");
  });

  it("never adapts a non-authorized endpoint", () => {
    for (const baseUrl of [LOOPBACK, "https://api.openai.com/v1", "https://openrouter.ai/api/v1"]) {
      const request = body();
      expect(adaptCompletionBodyForKnownEndpoint(request, baseUrl)).toBeUndefined();
      expect(request.tool_choice).toEqual({ type: "function", function: { name: "select_dm_beat" } });
    }
  });
});

describe("completeWithProvider on the known thinking endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends auto and accepts a faithful no-tool-call hold instead of paying a rejected forced call", async () => {
    const fetchMock = stubFetch();
    const result = await completeWithProvider(forcedRequest(ROUTER));
    const wire = sentBody(fetchMock);
    expect(wire.tool_choice).toBe("auto");
    expect(wire.reasoning_effort).toBe("none");
    expect(result.message).toEqual({ role: "assistant", content: "Held for a player choice." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the forced named choice for any other endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "select_dm_beat", arguments: "{}" } }] } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await completeWithProvider(forcedRequest(LOOPBACK, "deepseek-v4-flash"));
    expect(sentBody(fetchMock).tool_choice).toEqual({ type: "function", function: { name: "select_dm_beat" } });
    expect(result.message.toolCalls?.[0]?.name).toBe("select_dm_beat");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
