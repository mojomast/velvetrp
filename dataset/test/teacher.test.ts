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
  TeacherResponseError,
  TeacherTimeoutError,
  TeacherUncertainDispatchError,
  assertDistinctModels,
  createTeacherClient,
  isRetryableStatus,
  replayCapturedTeacherResponse,
  requireReviewerCredentials,
  requireTeacherCredentials,
  resolveTeacherCredentials,
  retryDelayMs,
  sha256Hex,
  type ResolvedTeacherCredentials,
  type TeacherDispatchObservation,
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

test("explicit thinking/reasoning modes are sent upstream, digest-bound and kept out of assistant targets", async () => {
  const raw = completionBody("Final answer only.", { choices: [{ message: { role: "assistant", content: "Final answer only.", reasoning_content: "fixture private reasoning" }, finish_reason: "stop" }] });
  const { transport, recorded } = fakeTransport([{ status: 200, body: raw }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const request = { attemptId: "inference-mode", system: "fixture", messages: [] };
  const ordinary = await client.complete(request);
  const flash = await client.complete({ ...request, thinking: "disabled", temperature: 0.7, maxTokens: 2048 });
  const kimi = await client.complete({ ...request, reasoningEffort: "low", maxTokens: 4096 });
  const flashBody = JSON.parse(recorded.requests[1]!.body);
  const kimiBody = JSON.parse(recorded.requests[2]!.body);
  assert.deepEqual(flashBody.thinking, { type: "disabled" });
  assert.equal(kimiBody.reasoning_effort, "low");
  assert.equal(Object.hasOwn(kimiBody, "temperature"), false);
  assert.equal(kimiBody.max_tokens, 4096);
  assert.notEqual(flash.requestDigest, ordinary.requestDigest);
  assert.notEqual(kimi.requestDigest, ordinary.requestDigest);
  assert.equal(flash.content, "Final answer only.");
  assert.doesNotMatch(JSON.stringify(flash), /fixture private reasoning/);
});

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

test("3. only explicit rate limiting is retryable without provider idempotency", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), false);
  assert.equal(isRetryableStatus(503), false);
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
    { status: 429, body: "still rate limited" },
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

test("4. the default timeout matches the relay's long completion budget", async () => {
  assert.equal(DEFAULT_TEACHER_TIMEOUT_MS, 660_000);
  const { transport, recorded } = fakeTransport([{ status: 200, body: completionBody("ok") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] });
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

// --- 7. Uncertain dispatch is never repeated (F4) ---------------------------------------------------

test("7a. a lost response after submission is UNCERTAIN and is sent exactly once", async () => {
  // The relay accepted and billed the request, then the connection died. A second
  // POST would be a second bill for a completion this run already owns.
  const { transport, recorded } = fakeTransport([
    new Error("socket hang up after the provider accepted the request"),
    { status: 200, body: completionBody("second copy the run must not buy") },
  ]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] }),
    (error: unknown) => {
      assert.ok(error instanceof TeacherUncertainDispatchError);
      assert.equal(error.attemptId, "a1");
      assert.equal(error.requestNumber, 1);
      assert.equal(error.idempotent, false);
      assert.match(error.message, /will not be resent automatically/);
      assertNoCredential(error.message, "uncertain-dispatch message");
      return true;
    },
  );
  assert.equal(recorded.requests.length, 1, "an uncertain dispatch must not be repeated inside one call");
});

test("7b. a timeout is an unknown outcome, not a failure to retry", async () => {
  const { transport, recorded } = fakeTransport([new TeacherTimeoutError(660_000)]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({ attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }] }),
    TeacherUncertainDispatchError,
  );
  assert.equal(recorded.requests.length, 1);
});

test("7c. an explicit 429 rate limit rejection is repeatable", async () => {
  const { transport, recorded } = fakeTransport([
    { status: 429, body: "not accepted" },
    { status: 200, body: completionBody("accepted on the second try") },
  ]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(completion.content, "accepted on the second try");
  assert.equal(recorded.requests.length, 2, "a refusal that the server stated is safe to repeat");
});

test("7d. repeats are only allowed under an explicit, verified idempotency contract", async () => {
  const { transport, recorded } = fakeTransport([
    new Error("connection reset after acceptance"),
    { status: 200, body: completionBody("deduplicated replay") },
  ]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  const completion = await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
    idempotencyKey: "velvet-attempt-a1",
  });
  assert.equal(completion.content, "deduplicated replay");
  assert.equal(recorded.requests.length, 2);
  assert.equal(recorded.requests[0]!.headers["idempotency-key"], "velvet-attempt-a1");
});

test("7e. the idempotency contract joins the request digest; the observer does not", async () => {
  const plain = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const observed = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const a = createTeacherClient({ credentials: CREDENTIALS, transport: plain.transport, sleep: noSleep });
  const b = createTeacherClient({ credentials: CREDENTIALS, transport: observed.transport, sleep: noSleep });
  const request = { attemptId: "a1", system: "s", messages: [{ role: "user" as const, content: "hi" }] };
  const withoutObserver = await a.complete(request);
  const withObserver = await b.complete({ ...request, observer: () => {} });
  assert.equal(
    withoutObserver.requestDigest,
    withObserver.requestDigest,
    "a runtime-only observer must never change request identity",
  );
  assert.deepEqual(plain.recorded.requests[0]!.headers, observed.recorded.requests[0]!.headers);

  const keyed = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const c = createTeacherClient({ credentials: CREDENTIALS, transport: keyed.transport, sleep: noSleep });
  const withKey = await c.complete({ ...request, idempotencyKey: "k1" });
  assert.notEqual(withoutObserver.requestDigest, withKey.requestDigest,
    "changing the idempotency contract changes what a repeat of this attempt means");
});

// --- 8. Durable evidence for every physical request (F4) -------------------------------------------

test("8a. the observer sees each physical request before the socket and the raw body before parsing", async () => {
  const body = completionBody("evidence please");
  const { transport } = fakeTransport([{ status: 200, body }]);
  const seen: TeacherDispatchObservation[] = [];
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
    observer: (observation) => { seen.push(observation); },
  });
  assert.deepEqual(seen.map((entry) => entry.phase), ["before-send", "response"]);
  assert.equal(seen[0]!.requestNumber, 1);
  assert.equal(seen[1]!.status, 200);
  assert.equal(seen[1]!.body, body, "the returned bytes are captured verbatim");
  assert.equal(seen[1]!.bodyDigest, sha256Hex(body), "the digest is over the bytes as returned");
  assert.match(seen[1]!.requestDigest, /^[0-9a-f]{64}$/, "evidence names the logical request it carried");
  assert.equal(seen[1]!.retryable, false);
  assertNoCredential(seen, "physical-request evidence");
});

test("8b. a malformed 200 is durable evidence, not a lost response", async () => {
  const { transport, recorded } = fakeTransport([{ status: 200, body: "{not json" }]);
  const seen: TeacherDispatchObservation[] = [];
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({
      attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
      observer: (observation) => { seen.push(observation); },
    }),
    TeacherResponseError,
  );
  assert.equal(recorded.requests.length, 1, "an unusable answer is not a reason to ask again");
  assert.deepEqual(seen.map((entry) => entry.phase), ["before-send", "response"]);
  assert.equal(seen[1]!.body, "{not json", "the unusable bytes are retained for replay");
});

test("8c. an uncertain transport outcome is reported as uncertain, with no body", async () => {
  const { transport } = fakeTransport([new TeacherTimeoutError(660_000)]);
  const seen: TeacherDispatchObservation[] = [];
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(() => client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
    observer: (observation) => { seen.push(observation); },
  }), TeacherUncertainDispatchError);
  const last = seen[seen.length - 1]!;
  assert.equal(last.phase, "uncertain");
  assert.equal(last.body, null);
  assert.equal(last.status, null);
  assert.equal(last.retryable, false);
});

test("8d. an observer that throws stops the call BEFORE the socket opens", async () => {
  const { transport, recorded } = fakeTransport([{ status: 200, body: completionBody("hi") }]);
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(
    () => client.complete({
      attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }],
      observer: () => { throw new Error("the run lost its lease"); },
    }),
    /the run lost its lease/,
  );
  assert.equal(recorded.requests.length, 0, "an expired owner must not open a socket it cannot account for");
});

test("8e. evidence handed to an observer never carries the credential", async () => {
  const { transport } = fakeTransport([{ status: 500, body: `upstream rejected ${SECRET}` }]);
  const seen: TeacherDispatchObservation[] = [];
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: noSleep });
  await assert.rejects(() => client.complete({
    attemptId: "a1", system: "s", messages: [{ role: "user", content: "hi" }], maxAttempts: 1,
    observer: (observation) => { seen.push(observation); },
  }), TeacherUncertainDispatchError);
  assertNoCredential(seen, "rejection evidence");
  assert.match(seen[1]!.body ?? "", /redacted-credential/);
});

test("8f. a captured response replays without a second request", () => {
  const body = completionBody("replayed, not resent");
  const completion = replayCapturedTeacherResponse(
    { body, bodyDigest: sha256Hex(body) },
    { attemptId: "a1", requestNumber: 1, requestDigest: "d".repeat(64) },
  );
  assert.equal(completion.content, "replayed, not resent");
  assert.equal(completion.requestDigest, "d".repeat(64));
});

test("8g. a redacted capture is refused rather than replayed as fabricated data", () => {
  const body = `the api key is ${SECRET}`;
  const completionBodyText = JSON.stringify({
    id: "r9",
    choices: [{ message: { role: "assistant", content: body }, finish_reason: "stop" }],
  });
  assert.throws(
    () => replayCapturedTeacherResponse(
      { body: completionBodyText, bodyDigest: sha256Hex(body) },
      { attemptId: "a1", requestNumber: 1, requestDigest: "e".repeat(64) },
    ),
    (error: unknown) => {
      assert.ok(error instanceof TeacherCredentialError);
      assertNoCredential(error.message, "redacted-replay refusal");
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
