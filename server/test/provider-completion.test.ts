import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { getPromptPreset } from "../src/presets.js";
import {
  completeWithProvider,
  ProviderCallerAbortError,
  ProviderConfigurationError,
  ProviderHttpError,
  ProviderProtocolError,
  ProviderRedirectError,
  ProviderResponseError,
  ProviderTimeoutError,
} from "../src/provider/index.js";
import { buildProviderHeaders, canUseProvider } from "../src/provider/providerTransport.js";
import type { ProviderSettings } from "../src/types.js";

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface TestResponse {
  status?: number;
  body: unknown;
  raw?: boolean;
  delayMs?: number;
  headers?: Record<string, string>;
}

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function startProvider(response: TestResponse | ((request: CapturedRequest) => TestResponse)): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  server = createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { rawBody += chunk; });
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      };
      requests.push(captured);
      const selected = typeof response === "function" ? response(captured) : response;
      const send = () => {
        res.writeHead(selected.status ?? 200, { "Content-Type": selected.raw ? "text/plain" : "application/json", ...selected.headers });
        res.end(selected.raw ? String(selected.body) : JSON.stringify(selected.body));
      };
      if (selected.delayMs) setTimeout(send, selected.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function provider(baseUrl: string): ProviderSettings {
  return {
    ...defaultProviderSettings(),
    baseUrl,
    model: " requested-model ",
    apiKey: " local-secret ",
    requestTimeoutSeconds: 2,
    samplers: {
      ...defaultProviderSettings().samplers,
      maxTokens: 321,
      topP: 0.8,
      frequencyPenalty: 0.2,
      stopStrings: ["STOP"],
    },
  };
}

function input(settings: ProviderSettings) {
  return {
    provider: settings,
    harness: { ...defaultHarnessSettings(), temperature: 0.4 },
    preset: getPromptPreset("default"),
    messages: [
      { role: "system" as const, content: "Follow campaign rules." },
      { role: "user" as const, content: "Open the door." },
    ],
  };
}

const textResponse = (content = "The door opens.") => ({
  model: "response-model",
  choices: [{ message: { role: "assistant", content } }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
});

describe("non-stream provider completion request", () => {
  it("sends the configured model, messages, samplers, headers, and stream:false", async () => {
    const fake = await startProvider({ body: textResponse() });
    const result = await completeWithProvider(input(provider(`${fake.baseUrl}/`)));

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions" });
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer local-secret");
    expect(fake.requests[0]?.body).toMatchObject({
      model: "requested-model",
      stream: false,
      temperature: 0.4,
      max_tokens: 321,
      top_p: 0.8,
      frequency_penalty: 0.2,
      stop: ["STOP"],
      messages: [
        { role: "system", content: "Follow campaign rules." },
        { role: "user", content: "Open the door." },
      ],
    });
    expect(result.message).toEqual({ role: "assistant", content: "The door opens." });
  });

  it("wires strict tools, named choice, assistant calls, and tool results", async () => {
    const fake = await startProvider({ body: {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "next-call", type: "function", function: { name: "move_actor", arguments: " {\n  \"room\": \"r2\"\n} " } },
      ] } }],
    } });
    const request = input(provider(fake.baseUrl));
    const result = await completeWithProvider({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: null, toolCalls: [{ id: "prior-call", name: "move_actor", arguments: "{\"room\":\"r1\"}" }] },
        { role: "tool", toolCallId: "prior-call", content: "{\"ok\":true}" },
      ],
      tools: [{ name: "move_actor", description: "Move an actor", parameters: {
        type: "object", properties: { room: { type: "string" } }, required: ["room"], additionalProperties: false,
      } }],
      toolChoice: { name: "move_actor" },
    });

    expect(fake.requests[0]?.body).toMatchObject({
      stream: false,
      tools: [{ type: "function", function: { name: "move_actor", description: "Move an actor", strict: true } }],
      tool_choice: { type: "function", function: { name: "move_actor" } },
      messages: expect.arrayContaining([
        { role: "assistant", content: null, tool_calls: [{ id: "prior-call", type: "function", function: {
          name: "move_actor", arguments: "{\"room\":\"r1\"}",
        } }] },
        { role: "tool", tool_call_id: "prior-call", content: "{\"ok\":true}" },
      ]),
    });
    expect(result.message.toolCalls?.[0]?.arguments).toBe(" {\n  \"room\": \"r2\"\n} ");
  });

  it("transports strict json_schema without locally parsing assistant content", async () => {
    const fake = await startProvider({ body: textResponse("not locally schema validated") });
    await completeWithProvider({ ...input(provider(fake.baseUrl)), jsonSchema: {
      name: "narration",
      description: "Structured narration",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    } });
    expect(fake.requests[0]?.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "narration",
        description: "Structured narration",
        schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        strict: true,
      },
    });
  });

  it("surfaces strict-capability incompatibility without retrying or downgrading", async () => {
    const fake = await startProvider({ status: 400, body: { error: { message: "strict unsupported" } } });
    const pending = completeWithProvider({
      ...input(provider(fake.baseUrl)),
      tools: [{ name: "act", parameters: { type: "object", additionalProperties: false } }],
      jsonSchema: { name: "result", schema: { type: "object", additionalProperties: false } },
    });
    await expect(pending).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.body).toMatchObject({
      tools: [{ function: { strict: true } }],
      response_format: { json_schema: { strict: true } },
      stream: false,
    });
  });

  it("omits empty tools and assistant tool_calls from the wire", async () => {
    const fake = await startProvider({ body: textResponse() });
    const request = input(provider(fake.baseUrl));
    await completeWithProvider({
      ...request,
      messages: [...request.messages, { role: "assistant", content: "No call needed.", toolCalls: [] }],
      tools: [],
    });
    expect(fake.requests[0]?.body).not.toHaveProperty("tools");
    expect((fake.requests[0]?.body.messages as Array<Record<string, unknown>>)[2]).not.toHaveProperty("tool_calls");
  });
});

describe("provider completion parsing and metadata", () => {
  it("returns valid usage plus distinct requested and response model metadata", async () => {
    const fake = await startProvider({ body: textResponse() });
    const result = await completeWithProvider(input(provider(fake.baseUrl)));
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.model).toEqual({ requestedModel: "requested-model", responseModel: "response-model" });
  });

  it.each([
    undefined,
    { prompt_tokens: 1, completion_tokens: 2 },
    { prompt_tokens: 1, completion_tokens: -2, total_tokens: 3 },
    { prompt_tokens: 5, completion_tokens: 4, total_tokens: 8 },
  ])("normalizes absent or invalid usage to null", async (usage) => {
    const fake = await startProvider({ body: { choices: [{ message: { role: "assistant", content: "ok" } }], usage, model: "" } });
    const result = await completeWithProvider(input(provider(fake.baseUrl)));
    expect(result.usage).toBeNull();
    expect(result.model.responseModel).toBeNull();
  });

  it("rejects duplicate provider tool-call IDs", async () => {
    const call = { id: "duplicate", type: "function", function: { name: "act", arguments: "{}" } };
    const fake = await startProvider({ body: { choices: [{ message: { role: "assistant", content: null, tool_calls: [call, call] } }] } });
    await expect(completeWithProvider({
      ...input(provider(fake.baseUrl)),
      tools: [{ name: "act", parameters: { type: "object" } }],
    }))
      .rejects.toThrow(/duplicate tool call id/);
  });

  it("accepts compatibility variants with omitted assistant role or tool-call content", async () => {
    let call = 0;
    const fake = await startProvider(() => ++call === 1
      ? { body: { choices: [{ message: { content: "role omitted" } }] } }
      : { body: { choices: [{ message: { tool_calls: [
        { id: "call-1", type: "function", function: { name: "act", arguments: "{}" } },
      ] } }] } });
    const settings = provider(fake.baseUrl);
    expect((await completeWithProvider(input(settings))).message).toEqual({ role: "assistant", content: "role omitted" });
    const toolResult = await completeWithProvider({
      ...input(settings),
      tools: [{ name: "act", parameters: { type: "object" } }],
      toolChoice: "required",
    });
    expect(toolResult.message).toEqual({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "act", arguments: "{}" }],
    });
  });

  it.each([
    ["without advertised tools", undefined, undefined, "act"],
    ["when choice is none", ["act"], "none", "act"],
    ["for an undeclared function", ["act"], "auto", "other"],
    ["instead of the named function", ["act", "other"], { name: "act" }, "other"],
  ] as const)("rejects provider tool calls %s", async (_label, toolNames, toolChoice, responseName) => {
    const fake = await startProvider({ body: { choices: [{ message: { content: null, tool_calls: [
      { id: "call", type: "function", function: { name: responseName, arguments: "{}" } },
    ] } }] } });
    await expect(completeWithProvider({
      ...input(provider(fake.baseUrl)),
      ...(toolNames ? { tools: toolNames.map((name) => ({ name, parameters: { type: "object" } })) } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    })).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("rejects missing required calls and IDs colliding with transcript calls", async () => {
    let call = 0;
    const fake = await startProvider(() => ++call === 1
      ? { body: textResponse("provider ignored required choice") }
      : { body: { choices: [{ message: { content: null, tool_calls: [
        { id: "prior", type: "function", function: { name: "act", arguments: "{}" } },
      ] } }] } });
    const settings = provider(fake.baseUrl);
    const tool = { name: "act", parameters: { type: "object" } } as const;
    await expect(completeWithProvider({ ...input(settings), tools: [tool], toolChoice: "required" }))
      .rejects.toThrow(/required tool call/);
    const base = input(settings);
    await expect(completeWithProvider({
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: null, toolCalls: [{ id: "prior", name: "act", arguments: "{}" }] },
        { role: "tool", toolCallId: "prior", content: "ok" },
      ],
      tools: [tool],
    })).rejects.toThrow(/reused a prior tool call id/);
  });

  it.each([
    ["non-object", []],
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["missing message", { choices: [{}] }],
    ["wrong role", { choices: [{ message: { role: "user", content: "x" } }] }],
    ["missing content", { choices: [{ message: { role: "assistant" } }] }],
    ["empty null message", { choices: [{ message: { role: "assistant", content: null } }] }],
    ["malformed call", { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "x" }] } }] }],
  ])("rejects malformed %s responses", async (_label, body) => {
    const fake = await startProvider({ body });
    await expect(completeWithProvider(input(provider(fake.baseUrl)))).rejects.toBeInstanceOf(ProviderProtocolError);
  });
});

describe("provider completion failures and configuration", () => {
  it("classifies provider-declared and invalid-JSON errors", async () => {
    let call = 0;
    const fake = await startProvider(() => ++call === 1
      ? { body: { error: { message: "tool calling unavailable" } } }
      : { body: "not json", raw: true });
    await expect(completeWithProvider(input(provider(fake.baseUrl))))
      .rejects.toEqual(expect.objectContaining<Partial<ProviderResponseError>>({ message: "tool calling unavailable" }));
    await expect(completeWithProvider(input(provider(fake.baseUrl)))).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("bounds HTTP error details", async () => {
    const fake = await startProvider({ status: 503, body: `${"x".repeat(2_000)}NEVER_INCLUDED`, raw: true });
    const pending = completeWithProvider(input(provider(fake.baseUrl)));
    await expect(pending).rejects.toBeInstanceOf(ProviderHttpError);
    await expect(pending).rejects.not.toThrow(/NEVER_INCLUDED/);
  });

  it("redacts configured and shaped credentials from HTTP and provider errors", async () => {
    let call = 0;
    const reflected = "Authorization: Bearer reflected-token; standalone Bearer standalone-token; configured=local-secret";
    const fake = await startProvider(() => ++call === 1
      ? { status: 401, body: reflected, raw: true }
      : { body: { error: { message: reflected } } });
    const settings = provider(fake.baseUrl);
    for (let index = 0; index < 2; index += 1) {
      let caught: unknown;
      try {
        await completeWithProvider(input(settings));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(index === 0 ? ProviderHttpError : ProviderResponseError);
      expect(String(caught)).toContain("[REDACTED]");
      expect(String(caught)).not.toMatch(/local-secret|reflected-token|standalone-token/);
    }
  });

  it("refuses and safely classifies redirects", async () => {
    const fake = await startProvider({ status: 307, body: "redirect", raw: true, headers: { Location: "/reflected-local-secret" } });
    const pending = completeWithProvider(input(provider(fake.baseUrl)));
    await expect(pending).rejects.toBeInstanceOf(ProviderRedirectError);
    await expect(pending).rejects.not.toThrow(/local-secret|Location|reflected/);
    expect(fake.requests).toHaveLength(1);
  });

  it("distinguishes caller cancellation from provider timeout", async () => {
    const fake = await startProvider({ body: textResponse(), delayMs: 150 });
    const controller = new AbortController();
    const callerPending = completeWithProvider({ ...input(provider(fake.baseUrl)), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(callerPending).rejects.toBeInstanceOf(ProviderCallerAbortError);

    const timedProvider = provider(fake.baseUrl);
    timedProvider.requestTimeoutSeconds = 0.01;
    await expect(completeWithProvider(input(timedProvider))).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("fails closed instead of stubbing invalid or unauthenticated hosted configuration", async () => {
    const invalid = provider("http://example.com/v1");
    await expect(completeWithProvider(input(invalid))).rejects.toBeInstanceOf(ProviderConfigurationError);
    const hosted = provider("https://api.openai.com/v1");
    hosted.apiKey = "";
    await expect(completeWithProvider(input(hosted))).rejects.toBeInstanceOf(ProviderConfigurationError);
  });

  it("rejects duplicate tools, unknown named choices, and empty assistant replay messages", async () => {
    const fake = await startProvider({ body: textResponse() });
    const base = input(provider(fake.baseUrl));
    const tool = { name: "act", parameters: { type: "object" } } as const;
    await expect(completeWithProvider({ ...base, tools: [tool, tool] })).rejects.toThrow(/duplicate tool name/);
    await expect(completeWithProvider({ ...base, tools: [tool], toolChoice: { name: "missing" } })).rejects.toThrow(/unknown tool/);
    await expect(completeWithProvider({ ...base, messages: [{ role: "assistant", content: null }] }))
      .rejects.toThrow(/neither content nor tool calls/);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ["orphan result", [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "orphan", content: "no" },
    ], /orphan tool result/],
    ["duplicate result", [
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "act", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "one" },
      { role: "tool", toolCallId: "a", content: "two" },
    ], /duplicate tool result/],
    ["out-of-order result", [
      { role: "assistant", content: null, toolCalls: [
        { id: "a", name: "act", arguments: "{}" },
        { id: "b", name: "act", arguments: "{}" },
      ] },
      { role: "tool", toolCallId: "b", content: "second" },
      { role: "tool", toolCallId: "a", content: "first" },
    ], /out-of-order tool result/],
    ["interrupted pending calls", [
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "act", arguments: "{}" }] },
      { role: "user", content: "continue" },
    ], /unresolved tool call.*before/],
    ["unresolved final call", [
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "act", arguments: "{}" }] },
    ], /unresolved tool call at end/],
  ])("rejects invalid transcript with %s", async (_label, messages, pattern) => {
    const fake = await startProvider({ body: textResponse() });
    await expect(completeWithProvider({
      ...input(provider(fake.baseUrl)),
      messages: messages as never,
    })).rejects.toThrow(pattern);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("provider credential and OpenRouter header scope", () => {
  it("sends credentials only to the unchanged exact allowlist or loopback policy", () => {
    const settings = provider("https://api.openai.com/v1");
    settings.httpReferer = "https://velvet.example";
    settings.appTitle = "Velvet Test";
    expect(buildProviderHeaders(settings.baseUrl, settings).Authorization).toBe("Bearer local-secret");
    expect(buildProviderHeaders("http://127.0.0.2:123/v1", settings).Authorization).toBe("Bearer local-secret");
    expect(buildProviderHeaders("https://api.openai.com.evil.test/v1", settings)).not.toHaveProperty("Authorization");
    expect(buildProviderHeaders("https://sub.openrouter.ai/v1", settings)).toEqual({ "Content-Type": "application/json" });
    expect(buildProviderHeaders("https://openrouter.ai/api/v1", settings)).toMatchObject({
      Authorization: "Bearer local-secret",
      "HTTP-Referer": "https://velvet.example",
      "X-Title": "Velvet Test",
    });
  });

  it("requires keys only for exact hosted names across provider labels", () => {
    for (const providerType of ["openai-compatible", "ollama", "llamacpp", "koboldcpp"] as const) {
      const hosted = provider("https://api.openai.com/v1");
      hosted.providerType = providerType;
      hosted.apiKey = "";
      expect(canUseProvider(hosted)).toBe(false);

      const unknown = provider("https://compatible.example/v1");
      unknown.providerType = providerType;
      expect(canUseProvider(unknown)).toBe(true);
      expect(buildProviderHeaders(unknown.baseUrl, unknown)).not.toHaveProperty("Authorization");
    }
    const misleading = provider("https://api.openai.com.evil.test/v1");
    misleading.apiKey = "";
    expect(canUseProvider(misleading)).toBe(true);
    expect(buildProviderHeaders(misleading.baseUrl, { ...misleading, apiKey: "must-not-leak" })).not.toHaveProperty("Authorization");
  });

  it.each(["api.openai.com", "openrouter.ai", "router.requesty.ai", "requesty.ai"])(
    "requires and scopes credentials for exact hosted name %s",
    (hostname) => {
      const settings = provider(`https://${hostname}/v1`);
      settings.apiKey = "";
      expect(canUseProvider(settings)).toBe(false);
      settings.apiKey = "hosted-key";
      expect(canUseProvider(settings)).toBe(true);
      expect(buildProviderHeaders(settings.baseUrl, settings).Authorization).toBe("Bearer hosted-key");
    },
  );
});
