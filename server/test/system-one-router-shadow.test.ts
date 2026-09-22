import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { defaultSystemOneLaneModes, defaultSystemOneSettings } from "../src/defaults.js";
import {
  ROUTER_COMPLEXITY_KEY,
  ROUTER_DETERMINISTIC_KEY,
  ROUTER_HANDLER_KEY,
  ROUTER_NONE,
  type RouterRequestProjection,
} from "../src/agent/systemOneRouter.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneAnswer, SystemOneCaller } from "../src/provider/systemOneCompletion.js";
import type { SystemOneSettings } from "../src/types.js";
import { createRepository, listSystemOneDecisionsByLane, type SystemOneDecisionRecord } from "../src/repo/index.js";
import { recordRouterShadowDecision } from "../src/routes/roleplay/interactions.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const REQUEST: RouterRequestProjection = {
  summary: "Who should inspect the signal?",
  hasDeterministicPath: false,
  requiresHumanDecision: false,
  safetySensitive: false,
};

function lane(caller: SystemOneCaller, overrides: Partial<SystemOneSettings> = {}): { settings: SystemOneSettings; caller: SystemOneCaller } {
  return { settings: { ...defaultSystemOneSettings(), enabled: true, laneModes: defaultSystemOneLaneModes(), apiKey: "test-key", ...overrides }, caller };
}

function routerAnswers(): Record<string, SystemOneAnswer> {
  return {
    [ROUTER_HANDLER_KEY]: {
      type: "choice",
      choice: "cheap-generation",
      confidence: 0.9,
      probabilities: { "cheap-generation": 0.9, [ROUTER_NONE]: 0.1 },
    },
    [ROUTER_COMPLEXITY_KEY]: {
      type: "score",
      score: 1,
      confidence: 0.9,
      legend: { 0: "simple", 1: "moderate", 2: "complex" },
      probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 },
    },
    [ROUTER_DETERMINISTIC_KEY]: { type: "noul", noul: 0.2 },
  };
}

describe("recordRouterShadowDecision", () => {
  beforeEach(() => {
    createRepository();
  });

  it("records one immutable cost-router shadow decision with the composed selection", async () => {
    const caller = createFakeSystemOneCaller({ scripted: routerAnswers(), responseModel: "jev-shadow" });
    await recordRouterShadowDecision("session-1", REQUEST, lane(caller), "frontier-generation");

    expect(caller.calls).toHaveLength(1);
    const rows = listSystemOneDecisionsByLane("cost-router", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      lane: "cost-router",
      sessionId: "session-1",
      provider: "typesafe",
      model: "jev-shadow",
      confidencePolicyVersion: "system-one-confidence-v1",
      confidenceBand: "act",
      shadow: true,
      fallbackUsed: true,
    });
    expect(row.state).toEqual(REQUEST);
    expect(Object.keys(row.questions as Record<string, unknown>)).toEqual([
      ROUTER_HANDLER_KEY,
      ROUTER_COMPLEXITY_KEY,
      ROUTER_DETERMINISTIC_KEY,
    ]);
    expect(row.answers).toEqual(routerAnswers());
    expect(row.selection).toMatchObject({
      band: "act",
      handler: "cheap-generation",
      complexity: 1,
      deterministicSufficient: false,
      topSignal: 0.9,
    });
    expect(row.usage).toEqual({ inputTokens: 128, outputTokens: 16 });
  });

  it("records nothing and never throws when the caller fails", async () => {
    const caller = createFakeSystemOneCaller({ failWith: new Error("system one down") });
    await expect(recordRouterShadowDecision("session-2", REQUEST, lane(caller), "frontier-generation")).resolves.toBeUndefined();
    expect(listSystemOneDecisionsByLane("cost-router", 10)).toHaveLength(0);
  });

  it("records nothing and never throws when the caller throws synchronously", async () => {
    const caller = (() => { throw new Error("sync boom"); }) as unknown as SystemOneCaller;
    await expect(recordRouterShadowDecision("session-3", REQUEST, lane(caller), "frontier-generation")).resolves.toBeUndefined();
    expect(listSystemOneDecisionsByLane("cost-router", 10)).toHaveLength(0);
  });
});

interface FakeSystemOne {
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

function fakeSystemOneResponse(body: string): unknown {
  const parsed = JSON.parse(body) as { questions?: Record<string, Record<string, unknown>> };
  const questions = parsed.questions ?? {};
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const type = question.type;
    if (type === "noul") {
      answers[id] = { type: "noul", noul: 0.9 };
      continue;
    }
    if (type === "choice") {
      const options = Object.keys((question.criteria as Record<string, unknown>) ?? {});
      const winner = options[0] ?? "none_of_these";
      const rest = options.filter((option) => option !== winner);
      const share = rest.length > 0 ? 0.1 / rest.length : 0;
      const probabilities = Object.fromEntries(options.map((option) => [option, option === winner ? 0.9 : share]));
      if (rest.length === 0) probabilities[winner] = 1;
      answers[id] = { type: "choice", choice: winner, confidence: 0.9, probabilities };
      continue;
    }
    const criteria = (question.criteria as unknown[]) ?? [];
    const levels = criteria.map((_, index) => String(index));
    const winner = levels[Math.floor(levels.length / 2)] ?? "0";
    const rest = levels.filter((level) => level !== winner);
    const share = rest.length > 0 ? 0.1 / rest.length : 0;
    const probabilities = Object.fromEntries(levels.map((level) => [level, level === winner ? 0.9 : share]));
    if (rest.length === 0) probabilities[winner] = 1;
    answers[id] = {
      type: "score",
      score: Object.entries(probabilities).reduce((sum, [level, probability]) => sum + Number(level) * probability, 0),
      confidence: 0.9,
      legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
      probabilities,
    };
  }
  return { model: "jev-shadow", answers, usage: { input_tokens: 100, output_tokens: 10 } };
}

async function startFakeSystemOne(): Promise<FakeSystemOne> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/systemone") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      req.on("end", () => {
        requests += 1;
        res.writeHead(200, { "Content-Type": "application/json", "x-typesafe-request-id": "req_shadow" });
        res.end(JSON.stringify(fakeSystemOneResponse(body)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requestCount: () => requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const savedSystemOneEnv = {
  feature: process.env.FEATURE_SYSTEM_ONE,
  base: process.env.TYPESAFE_BASE_URL,
  key: process.env.TYPESAFE_API_KEY,
};

let provider: FakeProvider | null = null;
let systemOne: FakeSystemOne | null = null;

afterEach(async () => {
  if (provider) { await provider.close(); provider = null; }
  if (systemOne) { await systemOne.close(); systemOne = null; }
  if (savedSystemOneEnv.feature === undefined) delete process.env.FEATURE_SYSTEM_ONE; else process.env.FEATURE_SYSTEM_ONE = savedSystemOneEnv.feature;
  if (savedSystemOneEnv.base === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = savedSystemOneEnv.base;
  if (savedSystemOneEnv.key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedSystemOneEnv.key;
});

async function runRoomTurn(systemOneEnabled: boolean): Promise<{
  status: number;
  routing: string;
  selectedSpeakerIds: string[];
  replyContents: string[];
  costRouter: SystemOneDecisionRecord[];
  speakerRouting: SystemOneDecisionRecord[];
  systemOneRequests: number;
}> {
  provider = await startFakeProvider({
    replyTexts: ['["One", "Two"]', "One answers first.", "Two reacts to One."],
  });
  systemOne = await startFakeSystemOne();
  process.env.FEATURE_SYSTEM_ONE = "true";
  process.env.TYPESAFE_BASE_URL = systemOne.baseUrl;
  process.env.TYPESAFE_API_KEY = "shadow-test-key";

  const app = buildApp();
  await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
  await app.inject({
    method: "PUT",
    url: "/api/provider/system-one",
    // The guardrails lane has its own shadow test; keep it off here so this test counts only
    // the speaker-routing and cost-router lanes it exercises.
    payload: systemOneEnabled ? { enabled: true, laneModes: { guardrails: "off" } } : { enabled: false },
  });

  const characterInput = (name: string) => ({
    name, age: 30, archetype: `${name} archetype`, boundaries: "fictional", fictionalConfirmed: true,
  });
  const one = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput("One") })).json() as { id: string };
  const two = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput("Two") })).json() as { id: string };
  const three = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput("Three") })).json() as { id: string };
  const session = (await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { characterIds: [one.id, two.id, three.id], primaryCharacterId: one.id },
  })).json() as { id: string };

  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/room-turn`,
    payload: { content: "Who should inspect the signal?", maxSpeakers: 2 },
  });
  const costRouter = listSystemOneDecisionsByLane("cost-router", 10);
  const speakerRouting = listSystemOneDecisionsByLane("speaker-routing", 10);
  const systemOneRequests = systemOne.requestCount();
  const body = response.json() as {
    routing: string;
    selectedSpeakerIds: string[];
    replies: Array<{ content: string }>;
  };
  await app.close();

  return {
    status: response.statusCode,
    routing: body.routing,
    selectedSpeakerIds: body.selectedSpeakerIds,
    replyContents: body.replies.map((reply) => reply.content),
    costRouter,
    speakerRouting,
    systemOneRequests,
  };
}

describe("cost-router shadow classification in the room turn", () => {
  it("leaves routing and generation unchanged when the shadow classifier is enabled", async () => {
    const result = await runRoomTurn(true);
    expect(result.status).toBe(200);
    expect(result.routing).toBe("model");
    expect(result.selectedSpeakerIds).toHaveLength(2);
    expect(result.replyContents).toEqual(["One answers first.", "Two reacts to One."]);
    expect(result.costRouter).toHaveLength(1);
    expect(result.costRouter[0]).toMatchObject({
      lane: "cost-router", provider: "typesafe", shadow: true, fallbackUsed: true,
    });
    expect(result.costRouter[0]!.selection).toMatchObject({ handler: expect.any(String), band: expect.any(String) });
    // The speaker-routing shadow lane also records, and both lanes use the same caller.
    expect(result.speakerRouting).toHaveLength(1);
    expect(result.systemOneRequests).toBe(2);
  });

  it("routes identically and records nothing when the classifier is disabled", async () => {
    const result = await runRoomTurn(false);
    expect(result.status).toBe(200);
    expect(result.routing).toBe("model");
    expect(result.selectedSpeakerIds).toHaveLength(2);
    expect(result.replyContents).toEqual(["One answers first.", "Two reacts to One."]);
    expect(result.costRouter).toHaveLength(0);
    expect(result.speakerRouting).toHaveLength(0);
    expect(result.systemOneRequests).toBe(0);
  });
});
