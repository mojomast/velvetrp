import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { buildRequestBody, fallbackRoomSpeakers, generateReply, streamReply, type GenerationArgs } from "../src/llm.js";
import { getPromptPreset } from "../src/presets.js";
import type { Character, ProviderSettings, Session } from "../src/types.js";
import { startFakeProvider, type FakeProvider } from "./helpers.js";
import { assembleCampaignAgentContext } from "../src/context.js";

const character: Character = {
  id: "c1",
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "keep it fictional",
    fictionalConfirmed: true,
  isRealPerson: false,
  createdAt: new Date().toISOString(),
};

const session: Session = {
  id: "s1",
  characterId: "c1",
  primaryCharacterId: "c1",
  participants: [character],
  title: "",
  state: "active",
  presetId: "default",
  consentLog: [],
  activeLeafId: null,
  createdAt: new Date().toISOString(),
  stoppedAt: null,
  stopReason: null,
};

function makeArgs(provider: ProviderSettings): GenerationArgs {
  return {
    character,
    session,
    history: [],
    memories: [],
    summary: null,
    preset: getPromptPreset("default"),
    lore: [],
    harness: defaultHarnessSettings(),
    provider,
    userContent: "hello captain",
  };
}

let fake: FakeProvider | null = null;
let rawServer: Server | null = null;

afterEach(async () => {
  if (fake) {
    await fake.close();
    fake = null;
  }
  if (rawServer) {
    await new Promise<void>((resolve) => rawServer?.close(() => resolve()));
    rawServer = null;
  }
});

describe("buildRequestBody", () => {
  it("includes model, stream flag, temperature, and configured samplers", () => {
    const provider = defaultProviderSettings();
    provider.model = " test-model ";
    provider.samplers.maxTokens = 256;
    provider.samplers.topP = 0.9;
    provider.samplers.stopStrings = ["halt"];
    const harness = { ...defaultHarnessSettings(), temperature: 0.7 };
    const body = buildRequestBody(provider, harness, getPromptPreset("default"), [{ role: "user", content: "hi" }], true);
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      temperature: 0.7,
      max_tokens: 256,
      top_p: 0.9,
      stop: ["halt"],
    });
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("min_p");
    expect(body).not.toHaveProperty("repetition_penalty");
  });

  it("does not enable OpenRouter routing for an invalid base URL", () => {
    const provider = defaultProviderSettings();
    provider.baseUrl = "not a URL";
    const body = buildRequestBody(provider, defaultHarnessSettings(), getPromptPreset("default"), [{ role: "user", content: "hi" }], false);
    expect(body).not.toHaveProperty("provider");
  });
});

describe("fallbackRoomSpeakers", () => {
  it("uses two speakers for a broad room address but one for a named address", () => {
    const second = { ...character, id: "c2", name: "Bex" };
    const third = { ...character, id: "c3", name: "Cy" };
    expect(fallbackRoomSpeakers([character, second, third], character.id, "hey guys", 3)).toEqual([character.id, second.id]);
    expect(fallbackRoomSpeakers([character, second, third], character.id, "Bex, what do you think?", 3)).toEqual([second.id]);
    expect(fallbackRoomSpeakers([character, second, third], character.id, "you two should compare notes", 1)).toEqual([character.id]);
    expect(fallbackRoomSpeakers([character, second, third], character.id, "remember your characters", 3)).toEqual([character.id, second.id, third.id]);
  });
});

describe("streamReply", () => {
  it("concatenates OpenAI-style SSE deltas until [DONE]", async () => {
    fake = await startFakeProvider({ replyText: "The captain smiles and pours two glasses.", chunkSize: 5 });
    const provider = { ...defaultProviderSettings(), baseUrl: fake.baseUrl, model: "fake-model" };
    const deltas: string[] = [];
    const result = await streamReply(makeArgs(provider), (delta) => deltas.push(delta));
    expect(result.text).toBe("The captain smiles and pours two glasses.");
    expect(result.usage).toMatchObject({ promptTokens: 120, completionTokens: 24, totalTokens: 144, source: "provider" });
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join("")).toBe(result.text);
  });

  it("preserves scoped loopback authorization in the legacy streaming path", async () => {
    fake = await startFakeProvider({ replyText: "Scoped legacy reply." });
    const provider = { ...defaultProviderSettings(), baseUrl: fake.baseUrl, model: "fake-model", apiKey: "legacy-secret" };

    await streamReply(makeArgs(provider), () => undefined);

    expect(fake.requests[0]?.authorization).toBe("Bearer legacy-secret");
  });

  it("passes optional campaign context to the provider without changing the final declaration", async () => {
    fake = await startFakeProvider({ replyText: "Campaign-aware reply." });
    const provider = { ...defaultProviderSettings(), baseUrl: fake.baseUrl, model: "fake-model" };
    const args = makeArgs(provider);
    args.campaignContext = assembleCampaignAgentContext({
      snapshot: { campaignId: "campaign", timelineId: "timeline", timelineRevision: 0, campaignRevision: 0, sessionId: session.id, audience: { kind: "player", actorId: "actor" },
        authority: { role: "player", control: "controlled" }, speakerPersona: { characterId: character.id, displayName: character.name },
        safetyControl: ["CAMPAIGN_SAFETY"], humanCanon: [],
        committedMechanics: [], visibleWorld: [], visibleCast: [], visibleQuests: [], legalActions: [],
        privateTargetFacts: [],attributeCandidates:[], synthesizedSummaryFacts: [], recap: [], encounter: null },
      declaration: "stale declaration",
      approvedMemory: ["CAMPAIGN_ONLY_MEMORY"],
    });
    args.memories = [{ id: "legacy-memory", characterId: character.id, kind: "fact", content: "LEGACY_DUPLICATE_MEMORY",
      sourceTurnId: "turn", createdAt: "", userApproved: true, forgottenAt: null }];
    args.summary = { sessionId: session.id, summary: "LEGACY_DUPLICATE_SUMMARY", keyEvents: [], emotionalBeat: "", updatedAt: "" };
    args.lore = [{ id: "legacy-lore", characterId: null, characterIds: [], keys: [], content: "LEGACY_DUPLICATE_LORE",
      enabled: true, insertionOrder: 0, createdAt: "" }];
    args.sharedContext = "LEGACY_DUPLICATE_SHARED";
    await streamReply(args, () => undefined);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.systemContent).toContain("CAMPAIGN AGENT CONTEXT");
    expect(fake.requests[0]?.systemContent).toContain("CAMPAIGN_SAFETY");
    expect(fake.requests[0]?.systemContent).toContain("CAMPAIGN_ONLY_MEMORY");
    expect(fake.requests[0]?.systemContent).not.toMatch(/stale declaration|LEGACY_DUPLICATE|TRIGGERED LORE|RETRIEVED MEMORY|SHARED CONTEXT BASKET/);
    expect(fake.requests[0]?.lastUserContent).toBe(args.userContent);
  });

  it("emits an unterminated final SSE line after a split UTF-8 character", async () => {
    rawServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const body = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"cafe ☕"}}]}');
      const coffeeByte = body.indexOf(0xe2);
      res.write(body.slice(0, coffeeByte + 1));
      res.end(body.slice(coffeeByte + 1));
    });
    await new Promise<void>((resolve) => rawServer?.listen(0, "127.0.0.1", resolve));
    const port = (rawServer.address() as AddressInfo).port;
    const provider = { ...defaultProviderSettings(), baseUrl: `http://127.0.0.1:${port}/v1`, model: "test-model" };
    const deltas: string[] = [];

    const result = await streamReply(makeArgs(provider), (delta) => deltas.push(delta));

    expect(result.text).toBe("cafe ☕");
    expect(deltas).toEqual(["cafe ☕"]);
  });

  it("rejects when the abort signal fires mid-stream", async () => {
    fake = await startFakeProvider({ replyText: "slow", delayMs: 2000 });
    const provider = { ...defaultProviderSettings(), baseUrl: fake.baseUrl, model: "fake-model" };
    const controller = new AbortController();
    const pending = streamReply(makeArgs(provider), () => undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });

  it("throws on non-200 responses with the status code", async () => {
    rawServer = createServer((req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("upstream exploded");
    });
    await new Promise<void>((resolve) => rawServer?.listen(0, "127.0.0.1", resolve));
    const port = (rawServer.address() as AddressInfo).port;
    const provider = { ...defaultProviderSettings(), baseUrl: `http://127.0.0.1:${port}/v1` };
    await expect(streamReply(makeArgs(provider), () => undefined)).rejects.toThrow(/LLM request failed: 500/);
  });

  it("falls back to the local stub when the provider is not configured", async () => {
    const provider = defaultProviderSettings();
    provider.baseUrl = "https://api.openai.com/v1";
    provider.apiKey = "";
    const deltas: string[] = [];
    const result = await streamReply(makeArgs(provider), (delta) => deltas.push(delta));
    expect(result.text).toContain("[local stub");
    expect(result.text).toContain("hello captain");
    expect(result.usage).toBeNull();
    expect(deltas).toEqual([result.text]);
  });
});

describe("generateReply", () => {
  it("buffers streamed deltas into a single string", async () => {
    fake = await startFakeProvider({ replyText: "Buffered reply across many chunks.", chunkSize: 2 });
    const provider = { ...defaultProviderSettings(), baseUrl: fake.baseUrl, model: "fake-model" };
    const args = makeArgs(provider);
    const result = await generateReply(
      args.character,
      args.session,
      args.history,
      args.memories,
      args.summary,
      args.preset,
      args.lore,
      args.harness,
      args.provider,
      args.userContent,
    );
    expect(result.text).toBe("Buffered reply across many chunks.");
    expect(result.usage?.source).toBe("provider");
  });
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter live integration", () => {
  it("completes a real OpenRouter request", async () => {
    const provider = {
      ...defaultProviderSettings(),
      baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      model: process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat-v4",
      apiKey: process.env.OPENROUTER_API_KEY!,
      streaming: false,
      httpReferer: process.env.OPENROUTER_HTTP_REFERER ?? "http://localhost:5173",
      appTitle: process.env.OPENROUTER_APP_TITLE ?? "Velvet integration test",
      samplers: { ...defaultProviderSettings().samplers, maxTokens: 1600, topP: 0.95 },
    };
    const result = await generateReply(
      character,
      session,
      [],
      [],
      null,
      getPromptPreset("default"),
      [],
      defaultHarnessSettings(),
      provider,
      "Reply with exactly: live provider test passed",
    );
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.usage).not.toBeNull();
  }, 45_000);
});
