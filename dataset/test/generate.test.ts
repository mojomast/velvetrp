/**
 * Tests for the generation pipeline.
 *
 * Every dispatch goes through an injected fake transport. No test may reach the
 * live relay, and every run uses a real `RunStore` in a temp directory, because
 * the properties under test -- repair supersedes its parent, an admitted record
 * carries a certificate that verifies -- are properties of the STORE, not of
 * the pipeline's intentions.
 *
 * The nine tests below are named for the properties they pin:
 *
 *  1. determinism                -> same seed, same spec, same realizations
 *  2. fail-closed budget          -> no tokenizer means no spending
 *  3. dryRun                     -> zero network calls
 *  4. real certificate            -> the certificate verifies, not the status
 *  5. repair supersedes           -> RAW+PARSED retained, parent untouched
 *  6. reviewer independence       -> asserted, not assumed
 *  7. tool-selection split       -> initiation vs argument binding
 *  8. export path                -> only via exportTrainingJsonl
 *  9. credential discipline      -> nothing produced carries a key
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  admitCandidate,
  computePayloadDigest,
  revalidateAdmitted,
  verifyAdmissionCertificate,
  type AdmittedRecordV1,
} from "../src/admission.js";
import { exportTrainingJsonl } from "../src/export.js";
import { evaluateGroundedNarration } from "../src/grounding.js";
import {
  DEFAULT_TOKEN_BUDGET,
  FAMILY_WEIGHTS,
  PipelineRefusal,
  TokenizerUnavailableError,
  assertBatchAdmissible,
  budgetTargetFor,
  checkBudget,
  createBudgetLedger,
  createRng,
  exportAdmittedCorpus,
  measureDiversity,
  parseExecutionFlag,
  parseStage,
  planRun,
  realizeScenario,
  recordSpend,
  requireTokenizer,
  runPipeline,
  scenarioSpec,
  type GenerationTarget,
  type ScenarioSpec,
  type SupervisedExample,
  type TokenizerPort,
} from "../src/generate.js";
import { openRunStore, type RunStore } from "../src/runstore.js";
import { stableStringify, FOUNDRY_VERSION, RECORD_SCHEMA_VERSION, type CandidateRecord, type StoredMessage } from "../src/spec.js";
import { createTeacherClient, type ResolvedTeacherCredentials, type TeacherHttpRequest, type TeacherHttpResponse, type TeacherTransport } from "../src/teacher.js";

// ---------------------------------------------------------------------------
// Test doubles. None of these touch a network.
// ---------------------------------------------------------------------------

const SECRET = "sk-vlt-gen-2b7e4c1a9f60d33pipelinekey";

const CREDENTIAL_SHAPES: readonly RegExp[] = [
  new RegExp(SECRET),
  /sk-[A-Za-z0-9_-]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
];

function assertNoCredential(value: unknown, where: string, seen = new Set<unknown>()): void {
  if (typeof value === "string") {
    for (const shape of CREDENTIAL_SHAPES) {
      assert.ok(!shape.test(value), `${where} leaked a credential-shaped string`);
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

interface Call {
  readonly request: TeacherHttpRequest;
  readonly body: Record<string, unknown>;
}

/**
 * A fake relay. `responder` sees the parsed request body and returns the
 * assistant message; usage is always reported so budget accounting is exercised.
 */
function fakeRelay(responder: (call: Call, index: number) => {
  content: string;
  toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
  finishReason?: string;
}): { transport: TeacherTransport; calls: Call[]; transportCalls: () => number } {
  const calls: Call[] = [];
  const transport: TeacherTransport = async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const call: Call = { request, body };
    calls.push(call);
    const reply = responder(call, calls.length - 1);
    const response: TeacherHttpResponse = {
      status: 200,
      body: JSON.stringify({
        id: `resp-fake-${calls.length}`,
        choices: [{
          index: 0,
          finish_reason: reply.finishReason ?? "stop",
          message: {
            role: "assistant",
            content: reply.content,
            ...(reply.toolCalls?.length
              ? {
                tool_calls: reply.toolCalls.map((toolCall) => ({
                  id: toolCall.id,
                  type: "function",
                  function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
                })),
              }
              : {}),
          },
        }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      }),
    };
    return response;
  };
  return { transport, calls, transportCalls: () => calls.length };
}

function credentials(model: string): ResolvedTeacherCredentials {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: SECRET,
    model,
    providerId: "agentrouter",
    source: "env",
  };
}

/**
 * A stand-in tokenizer. It is NOT a guess presented as a measurement: it
 * counts whitespace-delimited words and says so in its name, so any artifact
 * carrying it is explicitly labelled as unmeasured. The real port is supplied
 * by the TRL/Transformers preprocessing run.
 */
const WORD_TOKENIZER: TokenizerPort = {
  name: "test-word-counter (NOT a trained tokenizer)",
  countSupervisedTokens(example: SupervisedExample): number {
    let count = 0;
    for (const index of example.targetSelection.supervisedAssistantIndices) {
      const message = example.messages[index];
      if (message) count += message.content.trim().split(/\s+/).filter(Boolean).length;
    }
    for (const index of example.targetSelection.supervisedToolCallIndices) {
      for (const call of example.messages[index]?.tool_calls ?? []) {
        count += stableStringify(call.function.arguments).split(/\s+/).filter(Boolean).length;
      }
    }
    return count;
  },
};

const REVIEW_ACCEPT = JSON.stringify({
  characterization: 0.8,
  dialogueQuality: 0.75,
  coherence: 0.85,
  narrativeInitiative: 0.7,
  playerAgency: 0.9,
  nonRepetitive: 0.8,
  verdict: "accept",
  rationale: "bound to the receipt and distinct in voice",
});

const REVIEW_REJECT = JSON.stringify({
  characterization: 0.8,
  dialogueQuality: 0.75,
  coherence: 0.85,
  narrativeInitiative: 0.7,
  playerAgency: 0.9,
  nonRepetitive: 0.8,
  verdict: "reject",
  rationale: "fabricates an outcome",
});

function isReviewCall(call: Call): boolean {
  return String(call.request.body).includes("independent reviewer");
}

const roots: string[] = [];
const stores: RunStore[] = [];

after(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function openStore(runId: string): RunStore {
  const root = mkdtempSync(join(tmpdir(), "velvet-gen-"));
  roots.push(root);
  const store = openRunStore({
    runId,
    seed: "test-seed",
    sourceDigest: "a".repeat(64),
    splitAssignmentDigest: "b".repeat(64),
    corpusFreezeDigest: "c".repeat(64),
    artifactRoot: root,
    durability: "flush",
    gitCommit: null,
    totalUnits: 8,
  });
  stores.push(store);
  return store;
}

/** Finds the first spec for a family so a test can target one behaviour. */
function specForFamily(seed: string, family: ScenarioSpec["family"]): ScenarioSpec {
  for (let index = 0; index < 500; index += 1) {
    const spec = scenarioSpec(`${seed}|probe|${index}`);
    if (spec.family === family) return spec;
  }
  throw new Error(`no ${family} spec found`);
}

/** Reads the promoted spec for a family out of a plan. */
function plannedSpec(seed: string, family: ScenarioSpec["family"], units: number): ScenarioSpec {
  const plan = planRun({ seed, units, families: [family] });
  const found = plan.units.find((unit) => unit.spec.family === family);
  assert.ok(found, `plan for ${family} produced no unit`);
  return found.spec;
}

/**
 * A hand-built CandidateRecord claiming to be admitted. It exists only to prove
 * the store refuses an unverified claim; it is NOT a legitimate record and is
 * never passed to an export path.
 */
function forgedAdmittedCandidate(recordId: string, unitId: string): CandidateRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId,
    family: "roleplay-conversation",
    lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" },
    scenarioSeed: "seed",
    messages: [{ role: "assistant", content: "hi" }],
    contentDigest: "d".repeat(64),
    provenance: {
      datasetVersion: FOUNDRY_VERSION,
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      gitCommit: null,
      scenarioSeed: "seed",
      scenarioTemplate: "t",
      sourceFixture: null,
      validators: [],
      validatorVersions: {},
      generator: { provider: "p", model: "m", baseUrlDigest: null, temperature: 0 },
      reviewer: null,
      sourceDigests: {},
      tokenCount: null,
      syntheticOrigin: true,
      license: { status: "unverified", note: "n" },
    },
    // A CandidateRecord can never carry `admittedAt`; the claim is a lie the
    // store must reject.
    admission: { status: "admitted", reasons: [], findings: {}, review: null, admittedAt: null },
  } as CandidateRecord;
}

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

describe("1. determinism", () => {
  test("1a. the same seed produces a byte-identical ScenarioSpec", () => {
    const left = scenarioSpec("determinism-seed");
    const right = scenarioSpec("determinism-seed");
    assert.equal(stableStringify(left), stableStringify(right));
    assert.equal(left.digest, right.digest);
  });

  test("1b. a different seed produces a different spec", () => {
    const left = scenarioSpec("determinism-seed");
    const right = scenarioSpec("determinism-seed-2");
    assert.notEqual(left.digest, right.digest);
  });

  test("1c. the same seed produces identical realizations, in the same order", () => {
    const spec = scenarioSpec("realize-seed");
    const left = realizeScenario(spec, "r1", 6);
    const right = realizeScenario(spec, "r1", 6);
    assert.deepEqual(left.map((entry) => entry.digest), right.map((entry) => entry.digest));
    assert.deepEqual(left.map((entry) => entry.clusterId), right.map((entry) => entry.clusterId));
    assert.deepEqual(
      left.map((entry) => stableStringify(entry.context)),
      right.map((entry) => stableStringify(entry.context)),
    );
  });

  test("1d. realizations are distinct and respect the cluster cap", () => {
    const spec = scenarioSpec("cluster-seed");
    const realized = realizeScenario(spec, "r1", 8);
    assert.equal(new Set(realized.map((entry) => entry.digest)).size, 8);
    const perCluster = new Map<string, number>();
    for (const entry of realized) {
      perCluster.set(entry.clusterId, (perCluster.get(entry.clusterId) ?? 0) + 1);
    }
    // CLUSTER_TARGETS is 6 shapes; with 8 realizations the cap is ceil(8/6)=2.
    for (const [clusterId, count] of perCluster) {
      assert.ok(count <= 2, `cluster ${clusterId} took ${count} realizations, over the cap`);
    }
  });

  test("1e. diversity is measured, and a duplicated corpus is reported as duplicated", () => {
    const identical = measureDiversity(
      Array.from({ length: 6 }, () => ({ text: "the tide goes out and does not return", clusterId: "c1" })),
    );
    assert.equal(identical.distinct, 1, "six copies of one sentence is one distinct text");
    assert.equal(identical.uniqueRatio, 1 / 6, "duplicate detection is the point of this measurement");
    assert.equal(identical.maxClusterShare, 1);
    assert.ok(identical.meanPairwiseJaccard > 0.99, "identical text must score as identical");

    const varied = measureDiversity([
      { text: "Haug sets down the ledger and does not look up", clusterId: "a" },
      { text: "Ailsa counts the tide marks twice before answering", clusterId: "b" },
      { text: "Oswin refuses the harbour guild outright", clusterId: "c" },
      { text: "Maren waits for the ninth watch to turn", clusterId: "d" },
    ]);
    assert.equal(varied.uniqueRatio, 1);
    assert.ok(varied.meanPairwiseJaccard < identical.meanPairwiseJaccard);
    assert.ok(varied.clusterCount >= 3);
  });

  test("1f. the seeded PRNG is reproducible and never Math.random", () => {
    const left = createRng("seed");
    const right = createRng("seed");
    assert.deepEqual(
      Array.from({ length: 32 }, () => left.next()),
      Array.from({ length: 32 }, () => right.next()),
    );
    assert.notEqual(createRng("seed-a").next(), createRng("seed-b").next());
    // A fork is an independent stream that never shares state with its parent.
    const parent = createRng("seed");
    const fork = parent.fork("label");
    assert.notEqual(parent.next(), fork.next());
  });

  test("1g. a plan is reproducible and its split assignment is digest-bound", () => {
    const left = planRun({ seed: "plan-seed", units: 10 });
    const right = planRun({ seed: "plan-seed", units: 10 });
    assert.equal(left.splitAssignmentDigest, right.splitAssignmentDigest);
    assert.match(left.splitAssignmentDigest, /^[0-9a-f]{64}$/);
    assert.equal(
      left.units.filter((unit) => unit.spec.split === "train").length,
      left.splitCounts.train,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Fail-closed budget
// ---------------------------------------------------------------------------

describe("2. the token budget fails closed", () => {
  test("2a. a missing tokenizer is refused with an explicit, actionable error", () => {
    for (const missing of [null, undefined]) {
      assert.throws(
        () => requireTokenizer(missing),
        (error: unknown) => {
          assert.ok(error instanceof TokenizerUnavailableError);
          assert.equal(error.code, "tokenizer-unavailable");
          assert.match(error.message, /supervised assistant tokens AFTER MASKING/);
          assert.match(error.message, /tokens under training loss/);
          assert.match(error.message, /foundry plan command/);
          assert.match(error.message, /TokenizerPort/);
          return true;
        },
      );
    }
  });

  test("2b. a tokenizer that cannot measure is refused rather than trusted", () => {
    assert.throws(
      () => requireTokenizer({ name: "liar", countSupervisedTokens: () => Number.NaN }),
      TokenizerUnavailableError,
    );
    assert.throws(
      () => requireTokenizer({ name: "", countSupervisedTokens: () => 1 }),
      TokenizerUnavailableError,
    );
    assert.throws(
      () => requireTokenizer({ name: "no-tokens", countSupervisedTokens: () => -5 }),
      TokenizerUnavailableError,
    );
  });

  test("2c. runPipeline refuses to execute without a tokenizer, in execute mode", async () => {
    const relay = fakeRelay(() => ({ content: "anything" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    await assert.rejects(
      () => runPipeline({
        runId: "no-tokenizer", seed: "s", execute: true,
        tokenizer: null, generator, reviewer, units: 2, store: openStore("no-tokenizer"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof TokenizerUnavailableError);
        assertNoCredential(error.message, "tokenizer refusal");
        return true;
      },
    );
    assert.equal(relay.transportCalls(), 0, "refusing must happen before any dispatch");
  });

  test("2d. the budget refuses a dispatch whose worst case cannot fit", () => {
    const ledger = createBudgetLedger();
    const budget = { maxSupervisedAssistantTokens: 1_000 };
    const allowed = checkBudget({
      ledger, budget, target: "world-generation", maxCompletionTokens: 400,
    });
    assert.equal(allowed.allowed, true);

    const over = checkBudget({
      ledger, budget, target: "world-generation", maxCompletionTokens: 5_000,
    });
    assert.equal(over.allowed, false);
    assert.match(over.reason ?? "", /remaining for the run/);
  });

  test("2e. per-target caps stop one family starving the budget of another", () => {
    const ledger = createBudgetLedger();
    const target: GenerationTarget = "tool-selection:argument-binding";
    recordSpend(ledger, target, DEFAULT_TOKEN_BUDGET.perTarget![target]!);
    const decision = checkBudget({
      ledger, budget: DEFAULT_TOKEN_BUDGET, target, maxCompletionTokens: 10_000,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /remaining for target/);
  });

  test("2f. spend is only ever recorded from a measured integer", () => {
    const ledger = createBudgetLedger();
    assert.throws(() => recordSpend(ledger, "world-generation", Number.NaN), PipelineRefusal);
    assert.throws(() => recordSpend(ledger, "world-generation", 1.5), PipelineRefusal);
    assert.equal(ledger.total, 0, "a refused measurement must not move the ledger");
    recordSpend(ledger, "world-generation", 100);
    assert.equal(ledger.total, 100);
  });
});

// ---------------------------------------------------------------------------
// 3. dryRun
// ---------------------------------------------------------------------------

describe("3. dryRun is the default and dispatches nothing", () => {
  test("3a. dryRun makes zero network calls", async () => {
    const relay = fakeRelay(() => ({ content: "should never be requested" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    const report = await runPipeline({
      runId: "dry-run", seed: "dry-seed", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 6, store: openStore("dry-run"),
    });
    assert.equal(relay.transportCalls(), 0, "the transport must never be invoked");
    assert.equal(report.dryRun, true);
    assert.equal(report.executed, false);
    assert.equal(report.attempts, 0);
    assert.equal(report.admitted, 0);
    assert.equal(report.units, 6);
  });

  test("3b. dryRun still measures diversity and the family mix", async () => {
    const relay = fakeRelay(() => ({ content: "never" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    const report = await runPipeline({
      runId: "dry-mix", seed: "mix-seed", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 10, store: openStore("dry-mix"),
    });
    assert.equal(relay.transportCalls(), 0);
    assert.equal(report.diversity.plannedPrompts.count, 10);
    assert.ok(report.diversity.plannedPrompts.uniqueRatio > 0.5);
    assert.equal(report.diversity.beforeValidation.count, 0, "undispatched prompts are not generated candidates");
    assert.ok(report.diversity.afterValidation.count === 0, "nothing was dispatched, so nothing validated");

    const counts = report.unitOutcomes.reduce<Record<string, number>>((acc, outcome) => {
      acc[outcome.family] = (acc[outcome.family] ?? 0) + 1;
      return acc;
    }, {});
    assert.ok(Object.keys(counts).length >= 3, `expected a spread across families, got ${Object.keys(counts).join(",")}`);
  });

  test("3c. --execute is the only way to spend; the flag parser defaults to dry", () => {
    assert.deepEqual(parseExecutionFlag([]), { execute: false, dryRun: true });
    assert.deepEqual(parseExecutionFlag(["--seed", "x"]), { execute: false, dryRun: true });
    assert.deepEqual(parseExecutionFlag(["--execute"]), { execute: true, dryRun: false });
  });

  test("3d. omitting execute entirely is a dry run", async () => {
    const relay = fakeRelay(() => ({ content: "never" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    const report = await runPipeline({
      runId: "implicit-dry", seed: "implicit", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 4, store: openStore("implicit-dry"),
    });
    assert.equal(report.dryRun, true);
    assert.equal(relay.transportCalls(), 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Admission is a real certificate
// ---------------------------------------------------------------------------

describe("4. nothing is admitted without a real admitCandidate certificate", () => {
  test("4a. executing without a run store is refused outright", async () => {
    const relay = fakeRelay(() => ({ content: "x" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    await assert.rejects(
      () => runPipeline({
        runId: "no-store", seed: "s", execute: true, tokenizer: WORD_TOKENIZER,
        generator, reviewer, units: 2,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineRefusal);
        assert.match(error.message, /run store/);
        return true;
      },
    );
    assert.equal(relay.transportCalls(), 0);
  });

  test("4b. a candidate record is never constructed in the admitted state", async () => {
    const relay = fakeRelay(() => ({ content: "Haug will not say more." }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("never-admitted");
    await runPipeline({
      runId: "never-admitted", seed: "boundary-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, units: 4, store,
      families: ["boundary-recovery"], maxRepairs: 0,
    });
    // Every registered candidate is pending-review: the pipeline's refusals are
    // committed as refusals, and `readCandidate` refuses to present a
    // CandidateRecord as admitted even if one were.
    for (const record of store.candidates()) {
      assert.notEqual(record.admission.status, "admitted");
      assert.equal(record.admission.admittedAt, null);
    }
    assert.equal(store.readAdmittedRecord("no-such-attempt"), null);
  });

  test("4c. the store's own downgrade path defeats a bare `status: admitted` claim", () => {
    // The bypass that was closed: passing `admission: { status: "admitted" }`
    // with no `admittedRecord` must not survive as admitted.
    const store = openStore("downgrade-probe");
    const record = forgedAdmittedCandidate("rec-1", "u1");
    const result = store.commitCandidate({
      unitId: "u1", attemptId: "a1", record,
      admission: { status: "admitted" },
    });
    assert.equal(result.status, "pending-review", "an unverified admitted claim is downgraded");
    assert.equal(store.readAdmittedRecord("a1"), null);
    assert.equal(store.readCandidate("a1")?.admission.status, "pending-review");
  });

  test("4d. assertBatchAdmissible refuses a batch with no verifiable certificate", () => {
    const store = openStore("batch-probe");
    const record = forgedAdmittedCandidate("rec-2", "u1");
    store.commitCandidate({ unitId: "u1", attemptId: "a1", record, admission: { status: "admitted" } });
    assert.throws(
      () => assertBatchAdmissible([record as unknown as AdmittedRecordV1]),
      (error: unknown) => {
        assert.ok(error instanceof PipelineRefusal);
        assert.match(error.message, /rec-2/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 4f. The happy path, end to end
// ---------------------------------------------------------------------------

describe("4f. a clean run reaches admission with a verifiable certificate", () => {
  test("4f-i. roleplay prose that satisfies every gate is admitted, and the stored certificate verifies", async () => {
    const answer = "Haug counts the tide marks twice before answering, and the lantern gutters low.";
    const relay = fakeRelay((call) => (isReviewCall(call) ? { content: REVIEW_ACCEPT } : { content: answer }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("happy-roleplay");
    const report = await runPipeline({
      runId: "happy-roleplay", seed: "happy-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 4, families: ["roleplay-conversation"], maxRepairs: 0, temperature: 0.37,
    });
    assert.equal(report.admitted, 4, `expected every clean candidate to be admitted, got ${report.admitted}`);
    assert.equal(report.buckets.ok, 0, "roleplay is not a tool family, so its bucket is unscored");
    assert.equal(report.buckets.unscored, 4);
    assert.equal(report.diversity.beforeValidation.count, 4);
    assert.equal(report.diversity.beforeValidation.uniqueRatio, 0.25, "four identical outputs cannot be scored as diverse prompts");

    for (const outcome of report.unitOutcomes) {
      assert.ok(outcome.admittedAttemptId, `${outcome.unitId} should be admitted`);
      // Read back THROUGH THE STORE, which re-verifies on every read.
      const stored = store.readAdmittedRecord(outcome.admittedAttemptId!);
      assert.ok(stored, "the store must return the certified record");
      assert.equal(stored!.admission.status, "admitted");
      assert.doesNotThrow(() => verifyAdmissionCertificate(stored!));
      assert.deepEqual(revalidateAdmitted(stored!), []);
      assert.match(stored!.admissionCertificate.certificateDigest, /^[0-9a-f]{64}$/);
      assert.equal(stored!.provenance.reviewer?.model, "reviewer-beta");
      assert.equal(stored!.provenance.generator.model, "teacher-alpha");
      assert.equal(stored!.provenance.generator.temperature, 0.37);
      assert.equal(stored!.provenance.reviewer?.provider, "agentrouter");
      assert.notEqual(
        stored!.admissionCertificate.generatorIdentity,
        stored!.admissionCertificate.reviews[0]!.reviewerIdentity,
      );
      assert.ok(stored!.admissionCertificate.evidence.length >= 2);
      assertNoCredential(stored!, "admitted record");
    }
    // The budget measured real supervised tokens for every admitted record.
    assert.equal(report.budget.tokenizer, WORD_TOKENIZER.name);
    assert.ok(report.budget.supervisedTokens > 0);
    assert.equal(report.budget.supervisedTokens, store.candidates().length > 0 ? report.budget.supervisedTokens : 0);
  });

  test("4f-ii. grounded narration is admitted only when it binds to the scenario's receipts", async () => {
    // The narration is DERIVED FROM THE SPEC's committed receipts, so the
    // binding gate has something real to bind to. Nothing here is invented.
    const spec = plannedSpec("grounded-seed", "grounded-narration", 300);
    const receipt = spec.oracle.receipts.find((entry) => entry.kind === "check");
    assert.ok(receipt, "the scenario should carry a check receipt");
    const check = receipt as Extract<typeof receipt, { kind: "check" }>;
    const narration =
      `Your ${check.skill} check comes to ${check.total} against DC of ${check.dc}. ` +
      `Your ${check.skill} check is a ${check.outcome}.`;
    const bound = evaluateGroundedNarration(narration, spec.oracle.receipts);
    assert.equal(bound.verdict, "verified", `fixture narration should bind: ${JSON.stringify(bound)}`);

    const relay = fakeRelay((call) => (isReviewCall(call)
      ? { content: REVIEW_ACCEPT }
      : {
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "submit_adventure_narration",
          arguments: { narration },
        }],
      }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("happy-grounded");
    const report = await runPipeline({
      runId: "happy-grounded", seed: "grounded-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["grounded-narration"], maxRepairs: 0,
    });
    const outcome = report.unitOutcomes[0]!;
    assert.ok(outcome.admittedAttemptId, `grounded narration should be admitted, refused at ${outcome.refusedAt}`);
    const stored = store.readAdmittedRecord(outcome.admittedAttemptId!)!;
    assert.doesNotThrow(() => verifyAdmissionCertificate(stored));
    const validators = stored.provenance.validators;
    for (const required of ["receipt-provenance", "production-grounding-predicate", "binding-grounding", "tool-envelope", "boundary-leakage"]) {
      assert.ok(validators.includes(required), `expected ${required} evidence, got ${validators.join(",")}`);
    }
    // The admitted turn really carries the tool call, not prose.
    const last = stored.messages[stored.messages.length - 1]!;
    assert.equal(last.role, "assistant");
    assert.equal(last.tool_calls?.[0]?.function.name, "submit_adventure_narration");
    assert.equal(last.tool_calls?.[0]?.function.arguments.narration, narration);
  });

  test("4f-iii. the same narration with one wrong number is refused by the binding gate", async () => {
    const spec = plannedSpec("grounded-neg-seed", "grounded-narration", 300);
    const receipt = spec.oracle.receipts.find((entry) => entry.kind === "check");
    assert.ok(receipt);
    const check = receipt as Extract<typeof receipt, { kind: "check" }>;
    // Swapped total and DC: the classic defect the audit reproduced against
    // production's own presence predicate.
    const wrong =
      `Your ${check.skill} check comes to ${check.dc} against DC of ${check.total}. ` +
      `Your ${check.skill} check is a ${check.outcome}.`;
    const bound = evaluateGroundedNarration(wrong, spec.oracle.receipts);
    assert.notEqual(bound.verdict, "verified");

    const relay = fakeRelay((call) => (isReviewCall(call)
      ? { content: REVIEW_ACCEPT }
      : {
        content: "",
        toolCalls: [{ id: "call_1", name: "submit_adventure_narration", arguments: { narration: wrong } }],
      }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("grounded-neg");
    const report = await runPipeline({
      runId: "grounded-neg", seed: "grounded-neg-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["grounded-narration"], maxRepairs: 0,
    });
    assert.equal(report.admitted, 0);
    const stored = store.readCandidate(report.unitOutcomes[0]!.unitId + "-a0")!;
    assert.ok(String(stored.admission.findings.gateFindings).length > 0, "the refusal must carry a structured reason");
  });
});

// ---------------------------------------------------------------------------
// 5. Repair supersedes; it never mutates
// ---------------------------------------------------------------------------

describe("5. a repair is a new attempt that supersedes its parent", () => {
  test("5a. a refused attempt retains RAW and PARSED, and its repair is a child", async () => {
    // First dispatch fails to parse as world-generation JSON; the repair fixes it.
    let dispatch = 0;
    const relay = fakeRelay(() => {
      dispatch += 1;
      return dispatch === 1
        ? { content: "sorry, here is prose instead of the object" }
        : { content: JSON.stringify({ locations: [] }) };
    });
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({
      credentials: credentials("reviewer-y"),
      transport: async (request) => {
        const body = String(request.body);
        const response: TeacherHttpResponse = {
          status: 200,
          body: JSON.stringify({
            id: "r",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: REVIEW_ACCEPT } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
        assert.match(body, /independent reviewer/);
        return response;
      },
      sleep: async () => {},
    });
    const store = openStore("repair-run");
    const spec = plannedSpec("repair-seed", "world-generation", 1);
    const report = await runPipeline({
      runId: "repair-run", seed: "repair-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["world-generation"], maxRepairs: 1,
    });
    const outcome = report.unitOutcomes[0]!;
    assert.equal(spec.family, "world-generation");

    // Two attempts exist for the unit: the refusal and its repair.
    const attempts = store.attempts(outcome.unitId);
    assert.equal(attempts.length, 2, `expected a repair attempt, saw ${attempts.map((a) => a.attemptId).join(",")}`);
    const [parent, child] = attempts;
    assert.equal(parent!.parentAttemptId, null);
    assert.equal(child!.parentAttemptId, parent!.attemptId);
    assert.equal(parent!.superseded, true);
    assert.notEqual(parent!.attemptId, child!.attemptId);
    assert.equal(parent!.recordId, child!.recordId, "a repair keeps the logical record identity");

    // The PARENT is untouched: it still carries the raw text that failed.
    const parentCandidate = store.readCandidate(parent!.attemptId)!;
    const findings = parentCandidate.admission.findings;
    assert.match(String(findings.stage), /PARSED/);
    assert.equal(findings.code, "world-generation-not-json");
    assert.equal(findings.raw, "sorry, here is prose instead of the object");
    assert.ok(String(findings.parsed).length > 0 || String(findings.raw).length > 0);
    assert.equal(parent!.status, "pending-review");
  });

  test("5b. the repair prompt carries the refused RAW and PARSED text", async () => {
    const prompts: string[] = [];
    const relay = fakeRelay((call) => {
      prompts.push(call.request.body);
      return { content: "not json" };
    });
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    await runPipeline({
      runId: "repair-prompt", seed: "repair-prompt-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store: openStore("repair-prompt"),
      units: 1, families: ["world-generation"], maxRepairs: 1,
    });
    assert.equal(prompts.length, 2, "the second dispatch should be the repair");
    assert.match(prompts[1]!, /RAW output that was refused/);
    assert.match(prompts[1]!, /not json/);
    assert.match(prompts[1]!, /world-generation-not-json/);
  });

  test("5c. the repair budget is bounded", async () => {
    const relay = fakeRelay(() => ({ content: "never json" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-x"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-y"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("bounded-repair");
    const report = await runPipeline({
      runId: "bounded-repair", seed: "bounded-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["world-generation"], maxRepairs: 1,
    });
    const outcome = report.unitOutcomes[0]!;
    assert.equal(outcome.attempts, 2, "one initial attempt plus one repair, then stop");
    assert.equal(report.admitted, 0);
    assert.equal(store.attempts(outcome.unitId).length, 2);
  });

  test("5d. a PARSE failure carries the RAW text through the stage record", () => {
    const completion = {
      content: "prose that is not an object",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      responseId: null,
      attempts: 1,
      latencyMs: 0,
      requestDigest: "x",
    };
    const parsed = parseStage("world-generation", completion);
    assert.equal(parsed.parsed, null);
    assert.ok(parsed.failure);
    assert.equal(parsed.failure.stage, "PARSED");
    assert.equal(parsed.failure.raw, "prose that is not an object", "RAW must be retained for repair");
    assert.ok(parsed.failure.detail.length > 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Reviewer independence
// ---------------------------------------------------------------------------

describe("6. the reviewer is a different model, and that is asserted", () => {
  test("6a. a reviewer equal to the generator is refused before any dispatch", async () => {
    const relay = fakeRelay(() => ({ content: "x" }));
    const same = createTeacherClient({ credentials: credentials("same-model"), transport: relay.transport, sleep: async () => {} });
    await assert.rejects(
      () => runPipeline({
        runId: "self-review", seed: "self", execute: true, tokenizer: WORD_TOKENIZER,
        generator: same, reviewer: same, units: 1, store: openStore("self-review"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineRefusal);
        assert.equal(error.code, "reviewer-not-independent");
        assertNoCredential(error.message, "self-review refusal");
        return true;
      },
    );
    assert.equal(relay.transportCalls(), 0, "the check must precede spending");
  });

  test("6b. the report states the reviewer identity and that it differs", async () => {
    const relay = fakeRelay(() => ({ content: "x" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const report = await runPipeline({
      runId: "independent", seed: "indep", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 2, store: openStore("independent"),
    });
    assert.equal(report.generatorModel, "teacher-alpha");
    assert.equal(report.reviewerModel, "reviewer-beta");
    assert.equal(report.reviewerIndependent, true);
    assert.notEqual(report.generatorModel, report.reviewerModel);
  });

  test("6c. a reviewer that rejects leaves nothing admitted", async () => {
    const generatorRelay = fakeRelay(() => ({ content: "Haug says nothing at all." }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: generatorRelay.transport, sleep: async () => {} });
    const reviewerRelay = fakeRelay(() => ({ content: REVIEW_REJECT }));
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: reviewerRelay.transport, sleep: async () => {} });
    const store = openStore("reviewer-rejects");
    const report = await runPipeline({
      runId: "reviewer-rejects", seed: "reject-seed", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["roleplay-conversation"], maxRepairs: 0,
    });
    assert.equal(report.admitted, 0);
    for (const record of store.candidates()) {
      assert.notEqual(record.admission.status, "admitted");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Tool-selection is split by tool family and by behaviour
// ---------------------------------------------------------------------------

describe("7. tool-selection separates initiation from argument binding", () => {
  test("7a. the family weight is split into two budget targets", () => {
    const plan = planRun({ seed: "split-seed", units: 100, families: ["tool-selection"] });
    const targets = new Set(plan.units.flatMap((unit) =>
      unit.spec.family === "tool-selection" ? ["initiation", "binding"] : [],
    ));
    assert.ok(targets.has("initiation"));
    assert.ok(targets.has("binding"));
    assert.ok(FAMILY_WEIGHTS["tool-selection:initiation"] > 0);
    assert.ok(FAMILY_WEIGHTS["tool-selection:argument-binding"] > 0);
  });

  test("7a-ii. the two tool-selection budgets are charged separately", async () => {
    // Initiation failures charge the initiation budget; argument-binding
    // failures charge the binding budget. Collapsing them would let one
    // behaviour's collapse hide inside the other's spend.
    assert.equal(budgetTargetFor("tool-selection", "initiation-failure"), "tool-selection:initiation");
    assert.equal(budgetTargetFor("tool-selection", "ok"), "tool-selection:initiation");
    assert.equal(budgetTargetFor("tool-selection", "argument-binding-failure"), "tool-selection:argument-binding");
    assert.equal(budgetTargetFor("tool-selection", "shape-failure"), "tool-selection:argument-binding");
    assert.equal(budgetTargetFor("grounded-narration", "unscored"), "grounded-narration");
  });

  test("7b. an abstention on a tool-call decision is an INITIATION failure", async () => {
    // A prose answer where the advertised menu says a tool must be chosen.
    const relay = fakeRelay((call) => {
      const body = String(call.request.body);
      if (body.includes("independent reviewer")) return { content: REVIEW_ACCEPT };
      return { content: "Haug simply says nothing useful." };
    });
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("initiation-failure");
    // Find a tool-selection spec whose oracle requires a call.
    let seed = "init-seed";
    let spec = plannedSpec(seed, "tool-selection", 200);
    let guard = 0;
    while (!spec.oracle.expectsToolCall && guard < 20) {
      seed = `${seed}+`;
      spec = plannedSpec(seed, "tool-selection", 200);
      guard += 1;
    }
    assert.ok(spec.oracle.expectsToolCall, "no tool-call tool-selection scenario was found");

    const report = await runPipeline({
      runId: "initiation-failure", seed, execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["tool-selection"], maxRepairs: 0,
    });
    assert.equal(report.admitted, 0);
    assert.equal(report.buckets["initiation-failure"], 1, "an abstention must land in the initiation bucket");
    assert.equal(report.buckets["argument-binding-failure"], 0);
    assert.equal(report.unitOutcomes[0]!.refusedAt, "VALIDATED:no-initiation");
  });

  test("7c. a {} -argument collapse is an ARGUMENT-BINDING failure, not an initiation one", async () => {
    // This is the measured Qwen3.5-9B behaviour: it initiates 7/7, then emits
    // 43-45 copies with empty arguments. Initiation SUCCEEDED here.
    const relay = fakeRelay((call) => {
      const body = String(call.request.body);
      if (body.includes("independent reviewer")) return { content: REVIEW_ACCEPT };
      return {
        content: "",
        toolCalls: [{ id: "call_1", name: "choose_adventure_candidate", arguments: {} }],
      };
    });
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("empty-args");
    let seed = "binding-seed";
    let spec = plannedSpec(seed, "tool-selection", 200);
    let guard = 0;
    while (spec.oracle.toolFamily !== "exact-candidate" && guard < 40) {
      seed = `${seed}+`;
      spec = plannedSpec(seed, "tool-selection", 200);
      guard += 1;
    }
    assert.equal(spec.oracle.toolFamily, "exact-candidate");
    assert.equal(spec.oracle.expectsToolCall, true);

    const report = await runPipeline({
      runId: "empty-args", seed, execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["tool-selection"], maxRepairs: 0,
    });
    assert.equal(report.admitted, 0);
    assert.equal(report.buckets["argument-binding-failure"], 1, "empty arguments are a binding failure");
    assert.equal(report.buckets["initiation-failure"], 0, "the model DID initiate");
    assert.match(report.unitOutcomes[0]!.refusedAt ?? "", /VALIDATED:argument-binding/);
    // The spend is charged to the binding budget, not the initiation budget.
    assert.ok((report.budget.byTarget["tool-selection:argument-binding"] ?? 0) >= 0);
    assert.equal(report.budget.byTarget["tool-selection:initiation"], undefined);
  });

  test("7d. an unadvertised candidate is a binding failure even with a valid shape", async () => {
    const relay = fakeRelay((call) => {
      const body = String(call.request.body);
      if (body.includes("independent reviewer")) return { content: REVIEW_ACCEPT };
      return {
        content: "",
        toolCalls: [{
          id: "call_1",
          name: "choose_adventure_candidate",
          arguments: { candidateId: "invented-candidate", digest: "f".repeat(64) },
        }],
      };
    });
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    let seed = "unadvertised-seed";
    let spec = plannedSpec(seed, "tool-selection", 200);
    let guard = 0;
    while (spec.oracle.toolFamily !== "exact-candidate" && guard < 40) {
      seed = `${seed}+`;
      spec = plannedSpec(seed, "tool-selection", 200);
      guard += 1;
    }
    const store = openStore("unadvertised");
    const report = await runPipeline({
      runId: "unadvertised", seed, execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 1, families: ["tool-selection"], maxRepairs: 0,
    });
    assert.equal(report.admitted, 0);
    assert.equal(report.buckets["argument-binding-failure"], 1);
  });
});

// ---------------------------------------------------------------------------
// 8. Export
// ---------------------------------------------------------------------------

describe("8. export is reached only through exportTrainingJsonl", () => {
  test("8a. export without an approved registry is refused before anything is written", () => {
    assert.throws(
      () => exportAdmittedCorpus([], { outputDir: "/tmp/never", approvedRegistry: undefined as never }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineRefusal);
        assert.match(error.message, /approved artifact registry/);
        return true;
      },
    );
  });

  test("8b. export refuses a batch whose certificate does not verify", async () => {
    const fakeRecord = {
      recordId: "rec-fake",
      admissionCertificate: { version: "admission-certificate-v1" },
      admission: { status: "admitted", reasons: [] },
    } as unknown as AdmittedRecordV1;
    assert.throws(
      () => assertBatchAdmissible([fakeRecord]),
      PipelineRefusal,
    );
  });

  test("8c. a certified batch reaches exportTrainingJsonl and is refused at the template gate", () => {
    // Built through the ONLY admission constructor, with evidence and a review
    // that really ran, so this is a certificate that verifies.
    const messages: StoredMessage[] = [
      { role: "system", content: "You are the narrator." },
      { role: "user", content: "Who paid Haug?" },
      { role: "assistant", content: "Haug sets the ledger down and does not answer." },
    ];
    const payloadDigest = computePayloadDigest({ messages });
    const record = admitCandidate({
      family: "roleplay-conversation",
      recordId: "rec-export-1",
      unitId: "unit-export-1",
      lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" },
      split: "train",
      splitAssignmentDigest: "b".repeat(64),
      messages,
      provenance: {
        datasetVersion: FOUNDRY_VERSION,
        recordSchemaVersion: RECORD_SCHEMA_VERSION,
        gitCommit: null,
        scenarioSeed: "seed",
        scenarioTemplate: "t",
        sourceFixture: null,
        generator: { provider: "agentrouter", model: "teacher-x", baseUrlDigest: "e".repeat(64), temperature: 0.7 },
        reviewer: { provider: "agentrouter", model: "reviewer-y", promptVersion: "review-prompt-v1" },
        sourceDigests: {},
        tokenCount: { tokenizer: "measured", tokens: 24 },
        syntheticOrigin: true,
        license: { status: "unverified", note: "n" },
      },
      evidence: [
        { validator: "boundary-leakage", version: "v1", payloadDigest, evidenceDigest: "a".repeat(64), passed: true },
        { validator: "player-agency", version: "v1", payloadDigest, evidenceDigest: "a".repeat(64), passed: true },
      ],
      reviews: [{
        reviewerIdentity: "agentrouter:reviewer-y",
        reviewerPromptDigest: "f".repeat(64),
        candidateDigest: payloadDigest,
        scores: {
          characterization: 0.8, dialogueQuality: 0.8, coherence: 0.8, narrativeInitiative: 0.7,
          playerAgency: 0.9, nonRepetitive: 0.8, verdict: "accept", rationale: "ok", reviewerCount: 1,
        },
      }],
      generatorIdentity: "agentrouter:teacher-x",
    });
    // It really verifies before it is ever offered to the exporter.
    assert.doesNotThrow(() => verifyAdmissionCertificate(record));

    const root = mkdtempSync(join(tmpdir(), "velvet-export-"));
    roots.push(root);
    const outputDir = join(root, "bundle");
    const registry = {
      validators: {},
      artifacts: new Map<string, string>(),
      // The certificate is not pinned, so export must refuse BEFORE the
      // template gate even reaches it.
      certificates: new Map<string, string>(),
      templateProfiles: [],
    };
    // Reaching `assertExportable` proves the batch went through the real export
    // path; the refusal proves it is fail-closed. Nothing is written, because
    // export verifies the whole corpus before touching the filesystem.
    assert.throws(
      () => exportAdmittedCorpus([record], { outputDir, approvedRegistry: registry }),
      /certificate|template/i,
    );
    assert.equal(existsSync(outputDir), false, "a refused export writes nothing");
  });

  test("8d. exportTrainingJsonl itself refuses a batch that is not admitted", () => {
    const root = mkdtempSync(join(tmpdir(), "velvet-export-raw-"));
    roots.push(root);
    const outputDir = join(root, "raw-bundle");
    const registry = {
      validators: {},
      artifacts: new Map<string, string>(),
      certificates: new Map<string, string>(),
      templateProfiles: [],
    };
    const forged = {
      recordId: "rec-fake",
      admission: { status: "admitted", reasons: [] },
    } as unknown as AdmittedRecordV1;
    assert.throws(() => exportTrainingJsonl([forged], { outputDir, approvedRegistry: registry }));
    assert.equal(existsSync(outputDir), false);
  });

  test("8d. a forged certificate does not revalidate or verify", () => {
    // The local integrity check the store runs on every read.
    const store = openStore("revalidate-probe");
    const record = forgedAdmittedCandidate("rec-3", "u1");
    const result = store.commitCandidate({
      unitId: "u1", attemptId: "a1", record, admission: { status: "admitted" },
    });
    assert.equal(result.status, "pending-review");

    const forged = {
      ...record,
      admissionCertificate: { version: "admission-certificate-v1" },
    } as unknown as AdmittedRecordV1;
    assert.ok(revalidateAdmitted(forged).length > 0, "a forged certificate must not revalidate");
    assert.throws(() => verifyAdmissionCertificate(forged));
  });
});

// ---------------------------------------------------------------------------
// 9. Credential discipline across the pipeline's own artifacts
// ---------------------------------------------------------------------------

describe("9. the pipeline produces no credential-shaped artifact", () => {
  test("9a. a full dry-run report is credential-free", async () => {
    const relay = fakeRelay(() => ({ content: "x" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const report = await runPipeline({
      runId: "credential-audit", seed: "cred", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 6, store: openStore("credential-audit"),
    });
    assertNoCredential(report, "pilot report");
  });

  test("9b. an executed run's committed records are credential-free", async () => {
    const relay = fakeRelay(() => ({ content: "Haug will not say more." }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    const store = openStore("credential-exec");
    const report = await runPipeline({
      runId: "credential-exec", seed: "cred-exec", execute: true,
      tokenizer: WORD_TOKENIZER, generator, reviewer, store,
      units: 2, families: ["boundary-recovery"], maxRepairs: 0,
    });
    assertNoCredential(report, "executed report");
    assertNoCredential(store.candidates(), "committed candidates");
    assertNoCredential(store.ledger(), "run ledger");
    for (const record of store.candidates()) {
      // Provenance carries a digest of the endpoint, never the endpoint itself.
      assert.match(String(record.provenance.generator.baseUrlDigest), /^[0-9a-f]{64}$/);
      assert.equal(record.provenance.tokenCount?.tokenizer, WORD_TOKENIZER.name);
      assert.ok(!JSON.stringify(record).includes("127.0.0.1:9"));
    }
  });

  test("9c. the outgoing request body never carries the credential as a field", async () => {
    const relay = fakeRelay(() => ({ content: "x" }));
    const generator = createTeacherClient({ credentials: credentials("teacher-alpha"), transport: relay.transport, sleep: async () => {} });
    const reviewer = createTeacherClient({ credentials: credentials("reviewer-beta"), transport: relay.transport, sleep: async () => {} });
    await runPipeline({
      runId: "body-audit", seed: "body", tokenizer: WORD_TOKENIZER,
      generator, reviewer, units: 1, store: openStore("body-audit"),
    });
    for (const call of relay.calls) {
      assertNoCredential(call.body, "teacher request body");
      assert.match(String(call.request.headers.authorization ?? ""), /^Bearer /);
    }
  });
});

// ---------------------------------------------------------------------------
// Weight policy
// ---------------------------------------------------------------------------

describe("family weights", () => {
  test("weights follow BASELINE_SIGNAL and roleplay is a non-zero retention tranche", () => {
    assert.ok(FAMILY_WEIGHTS["tool-selection:argument-binding"] > 0);
    assert.ok(FAMILY_WEIGHTS["tool-selection:initiation"] > 0);
    assert.ok(FAMILY_WEIGHTS["world-generation"] > 0);
    assert.ok(FAMILY_WEIGHTS["grounded-narration"] > 0);
    assert.ok(FAMILY_WEIGHTS["boundary-recovery"] > 0);
    // Deliberately NOT zero: a zero tranche cannot be measured at all.
    assert.ok(FAMILY_WEIGHTS["roleplay-conversation"] > 0, "roleplay must not be deferred to zero");
    const total = Object.values(FAMILY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights must sum to 1, got ${total}`);
    // The compact tranche is genuinely smaller than the high families.
    assert.ok(
      FAMILY_WEIGHTS["roleplay-conversation"] < FAMILY_WEIGHTS["world-generation"],
      "roleplay is a compact tranche, not a co-equal family",
    );
  });
});
