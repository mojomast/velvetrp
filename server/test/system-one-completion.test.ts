import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSystemOneSettings } from "../src/defaults.js";
import {
  completeWithSystemOne,
  SystemOneAuthenticationError,
  SystemOneCallerAbortError,
  SystemOneConfigurationError,
  SystemOneOverloadedError,
  SystemOneProtocolError,
  SystemOneRateLimitError,
  SystemOneRedirectError,
  SystemOneTimeoutError,
  SystemOneValidationError,
  type SystemOneQuestion,
} from "../src/provider/systemOneCompletion.js";
import type { SystemOneSettings } from "../src/types.js";

interface CapturedRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface TestResponse {
  status?: number;
  body: unknown;
  delayMs?: number;
  headers?: Record<string, string>;
}

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function startServer(response: TestResponse | ((request: CapturedRequest, index: number) => TestResponse)): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  server = createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { rawBody += chunk; });
    req.on("end", () => {
      const captured: CapturedRequest = { url: req.url, headers: req.headers, body: JSON.parse(rawBody) as Record<string, unknown> };
      requests.push(captured);
      const selected = typeof response === "function" ? response(captured, requests.length - 1) : response;
      const send = () => {
        res.writeHead(selected.status ?? 200, { "Content-Type": "application/json", ...selected.headers });
        res.end(JSON.stringify(selected.body));
      };
      if (selected.delayMs) setTimeout(send, selected.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function settings(baseUrl: string, overrides: Partial<SystemOneSettings> = {}): SystemOneSettings {
  return { ...defaultSystemOneSettings(), baseUrl, apiKey: " local-secret ", requestTimeoutSeconds: 10, ...overrides };
}

const questions: Record<string, SystemOneQuestion> = {
  hold: { type: "noul", instructions: "Should the Director hold?" },
  grounded: { type: "score", instructions: "Rate groundedness.", criteria: ["grounded", "contradicts"] },
  pick: { type: "choice", instructions: "Pick a legal action.", criteria: { attack: "commit the attack", none_of_these: null } },
};

const goodAnswers = {
  hold: { type: "noul", noul: 0.8 },
  grounded: { type: "score", score: 0.1, confidence: 0.9, legend: { 0: "grounded", 1: "contradicts" }, probabilities: { 0: 0.9, 1: 0.1 } },
  pick: { type: "choice", choice: "attack", confidence: 0.9, probabilities: { attack: 0.9, none_of_these: 0.1 } },
};

describe("System One completion adapter", () => {
  it("sends the documented request and parses typed answers with provenance", async () => {
    const { baseUrl, requests } = await startServer({ body: { model: "jev-1.13.0", answers: goodAnswers, usage: { input_tokens: 300, output_tokens: 20 } }, headers: { "x-typesafe-request-id": "req_123" } });
    const result = await completeWithSystemOne({ settings: settings(baseUrl), state: { room: "mill" }, questions });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/systemone");
    expect(requests[0]!.headers.authorization).toBe("Bearer local-secret");
    expect(requests[0]!.body).toEqual({ state: { room: "mill" }, model: "jev-latest", questions });
    expect(result.model).toEqual({ requestedModel: "jev-latest", responseModel: "jev-1.13.0" });
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 20, totalTokens: 320 });
    expect(result.provenance).toMatchObject({ requestId: "req_123", attempts: 1 });
    expect(result.answers.pick).toMatchObject({ type: "choice", choice: "attack" });
  });

  it("returns null usage when the provider omits it", async () => {
    const { baseUrl } = await startServer({ body: { model: "jev-1.13.0", answers: goodAnswers } });
    const result = await completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions });
    expect(result.usage).toBeNull();
  });

  it("retries retryable statuses with bounded backoff", async () => {
    const { baseUrl, requests } = await startServer((_request, index) => index === 0
      ? { status: 429, body: { detail: "slow down" } }
      : { status: 200, body: { model: "jev-1.13.0", answers: goodAnswers } });
    const sleeps: number[] = [];
    const result = await completeWithSystemOne({
      settings: settings(baseUrl),
      state: "x",
      questions,
      maxAttempts: 3,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(requests).toHaveLength(2);
    expect(result.provenance.attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it("does not retry a validation failure", async () => {
    const { baseUrl, requests } = await startServer({ status: 422, body: { detail: "bad body" } });
    await expect(completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions })).rejects.toBeInstanceOf(SystemOneValidationError);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [401, SystemOneAuthenticationError],
    [400, SystemOneValidationError],
    [529, SystemOneOverloadedError],
  ])("classifies HTTP %i", async (status, errorType) => {
    const { baseUrl } = await startServer({ status, body: { detail: "nope" } });
    await expect(completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions, maxAttempts: 1 })).rejects.toBeInstanceOf(errorType);
  });

  it("surfaces rate-limit metadata after exhausting attempts", async () => {
    const { baseUrl } = await startServer({ status: 429, body: { detail: "slow" }, headers: { "retry-after": "2" } });
    const error = await completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions, maxAttempts: 1 })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SystemOneRateLimitError);
    expect((error as SystemOneRateLimitError).retryAfter).toBe("2");
  });

  it("refuses redirects", async () => {
    const { baseUrl } = await startServer({ status: 307, body: {}, headers: { location: "https://evil.test/systemone" } });
    await expect(completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions, maxAttempts: 1 })).rejects.toBeInstanceOf(SystemOneRedirectError);
  });

  it("times out slow responses", async () => {
    const { baseUrl } = await startServer({ body: { model: "jev-1.13.0", answers: goodAnswers }, delayMs: 1_500 });
    await expect(completeWithSystemOne({ settings: settings(baseUrl, { requestTimeoutSeconds: 1 }), state: "x", questions, maxAttempts: 1 }))
      .rejects.toBeInstanceOf(SystemOneTimeoutError);
  });

  it("honors caller aborts", async () => {
    const { baseUrl } = await startServer({ body: { model: "jev-1.13.0", answers: goodAnswers }, delayMs: 300 });
    const controller = new AbortController();
    const pending = completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions, signal: controller.signal, maxAttempts: 1 });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(SystemOneCallerAbortError);
  });

  it("requires a credential for the hosted host and rejects invalid settings", async () => {
    await expect(completeWithSystemOne({ settings: settings("https://api.typesafe.ai/v1", { apiKey: "" }), state: "x", questions }))
      .rejects.toBeInstanceOf(SystemOneConfigurationError);
    await expect(completeWithSystemOne({ settings: settings("https://api.typesafe.ai/v1", { requestTimeoutSeconds: 0 }), state: "x", questions }))
      .rejects.toBeInstanceOf(SystemOneConfigurationError);
    await expect(completeWithSystemOne({ settings: settings("http://api.typesafe.ai/v1"), state: "x", questions }))
      .rejects.toBeInstanceOf(SystemOneConfigurationError);
  });

  it.each([
    ["a probability sum away from one", { ...goodAnswers, pick: { type: "choice", choice: "attack", confidence: 0.5, probabilities: { attack: 0.5, none_of_these: 0.1 } } }],
    ["an undeclared option", { ...goodAnswers, pick: { type: "choice", choice: "attack", confidence: 0.9, probabilities: { attack: 0.9, flee: 0.1 } } }],
    ["a missing answer", { hold: goodAnswers.hold, grounded: goodAnswers.grounded }],
    ["an answer type mismatch", { ...goodAnswers, hold: { type: "noul", noul: 0.8 }, pick: { type: "choice", choice: "attack", confidence: 0.9, probabilities: { attack: 0.9, none_of_these: 0.1 } }, grounded: { type: "choice", choice: "grounded", confidence: 0.9, probabilities: { grounded: 0.9, contradicts: 0.1 } } }],
    ["an unknown answer field", { ...goodAnswers, pick: { type: "choice", choice: "attack", confidence: 0.9, probabilities: { attack: 0.9, none_of_these: 0.1 }, note: "hi" } }],
    ["an out-of-range confidence", { ...goodAnswers, pick: { type: "choice", choice: "attack", confidence: 1.5, probabilities: { attack: 0.9, none_of_these: 0.1 } } }],
  ])("rejects a response with %s", async (_label, answers) => {
    const { baseUrl } = await startServer({ body: { model: "jev-1.13.0", answers } });
    await expect(completeWithSystemOne({ settings: settings(baseUrl), state: "x", questions, maxAttempts: 1 }))
      .rejects.toBeInstanceOf(SystemOneProtocolError);
  });

  it("rejects malformed request questions before dispatching", async () => {
    const { baseUrl, requests } = await startServer({ body: { model: "jev-1.13.0", answers: goodAnswers } });
    await expect(completeWithSystemOne({
      settings: settings(baseUrl),
      state: "x",
      questions: { bad: { type: "score", instructions: "x", criteria: ["only-one"] } as unknown as SystemOneQuestion },
    })).rejects.toBeInstanceOf(SystemOneConfigurationError);
    expect(requests).toHaveLength(0);
  });

  it("accepts the vendor's structured instructions and criteria and forwards them unchanged", async () => {
    const structured: Record<string, SystemOneQuestion> = {
      route: {
        type: "choice",
        instructions: { question: "Which team should handle this?", focus: "Classify the primary request." },
        criteria: {
          billing: { what: "Charges, invoices, refunds", not_for: "Order tracking", examples: ["I was charged twice"] },
          orders: { what: "Order status and delivery", not_for: "Charges", examples: ["Where is my package?"] },
          taxonomy: { "Sporting Goods": { Cycling: ["Bike Bottles", "Helmets"] } },
        },
      },
      scope: {
        type: "score",
        instructions: { question: "How focused is the change?" },
        criteria: [
          { summary: "One change", signals: ["A single fix", "No \"also\" clauses"] },
          { summary: "Several independent changes", signals: ["Could each be their own PR"] },
        ],
      },
      credentials: {
        type: "noul",
        instructions: { question: "Does it request a credential?", inspect: "message" },
        criteria: { true: { what: "Asks for a password or code" }, false: null },
      },
      absent: { type: "noul", instructions: null },
    };
    const structuredAnswers = {
      route: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.8, orders: 0.1, taxonomy: 0.1 } },
      scope: { type: "score", score: 0.1, confidence: 0.9, legend: { 0: "One change", 1: "Several independent changes" }, probabilities: { 0: 0.9, 1: 0.1 } },
      credentials: { type: "noul", noul: 0.7 },
      absent: { type: "noul", noul: 0.5 },
    };
    const { baseUrl, requests } = await startServer({ body: { model: "jev-1.13.0", answers: structuredAnswers } });
    const result = await completeWithSystemOne({ settings: settings(baseUrl), state: { message: "hi" }, questions: structured });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.questions).toEqual(structured);
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "billing" });
  });
});
