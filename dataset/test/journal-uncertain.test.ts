/**
 * Durable dispatch evidence for `dataset/src/pipelineJournal.ts` and the real
 * teacher client behind it (audit F3/F4).
 *
 * NO TEST IN THIS FILE MAY REACH A LIVE RELAY. Every dispatch goes through an
 * injected transport; a `fetch` that escapes is a test that spends money.
 *
 * The properties pinned here are the ones a paid request cannot recover from:
 *
 *  1. An uncertain physical request is NEVER repeated, inside one call or across
 *     two invocations of the journal.
 *  2. A returned-but-unusable response is REPLAYED from its durable bytes, not
 *     re-requested: "the provider answered badly" and "the provider never
 *     answered" are different facts with different safe responses.
 *  3. An explicit server refusal is repeatable, because the server said no.
 *  4. The lease is held for the whole call, and losing it mid-flight stops the
 *     owner from publishing or spending again.
 *  5. Retained evidence never contains a credential.
 *
 * Run: npm run test:foundry   (tsx --test --test-concurrency=1)
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { PipelineJournal, UncertainDispatchError } from "../src/pipelineJournal.js";
import { RunLockError, openRunStore, type RunStore } from "../src/runstore.js";
import {
  TeacherHttpError,
  TeacherResponseError,
  TeacherUncertainDispatchError,
  createTeacherClient,
  type TeacherClient,
  type TeacherCompletionRequest,
  type TeacherHttpResponse,
  type TeacherTransport,
} from "../src/teacher.js";

const SECRET = "sk-vlt-journal-4c81da0b77e2secret";
const CREDENTIALS = {
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: SECRET,
  model: "journal-teacher",
  providerId: "agentrouter",
  source: "env" as const,
};

const ROOT: string = mkdtempSync("/tmp/opencode/foundry-journal-");
after(() => { rmSync(ROOT, { recursive: true, force: true }); });

let caseCounter = 0;
function caseRoot(): string {
  caseCounter += 1;
  return join(ROOT, `case-${caseCounter}`);
}

function openStore(artifactRoot: string, overrides: Record<string, unknown> = {}): RunStore {
  return openRunStore({
    runId: "journal", seed: "seed-1", sourceDigest: "source-digest",
    splitAssignmentDigest: "split-digest", corpusFreezeDigest: "freeze-digest",
    artifactRoot, gitCommit: null, durability: "flush",
    ...overrides,
  } as Parameters<typeof openRunStore>[0]);
}

function completionBody(content: string): string {
  return JSON.stringify({
    id: "resp-journal-1",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
}

interface Harness {
  readonly client: TeacherClient;
  readonly requests: number;
}

/** A client whose transport records every PHYSICAL request it is given. */
function harness(
  behaviour: (attempt: number) => TeacherHttpResponse | Error | Promise<TeacherHttpResponse>,
  options: { maxAttempts?: number } = {},
): Harness {
  const state = { requests: 0 };
  const transport: TeacherTransport = async () => {
    state.requests += 1;
    const next = await behaviour(state.requests);
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createTeacherClient({ credentials: CREDENTIALS, transport, sleep: async () => {} });
  const wrapped: TeacherClient = {
    ...client,
    complete: (request: TeacherCompletionRequest) =>
      client.complete({ ...request, maxAttempts: options.maxAttempts ?? request.maxAttempts }),
  };
  return { client: wrapped, get requests() { return state.requests; } };
}

const REQUEST = { attemptId: "attempt-1", system: "fixture", messages: [{ role: "user" as const, content: "hi" }] };

/** Counts lease renewals so a heartbeat can be observed rather than assumed. */
function counted(store: RunStore): { store: RunStore; renewals: () => number } {
  let renewals = 0;
  const proxy = Object.create(store) as RunStore;
  proxy.renewLease = (): void => { renewals += 1; store.renewLease(); };
  return { store: proxy, renewals: () => renewals };
}

describe("F4: an uncertain physical request is never repeated", () => {
  for (const status of [400, 503]) test(`captured HTTP ${status} is not resent on resume`, async () => {
    const root = caseRoot();
    const store = openStore(root);
    const first = harness(() => ({ status, body: "upstream response" }));
    const journal = new PipelineJournal(store, { version: "http-outcome" });
    await assert.rejects(() => journal.complete(first.client, REQUEST), status === 503 ? TeacherUncertainDispatchError : TeacherHttpError);
    assert.equal(first.requests, 1);
    store.close();
    const resumed = openStore(root);
    const next = harness(() => ({ status: 200, body: completionBody("must not request") }));
    await assert.rejects(() => new PipelineJournal(resumed, { version: "http-outcome" }).complete(next.client, REQUEST),
      status === 503 ? UncertainDispatchError : TeacherHttpError);
    assert.equal(next.requests, 0);
    resumed.close();
  });
  test("a lost response is journalled as uncertain and blocks the resume", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => new Error("connection reset after the provider accepted the request"));
    const journal = new PipelineJournal(store, { version: "uncertain-test" });

    await assert.rejects(() => journal.complete(provider.client, REQUEST), (error: unknown) => {
      assert.ok(error instanceof TeacherUncertainDispatchError, "the caller is told the outcome is unknown");
      assert.equal(error.requestNumber, 1);
      return true;
    });
    assert.equal(provider.requests, 1, "the client did not repeat the request inside one call");
    assert.equal(journal.physicalRequestCount("attempt-1"), 1, "the physical dispatch is durable");
    assert.equal(journal.lastOutcome("attempt-1")?.kind, "uncertain");
    assert.equal(journal.hasResponse("attempt-1"), false);
    store.close();

    // Resume: the request is NOT sent again, not even with a fresh client.
    const resumed = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("a second bill") }));
    const resumedJournal = new PipelineJournal(resumed, { version: "uncertain-test" });
    await assert.rejects(() => resumedJournal.complete(second.client, REQUEST), (error: unknown) => {
      assert.ok(error instanceof UncertainDispatchError);
      assert.match(error.message, /connection reset after the provider accepted the request/);
      return true;
    });
    assert.equal(second.requests, 0, "resume must not buy the same completion twice");
    resumed.close();
  });

  test("a returned-but-unusable body is replayed, never re-requested", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 200, body: "{ this is not json" }));
    const journal = new PipelineJournal(store, { version: "malformed-test" });

    await assert.rejects(() => journal.complete(provider.client, REQUEST), (error: unknown) => {
      assert.ok(error instanceof TeacherResponseError);
      return true;
    });
    assert.equal(provider.requests, 1);
    assert.equal(journal.lastOutcome("attempt-1")?.kind, "response");
    assert.equal(journal.lastOutcome("attempt-1")?.body, "{ this is not json", "the exact bytes are retained");
    store.close();

    const resumed = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("a second bill") }));
    const resumedJournal = new PipelineJournal(resumed, { version: "malformed-test" });
    await assert.rejects(() => resumedJournal.complete(second.client, REQUEST), (error: unknown) => {
      // The identical failure, reproduced from durable bytes with no network.
      assert.ok(error instanceof TeacherResponseError);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
    assert.equal(second.requests, 0, "a provider that ANSWERED is never asked again");
    resumed.close();
  });

  test("a usable response is reused from the journal without a request", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 200, body: completionBody("the one true completion") }));
    const journal = new PipelineJournal(store, { version: "reuse-test" });

    const first = await journal.complete(provider.client, REQUEST);
    store.close();

    const resumed = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("a second bill") }));
    const resumedJournal = new PipelineJournal(resumed, { version: "reuse-test" });
    const replayed = await resumedJournal.complete(second.client, REQUEST);
    assert.equal(replayed.content, first.content);
    assert.equal(replayed.requestDigest, first.requestDigest);
    assert.equal(second.requests, 0);
    resumed.close();
  });

  test("an explicit server refusal is repeatable, and its evidence is durable", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 429, body: "slow down", headers: { "retry-after": "0" } }), { maxAttempts: 1 });
    const journal = new PipelineJournal(store, { version: "rejection-test" });

    await assert.rejects(() => journal.complete(provider.client, REQUEST), TeacherHttpError);
    assert.equal(provider.requests, 1);
    assert.equal(journal.lastOutcome("attempt-1")?.kind, "rejection");
    assert.equal(journal.lastOutcome("attempt-1")?.status, 429);
    store.close();

    // The relay said "not now", so a later invocation may legitimately ask again.
    const resumed = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("accepted later") }));
    const resumedJournal = new PipelineJournal(resumed, { version: "rejection-test" });
    const completion = await resumedJournal.complete(second.client, REQUEST);
    assert.equal(completion.content, "accepted later");
    assert.equal(second.requests, 1, "an explicit refusal is safe to repeat");
    assert.equal(resumedJournal.physicalRequestCount("attempt-1"), 2, "each physical request keeps its own evidence");
    resumed.close();
  });

  test("retired evidence never contains a credential", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 400, body: `upstream rejected ${SECRET}` }), { maxAttempts: 1 });
    const journal = new PipelineJournal(store, { version: "credential-test" });

    await assert.rejects(() => journal.complete(provider.client, REQUEST), TeacherHttpError);
    for (const name of readdirSync(join(artifactRoot, "runs", "journal", "pipeline"))) {
      const text = readFileSync(join(artifactRoot, "runs", "journal", "pipeline", name), "utf8");
      assert.equal(text.includes(SECRET), false, `${name} retained a credential`);
    }
    store.close();
  });
});

describe("F3/F4: the lease is held for the whole call", () => {
  test("an outstanding dispatch heartbeats the lease and stops on completion", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const instrumented = counted(store);
    const provider = harness(() => new Promise<TeacherHttpResponse>((resolve) => {
      setTimeout(() => resolve({ status: 200, body: completionBody("slow but certain") }), 60);
    }));
    const journal = new PipelineJournal(instrumented.store, { version: "heartbeat-test" }, { heartbeatMs: 10 });

    const before = instrumented.renewals();
    const completion = await journal.complete(provider.client, REQUEST);
    assert.equal(completion.content, "slow but certain");
    assert.ok(instrumented.renewals() > before + 1, "the lease was renewed while the request was outstanding");

    const afterCompletion = instrumented.renewals();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(instrumented.renewals(), afterCompletion, "the heartbeat is cleared once the call returns");
    store.close();
  });

  test("an owner that loses its lease mid-call publishes nothing and never retries", async () => {
    const artifactRoot = caseRoot();
    const paths = { lockPath: join(artifactRoot, "runs", "journal", "writer.lock") };
    const store = openStore(artifactRoot);
    let replacement: RunStore | null = null;
    const provider = harness(() => new Promise<TeacherHttpResponse>((resolve) => {
      // A replacement owner takes the run while this call is in flight, exactly
      // as a stale takeover would.
      rmSync(paths.lockPath, { force: true });
      replacement = openStore(artifactRoot);
      setTimeout(() => resolve({ status: 200, body: completionBody("too late to publish") }), 30);
    }));
    const journal = new PipelineJournal(store, { version: "lost-owner-test" });

    await assert.rejects(() => journal.complete(provider.client, REQUEST), (error: unknown) => {
      assert.ok(error instanceof RunLockError, "a replaced owner is stopped by the ownership check");
      return true;
    });
    assert.equal(provider.requests, 1, "the lost owner did not start another physical request");
    assert.equal(journal.hasResponse("attempt-1"), false, "nothing was published into the replacement's run");
    assert.equal(journal.physicalRequestCount("attempt-1"), 1, "its physical evidence is still durable");

    // The replacement can see exactly what happened, and will not resend it.
    replacement!.close();
    const next = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("a second bill") }));
    const nextJournal = new PipelineJournal(next, { version: "lost-owner-test" });
    await assert.rejects(() => nextJournal.complete(second.client, REQUEST), (error: unknown) => {
      assert.ok(error instanceof UncertainDispatchError);
      return true;
    });
    assert.equal(second.requests, 0);
    store.close();
    next.close();
  });

  test("a crash between the dispatch marker and the socket still blocks a resume", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 200, body: completionBody("never reached") }));
    const journal = new PipelineJournal(store, { version: "crash-before-socket-test" });

    await assert.rejects(
      () => journal.complete(provider.client, REQUEST, () => {
        throw new Error("crash between the dispatch marker and the network call");
      }),
      /crash between the dispatch marker/,
    );
    assert.equal(provider.requests, 0);
    store.close();

    const resumed = openStore(artifactRoot);
    const second = harness(() => ({ status: 200, body: completionBody("a second bill") }));
    const resumedJournal = new PipelineJournal(resumed, { version: "crash-before-socket-test" });
    await assert.rejects(() => resumedJournal.complete(second.client, REQUEST), UncertainDispatchError);
    assert.equal(second.requests, 0);
    resumed.close();
  });

  test("a changed request identity is refused before anything is sent", async () => {
    const artifactRoot = caseRoot();
    const store = openStore(artifactRoot);
    const provider = harness(() => ({ status: 200, body: completionBody("one") }));
    const journal = new PipelineJournal(store, { version: "identity-test" });
    await journal.complete(provider.client, REQUEST);
    await assert.rejects(
      () => journal.complete(provider.client, { ...REQUEST, system: "different system prompt" }),
      /dispatch request\/identity drift/,
    );
    assert.equal(provider.requests, 1);
    store.close();
  });
});
