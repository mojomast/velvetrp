/**
 * Tests for the teacher HTTP client.
 *
 * NO TEST IN THIS FILE MAY REACH THE LIVE RELAY. Every dispatch goes through an
 * injected fake transport, and a `fetch` that escapes is a test that spends
 * money and fails differently every run.
 *
 * The six tests below are named for the properties they pin:
 *
 *  1. no credential is present            -> construction is refused
 *  2. env wins over the config fallback   -> the documented precedence
 *  3. retries cover 429/5xx only          -> a 400 is not retried
 *  4. the default timeout is the relay's  -> long completions are not aborted
 *  5. usage is returned, or honestly null -> accounting is possible
 *  6. no credential-shaped string survives -> discipline is total
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TEACHER_MAX_ATTEMPTS,
  DEFAULT_TEACHER_MODEL,
  DEFAULT_TEACHER_TIMEOUT_MS,
  TeacherCredentialError,
  TeacherHttpError,
  assertDistinctModels,
  createTeacherClient,
  isRetryableStatus,
  requireReviewerCredentials,
  requireTeacherCredentials,
  resolveTeacherCredentials,
  retryDelayMs,
  type ResolvedTeacherCredentials,
  type TeacherHttpRequest,
  type TeacherHttpResponse,
  type TeacherTransport,
} from "../src/teacher.js";

/** A credential-shaped secret: long, unique, and greppable. */
const SECRET = "sk-vlt-teach-9f3c1a7be40d25secretvalue";
const BASE_URL = "http://127.0.0.1:9/v1";

const CREDENTIALS: ResolvedTeacherCredentials = {
  baseUrl: BASE_URL,
  apiKey: SECRET,
  model: "teacher-model-alpha",
  providerId: "agentrouter",
  source: "env",
};

/** Shape patterns a credential can take. Any hit is a failure. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  new RegExp(SECRET),
  /sk-[A-Za-z0-9_-]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /api[_-]?key["'\s:=]+[A-Za-z0-9._-]{12,}/i,
];

function assertNoCredential(value: unknown, where: string, seen = new Set<unknown>()): void {
  if (typeof value === "string") {
    for (const shape of CREDENTIAL_SHAPES) {
      assert.ok(!shape.test(value), `${where} leaked a credential-shaped string: ${JSON.stringify(value.slice(0, 120))}`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredential(entry, `${where}[${index}]`, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertNoCredential(entry, `${where}.${key}`, seen);
  }
}

interface Recorded {
  readonly requests: TeacherHttpRequest[];
}

function fakeTransport(
  responses: readonly (TeacherHttpResponse | Error)[],
): { transport: TeacherTransport; recorded: Recorded } {
  const requests: TeacherHttpRequest[] = [];
  let index = 0;
  const transport: TeacherTransport = async (request) => {
    requests.push(request);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next!;
  };
  return { transport, recorded: { requests } };
}

function completionBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp-test-1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...extra,
  });
}

const noSleep = async (): Promise<void> => {};

// --- 1. Credential presence -------------------------------------------------------------------

test("1. constructing a client with no credential is refused, not defaulted", () => {
  assert.throws(
    () => createTeacherClient({ credentialOptions: { env: {}, configPath: null } }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assert.match(error.message, /VELVET_TEACHER_BASE_URL/);
      assertNoCredential(error.message, "credential-refusal message");
      return true;
    },
  );
});

test("1b. an empty API key is refused rather than sent as an empty bearer", () => {
  assert.throws(
    () => requireTeacherCredentials({
      env: { VELVET_TEACHER_BASE_URL: BASE_URL, VELVET_TEACHER_API_KEY: "   " },
      configPath: null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assert.match(error.message, /API key is empty/);
      return true;
    },
  );
});

// --- 2. Resolution precedence -----------------------------------------------------------------

test("2. env credentials win over the opencode.json convenience fallback", () => {
  const configPath = "/nonexistent/opencode.json";
  const fromEnv = resolveTeacherCredentials({
    env: {
      VELVET_TEACHER_BASE_URL: BASE_URL,
      VELVET_TEACHER_API_KEY: SECRET,
      VELVET_TEACHER_MODEL: "teacher-model-alpha",
    },
    configPath,
  });
  assert.ok(fromEnv);
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.model, "teacher-model-alpha");
  // The resolver necessarily hands the key to the client constructor, so this
  // is NOT one of the surfaces under the credential-discipline rule. What is
  // under the rule is everything the client then PRODUCES, and those are
  // asserted in tests 6, 6b, 6c, 6d, 6e and 6f.
  assert.equal(fromEnv.apiKey, SECRET);
  // A half-configured environment must not silently fall through to the config.
  const partial = resolveTeacherCredentials({
    env: { VELVET_TEACHER_BASE_URL: BASE_URL },
    configPath,
  });
  assert.equal(partial, null, "a base URL without a key must not resolve");
});

test("2b. the documented fallback reads provider.agentrouter when env is absent", () => {
  const config = JSON.stringify({
    provider: {
      agentrouter: {
        options: { baseURL: "http://relay.invalid:8787/v1", apiKey: SECRET },
        models: { "only-model": {} },
      },
    },
  });
  const resolved = resolveTeacherCredentials({
    env: {},
    readFile: () => config,
    configPath: "/virtual/opencode.json",
  });
  assert.ok(resolved, "the fallback should resolve");
  assert.equal(resolved.source, "opencode-config");
  assert.equal(resolved.baseUrl, "http://relay.invalid:8787/v1");
  assert.equal(resolved.model, "only-model");
});

test("2c. a multi-model provider without an explicit model falls back to the documented default", () => {
  const config = JSON.stringify({
    provider: {
      agentrouter: {
        options: { baseURL: "http://relay.invalid:8787/v1", apiKey: SECRET },
        models: { alpha: {}, beta: {}, gamma: {} },
      },
    },
  });
  const resolved = resolveTeacherCredentials({
    env: {},
    readFile: () => config,
    configPath: "/virtual/opencode.json",
  });
  assert.equal(resolved?.model, DEFAULT_TEACHER_MODEL);
});

// --- 3. Retry policy ---------------------------------------------------------------------------

test("3. only 429 and 5xx are retryable; every other 4xx is a permanent refusal", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  for (const status of [400, 401, 403, 404, 409, 418, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} must not be retried`);
  }
});

test("3b. a 400 is attempted exactly once, even with retry budget remaining", async () => {
  const { transport, recorded } = fakeTransport([
    { status: 400, body: JSON.stringify({ error: { message: "bad model" } }) },
  ]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherHttpError);
      assert.equal(error.status, 400);
      assert.equal(error.retried, false);
      assertNoCredential(error.message, "400 error message");
      return true;
    },
  );
  assert.equal(recorded.requests.length, 1, "a 400 must not be retried");
});

test("3c. a 429 is retried within the bounded budget and then succeeds", async () => {
  const { transport, recorded } = fakeTransport([
    { status: 429, body: "slow down", headers: { "retry-after": "0" } },
    { status: 503, body: "unavailable" },
    { status: 200, body: completionBody("eventually") },
  ]);
  const delays: number[] = [];
  const client = createTeacherClient({
    credentials: CREDENTIALS,
    transport,
    sleep: async (ms) => { delays.push(ms); },
  });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(completion.content, "eventually");
  assert.equal(completion.attempts, 3);
  assert.equal(recorded.requests.length, 3);
  assert.ok(delays.length === 2, "backoff should be awaited between attempts");
  assert.equal(delays[0], 0, "an explicit retry-after of 0 is honoured");
});

test("3d. retries are bounded: an always-429 relay exhausts the budget and stops", async () => {
  const { transport, recorded } = fakeTransport([{ status: 429, body: "still throttled" }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({
      attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
      maxAttempts: DEFAULT_TEACHER_MAX_ATTEMPTS,
    }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherHttpError);
      assert.equal(error.retried, true);
      return true;
    },
  );
  assert.equal(recorded.requests.length, DEFAULT_TEACHER_MAX_ATTEMPTS);
});

test("3e. backoff is deterministic and capped, not jittered", () => {
  assert.equal(retryDelayMs(1), 500);
  assert.equal(retryDelayMs(2), 1_000);
  assert.equal(retryDelayMs(3), 2_000);
  assert.ok(retryDelayMs(20) <= 30_000);
  assert.equal(retryDelayMs(1, "7"), 7_000);
});

// --- 4. Timeout -------------------------------------------------------------------------------

test("4. the default timeout matches the relay's long completion budget", () => {
  assert.equal(DEFAULT_TEACHER_TIMEOUT_MS, 660_000);
  const { transport, recorded } = fakeTransport([{ status: 200, body: completionBody("ok") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  void client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] });
  const request = recorded.requests[0]!;
  assert.equal(request.timeoutMs, DEFAULT_TEACHER_TIMEOUT_MS);
  assert.ok(request.timeoutMs > 600_000, "a default under 10 minutes would abort real generations");
});

// --- 5. Usage ----------------------------------------------------------------------------------

test("5. usage is returned per call so budget accounting is possible", async () => {
  const { transport } = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(completion.usage, { promptTokens: 11, completionTokens: 7, totalTokens: 18 });
  assert.equal(completion.finishReason, "stop");
  assert.equal(completion.responseId, "resp-test-1");
});

test("5b. missing usage is reported as null rather than estimated", async () => {
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  });
  const { transport } = fakeTransport([{ status: 200, body }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(completion.usage, null, "an absent usage block must never be invented");
});

test("5c. a truncated completion is visible through finishReason", async () => {
  const body = JSON.stringify({
    id: "r",
    choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "length" }],
  });
  const { transport } = fakeTransport([{ status: 200, body }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(completion.finishReason, "length");
});

// --- 6. Credential discipline --------------------------------------------------------------------

test("6. the credential appears in exactly one place: the outgoing Authorization header", async () => {
  const { transport, recorded } = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(recorded.requests.length, 1);
  assert.equal(recorded.requests[0]!.headers.authorization, `Bearer ${SECRET}`);
  assertNoCredential(completion, "teacher completion");
  assertNoCredential(client.identity, "teacher identity");
  assertNoCredential(client.model, "teacher model");
});

test("6b. identity records a baseUrl digest, never the endpoint", async () => {
  const { transport } = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.match(client.identity.baseUrlDigest, /^[0-9a-f]{64}$/);
  assert.equal(client.identity.baseUrlDigest.length, 64);
  assert.ok(!JSON.stringify(client.identity).includes(BASE_URL), "the endpoint must not be in identity");
  assertNoCredential(client.identity, "teacher identity");
});

test("6c. a relay error body echoing the credential is scrubbed before it becomes a message", async () => {
  const leaky = JSON.stringify({ error: { message: `invalid key ${SECRET} supplied` } });
  const { transport } = fakeTransport([{ status: 401, body: leaky }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherHttpError);
      assert.match(error.message, /\[redacted-credential\]/);
      assertNoCredential(error.message, "401 error message");
      assertNoCredential(error.stack ?? "", "401 error stack");
      return true;
    },
  );
});

test("6d. a transport that throws with the credential in its message is scrubbed", async () => {
  const { transport } = fakeTransport([
    new Error(`connect ECONNREFUSED while sending ${SECRET}`),
  ]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({
      attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }], maxAttempts: 1,
    }),
    (error: unknown) => {
      assertNoCredential(error instanceof Error ? error.message : String(error), "transport error");
      return true;
    },
  );
});

test("6e. an onCall log record is credential-free", async () => {
  const logs: unknown[] = [];
  const { transport } = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const client = createTeacherClient({
    credentials: CREDENTIALS, transport, sleep: noSleep,
    onCall: (log) => logs.push(log),
  });
  await client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(logs.length, 1);
  assertNoCredential(logs, "teacher call log");
});

test("6f. a model that answers with the credential in its content is refused, not returned", async () => {
  const body = completionBody(`the api key is ${SECRET}`);
  const { transport } = fakeTransport([{ status: 200, body }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assertNoCredential(error.message, "content-refusal message");
      return true;
    },
  );
});

// --- Tool calls and model independence ------------------------------------------------------------

test("tool call arguments arrive as objects, parsed exactly once", async () => {
  const body = JSON.stringify({
    id: "r2",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "submit_adventure_narration", arguments: '{"narration":"the tide goes out"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  const { transport } = fakeTransport([{ status: 200, body }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "go" }],
  });
  assert.equal(completion.toolCalls.length, 1);
  const call = completion.toolCalls[0]!;
  assert.equal(call.function.name, "submit_adventure_narration");
  assert.equal(typeof call.function.arguments, "object", "HF requires object arguments, never a JSON string");
  assert.equal(call.function.arguments.narration, "the tide goes out");
});

test("a reviewer model that is the generator is refused, not tolerated", () => {
  assert.throws(
    () => assertDistinctModels("deepseek-v4-flash", "deepseek-v4-flash"),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assert.match(error.message, /not independent/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertDistinctModels("deepseek-v4-flash", "glm-5.3"));
});

test("requireReviewerCredentials picks a model that is not the generator", () => {
  const config = JSON.stringify({
    provider: {
      agentrouter: {
        options: { baseURL: BASE_URL, apiKey: SECRET },
        models: { alpha: {}, "deepseek-v4-flash": {}, gamma: {} },
      },
    },
  });
  const reviewer = requireReviewerCredentials("deepseek-v4-flash", {
    env: {},
    readFile: () => config,
    configPath: "/virtual/opencode.json",
  });
  assert.notEqual(reviewer.model, "deepseek-v4-flash");
  assert.ok(["alpha", "gamma"].includes(reviewer.model));
});

test("requireReviewerCredentials refuses when no distinct model exists", () => {
  const config = JSON.stringify({
    provider: {
      agentrouter: {
        options: { baseURL: BASE_URL, apiKey: SECRET },
        models: { "deepseek-v4-flash": {} },
      },
    },
  });
  assert.throws(
    () => requireReviewerCredentials("deepseek-v4-flash", {
      env: {}, readFile: () => config, configPath: "/virtual/opencode.json",
    }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assert.match(error.message, /different from the generator/);
      return true;
    },
  );
});

test("credential resolution reads process.env by default", () => {
  const names = ["VELVET_TEACHER_BASE_URL", "VELVET_TEACHER_API_KEY", "VELVET_TEACHER_MODEL"] as const;
  const previous = names.map((name) => process.env[name]);
  try {
    process.env.VELVET_TEACHER_BASE_URL = BASE_URL;
    process.env.VELVET_TEACHER_API_KEY = SECRET;
    process.env.VELVET_TEACHER_MODEL = "environment-teacher";
    const resolved = resolveTeacherCredentials({ configPath: null });
    assert.equal(resolved?.source, "env");
    assert.equal(resolved?.model, "environment-teacher");
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test("a partial environment refuses instead of silently switching to a configured route", () => {
  const config = JSON.stringify({ provider: { agentrouter: {
    options: { baseURL: BASE_URL, apiKey: SECRET }, models: { other: {} },
  } } });
  assert.equal(resolveTeacherCredentials({
    env: { VELVET_TEACHER_BASE_URL: "http://other.invalid/v1" },
    readFile: () => config, configPath: "/virtual/config.json",
  }), null);
});

test("reviewer fallback excludes the actual generator even when credential defaults differ", () => {
  const config = JSON.stringify({ provider: { agentrouter: {
    options: { baseURL: BASE_URL, apiKey: SECRET }, models: { alpha: {}, gamma: {} },
  } } });
  const reviewer = requireReviewerCredentials("alpha", {
    env: {}, readFile: () => config, configPath: "/virtual/config.json",
  });
  assert.equal(reviewer.model, "gamma");
});

test("explicit self-review and routing aliases refuse rather than selecting a fallback", () => {
  for (const model of ["teacher", "auto", "best"]) {
    assert.throws(() => requireReviewerCredentials("teacher", {
      env: { VELVET_TEACHER_BASE_URL: BASE_URL, VELVET_TEACHER_API_KEY: SECRET,
        VELVET_REVIEWER_MODEL: model }, configPath: null,
    }), TeacherCredentialError);
  }
});
