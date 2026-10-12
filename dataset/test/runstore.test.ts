/**
 * Crash-consistency and accounting suite for `dataset/src/runstore.ts`.
 *
 * Every test that touches the event table uses a FAKE CLOCK, so timestamps,
 * digests and lease ages are deterministic and a failure always reproduces.
 *
 * The nine regression tests below are named for the defects they pin:
 *
 *  1. crash after the payload write but before the registering event  → D1
 *  2. torn trailing line, then further appends                          → D2
 *  3. malformed INTERIOR line                                            → D2
 *  4. pending-review revised into admitted with the same record id      → D3
 *  5. configuration drift on resume                                      → D4
 *  6. replayed settlement                                                → D5
 *  7. uncertain payment retains its reservation                         → D5
 *  8. run id escaping the runs directory                                → traversal
 *  9. a second writer                                                   → corruption
 *
 * Plus direct coverage of the snapshot-is-derived contract, the stage resume
 * point, atomic multi-event commits, and the quadratic-manifest defect (D7).
 *
 * Run: npm run test:foundry   (tsx --test --test-concurrency=1)
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { REQUIRED_VALIDATORS, admitCandidate, computePayloadDigest } from "../src/admission.js";
import {
  type AdmissionDecision,
  ConfigDriftError,
  ConflictingSettlementError,
  InjectedCrashError,
  InvalidUsageError,
  RUN_STAGES,
  RunCorruptionError,
  RunLockError,
  RunStore,
  UnsafeRunIdError,
  BudgetExceededError,
  FAULT_POINTS,
  attemptPayloadFileName,
  computeConfigDigest,
  isSafeRunId,
  logicalResultsDigest,
  openRunStore,
  readGitCommit,
  recordContentDigest,
  runStorePaths,
  type AdmissionStatus,
  type FaultContext,
  type FaultInjector,
  type FaultPoint,
  type OpenRunStoreOptions,
  type RunBudget,
  type RunStorePaths,
} from "../src/runstore.js";
import {
  RECORD_SCHEMA_VERSION,
  type CandidateRecord,
  type LineageGroup,
  type TrainingFamily,
} from "../src/spec.js";

// -------------------------------------------------------------------------------------------------
// Harness
// -------------------------------------------------------------------------------------------------

const ROOT: string = mkdtempSync(join(tmpdir(), "velvet-runstore-"));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Deterministic clock. Nothing in this suite reads the wall clock. */
class FakeClock {
  constructor(private nowMs: number = Date.parse("2026-04-01T00:00:00.000Z")) {}

  readonly read = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

let caseCounter = 0;

function caseRoot(): string {
  caseCounter += 1;
  return join(ROOT, `case-${caseCounter.toString().padStart(3, "0")}`);
}

function pathsFor(artifactRoot: string, runId = "run-a"): RunStorePaths {
  return runStorePaths(runId, artifactRoot);
}

/**
 * A minimal but contract-complete candidate. `suffix` perturbs the content so
 * two records in the same suite are not accidentally identical.
 */
function candidate(
  suffix: string,
  options: {
    recordId?: string;
    family?: TrainingFamily;
    status?: AdmissionStatus;
    reasons?: string[];
    /** Produce a genuine admission certificate via the real constructor. */
    certified?: boolean;
  } = {},
): CandidateRecord {
  const recordId = options.recordId ?? `rec-${suffix}`;
  const family = options.family ?? "roleplay-conversation";
  const status = options.status ?? "admitted";
  const lineage: LineageGroup = {
    characterFamily: "veiled-herald",
    worldFamily: "baie-comeau",
    scenarioFamily: "harbour-dawn",
  };
  const messages: CandidateRecord["messages"] = [
    { role: "system", content: `You are a herald of Baie-Comeau. Variant ${suffix}.` },
    { role: "user", content: "Tell me what the harbour looks like at dawn." },
    { role: "assistant", content: `Fog sits on the water, and the lamps go out one by one. (${suffix})` },
  ];
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId,
    family,
    lineage,
    scenarioSeed: `seed-${suffix}`,
    messages,
    contentDigest: recordContentDigest({ messages }),
    provenance: {
      datasetVersion: "foundry-v1",
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      gitCommit: "c0ffee",
      scenarioSeed: `seed-${suffix}`,
      scenarioTemplate: "template-v1",
      sourceFixture: `case-${suffix}.json`,
      validators: status === "admitted" ? ["receipt-grounded-narration"] : [],
      validatorVersions: { "receipt-grounded-narration": "1.2.0" },
      generator: { provider: "openai-compatible", model: "fake-1", baseUrlDigest: "d1g35t", temperature: 0.7 },
      reviewer: null,
      sourceDigests: { case: `digest-${suffix}` },
      tokenCount: { tokenizer: "cl100k_base", tokens: 128 },
      syntheticOrigin: true,
      license: { status: "unverified", note: "provider terms unconfirmed" },
    },
    admission: {
      status,
      reasons: options.reasons ?? (status === "rejected" ? ["fabricated-outcome"] : []),
      findings: { checked: true },
      review: null,
      admittedAt: null,
    },
  };
}

const BASE_CONFIG = {
  seed: "seed-1",
  sourceDigest: "src-digest-a",
  splitAssignmentDigest: "split-digest-a",
  corpusFreezeDigest: "freeze-digest-a",
  gitCommit: "c0ffee",
  generator: { provider: "openai-compatible", model: "fake-1", baseUrlDigest: "d1g35t", temperature: 0.7 },
  validatorVersions: { "receipt-grounded-narration": "1.2.0" },
} as const;

function options(
  artifactRoot: string,
  clock: FakeClock,
  overrides: Partial<OpenRunStoreOptions> = {},
): OpenRunStoreOptions {
  return {
    runId: "run-a",
    artifactRoot,
    clock: clock.read,
    durability: "flush",
    ...BASE_CONFIG,
    ...overrides,
  };
}

/**
 * Crashes at the first occurrence of `point` after `skip` earlier occurrences,
 * then disarms itself. `skip` exists because `openRunStore` itself appends the
 * `run.created` transaction, so an `after-event-append` seam would otherwise
 * fire during construction rather than during the call under test.
 */
function crashAt(point: FaultPoint, skip = 0): (context: FaultContext) => void {
  let seen = 0;
  let armed = true;
  return (context: FaultContext) => {
    if (!armed || context.fault !== point) return;
    seen += 1;
    if (seen <= skip) return;
    armed = false;
    throw new InjectedCrashError(context.fault);
  };
}

function payloadFiles(paths: RunStorePaths): string[] {
  return readdirSync(paths.attemptsDir).sort();
}

function eventLines(paths: RunStorePaths): string[] {
  const text = readFileSync(paths.eventsPath, "utf8");
  if (text.length === 0) return [];
  return text.slice(0, text.endsWith("\n") ? text.length - 1 : text.length).split("\n");
}

// -------------------------------------------------------------------------------------------------
// 1. Crash between the payload write and the registering event (D1)
// -------------------------------------------------------------------------------------------------

describe("D1: registration is atomic with its payload", () => {
  test("crash after the payload write but before registration yields no duplicate on resume", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const record = candidate("d1a");

    // --- the crash -------------------------------------------------------
    const crashing = openRunStore(
      options(artifactRoot, clock, { faultInjector: crashAt("after-payload-write") }),
    );
    assert.throws(
      () => crashing.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record }),
      (error: unknown) => error instanceof InjectedCrashError && error.fault === "after-payload-write",
    );
    // Simulate process death: the lease file is abandoned, not released.
    rmSync(paths.lockPath, { force: true });

    // The payload landed on disk; the event that would make it visible did not.
    assert.deepEqual(payloadFiles(paths), [attemptPayloadFileName("attempt-1")]);
    assert.equal(eventLines(paths).filter((line) => line.includes("attempt.registered")).length, 0);
    assert.equal(
      readFileSync(paths.snapshotPath, "utf8").includes("attempt-1"),
      false,
      "an uncommitted mutation never reaches the derived snapshot",
    );

    // --- the resume ------------------------------------------------------
    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.hasAttempt("attempt-1"), false, "an unregistered payload is invisible");
    assert.equal(resumed.hasRecord(record.recordId), false);
    assert.equal(resumed.ledger().length, 0);

    const result = resumed.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record });
    assert.equal(result.committed, true);
    assert.equal(result.alreadyRegistered, false);

    assert.equal(resumed.ledger().length, 1, "exactly one ledger row");
    assert.equal(resumed.candidates().length, 1, "exactly one candidate");
    assert.deepEqual(payloadFiles(paths), [attemptPayloadFileName("attempt-1")], "the retry overwrote in place");
    resumed.close();

    // And the state survives a further reopen.
    const again = openRunStore(options(artifactRoot, clock));
    assert.equal(again.ledger().length, 1);
    assert.equal(again.candidates().length, 1);
    assert.equal(again.hasAttempt("attempt-1"), true);
    again.close();
  });

  test("a crash after the registering event replays as an idempotent no-op", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const record = candidate("d1b");

    const crashing = openRunStore(
      options(artifactRoot, clock, { faultInjector: crashAt("after-event-append", 1) }),
    );
    assert.throws(
      () => crashing.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record }),
      InjectedCrashError,
    );
    rmSync(paths.lockPath, { force: true });

    // The event is durable, so the attempt IS committed even though the caller
    // never saw a return value. This is the whole point of the event table.
    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.hasAttempt("attempt-1"), true);
    assert.equal(resumed.ledger().length, 1);

    const retry = resumed.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record });
    assert.equal(retry.committed, false);
    assert.equal(retry.alreadyRegistered, true);
    assert.equal(resumed.ledger().length, 1, "a replay never appends a second row");
    assert.equal(resumed.candidates().length, 1);
    assert.equal(eventLines(paths).filter((line) => line.includes("attempt.registered")).length, 1);
    resumed.close();
  });

  test("registration, admission, finalization and completion are one transaction", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const store = openRunStore(options(artifactRoot, clock));
    const before = eventLines(paths).length;

    const atomic = certifiedCandidate("atomic", { unitId: "unit-1" });
    store.commitCandidate({
      unitId: "unit-1",
      attemptId: "attempt-1",
      record: atomic.record,
      admission: atomic.decision,
      finalize: true,
      completeUnit: true,
    });

    assert.equal(eventLines(paths).length, before + 1, "one appended line carries every effect");
    const unit = store.unit("unit-1");
    assert.equal(unit?.finalizedAttemptId, "attempt-1");
    assert.equal(unit?.completed, true);
    assert.equal(unit?.effective?.status, "admitted");
    store.close();
  });
});

// -------------------------------------------------------------------------------------------------
// 2 + 3. Event-log framing (D2)
// -------------------------------------------------------------------------------------------------

describe("D2: torn writes are truncated, interior corruption is refused", () => {
  test("an unterminated trailing line is truncated and later appends stay readable", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);

    const first = openRunStore(options(artifactRoot, clock));
    first.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("torn-1") });
    first.close();
    assert.equal(eventLines(paths).length, 2); // run.created + the commit

    // Reproduce the old reader's exact defect: a torn suffix LEFT IN PLACE.
    appendRaw(paths.eventsPath, '{"seq":99,"txId":"torn","at":"2026-04-01T00:00:00.000Z","eve');

    const resumed = openRunStore(options(artifactRoot, clock));
    assert.ok(resumed.snapshot().diagnostics.truncatedBytes > 0, "the torn suffix was detected");
    assert.equal(resumed.ledger().length, 1, "only committed lines survived");
    resumed.commitCandidate({ unitId: "unit-2", attemptId: "attempt-2", record: candidate("torn-2") });
    resumed.close();

    // The old reader would have produced `...{"a":1}{"a":2}` and thrown forever
    // after. Here the next append lands on a clean boundary.
    const final = openRunStore(options(artifactRoot, clock));
    assert.equal(final.ledger().length, 2);
    assert.equal(final.candidates().length, 2);
    assert.equal(readFileSync(paths.eventsPath, "utf8").endsWith("\n"), true);
    assert.equal(eventLines(paths).every((line) => line.startsWith("{") && line.endsWith("}")), true);
    final.close();
  });

  test("a malformed interior line throws instead of being skipped", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);

    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("bad-1") });
    store.commitCandidate({ unitId: "unit-2", attemptId: "attempt-2", record: candidate("bad-2") });
    store.close();

    const lines = eventLines(paths);
    lines.splice(1, 0, '{"seq":1,"txId":"garbage","at":"x","events":[]');
    writeFileSync(paths.eventsPath, `${lines.join("\n")}\n`, "utf8");

    assert.throws(
      () => openRunStore(options(artifactRoot, clock)),
      (error: unknown) =>
        error instanceof RunCorruptionError &&
        error.line === 2 &&
        /not valid JSON/.test(error.message),
    );
    // The refused open must not have left a lease behind for the next attempt.
    assert.equal(existsSync(paths.lockPath), false);
  });

  test("a blank interior line is refused rather than skipped", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const store = openRunStore(options(artifactRoot, clock));
    store.close();

    const lines = eventLines(paths);
    lines.splice(1, 0, "");
    writeFileSync(paths.eventsPath, `${lines.join("\n")}\n`, "utf8");
    assert.throws(() => openRunStore(options(artifactRoot, clock)), RunCorruptionError);
  });
});

// -------------------------------------------------------------------------------------------------
// 4. Repair lifecycle (D3)
// -------------------------------------------------------------------------------------------------

describe("D3: a unit is revised by superseding attempts, not by blocking record ids", () => {
  test("a pending-review candidate is superseded by an admitted revision of the same record id", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));

    const recordId = "rec-repairable";
    const pending = candidate("repair-a", { recordId, status: "pending-review" });
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: pending });

    assert.equal(store.hasRecord(recordId), true);
    assert.equal(store.latestEligibleCandidate("unit-1")?.attemptId, "attempt-1");
    assert.equal(store.latestEligibleCandidate("unit-1")?.status, "pending-review");

    // The old store refused this write outright because the record id was taken.
    const certifiedRepair = certifiedCandidate("repair-b", { unitId: "unit-1", recordId });
    const admitted = certifiedRepair.record;
    const result = store.commitCandidate({
      unitId: "unit-1",
      attemptId: "attempt-2",
      parentAttemptId: "attempt-1",
      record: admitted,
      admission: certifiedRepair.decision,
    });
    assert.equal(result.committed, true);
    assert.equal(result.supersededAttemptId, "attempt-1");

    const latest = store.latestEligibleCandidate("unit-1");
    assert.equal(latest?.attemptId, "attempt-2", "the admitted revision wins");
    assert.equal(latest?.status, "admitted");
    assert.equal(latest?.recordId, recordId);

    const attempts = store.attempts("unit-1");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.superseded, true);
    assert.equal(attempts[1]?.superseded, false);
    assert.equal(store.unit("unit-1")?.effective?.attemptId, "attempt-2");

    // Explicit finalization pins the winner and closes the unit.
    const finalized = store.finalizeUnit("unit-1");
    assert.equal(finalized.attemptId, "attempt-2");
    assert.equal(finalized.finalized, true);
    assert.throws(
      () => store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-3", record: candidate("repair-c") }),
      /finalized/,
    );

    // Reopening preserves the repaired lifecycle.
    store.close();
    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.latestEligibleCandidate("unit-1")?.attemptId, "attempt-2");
    assert.equal(resumed.unit("unit-1")?.finalizedAttemptId, "attempt-2");
    assert.equal(resumed.candidates().length, 2, "both attempts remain readable for audit");
    resumed.close();
  });

  test("a rejected attempt is not eligible and cannot be finalized", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({
      unitId: "unit-1",
      attemptId: "attempt-1",
      record: candidate("rejected", { status: "rejected", reasons: ["fabricated-outcome"] }),
    });
    assert.equal(store.latestEligibleCandidate("unit-1"), null);
    assert.throws(() => store.finalizeUnit("unit-1"), /attempt-1=rejected/);
    assert.throws(() => store.finalizeUnit("unit-1", "attempt-1"), /not eligible/);
    store.close();
  });

  test("reusing an attempt id for different bytes is refused", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("immutable") });
    assert.throws(
      () => store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("changed") }),
      /already registered with different bytes/,
    );
    store.close();
  });
});

// -------------------------------------------------------------------------------------------------
// 5. Resume and configuration drift (D4)
// -------------------------------------------------------------------------------------------------

describe("D4: resume compares the full configuration, not just the seed", () => {
  test("drift in any identity-bearing field refuses the resume", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const original = openRunStore(options(artifactRoot, clock));
    original.close();

    const drifts: Array<[string, Partial<OpenRunStoreOptions>]> = [
      ["seed", { seed: "seed-2" }],
      ["sourceDigest", { sourceDigest: "src-digest-b" }],
      ["splitAssignmentDigest", { splitAssignmentDigest: "split-digest-b" }],
      ["corpusFreezeDigest", { corpusFreezeDigest: "freeze-digest-b" }],
      ["gitCommit", { gitCommit: "deadbee" }],
      [
        "generator",
        { generator: { provider: "openai-compatible", model: "fake-2", baseUrlDigest: "d1g35t", temperature: 0.7 } },
      ],
      ["validatorVersions", { validatorVersions: { "receipt-grounded-narration": "2.0.0" } }],
      ["storeVersion", { storeVersion: "run-store-v2" }],
    ];

    for (const [field, drift] of drifts) {
      assert.throws(
        () => openRunStore(options(artifactRoot, clock, drift)),
        (error: unknown) =>
          error instanceof ConfigDriftError &&
          error.differences.some((difference) => difference.startsWith(field)),
        `drift in ${field} must refuse the resume`,
      );
    }

    // The identical configuration resumes cleanly.
    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.seed(), "seed-1");
    resumed.close();
  });

  test("the same seed under a different scenario plan is exactly the drift that used to slip through", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    openRunStore(options(artifactRoot, clock)).close();

    assert.throws(
      () => openRunStore(options(artifactRoot, clock, { splitAssignmentDigest: "resplit-v2" })),
      (error: unknown) => error instanceof ConfigDriftError && /resplit-v2/.test(error.message),
    );
  });

  test("a budget or unit-total change is recorded as an amendment, never ignored", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const first = openRunStore(options(artifactRoot, clock, { totalUnits: 10 }));
    first.close();

    const raised: Partial<RunBudget> = { maxCostUsd: 50, maxTotalTokens: 1234 };
    const resumed = openRunStore(options(artifactRoot, clock, { budget: raised, totalUnits: 25 }));

    const snapshot = resumed.snapshot();
    assert.equal(snapshot.budget.maxCostUsd, 50);
    assert.equal(snapshot.budget.maxTotalTokens, 1234);
    assert.equal(snapshot.totalUnits, 25);
    assert.equal(snapshot.budgetAmendments.length, 1);
    assert.equal(snapshot.budgetAmendments[0]?.before.maxCostUsd, 25);
    assert.equal(snapshot.planAmendments.length, 1);
    assert.equal(snapshot.planAmendments[0]?.before, 10);
    assert.equal(snapshot.planAmendments[0]?.after, 25);
    resumed.close();

    // The amendment is durable, not a transient in-memory overlay.
    const reopened = openRunStore(options(artifactRoot, clock, { budget: raised, totalUnits: 25 }));
    assert.equal(reopened.snapshot().budget.maxCostUsd, 50);
    assert.equal(reopened.snapshot().budgetAmendments.length, 1, "an unchanged budget is not re-amended");
    reopened.close();
  });

  test("resume continues from the last completed stage", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    assert.equal(store.resumeFromStage, "plan");
    store.markStageComplete("plan");
    store.markStageComplete("generate");
    assert.equal(store.resumeFromStage, "validate");
    store.markStageComplete("generate"); // idempotent
    assert.equal(store.resumeFromStage, "validate");
    assert.deepEqual(store.snapshot().stagesCompleted, ["plan", "generate"]);
    store.close();

    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.resumeFromStage, "validate");
    for (const stage of RUN_STAGES) resumed.markStageComplete(stage);
    assert.equal(resumed.resumeFromStage, "done");
    resumed.close();
  });

  test("a declared configDigest that disagrees with the configuration is refused", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    assert.throws(
      () => openRunStore(options(artifactRoot, clock, { configDigest: "not-the-real-digest" })),
      /does not match the digest of the supplied configuration/,
    );
    const store = openRunStore(options(artifactRoot, clock));
    assert.equal(store.snapshot().configDigest, computeConfigDigest(store.config()));
    store.close();
  });
});

// -------------------------------------------------------------------------------------------------
// Fault-injection seam completeness
// -------------------------------------------------------------------------------------------------

describe("the fault seam can crash between any two durable steps", () => {
  test("every declared fault point is reachable from ordinary store usage", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const seen = new Set<FaultPoint>();
    const observer: FaultInjector = (context: FaultContext) => {
      seen.add(context.fault);
    };

    const store = openRunStore(options(artifactRoot, clock, { faultInjector: observer }));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("seam") });
    store.markUnitComplete("unit-1");
    store.reserveAttempt({ attemptId: "a1", requestDigest: "r", worstCaseTokens: 10, worstCaseCostUsd: 0.1 });
    store.settleAttempt({ attemptId: "a1", responseId: "resp", measuredTokens: 8, measuredCostUsd: 0.05 });
    store.checkpoint();
    store.close();

    const reopened = openRunStore(options(artifactRoot, clock, { faultInjector: observer }));
    reopened.close();

    const unreachable = FAULT_POINTS.filter((point) => !seen.has(point));
    assert.deepEqual(unreachable, [], `fault points that nothing can reach: ${unreachable.join(", ")}`);
  });
});

// -------------------------------------------------------------------------------------------------
// 6 + 7. Metered accounting (D5)
// -------------------------------------------------------------------------------------------------

describe("D5: reservations are prospective and settlement is exactly-once", () => {
  test("replaying a settlement is a no-op that returns the first result", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));

    store.reserveAttempt({ attemptId: "a1", requestDigest: "req-1", worstCaseTokens: 1000, worstCaseCostUsd: 0.5 });
    assert.equal(store.spend().reservedTokens, 1000);
    assert.equal(store.spend().providerRequests, 0, "a reservation is not yet a request");

    const first = store.settleAttempt({
      attemptId: "a1",
      responseId: "resp-1",
      measuredTokens: 640,
      measuredCostUsd: 0.32,
    });
    assert.equal(first.replayed, false);
    assert.equal(first.deltaTokens, -360);
    assert.equal(first.deltaCostUsd, -0.18);
    assert.equal(store.spend().settledTokens, 640);
    assert.equal(store.spend().reservedTokens, 0, "settling releases the reservation");
    assert.equal(store.spend().providerRequests, 1);

    clock.advance(5_000);
    const replay = store.settleAttempt({
      attemptId: "a1",
      responseId: "resp-1",
      measuredTokens: 640,
      measuredCostUsd: 0.32,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.settledAt, first.settledAt, "the first settlement's timestamp is preserved");
    assert.equal(store.spend().settledTokens, 640, "a replay does not double-count");
    assert.equal(store.spend().providerRequests, 1);
    assert.equal(store.spend().settledCostUsd, 0.32);

    // A replay that DISAGREES is an upstream bug, not an adjustment.
    assert.throws(
      () =>
        store.settleAttempt({
          attemptId: "a1",
          responseId: "resp-2",
          measuredTokens: 700,
          measuredCostUsd: 0.4,
        }),
      ConflictingSettlementError,
    );
    assert.equal(store.spend().settledTokens, 640);
    store.close();
  });

  test("an uncertain attempt retains its reservation and keeps consuming budget", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const budget: Partial<RunBudget> = { maxTotalTokens: 1_000, maxCostUsd: 1, maxProviderRequests: 10 };
    const store = openRunStore(options(artifactRoot, clock, { budget }));

    store.reserveAttempt({ attemptId: "a1", requestDigest: "req-1", worstCaseTokens: 1_000, worstCaseCostUsd: 1 });
    store.markAttemptUncertain("a1");

    const spend = store.spend();
    assert.equal(spend.uncertainAttempts, 1);
    assert.equal(spend.outstandingReservations, 0);
    assert.equal(spend.reservedTokens, 1_000, "the worst case is retained: payment may have happened");
    assert.equal(spend.reservedCostUsd, 1);
    assert.equal(spend.providerRequests, 1, "an uncertain dispatch is still a dispatched request");

    assert.equal(store.budgetExhausted(), "max-total-tokens", "reserved capacity counts toward the cap");
    assert.throws(
      () => store.reserveAttempt({ attemptId: "a2", requestDigest: "req-2", worstCaseTokens: 1, worstCaseCostUsd: 0.01 }),
      (error: unknown) => error instanceof BudgetExceededError && error.reason === "max-total-tokens",
    );

    // Marking twice is a no-op; settling a known outcome cannot become unknown.
    store.markAttemptUncertain("a1");
    assert.equal(store.spend().uncertainAttempts, 1);
    store.settleAttempt({ attemptId: "a1", responseId: "resp-late", measuredTokens: 10, measuredCostUsd: 0.01 });
    assert.throws(() => store.markAttemptUncertain("a1"), ConflictingSettlementError);

    // The uncertainty resolves, releasing the retained reservation.
    assert.equal(store.spend().reservedTokens, 0);
    assert.equal(store.spend().settledTokens, 10);
    store.close();
  });

  test("budgetExhausted sees reservations that have not been dispatched yet", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock, { budget: { maxTotalTokens: 100 } }));
    assert.equal(store.budgetExhausted(), null);
    store.reserveAttempt({ attemptId: "a1", requestDigest: "req", worstCaseTokens: 100, worstCaseCostUsd: 0 });
    assert.equal(store.budgetExhausted(), "max-total-tokens");
    assert.equal(store.spend().outstandingReservations, 1);
    store.close();
  });

  test("a reservation that would breach a cap is refused before dispatch", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(
      options(artifactRoot, clock, { budget: { maxCostUsd: 1, maxTotalTokens: 10_000 } }),
    );
    store.reserveAttempt({ attemptId: "a1", requestDigest: "req", worstCaseTokens: 10, worstCaseCostUsd: 0.5 });
    assert.equal(store.budgetExhausted(), null);
    assert.throws(
      () => store.reserveAttempt({ attemptId: "a2", requestDigest: "req", worstCaseTokens: 1, worstCaseCostUsd: 0.75 }),
      (error: unknown) => error instanceof BudgetExceededError && error.reason === "max-cost-usd",
    );
    assert.equal(store.spend().outstandingReservations, 1, "the refused reservation never became durable");

    // The request count cap is enforced the same way, before dispatch.
    const counted = openRunStore(
      options(join(caseRoot(), "requests"), clock, { budget: { maxProviderRequests: 1 } }),
    );
    counted.reserveAttempt({ attemptId: "b1", requestDigest: "req", worstCaseTokens: 1, worstCaseCostUsd: 0 });
    assert.throws(
      () => counted.reserveAttempt({ attemptId: "b2", requestDigest: "req", worstCaseTokens: 1, worstCaseCostUsd: 0 }),
      (error: unknown) => error instanceof BudgetExceededError && error.reason === "max-provider-requests",
    );
    counted.close();
    store.close();
  });

  test("overshoot is recorded rather than silently clamped", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    store.reserveAttempt({ attemptId: "a1", requestDigest: "req", worstCaseTokens: 100, worstCaseCostUsd: 0.1 });
    const settlement = store.settleAttempt({
      attemptId: "a1",
      responseId: "resp",
      measuredTokens: 250,
      measuredCostUsd: 0.25,
    });
    assert.equal(settlement.deltaTokens, 150);
    assert.equal(store.spend().overshootTokens, 150);
    assert.equal(store.spend().overshootCostUsd, 0.15);
    assert.equal(store.spend().settledTokens, 250);
    store.close();
  });

  test("negative, non-finite and inconsistent usage is rejected", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));

    // Tokens are whole units, so a fractional or non-finite token count is a bug.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.reserveAttempt({ attemptId: "bad", requestDigest: "r", worstCaseTokens: bad, worstCaseCostUsd: 0 }),
        InvalidUsageError,
        `worstCaseTokens ${bad} must be rejected`,
      );
    }
    // Dollars are fractional by nature; only negativity and non-finiteness are bugs.
    for (const bad of [-0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.reserveAttempt({ attemptId: "bad", requestDigest: "r", worstCaseTokens: 1, worstCaseCostUsd: bad }),
        InvalidUsageError,
        `worstCaseCostUsd ${bad} must be rejected`,
      );
    }
    assert.doesNotThrow(() =>
      store.reserveAttempt({ attemptId: "fractional", requestDigest: "r", worstCaseTokens: 1, worstCaseCostUsd: 0.005 }),
    );

    store.reserveAttempt({ attemptId: "a1", requestDigest: "req-1", worstCaseTokens: 10, worstCaseCostUsd: 0.1 });
    assert.throws(
      () => store.reserveAttempt({ attemptId: "a1", requestDigest: "req-1", worstCaseTokens: 11, worstCaseCostUsd: 0.1 }),
      /already reserved for a different request/,
    );
    assert.throws(
      () => store.settleAttempt({ attemptId: "a1", responseId: "r", measuredTokens: -5, measuredCostUsd: 0 }),
      InvalidUsageError,
    );
    assert.throws(
      () => store.settleAttempt({ attemptId: "never-reserved", responseId: "r", measuredTokens: 5, measuredCostUsd: 0 }),
      /no attempt is registered/,
    );
    // The failed calls left no accounting behind; only the two valid reservations do.
    assert.equal(store.spend().settledTokens, 0);
    assert.equal(store.spend().reservedTokens, 11);
    assert.equal(store.spend().outstandingReservations, 2);
    store.close();
  });

  test("wall-clock exhaustion uses the injected clock", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock, { budget: { maxWallClockMs: 60_000 } }));
    assert.equal(store.budgetExhausted(), null);
    clock.advance(60_000);
    assert.equal(store.budgetExhausted(), "max-wall-clock");
    store.close();
  });
});

// -------------------------------------------------------------------------------------------------
// 8. Path traversal
// -------------------------------------------------------------------------------------------------

describe("path safety: a run id can never escape the runs directory", () => {
  test("traversal, separators and control characters are rejected", () => {
    const unsafe = [
      "../escape",
      "../../etc",
      "..",
      ".",
      "a/b",
      "a\\b",
      "/absolute",
      "",
      " run",
      "run/",
      "-leading-dash",
      "nul byte",
      "x".repeat(129),
    ];
    for (const runId of unsafe) {
      assert.equal(isSafeRunId(runId), false, `${JSON.stringify(runId)} must not be a safe run id`);
      assert.throws(
        () => openRunStore({ runId, artifactRoot: caseRoot(), ...BASE_CONFIG, clock: Date.now, durability: "flush" }),
        UnsafeRunIdError,
        `${JSON.stringify(runId)} must be refused`,
      );
    }
  });

  test("the resolved run directory is asserted to be a direct child of <root>/runs", () => {
    const artifactRoot = caseRoot();
    const paths = runStorePaths("run-safe", artifactRoot);
    assert.equal(paths.runDir, join(paths.runsRoot, "run-safe"));
    assert.equal(paths.eventsPath.startsWith(paths.runDir), true);

    // Even with a symlinked-looking artifact root, containment is asserted from
    // resolved paths rather than from string prefixes alone.
    assert.equal(isSafeRunId("run-2026.04.01_final"), true);
    assert.throws(() => runStorePaths("../sibling", artifactRoot), UnsafeRunIdError);
  });

  test("payload file names cannot be influenced by the attempt id", () => {
    const name = attemptPayloadFileName("../../etc/passwd");
    assert.equal(name.includes(".."), false);
    assert.equal(name.includes("/"), false);
    assert.match(name, /^[0-9a-f]{40}\.json$/);
  });
});

// -------------------------------------------------------------------------------------------------
// 9. Single writer
// -------------------------------------------------------------------------------------------------

describe("single-writer lease", () => {
  test("a second open of the same run is refused while the first is live", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const store = openRunStore(options(artifactRoot, clock));

    assert.throws(
      () => openRunStore(options(artifactRoot, clock)),
      (error: unknown) => error instanceof RunLockError && error.holderPid === process.pid,
    );

    store.close();
    assert.equal(existsSync(paths.lockPath), false, "closing releases the lease");

    const reopened = openRunStore(options(artifactRoot, clock));
    assert.equal(reopened.snapshot().diagnostics.tookOverStaleLock, false);
    reopened.close();
  });

  test("an abandoned lease from a dead pid is taken over", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    openRunStore(options(artifactRoot, clock)).close();

    // A lease written by a process that no longer exists. pid 4194303 is above
    // every default pid_max, so `kill(pid, 0)` reliably reports ESRCH.
    writeFileSync(
      paths.lockPath,
      JSON.stringify({ pid: 4_194_303, acquiredAtMs: Date.parse("2026-03-01T00:00:00.000Z") }),
      "utf8",
    );

    const store = openRunStore(options(artifactRoot, clock));
    const diagnostics = store.snapshot().diagnostics;
    assert.equal(diagnostics.tookOverStaleLock, true);
    assert.equal(diagnostics.staleLockHolderPid, 4_194_303);
    store.close();
  });

  test("a corrupt lease file is treated as abandoned", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    openRunStore(options(artifactRoot, clock)).close();
    writeFileSync(paths.lockPath, "{ truncated", "utf8");

    const store = openRunStore(options(artifactRoot, clock));
    assert.equal(store.snapshot().diagnostics.tookOverStaleLock, true);
    store.close();
  });

  test("a closed store refuses further mutation", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    store.close();
    assert.throws(
      () => store.commitCandidate({ unitId: "u", attemptId: "a", record: candidate("closed") }),
      /is closed/,
    );
  });
});

// -------------------------------------------------------------------------------------------------
// Snapshot, digests and write amplification
// -------------------------------------------------------------------------------------------------

describe("derived snapshot, digests and write amplification", () => {
  test("the snapshot is a frozen copy, never the live internal state", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("frozen") });

    const first = store.snapshot();
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.spend), true);
    assert.equal(Object.isFrozen(first.completedUnitIds), true);
    assert.throws(() => {
      (first as { state: string }).state = "complete";
    }, TypeError);

    store.setState("complete");
    assert.equal(first.state, "planned", "a previously handed-out snapshot never changes");
    assert.equal(store.snapshot().state, "complete");
    store.close();
  });

  test("the snapshot file is replaced atomically and is not authoritative", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("atomic-file") });
    store.checkpoint();

    const onDisk = JSON.parse(readFileSync(paths.snapshotPath, "utf8")) as { completedUnits: number };
    assert.equal(onDisk.completedUnits, 0);

    // Deleting the snapshot loses nothing: the event log is the source of truth.
    rmSync(paths.snapshotPath, { force: true });
    store.close();
    const resumed = openRunStore(options(artifactRoot, clock));
    assert.equal(resumed.hasAttempt("attempt-1"), true);
    assert.equal(existsSync(paths.snapshotPath), true, "close rewrites it from the event log");
    resumed.close();
  });

  test("completing a unit does not rewrite the snapshot (D7)", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const paths = pathsFor(artifactRoot);
    const store = openRunStore(options(artifactRoot, clock));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("amp-1") });

    // A sentinel proves the file is not merely rewritten with identical bytes.
    store.checkpoint();
    const sentinel = "{\"sentinel\":true}\n";
    writeFileSync(paths.snapshotPath, sentinel, "utf8");

    store.markUnitComplete("unit-1");
    assert.equal(readFileSync(paths.snapshotPath, "utf8"), sentinel, "markUnitComplete must not rewrite the manifest");

    store.markUnitComplete("unit-1"); // idempotent
    store.commitCandidate({ unitId: "unit-2", attemptId: "attempt-2", record: candidate("amp-2") });
    store.markUnitComplete("unit-2");
    assert.equal(readFileSync(paths.snapshotPath, "utf8"), sentinel, "still no rewrite");

    store.checkpoint();
    assert.notEqual(readFileSync(paths.snapshotPath, "utf8"), sentinel);
    assert.equal(store.snapshot().completedUnits, 2);
    assert.deepEqual(store.snapshot().completedUnitIds, ["unit-1", "unit-2"]);
    store.close();
  });

  test("the logical digest ignores timestamps; the audit digest does not", () => {
    const build = (runId: string, clock: FakeClock): RunStore => {
      const artifactRoot = join(caseRoot(), runId);
      const store = openRunStore(options(artifactRoot, clock, { runId }));
      store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("digest") });
      store.commitCandidate({ unitId: "unit-2", attemptId: "attempt-2", record: candidate("digest-2") });
      store.close();
      return store;
    };

    const early = new FakeClock(Date.parse("2026-04-01T00:00:00.000Z"));
    const late = new FakeClock(Date.parse("2026-06-30T23:59:59.000Z"));
    const first = build("run-early", early);
    const second = build("run-late", late);

    assert.notEqual(first.auditResultsDigest(), second.auditResultsDigest(), "the audit digest sees the clock");
    assert.equal(first.logicalResultsDigest(), second.logicalResultsDigest(), "the logical digest does not");

    // A different logical result must change the digest, or it proves nothing.
    const third = new FakeClock(early.read());
    const artifactRoot = join(caseRoot(), "run-different");
    const other = openRunStore(options(artifactRoot, third, { runId: "run-different" }));
    other.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record: candidate("digest") });
    other.commitCandidate({ unitId: "unit-2", attemptId: "attempt-2", record: candidate("digest-CHANGED") });
    other.close();
    assert.notEqual(first.logicalResultsDigest(), other.logicalResultsDigest());

    // The pure helper strips volatile keys, at the top level and recursively.
    assert.equal(
      logicalResultsDigest([{ a: 1, writtenAt: "x" }]),
      logicalResultsDigest([{ a: 1, writtenAt: "y" }]),
    );
    assert.equal(
      logicalResultsDigest([{ a: 1, nested: { createdAt: "x" } }]),
      logicalResultsDigest([{ a: 1, nested: { createdAt: "y" } }]),
      "a nested provenance timestamp must not destabilize the digest",
    );
    assert.notEqual(
      logicalResultsDigest([{ a: 1, nested: { verdict: "x" } }]),
      logicalResultsDigest([{ a: 1, nested: { verdict: "y" } }]),
      "a nested LOGICAL field must still change the digest",
    );
  });

  test("candidates are stored and read back byte-identically", () => {
    const artifactRoot = caseRoot();
    const clock = new FakeClock();
    const roundTrip = certifiedCandidate("round-trip", { unitId: "unit-1" });
    const record = roundTrip.record;
    // Default durability (`fsync`), so the fsync-per-durable-write path is
    // covered rather than only the faster `flush` path the rest of the suite uses.
    const store = openRunStore(options(artifactRoot, clock, { durability: "fsync" }));
    store.commitCandidate({ unitId: "unit-1", attemptId: "attempt-1", record, admission: roundTrip.decision });
    // The store may re-derive admission status from the persisted certificate, so
    // compare the payload, not the admission bookkeeping the store owns.
    assert.deepEqual({ ...store.readCandidate("attempt-1")!, admission: record.admission }, { ...record, admission: record.admission });
    assert.equal(store.readCandidate("missing"), null);
    store.close();

    const resumed = openRunStore(options(artifactRoot, clock, { durability: "fsync" }));
    assert.deepEqual({ ...resumed.readCandidate("attempt-1")!, admission: record.admission }, { ...record, admission: record.admission });
    assert.deepEqual(resumed.candidates().map((entry) => ({ ...entry, admission: record.admission })), [record]);
    resumed.close();
  });
});

// -------------------------------------------------------------------------------------------------
// ESM git invocation (D6)
// -------------------------------------------------------------------------------------------------

describe("git revision capture under native ESM", () => {
  test("readGitCommit returns a real revision rather than null from a swallowed ReferenceError", () => {
    const commit = readGitCommit();
    // In this repository HEAD must resolve; the old lazy `require` made this
    // silently null under native ESM.
    assert.equal(typeof commit, "string");
    assert.match(commit ?? "", /^[0-9a-f]{40}$/);
    assert.equal(readGitCommit(join(ROOT, "definitely-not-a-repo")), null, "a missing git repo yields null, not a throw");
  });
});

/** Appends a torn suffix exactly as an interrupted process would leave it. */
function appendRaw(path: string, text: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, existing + text, "utf8");
}

/**
 * Builds a genuinely admitted record through the real admission constructor, so
 * runstore tests exercise the certified path rather than a status-only claim.
 * The store now refuses to read an uncertified record back as admitted.
 */
function certifiedCandidate(
  suffix: string,
  options: { family?: TrainingFamily; unitId?: string; recordId?: string } = {},
): {
  record: CandidateRecord;
  decision: AdmissionDecision;
} {
  const family = options.family ?? "roleplay-conversation";
  const unitId = options.unitId ?? `unit-${suffix}`;
  const recordId = options.recordId ?? `rec-${suffix}`;
  const lineage: LineageGroup = {
    characterFamily: "veiled-herald",
    worldFamily: "baie-comeau",
    scenarioFamily: "harbour-dawn",
  };
  const messages: CandidateRecord["messages"] = [
    { role: "system", content: `You are a herald of Baie-Comeau. Variant ${suffix}.` },
    { role: "user", content: "Tell me what the harbour looks like at dawn." },
    { role: "assistant", content: `Fog sits on the water, and the lamps go out one by one. (${suffix})` },
  ];
  const required = REQUIRED_VALIDATORS[family];
  const payloadDigest = computePayloadDigest({ messages });
  const admittedRecord = admitCandidate({
    family,
    recordId,
    unitId,
    lineage,
    split: "train",
    splitAssignmentDigest: "e".repeat(64),
    messages,
    provenance: {
      datasetVersion: "foundry-v1",
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      gitCommit: "c0ffee",
      scenarioSeed: `seed-${suffix}`,
      scenarioTemplate: "template-v1",
      sourceFixture: `case-${suffix}.json`,
      generator: { provider: "openai-compatible", model: "fake-1", baseUrlDigest: "d1g35t", temperature: 0.7 },
      reviewer: { provider: "openai-compatible", model: "kimi:k3", promptVersion: "review-v1" },
      sourceDigests: { case: `digest-${suffix}` },
      tokenCount: { tokenizer: "cl100k_base", tokens: 128 },
      syntheticOrigin: true,
      license: { status: "unverified", note: "test fixture" },
    },
    evidence: required.map((validator) => ({
      validator, version: "1.2.0", payloadDigest, evidenceDigest: "f".repeat(64), passed: true,
    })),
    reviews: [{
      reviewerIdentity: "kimi:k3",
      reviewerPromptDigest: "a".repeat(64),
      candidateDigest: payloadDigest,
      scores: {
        characterization: 0.8, dialogueQuality: 0.8, coherence: 0.9, narrativeInitiative: 0.7,
        playerAgency: 0.9, nonRepetitive: 0.8, verdict: "accept", rationale: "ok", reviewerCount: 1,
      },
    }],
    generatorIdentity: "fake-1",
  });
  const record: CandidateRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId,
    family,
    lineage,
    scenarioSeed: `seed-${suffix}`,
    messages,
    contentDigest: recordContentDigest({ messages }),
    // The candidate carries scenario provenance only; admission bookkeeping
    // (createdAt, validators, reviewer) is excluded, matching how the store
    // compares a certificate against its registered candidate.
    provenance: (() => {
      const { createdAt: _createdAt, validators: _validators, validatorVersions: _versions, reviewer: _reviewer, ...rest } = admittedRecord.provenance;
      return { ...rest, validators: [], validatorVersions: {}, reviewer: null };
    })(),
    admission: { status: "admitted", reasons: [], findings: {}, review: null, admittedAt: null },
  };
  return { record, decision: { status: "admitted", admittedRecord } };
}

