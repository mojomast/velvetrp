/**
 * Transactional, resumable run store for the VelvetRP training-data foundry.
 *
 * The defect class this module exists to eliminate is "write N files, then
 * record that you wrote N files". The previous ledger appended a candidate, then
 * a rejection, then a ledger row, then rewrote the manifest, then rewrote the
 * spend counters — five separate writes with five separate crash windows, and a
 * dedup index rebuilt only from the *last* of them. A crash anywhere in that
 * sequence produced a store that claimed a record had never been seen while a
 * candidate for it sat on disk, so the retry appended a second copy. Duplicate
 * training data is a silent, permanent corruption of a dataset; it is not
 * recoverable downstream.
 *
 * The design here collapses that into one durable append-only event table:
 *
 *  1. ONE source of truth. `events.jsonl` is a log of transactions. Every
 *     mutation — registration, admission, finalization, unit completion, stage
 *     completion, budget amendment, reservation, settlement — is an event inside
 *     exactly one transaction line. `manifest.json` is a DERIVED SNAPSHOT,
 *     written by atomic rename, and is never read back to make a decision.
 *     Deleting it is safe; a corrupt one is ignored.
 *  2. ONE atomic commit per logical change. A line terminator frames a
 *     transaction. Registration + admission + finalization + unit completion are
 *     one line, so there is no interleaving in which a record exists but its
 *     admission does not.
 *  3. Payloads are addressed side files written *before* the event that claims
 *     them, with atomic rename. An orphaned payload (crash between the two) is
 *     invisible to the store — no event, no record — and an identical retry
 *     rewrites the same bytes to the same path. Deduplication is by immutable
 *     `attemptId`, never by `recordId`, because a repair legitimately reuses the
 *     record id of the attempt it supersedes.
 *  4. Torn-write recovery is explicit and owned. On open, under an exclusive
 *     single-writer lease, an unterminated final line is truncated back to the
 *     last committed line boundary. A MALFORMED INTERIOR line is a hard error:
 *     skipping an interior line is silent data loss wearing a recovery costume.
 *  5. Metering is prospective. Capacity is reserved before dispatch, settled
 *     exactly once, and retained forever when the payment outcome is unknown.
 *     `budgetExhausted()` therefore counts money not yet spent but already
 *     committed, which is the only way to stop a request that would overshoot.
 *
 * Deliberate non-goals: no network, no provider SDK, nothing outside
 * `node:builtins`, and no attempt at concurrent writes to one run. Concurrency is
 * handled by refusing it with a lease, not by merging it.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateRecord, ReviewScores } from "./spec.js";
import { stableStringify } from "./spec.js";

// -------------------------------------------------------------------------------------------------
// Versions and constants
// -------------------------------------------------------------------------------------------------

/** On-disk format version. Bumped on any event-table or snapshot shape change. */
export const RUN_STORE_VERSION = "run-store-v1";

/** Artifact root used when the caller does not supply one. */
export const DEFAULT_ARTIFACT_ROOT = ".dataset";

/**
 * The ordered pipeline stages. Resume continues from the first stage that has
 * NOT been completed, never from "something was appended".
 */
export const RUN_STAGES = ["plan", "generate", "validate", "admit", "export", "done"] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export type RunState = "planned" | "running" | "complete" | "failed" | "aborted";

export type AdmissionStatus = "admitted" | "rejected" | "pending-review";

/** Admission statuses that may still become the unit's final answer. */
const ELIGIBLE_STATUSES: ReadonlySet<string> = new Set<AdmissionStatus>(["admitted", "pending-review"]);

/**
 * Run ids are directory names. Restricting them to a conservative charset is
 * cheaper and more total than sanitizing: `..`, `.`, `/`, `\`, NUL, leading
 * dashes and absolute-looking names never reach the filesystem at all.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A lease older than this is assumed to belong to a dead process. */
export const DEFAULT_STALE_LOCK_MS = 15 * 60 * 1_000;

/** USD accumulators are rounded at 1e-9 to keep binary float drift bounded. */
const USD_SCALE = 1e9;

// -------------------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------------------

export type RunStoreErrorCode =
  | "unsafe-run-id"
  | "run-locked"
  | "config-drift"
  | "corrupt-event-log"
  | "corrupt-payload"
  | "budget-exceeded"
  | "invalid-usage"
  | "duplicate-attempt"
  | "conflicting-settlement"
  | "unknown-attempt"
  | "unknown-unit"
  | "invalid-attempt"
  | "unit-finalized"
  | "run-closed"
  | "injected-crash";

/** Base class, so a caller can distinguish a store refusal from a programmer bug. */
export class RunStoreError extends Error {
  readonly code: RunStoreErrorCode;

  constructor(code: RunStoreErrorCode, message: string) {
    super(message);
    this.name = "RunStoreError";
    this.code = code;
  }
}

export class UnsafeRunIdError extends RunStoreError {
  constructor(runId: string, reason: string) {
    super("unsafe-run-id", `refusing to use run id ${JSON.stringify(runId)}: ${reason}`);
    this.name = "UnsafeRunIdError";
  }
}

export class RunLockError extends RunStoreError {
  readonly holderPid: number | null;
  readonly heldSinceMs: number | null;

  constructor(runId: string, holderPid: number | null, heldSinceMs: number | null) {
    super(
      "run-locked",
      `run ${JSON.stringify(runId)} is already open by another writer` +
        `${holderPid === null ? "" : ` (pid ${holderPid})`}` +
        `${heldSinceMs === null ? "" : ` since ${new Date(heldSinceMs).toISOString()}`}; ` +
        `a run store admits exactly one writer`,
    );
    this.name = "RunLockError";
    this.holderPid = holderPid;
    this.heldSinceMs = heldSinceMs;
  }
}

export class ConfigDriftError extends RunStoreError {
  readonly differences: readonly string[];

  constructor(runId: string, differences: readonly string[]) {
    super(
      "config-drift",
      `run ${JSON.stringify(runId)} was created with a different configuration and cannot be resumed: ` +
        `${differences.join("; ")}. Use a new run id instead of mixing two configurations under one id`,
    );
    this.name = "ConfigDriftError";
    this.differences = differences;
  }
}

export class RunCorruptionError extends RunStoreError {
  readonly path: string;
  readonly line: number | null;

  constructor(path: string, line: number | null, message: string) {
    super("corrupt-event-log", `${path}${line === null ? "" : `:${line}`}: ${message}`);
    this.name = "RunCorruptionError";
    this.path = path;
    this.line = line;
  }
}

export class CorruptPayloadError extends RunStoreError {
  readonly attemptId: string;

  constructor(attemptId: string, message: string) {
    super("corrupt-payload", `attempt payload ${JSON.stringify(attemptId)}: ${message}`);
    this.name = "CorruptPayloadError";
    this.attemptId = attemptId;
  }
}

export class BudgetExceededError extends RunStoreError {
  readonly reason: BudgetExhaustionReason;
  readonly projected: number;
  readonly limit: number;

  constructor(reason: BudgetExhaustionReason, projected: number, limit: number) {
    super("budget-exceeded", `run budget exhausted (${reason}): ${projected} would exceed the cap of ${limit}`);
    this.name = "BudgetExceededError";
    this.reason = reason;
    this.projected = projected;
    this.limit = limit;
  }
}

export class InvalidUsageError extends RunStoreError {
  constructor(message: string) {
    super("invalid-usage", message);
    this.name = "InvalidUsageError";
  }
}

export class ConflictingSettlementError extends RunStoreError {
  constructor(attemptId: string, message: string) {
    super("conflicting-settlement", `attempt ${JSON.stringify(attemptId)}: ${message}`);
    this.name = "ConflictingSettlementError";
  }
}

export class UnknownAttemptError extends RunStoreError {
  constructor(attemptId: string) {
    super("unknown-attempt", `no attempt is registered under ${JSON.stringify(attemptId)}`);
    this.name = "UnknownAttemptError";
  }
}

export class UnknownUnitError extends RunStoreError {
  constructor(unitId: string) {
    super("unknown-unit", `no unit is registered under ${JSON.stringify(unitId)}`);
    this.name = "UnknownUnitError";
  }
}

export class InvalidAttemptError extends RunStoreError {
  constructor(message: string) {
    super("invalid-attempt", message);
    this.name = "InvalidAttemptError";
  }
}

export class UnitFinalizedError extends RunStoreError {
  constructor(unitId: string, attemptId: string) {
    super(
      "unit-finalized",
      `unit ${JSON.stringify(unitId)} is finalized at attempt ${JSON.stringify(attemptId)}; ` +
        `a repair of a finalized unit needs a new unit id`,
    );
    this.name = "UnitFinalizedError";
  }
}

export class RunClosedError extends RunStoreError {
  constructor(runId: string) {
    super("run-closed", `run ${JSON.stringify(runId)} is closed; reopen it to continue`);
    this.name = "RunClosedError";
  }
}

/** Thrown by a test fault injector to simulate a crash at an exact seam. */
export class InjectedCrashError extends RunStoreError {
  readonly fault: FaultPoint;

  constructor(fault: FaultPoint) {
    super("injected-crash", `injected crash at fault point ${JSON.stringify(fault)}`);
    this.name = "InjectedCrashError";
    this.fault = fault;
  }
}

// -------------------------------------------------------------------------------------------------
// Fault injection seam
// -------------------------------------------------------------------------------------------------

/**
 * Every point at which a crash can be provoked. The seams sit *between* durable
 * steps, which is the only place a crash-consistency test has meaning: a fault at
 * `after-payload-write` is precisely the window that produced duplicate
 * candidates in the old ledger.
 */
export const FAULT_POINTS = [
  "before-lock",
  "after-lock",
  "before-recovery",
  "after-recovery",
  "before-payload-write",
  "after-payload-write",
  "before-event-append",
  "after-event-append",
  "before-snapshot",
  "after-snapshot",
  "before-close",
  "after-close",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultContext {
  readonly fault: FaultPoint;
  readonly runId: string;
  readonly txId: string;
}

export type FaultInjector = (context: FaultContext) => void;

// -------------------------------------------------------------------------------------------------
// Budget and configuration
// -------------------------------------------------------------------------------------------------

/** Per-run caps. A run stops cleanly and reportably rather than silently overspending. */
export interface RunBudget {
  /** Maximum provider requests, counting reserved-but-undispatched ones. */
  maxProviderRequests: number;
  /** Maximum total tokens, counting reserved-but-unsettled ones. */
  maxTotalTokens: number;
  /** Maximum USD. `null` disables the dollar ceiling. */
  maxCostUsd: number | null;
  /** Maximum wall-clock milliseconds measured from `startedAt`. */
  maxWallClockMs: number;
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxProviderRequests: 20_000,
  maxTotalTokens: 40_000_000,
  maxCostUsd: 25,
  maxWallClockMs: 4 * 60 * 60 * 1_000,
};

/** Merges partial overrides onto the defaults and rejects nonsense caps. */
export function resolveRunBudget(overrides?: Partial<RunBudget>): RunBudget {
  const budget: RunBudget = { ...DEFAULT_RUN_BUDGET, ...overrides };
  const finiteInts = [budget.maxProviderRequests, budget.maxTotalTokens, budget.maxWallClockMs];
  if (finiteInts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new InvalidUsageError(
      `budget request, token and wall-clock caps must be non-negative safe integers, received ${stableStringify(budget)}`,
    );
  }
  if (budget.maxCostUsd !== null && (!Number.isFinite(budget.maxCostUsd) || budget.maxCostUsd < 0)) {
    throw new InvalidUsageError("budget.maxCostUsd must be null or a finite non-negative number");
  }
  return budget;
}

/** Generator identity. `baseUrlDigest` is a digest, never the endpoint URL. */
export interface GeneratorIdentity {
  readonly provider: string;
  readonly model: string;
  readonly baseUrlDigest: string | null;
  readonly temperature: number;
}

export const UNKNOWN_GENERATOR: GeneratorIdentity = {
  provider: "unknown",
  model: "unknown",
  baseUrlDigest: null,
  temperature: 0,
};

/**
 * Everything that makes a run reproducible. Resume compares a digest of the
 * identity-bearing fields, so a run cannot silently continue under a different
 * scenario plan, generator, validator set, split assignment or frozen corpus.
 *
 * `budget` and `totalUnits` are deliberately OUT of `configDigest`: they are
 * operational, not identifying. Raising a cap mid-run is legitimate and is
 * recorded as an explicit amendment event rather than ignored or refused.
 */
export interface RunConfig {
  readonly runId: string;
  readonly seed: string;
  readonly gitCommit: string | null;
  /** Digest of the source tree that produced this run's code. */
  readonly sourceDigest: string;
  readonly storeVersion: string;
  readonly generator: GeneratorIdentity;
  readonly validatorVersions: Readonly<Record<string, string>>;
  readonly splitAssignmentDigest: string;
  readonly corpusFreezeDigest: string;
  readonly budget: RunBudget;
  readonly totalUnits: number;
}

/** The identity-bearing subset of a config, i.e. what a resume must match. */
export type RunConfigIdentity = Omit<RunConfig, "budget" | "totalUnits">;

/** The identity projection, exported so callers can display it in a report. */
export function runConfigIdentity(config: RunConfig | RunConfigIdentity): RunConfigIdentity {
  return {
    runId: config.runId,
    seed: config.seed,
    gitCommit: config.gitCommit,
    sourceDigest: config.sourceDigest,
    storeVersion: config.storeVersion,
    generator: config.generator,
    validatorVersions: config.validatorVersions,
    splitAssignmentDigest: config.splitAssignmentDigest,
    corpusFreezeDigest: config.corpusFreezeDigest,
  };
}

/**
 * Digest over the identity-bearing fields. Excludes `budget` and `totalUnits` by
 * construction; include those only via `budgetDigest` if a caller really wants
 * caps inside their own identity.
 */
export function computeConfigDigest(config: RunConfig | RunConfigIdentity): string {
  return sha256(stableStringify(runConfigIdentity(config)));
}

/** Digest of a budget alone. */
export function budgetDigest(budget: RunBudget): string {
  return sha256(stableStringify(budget));
}

// -------------------------------------------------------------------------------------------------
// Paths and run-id safety
// -------------------------------------------------------------------------------------------------

export interface RunStorePaths {
  readonly root: string;
  readonly runsRoot: string;
  readonly runDir: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  readonly lockPath: string;
  readonly attemptsDir: string;
}

/** True when `runId` can be used as a single, non-escaping path segment. */
export function isSafeRunId(runId: string): boolean {
  if (typeof runId !== "string") return false;
  if (runId.length === 0 || runId.length > 128) return false;
  if (!RUN_ID_PATTERN.test(runId)) return false;
  if (runId.includes("..")) return false;
  return runId !== "." && runId !== "..";
}

/** Throws `UnsafeRunIdError` unless the id can never escape its parent directory. */
export function assertSafeRunId(runId: string): string {
  if (typeof runId !== "string") {
    throw new UnsafeRunIdError(String(runId), "run ids must be strings");
  }
  if (runId.length === 0) throw new UnsafeRunIdError(runId, "run ids must not be empty");
  if (runId.includes("..")) throw new UnsafeRunIdError(runId, "run ids must not contain '..'");
  if (runId.includes("/") || runId.includes("\\")) {
    throw new UnsafeRunIdError(runId, "run ids must be a single path segment");
  }
  if (runId.includes("\0")) throw new UnsafeRunIdError(runId, "run ids must not contain NUL");
  if (!isSafeRunId(runId)) {
    throw new UnsafeRunIdError(
      runId,
      `run ids must match ${RUN_ID_PATTERN.source} (leading alphanumeric, then alphanumerics, dot, dash or underscore)`,
    );
  }
  return runId;
}

/**
 * Resolves the run directory and proves by CONTAINMENT, not by pattern alone,
 * that it is a direct child of `<root>/runs`. `relative(runsRoot, runDir)` is
 * exactly the run id only if no traversal occurred, which is belt to the regex
 * braces: a traversal defect here would let one run id truncate another run's
 * event log.
 */
export function runStorePaths(runId: string, artifactRoot = DEFAULT_ARTIFACT_ROOT): RunStorePaths {
  assertSafeRunId(runId);
  const root = resolve(artifactRoot);
  const runsRoot = join(root, "runs");
  const runDir = resolve(runsRoot, runId);
  const fromRunsRoot = relative(runsRoot, runDir);
  if (fromRunsRoot !== runId || fromRunsRoot.startsWith("..") || isAbsolute(fromRunsRoot)) {
    throw new UnsafeRunIdError(
      runId,
      `resolved run directory ${runDir} is not a direct child of ${runsRoot}`,
    );
  }
  if (!runDir.startsWith(runsRoot + sep)) {
    throw new UnsafeRunIdError(runId, `resolved run directory ${runDir} is not inside ${runsRoot}`);
  }
  return {
    root,
    runsRoot,
    runDir,
    eventsPath: join(runDir, "events.jsonl"),
    snapshotPath: join(runDir, "manifest.json"),
    lockPath: join(runDir, "writer.lock"),
    attemptsDir: join(runDir, "attempts"),
  };
}

// -------------------------------------------------------------------------------------------------
// Digests
// -------------------------------------------------------------------------------------------------

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Digest of a record's conversational bytes, independent of its provenance. */
export function recordContentDigest(record: Pick<CandidateRecord, "messages" | "tools">): string {
  return sha256(stableStringify({ messages: record.messages, tools: record.tools ?? null }));
}

/**
 * Keys whose values are wall-clock artifacts. Stripped before a logical digest so
 * two runs that produced the same examples at different times compare equal.
 * Recursive because provenance timestamps are nested inside records.
 */
export const VOLATILE_DIGEST_KEYS: ReadonlySet<string> = new Set([
  "writtenAt",
  "registeredAt",
  "settledAt",
  "reservedAt",
  "markedUncertainAt",
  "finalizedAt",
  "admittedAt",
  "completedAt",
  "updatedAt",
  "startedAt",
  "createdAt",
  "at",
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_DIGEST_KEYS.has(key)) continue;
      out[key] = stripVolatile(entry);
    }
    return out;
  }
  return value;
}

/**
 * Digest of the LOGICAL result set: same examples, same verdicts, same order of
 * derivation → same digest, regardless of when the work happened. This is the
 * digest to compare two runs by.
 */
export function logicalResultsDigest(entries: readonly unknown[]): string {
  return sha256(stableStringify(entries.map(stripVolatile)));
}

/**
 * Digest that DOES include timestamps. Kept alongside the logical digest so an
 * audit can prove two runs were not merely equivalent but co-temporal, without
 * contaminating the reproducibility comparison.
 */
export function auditResultsDigest(entries: readonly unknown[]): string {
  return sha256(stableStringify(entries));
}

/**
 * Digest of a source tree: every file's relative path plus content hash, sorted.
 * Used for `RunConfig.sourceDigest`, so a code change invalidates a resume even
 * when the commit hash happens to be unavailable.
 */
export function sourceTreeDigest(
  directory: string,
  options: { readonly skip?: readonly string[] } = {},
): string {
  const root = resolve(directory);
  const skip = new Set(options.skip ?? [".git", "node_modules", DEFAULT_ARTIFACT_ROOT, "dist"]);
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile()) {
        files.push({
          path: relative(root, full),
          sha256: createHash("sha256").update(readFileSync(full)).digest("hex"),
        });
      }
    }
  };
  walk(root);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256(stableStringify(files));
}

/**
 * The repository commit, or `null` when git is unavailable or this is not a work
 * tree. The `child_process` import is STATIC: the previous lazy
 * `require("node:child_process")` was `undefined` under native ESM, the
 * resulting ReferenceError was swallowed by the surrounding catch, and every run
 * silently recorded `gitCommit: null`. The `catch` is now scoped to the git
 * invocation alone, and the "no git" path cannot masquerade as a code defect.
 */
export function readGitCommit(cwd = process.cwd()): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// Event table
// -------------------------------------------------------------------------------------------------

/**
 * Every event body, one per logical mutation, carried inside a transaction
 * envelope. The union is closed on purpose: an unrecognized event type is a
 * corruption signal, not something to skip, because skipping an event this code
 * cannot interpret silently drops state it does not know how to rebuild.
 */
export type RunEventBody =
  | { type: "run.created"; runId: string; configDigest: string; config: RunConfig }
  | { type: "budget.amended"; before: RunBudget; after: RunBudget; reason: string | null }
  | { type: "plan.amended"; before: number; after: number; reason: string | null }
  | { type: "run.state"; from: RunState; to: RunState }
  | { type: "run.note"; note: string }
  | { type: "stage.completed"; stage: RunStage }
  | {
      type: "attempt.registered";
      unitId: string;
      attemptId: string;
      parentAttemptId: string | null;
      recordId: string;
      family: string;
      scenarioSeed: string;
      contentDigest: string;
      payloadDigest: string;
      payloadFile: string;
      status: AdmissionStatus;
      reasons: string[];
      findings: Record<string, unknown> | null;
      review: ReviewScores | null;
    }
  | {
      type: "attempt.admitted";
      unitId: string;
      attemptId: string;
      status: AdmissionStatus;
      reasons: string[];
      findings: Record<string, unknown> | null;
      review: ReviewScores | null;
      admittedAt: string | null;
    }
  | { type: "unit.finalized"; unitId: string; attemptId: string }
  | { type: "unit.completed"; unitId: string }
  | {
      type: "attempt.reserved";
      attemptId: string;
      requestDigest: string;
      worstCaseTokens: number;
      worstCaseCostUsd: number;
    }
  | {
      type: "attempt.settled";
      attemptId: string;
      responseId: string;
      measuredTokens: number;
      measuredCostUsd: number;
    }
  | { type: "attempt.uncertain"; attemptId: string };

const RUN_EVENT_TYPES: ReadonlySet<string> = new Set<RunEventBody["type"]>([
  "run.created",
  "budget.amended",
  "plan.amended",
  "run.state",
  "run.note",
  "stage.completed",
  "attempt.registered",
  "attempt.admitted",
  "unit.finalized",
  "unit.completed",
  "attempt.reserved",
  "attempt.settled",
  "attempt.uncertain",
]);

export interface RunTransaction {
  readonly seq: number;
  readonly txId: string;
  readonly at: string;
  readonly events: readonly RunEventBody[];
}

interface ParsedEventLog {
  transactions: RunTransaction[];
  truncatedBytes: number;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the event log.
 *
 * - An unterminated final line is an interrupted append. It is reported as
 *   `truncatedBytes`; the caller truncates it under its exclusive lease.
 * - A malformed INTERIOR line throws. The old reader dropped any line
 *   `JSON.parse` rejected, which loses committed state while still returning a
 *   plausible-looking array.
 */
function parseEventLog(path: string): ParsedEventLog {
  if (!existsSync(path)) return { transactions: [], truncatedBytes: 0 };
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return { transactions: [], truncatedBytes: 0 };

  let committed = text;
  let truncatedBytes = 0;
  if (!text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    committed = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
    truncatedBytes = Buffer.byteLength(text, "utf8") - Buffer.byteLength(committed, "utf8");
  }

  const transactions: RunTransaction[] = [];
  let expectedSeq = 1;
  const segments = committed.split("\n");
  segments.pop(); // the trailing empty segment after the final newline
  for (let index = 0; index < segments.length; index += 1) {
    const lineNumber = index + 1;
    const line = segments[index] ?? "";
    if (line.trim().length === 0) {
      throw new RunCorruptionError(
        path,
        lineNumber,
        "blank interior line in the event log; the writer never emits one, so this file is corrupt",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw new RunCorruptionError(
        path,
        lineNumber,
        `line is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    if (!isJsonObject(parsed)) {
      throw new RunCorruptionError(path, lineNumber, "transaction envelope is not a JSON object");
    }
    if (parsed.seq !== expectedSeq) {
      throw new RunCorruptionError(
        path,
        lineNumber,
        `expected transaction seq ${expectedSeq} but found ${JSON.stringify(parsed.seq)}`,
      );
    }
    if (typeof parsed.txId !== "string" || parsed.txId.length === 0) {
      throw new RunCorruptionError(path, lineNumber, "transaction envelope is missing a txId");
    }
    if (typeof parsed.at !== "string") {
      throw new RunCorruptionError(path, lineNumber, "transaction envelope is missing a timestamp");
    }
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
      throw new RunCorruptionError(path, lineNumber, "transaction carries no events");
    }
    for (const event of parsed.events) {
      if (!isJsonObject(event) || typeof event.type !== "string" || !RUN_EVENT_TYPES.has(event.type)) {
        throw new RunCorruptionError(
          path,
          lineNumber,
          `unknown event type ${JSON.stringify(isJsonObject(event) ? event.type : event)}; refusing to skip it`,
        );
      }
    }
    transactions.push({
      seq: parsed.seq,
      txId: parsed.txId,
      at: parsed.at,
      events: parsed.events as RunEventBody[],
    });
    expectedSeq += 1;
  }
  return { transactions, truncatedBytes };
}

// -------------------------------------------------------------------------------------------------
// Projection derived from the event log (never the reverse)
// -------------------------------------------------------------------------------------------------

interface AttemptProjection {
  unitId: string;
  attemptId: string;
  parentAttemptId: string | null;
  recordId: string;
  family: string;
  scenarioSeed: string;
  contentDigest: string;
  payloadDigest: string;
  payloadFile: string;
  status: AdmissionStatus;
  reasons: string[];
  findings: Record<string, unknown> | null;
  review: ReviewScores | null;
  registeredAt: string;
  ordinal: number;
  supersededBy: string | null;
  admittedAt: string | null;
}

interface UnitProjection {
  unitId: string;
  order: string[];
  attempts: Map<string, AttemptProjection>;
  finalizedAttemptId: string | null;
  completedAt: string | null;
}

interface AttemptMeter {
  attemptId: string;
  requestDigest: string | null;
  worstCaseTokens: number;
  worstCaseCostUsd: number;
  state: "reserved" | "settled" | "uncertain";
  responseId: string | null;
  measuredTokens: number | null;
  measuredCostUsd: number | null;
  settledAt: string | null;
  markedUncertainAt: string | null;
  reservedAt: string;
}

interface Projection {
  runId: string;
  config: RunConfig;
  configDigest: string;
  created: boolean;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  budget: RunBudget;
  totalUnits: number;
  stages: Set<RunStage>;
  notes: string[];
  budgetAmendments: BudgetAmendment[];
  planAmendments: PlanAmendment[];
  units: Map<string, UnitProjection>;
  unitOrder: string[];
  meters: Map<string, AttemptMeter>;
  lastSeq: number;
}

function emptyProjection(): Projection {
  return {
    runId: "",
    config: {
      runId: "",
      seed: "",
      gitCommit: null,
      sourceDigest: "",
      storeVersion: RUN_STORE_VERSION,
      generator: UNKNOWN_GENERATOR,
      validatorVersions: {},
      splitAssignmentDigest: "",
      corpusFreezeDigest: "",
      budget: DEFAULT_RUN_BUDGET,
      totalUnits: 0,
    },
    configDigest: "",
    created: false,
    state: "planned",
    startedAt: "",
    updatedAt: "",
    lastEventAt: null,
    budget: DEFAULT_RUN_BUDGET,
    totalUnits: 0,
    stages: new Set<RunStage>(),
    notes: [],
    budgetAmendments: [],
    planAmendments: [],
    units: new Map<string, UnitProjection>(),
    unitOrder: [],
    meters: new Map<string, AttemptMeter>(),
    lastSeq: 0,
  };
}

function applyEvent(projection: Projection, event: RunEventBody, at: string): void {
  switch (event.type) {
    case "run.created": {
      projection.config = event.config;
      projection.configDigest = event.configDigest;
      projection.budget = event.config.budget;
      projection.totalUnits = event.config.totalUnits;
      projection.runId = event.runId;
      projection.startedAt = at;
      projection.created = true;
      return;
    }
    case "budget.amended": {
      projection.budget = event.after;
      projection.config = { ...projection.config, budget: event.after };
      projection.budgetAmendments.push({ before: event.before, after: event.after, reason: event.reason, at });
      return;
    }
    case "plan.amended": {
      projection.totalUnits = event.after;
      projection.config = { ...projection.config, totalUnits: event.after };
      projection.planAmendments.push({ before: event.before, after: event.after, reason: event.reason, at });
      return;
    }
    case "run.state": {
      projection.state = event.to;
      return;
    }
    case "run.note": {
      if (!projection.notes.includes(event.note)) projection.notes.push(event.note);
      return;
    }
    case "stage.completed": {
      projection.stages.add(event.stage);
      return;
    }
    case "attempt.registered": {
      const existing = projection.units.get(event.unitId);
      const unit: UnitProjection = existing ?? {
        unitId: event.unitId,
        order: [],
        attempts: new Map<string, AttemptProjection>(),
        finalizedAttemptId: null,
        completedAt: null,
      };
      if (existing === undefined) {
        projection.units.set(event.unitId, unit);
        projection.unitOrder.push(event.unitId);
      }
      const attempt: AttemptProjection = {
        unitId: event.unitId,
        attemptId: event.attemptId,
        parentAttemptId: event.parentAttemptId,
        recordId: event.recordId,
        family: event.family,
        scenarioSeed: event.scenarioSeed,
        contentDigest: event.contentDigest,
        payloadDigest: event.payloadDigest,
        payloadFile: event.payloadFile,
        status: event.status,
        reasons: event.reasons,
        findings: event.findings,
        review: event.review,
        registeredAt: at,
        ordinal: unit.order.length + 1,
        supersededBy: null,
        admittedAt: null,
      };
      if (event.parentAttemptId !== null) {
        const parent = unit.attempts.get(event.parentAttemptId);
        if (!parent) {
          throw new RunCorruptionError(
            "(replay)",
            null,
            `attempt ${event.attemptId} names parent ${event.parentAttemptId}, which was never registered`,
          );
        }
        parent.supersededBy = event.attemptId;
      }
      unit.attempts.set(event.attemptId, attempt);
      unit.order.push(event.attemptId);
      return;
    }
    case "attempt.admitted": {
      const attempt = requireAttempt(projection, event.unitId, event.attemptId);
      attempt.status = event.status;
      attempt.reasons = event.reasons;
      attempt.findings = event.findings;
      attempt.review = event.review;
      attempt.admittedAt = event.admittedAt;
      return;
    }
    case "unit.finalized": {
      const unit = projection.units.get(event.unitId);
      if (!unit || !unit.attempts.has(event.attemptId)) {
        throw new RunCorruptionError(
          "(replay)",
          null,
          `cannot finalize ${JSON.stringify(event.unitId)} at unknown attempt ${event.attemptId}`,
        );
      }
      unit.finalizedAttemptId = event.attemptId;
      return;
    }
    case "unit.completed": {
      const unit = projection.units.get(event.unitId);
      if (!unit) {
        throw new RunCorruptionError(
          "(replay)",
          null,
          `cannot complete ${JSON.stringify(event.unitId)}: the unit was never registered`,
        );
      }
      unit.completedAt = at;
      return;
    }
    case "attempt.reserved": {
      projection.meters.set(event.attemptId, {
        attemptId: event.attemptId,
        requestDigest: event.requestDigest,
        worstCaseTokens: event.worstCaseTokens,
        worstCaseCostUsd: event.worstCaseCostUsd,
        state: "reserved",
        responseId: null,
        measuredTokens: null,
        measuredCostUsd: null,
        settledAt: null,
        markedUncertainAt: null,
        reservedAt: at,
      });
      return;
    }
    case "attempt.settled": {
      const meter = projection.meters.get(event.attemptId);
      if (!meter) {
        throw new RunCorruptionError("(replay)", null, `cannot settle ${event.attemptId}: it was never reserved`);
      }
      meter.state = "settled";
      meter.responseId = event.responseId;
      meter.measuredTokens = event.measuredTokens;
      meter.measuredCostUsd = event.measuredCostUsd;
      meter.settledAt = at;
      return;
    }
    case "attempt.uncertain": {
      const meter = projection.meters.get(event.attemptId);
      if (!meter) {
        throw new RunCorruptionError("(replay)", null, `cannot mark ${event.attemptId} uncertain: it was never reserved`);
      }
      meter.state = "uncertain";
      meter.markedUncertainAt = at;
      return;
    }
    default: {
      const unhandled: never = event;
      throw new RunCorruptionError("(replay)", null, `unhandled event type ${JSON.stringify(unhandled)}`);
    }
  }
}

function requireAttempt(projection: Projection, unitId: string, attemptId: string): AttemptProjection {
  const attempt = projection.units.get(unitId)?.attempts.get(attemptId);
  if (!attempt) {
    throw new RunCorruptionError(
      "(replay)",
      null,
      `attempt ${JSON.stringify(attemptId)} of unit ${JSON.stringify(unitId)} is missing from the event log`,
    );
  }
  return attempt;
}

function replayEventLog(path: string): { projection: Projection; truncatedBytes: number; transactions: number } {
  const { transactions, truncatedBytes } = parseEventLog(path);
  const projection = emptyProjection();
  for (const transaction of transactions) {
    for (const event of transaction.events) applyEvent(projection, event, transaction.at);
    projection.updatedAt = transaction.at;
    projection.lastEventAt = transaction.at;
    projection.lastSeq = transaction.seq;
  }
  return { projection, truncatedBytes, transactions: transactions.length };
}

// -------------------------------------------------------------------------------------------------
// Derived views (all frozen, all rebuilt from the event log)
// -------------------------------------------------------------------------------------------------

export interface LedgerEntry {
  unitId: string;
  attemptId: string;
  parentAttemptId: string | null;
  recordId: string;
  family: string;
  scenarioSeed: string;
  contentDigest: string;
  admissionStatus: AdmissionStatus;
  reasons: string[];
  finalized: boolean;
  completed: boolean;
  superseded: boolean;
  ordinal: number;
  writtenAt: string;
}

export interface UnitCandidate {
  unitId: string;
  attemptId: string;
  parentAttemptId: string | null;
  recordId: string;
  family: string;
  scenarioSeed: string;
  contentDigest: string;
  status: AdmissionStatus;
  reasons: string[];
  ordinal: number;
  finalized: boolean;
  superseded: boolean;
  payloadFile: string;
  payloadDigest: string;
  registeredAt: string;
}

export interface UnitSummary {
  unitId: string;
  attemptCount: number;
  attempts: readonly UnitCandidate[];
  finalizedAttemptId: string | null;
  completed: boolean;
  completedAt: string | null;
  effective: UnitCandidate | null;
}

export type BudgetExhaustionReason =
  | "max-provider-requests"
  | "max-total-tokens"
  | "max-cost-usd"
  | "max-wall-clock";

/**
 * Spend, split the way `turnBudget.ts` splits it: what was MEASURED versus what
 * was estimated locally. Keeping the two apart is what makes a token regression
 * diagnosable instead of merely visible.
 */
export interface SpendSummary {
  /** Settled dispatches plus attempts whose payment outcome is unknown. */
  providerRequests: number;
  settledAttempts: number;
  uncertainAttempts: number;
  /** Reservations that are neither settled nor uncertain. */
  outstandingReservations: number;
  settledTokens: number;
  settledCostUsd: number;
  /** Tokens attributable to provider-reported usage. */
  providerMeasuredTokens: number;
  /** Tokens attributable to local estimation (settled without provider usage). */
  locallyEstimatedTokens: number;
  /** Still-reserved tokens, INCLUDING retained uncertain reservations. */
  reservedTokens: number;
  reservedCostUsd: number;
  /** Measured amounts that exceeded their own worst-case reservation. */
  overshootTokens: number;
  overshootCostUsd: number;
}

export interface Reservation {
  attemptId: string;
  requestDigest: string;
  worstCaseTokens: number;
  worstCaseCostUsd: number;
  reservedAt: string;
  /** True when the reservation already existed and this call was a replay. */
  replayed: boolean;
}

export interface Settlement {
  attemptId: string;
  responseId: string;
  measuredTokens: number;
  measuredCostUsd: number;
  /** Measured minus worst case. Negative means the reservation was conservative. */
  deltaTokens: number;
  deltaCostUsd: number;
  settledAt: string;
  /** True when a settlement already existed and this call returned the first result. */
  replayed: boolean;
}

export interface AttemptAccounting {
  attemptId: string;
  requestDigest: string | null;
  worstCaseTokens: number;
  worstCaseCostUsd: number;
  state: "reserved" | "settled" | "uncertain";
  responseId: string | null;
  measuredTokens: number | null;
  measuredCostUsd: number | null;
  settledAt: string | null;
  markedUncertainAt: string | null;
}

export interface BudgetAmendment {
  before: RunBudget;
  after: RunBudget;
  reason: string | null;
  at: string;
}

export interface PlanAmendment {
  before: number;
  after: number;
  reason: string | null;
  at: string;
}

export interface OpenDiagnostics {
  /** Bytes discarded from an unterminated trailing line. */
  truncatedBytes: number;
  /** True when a lease was taken over from a presumed-dead holder. */
  tookOverStaleLock: boolean;
  staleLockHolderPid: number | null;
  /** Transactions read back from the durable log. */
  replayedTransactions: number;
}

export interface RunSnapshot {
  readonly storeVersion: string;
  readonly runId: string;
  readonly seed: string;
  readonly configDigest: string;
  readonly config: RunConfig;
  readonly gitCommit: string | null;
  readonly sourceDigest: string;
  readonly state: RunState;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastEventAt: string | null;
  readonly budget: RunBudget;
  readonly spend: SpendSummary;
  readonly totalUnits: number;
  readonly completedUnits: number;
  /** Units in event order. Never re-sorted and never rewritten per completion. */
  readonly completedUnitIds: readonly string[];
  readonly stagesCompleted: readonly RunStage[];
  /** First stage not yet completed. `done` only when every stage completed. */
  readonly resumeFromStage: RunStage;
  readonly notes: readonly string[];
  readonly budgetAmendments: readonly BudgetAmendment[];
  readonly planAmendments: readonly PlanAmendment[];
  readonly unitIds: readonly string[];
  readonly diagnostics: OpenDiagnostics;
}

// -------------------------------------------------------------------------------------------------
// Value helpers
// -------------------------------------------------------------------------------------------------

function roundUsd(value: number): number {
  return Math.round(value * USD_SCALE) / USD_SCALE;
}

function requireNonEmptyString(value: string, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidUsageError(`${what} must be a non-empty string`);
  }
  return value;
}

function requireTokenCount(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidUsageError(`${what} must be a non-negative safe integer, received ${String(value)}`);
  }
  return value;
}

function requireCostUsd(value: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InvalidUsageError(`${what} must be a finite non-negative number, received ${String(value)}`);
  }
  return roundUsd(value);
}

function requireAdmissionStatus(status: AdmissionStatus): AdmissionStatus {
  if (status !== "admitted" && status !== "rejected" && status !== "pending-review") {
    throw new InvalidUsageError(
      `admission status must be "admitted", "rejected" or "pending-review", received ${JSON.stringify(status)}`,
    );
  }
  return status;
}

function normalizeReasons(reasons: readonly string[] | undefined): string[] {
  if (reasons === undefined) return [];
  if (!Array.isArray(reasons)) throw new InvalidUsageError("admission reasons must be an array of strings");
  return reasons.map((reason) => requireNonEmptyString(reason, "admission reason"));
}

function isRunStage(value: string): value is RunStage {
  return (RUN_STAGES as readonly string[]).includes(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** Fresh, frozen deep copy: a caller can never reach the store's live state. */
function frozenCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/** Temp file + fsync + rename: a reader sees either the old bytes or the new ones. */
function writeFileAtomic(path: string, contents: string, fsync: boolean): void {
  const temp = `${path}.tmp-${process.pid.toString(36)}-${randomSuffix()}`;
  const fd = openSync(temp, "wx");
  try {
    writeAll(fd, contents);
    if (fsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Process-local, dependency-free uniqueness suffix for temp file names. */
let suffixCounter = 0;
function randomSuffix(): string {
  suffixCounter += 1;
  return `${Date.now().toString(36)}${suffixCounter.toString(36)}`;
}

// -------------------------------------------------------------------------------------------------
// Attempt payload side files
// -------------------------------------------------------------------------------------------------

export interface StoredAttemptPayload {
  readonly storeVersion: string;
  readonly attemptId: string;
  readonly unitId: string;
  readonly parentAttemptId: string | null;
  readonly payloadDigest: string;
  readonly writtenAt: string;
  readonly record: CandidateRecord;
}

/**
 * Payload file name. The attempt id is hashed rather than used verbatim, so an
 * arbitrary caller-supplied id can never influence a path; the id is stored
 * inside the file too, so a genuine hash collision is detected rather than
 * silently overwritten.
 */
export function attemptPayloadFileName(attemptId: string): string {
  return `${sha256(attemptId).slice(0, 40)}.json`;
}

// -------------------------------------------------------------------------------------------------
// Public option and input types
// -------------------------------------------------------------------------------------------------

export interface OpenRunStoreOptions {
  readonly runId: string;
  readonly seed: string;
  /** Digest of the source tree producing this run. Required. */
  readonly sourceDigest: string;
  /** Digest of the split assignment. Required. */
  readonly splitAssignmentDigest: string;
  /** Digest of the frozen corpus. Required. */
  readonly corpusFreezeDigest: string;
  /** Precomputed identity digest; asserted against the computed value when given. */
  readonly configDigest?: string;
  readonly artifactRoot?: string;
  /** Defaults to the repository HEAD. */
  readonly gitCommit?: string | null;
  readonly storeVersion?: string;
  readonly generator?: GeneratorIdentity;
  readonly validatorVersions?: Readonly<Record<string, string>>;
  readonly budget?: Partial<RunBudget>;
  readonly totalUnits?: number;
  /** Recorded on any resume that amends the budget or the unit total. */
  readonly amendmentReason?: string;
  /** Injectable clock returning epoch milliseconds. Tests supply a fake. */
  readonly clock?: () => number;
  /** Lease age past which a lock is treated as abandoned. */
  readonly staleLockMs?: number;
  /** `fsync` costs a syscall per durable write; `flush` is faster and weaker. */
  readonly durability?: "fsync" | "flush";
  /** Rewrite the derived snapshot on every mutation. Off by default; see `checkpoint`. */
  readonly writeSnapshotOnMutation?: boolean;
  /** Test seam. Throwing from the injector simulates a crash at that seam. */
  readonly faultInjector?: FaultInjector;
}

export interface AdmissionDecision {
  readonly status: AdmissionStatus;
  readonly reasons?: readonly string[];
  readonly findings?: Record<string, unknown>;
  readonly review?: ReviewScores | null;
}

export interface CommitCandidateInput {
  /** Stable logical example id. Two attempts of one unit are a repair. */
  readonly unitId: string;
  /** Immutable, globally unique attempt id. This is the dedup key. */
  readonly attemptId: string;
  /** The attempt this one supersedes. Must belong to the same unit. */
  readonly parentAttemptId?: string | null;
  readonly record: CandidateRecord;
  /** Defaults to the record's own admission block. */
  readonly admission?: AdmissionDecision;
  /** Emit `unit.finalized` in the same transaction. */
  readonly finalize?: boolean;
  /** Emit `unit.completed` in the same transaction. */
  readonly completeUnit?: boolean;
}

export interface CommitCandidateResult {
  readonly committed: boolean;
  readonly unitId: string;
  readonly attemptId: string;
  readonly status: AdmissionStatus;
  /** The parent attempt this registration superseded, if any. */
  readonly supersededAttemptId: string | null;
  readonly payloadFile: string;
  /** True when the attempt was already registered; nothing new was written. */
  readonly alreadyRegistered: boolean;
}

// -------------------------------------------------------------------------------------------------
// The store
// -------------------------------------------------------------------------------------------------

export class RunStore {
  readonly runId: string;
  readonly paths: RunStorePaths;
  readonly openedAt: string;

  private readonly clock: () => number;
  private readonly durability: "fsync" | "flush";
  private readonly writeSnapshotOnMutation: boolean;
  private readonly faultInjector: FaultInjector | undefined;
  private readonly lockAcquiredAtMs: number;

  private projection: Projection;
  private diagnostics: OpenDiagnostics;
  private eventFd: number | null = null;
  private closed = false;
  private txCounter = 0;

  private constructor(
    paths: RunStorePaths,
    projection: Projection,
    diagnostics: OpenDiagnostics,
    options: {
      clock: () => number;
      durability: "fsync" | "flush";
      writeSnapshotOnMutation: boolean;
      faultInjector: FaultInjector | undefined;
      runId: string;
      openedAt: string;
      lockAcquiredAtMs: number;
    },
  ) {
    this.paths = paths;
    this.projection = projection;
    this.diagnostics = diagnostics;
    this.clock = options.clock;
    this.durability = options.durability;
    this.writeSnapshotOnMutation = options.writeSnapshotOnMutation;
    this.faultInjector = options.faultInjector;
    this.runId = options.runId;
    this.openedAt = options.openedAt;
    this.lockAcquiredAtMs = options.lockAcquiredAtMs;
  }

  static open(options: OpenRunStoreOptions): RunStore {
    const paths = runStorePaths(options.runId, options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT);
    const clock = options.clock ?? Date.now;
    const nowMs = clock();
    /**
     * The lease is a CROSS-PROCESS protocol, so it is deliberately stamped and
     * aged with the real clock even when the run itself runs on an injected one.
     * Mixing an injected clock into the staleness comparison would make a
     * deterministic run instantly look abandoned to itself.
     */
    const leaseNowMs = Date.now();
    const durability = options.durability ?? "fsync";
    const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    const faultInjector = options.faultInjector;
    const identity: LeaseIdentity = { pid: process.pid, acquiredAtMs: leaseNowMs, runId: options.runId };
    const fault = (point: FaultPoint): void => faultInjector?.({ fault: point, runId: options.runId, txId: "open" });

    mkdirSync(paths.runDir, { recursive: true });
    mkdirSync(paths.attemptsDir, { recursive: true });

    fault("before-lock");
    const lease = acquireLease(paths, identity, staleLockMs, leaseNowMs);
    fault("after-lock");

    try {
      fault("before-recovery");
      const replay = replayEventLog(paths.eventsPath);
      if (replay.truncatedBytes > 0) {
        // The exclusive lease is already held, so no other process can be
        // mid-append behind our back: dropping the unterminated suffix is safe
        // and is the only way the NEXT append lands on a clean boundary.
        truncateSync(paths.eventsPath, statSync(paths.eventsPath).size - replay.truncatedBytes);
      }
      fault("after-recovery");

      const config: RunConfig = {
        runId: options.runId,
        seed: options.seed,
        gitCommit: options.gitCommit === undefined ? readGitCommit() : options.gitCommit,
        sourceDigest: requireNonEmptyString(options.sourceDigest, "sourceDigest"),
        storeVersion: options.storeVersion ?? RUN_STORE_VERSION,
        generator: options.generator ?? UNKNOWN_GENERATOR,
        validatorVersions: options.validatorVersions ?? {},
        splitAssignmentDigest: requireNonEmptyString(options.splitAssignmentDigest, "splitAssignmentDigest"),
        corpusFreezeDigest: requireNonEmptyString(options.corpusFreezeDigest, "corpusFreezeDigest"),
        budget: resolveRunBudget(options.budget),
        totalUnits: requireTokenCount(options.totalUnits ?? 0, "totalUnits"),
      };
      const computedDigest = computeConfigDigest(config);
      if (options.configDigest !== undefined && options.configDigest !== computedDigest) {
        throw new InvalidUsageError(
          `declared configDigest ${options.configDigest} does not match the digest of the supplied configuration ${computedDigest}`,
        );
      }

      const store = new RunStore(
        paths,
        replay.projection,
        {
          truncatedBytes: replay.truncatedBytes,
          tookOverStaleLock: lease.tookOver,
          staleLockHolderPid: lease.staleHolderPid,
          replayedTransactions: replay.transactions,
        },
        {
          clock,
          durability,
          writeSnapshotOnMutation: options.writeSnapshotOnMutation ?? false,
          faultInjector,
          runId: options.runId,
          openedAt: new Date(nowMs).toISOString(),
          lockAcquiredAtMs: leaseNowMs,
        },
      );
      store.reconcile(config, options.amendmentReason ?? null);
      return store;
    } catch (error) {
      releaseLease(paths, identity);
      throw error;
    }
  }

  /**
   * Applies the resume rules: refuse identity drift, record operational drift as
   * explicit amendments. The old store compared only `seed` and silently ignored
   * a changed budget or unit total, which is how a "resumed" run could quietly
   * produce a third configuration nobody wrote down.
   */
  private reconcile(config: RunConfig, amendmentReason: string | null): void {
    if (!this.projection.created) {
      this.append([{ type: "run.created", runId: config.runId, configDigest: computeConfigDigest(config), config }]);
      this.checkpoint();
      return;
    }

    const storedIdentity = runConfigIdentity(this.projection.config);
    const nextIdentity = runConfigIdentity(config);
    const differences: string[] = [];
    for (const key of Object.keys(nextIdentity).sort() as Array<keyof RunConfigIdentity>) {
      const before = stableStringify(storedIdentity[key]);
      const after = stableStringify(nextIdentity[key]);
      if (before !== after) differences.push(`${key} was ${before} but is now ${after}`);
    }
    if (differences.length > 0) throw new ConfigDriftError(this.runId, differences);

    const events: RunEventBody[] = [];
    if (stableStringify(this.projection.budget) !== stableStringify(config.budget)) {
      events.push({
        type: "budget.amended",
        before: this.projection.budget,
        after: config.budget,
        reason: amendmentReason,
      });
    }
    if (this.projection.totalUnits !== config.totalUnits) {
      events.push({
        type: "plan.amended",
        before: this.projection.totalUnits,
        after: config.totalUnits,
        reason: amendmentReason,
      });
    }
    if (events.length > 0) {
      this.append(events);
      this.checkpoint();
    }
  }

  // -- durable write path -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new RunClosedError(this.runId);
  }

  private ensureEventFd(): number {
    if (this.eventFd === null) this.eventFd = openSync(this.paths.eventsPath, "a");
    return this.eventFd;
  }

  private nextTxId(): string {
    this.txCounter += 1;
    return sha256(`${this.runId}:${this.projection.lastSeq}:${this.txCounter}:${this.clock()}`).slice(0, 16);
  }

  /**
   * The single durable mutation. One line, one transaction, one `write(2)` on an
   * `O_APPEND` descriptor. Nothing else in this class writes durable state, which
   * is what makes "registration + admission + completion are atomic" true by
   * construction rather than by convention.
   */
  private append(events: readonly RunEventBody[]): RunTransaction {
    this.assertOpen();
    if (events.length === 0) throw new InvalidUsageError("refusing to append an empty transaction");
    const transaction: RunTransaction = {
      seq: this.projection.lastSeq + 1,
      txId: this.nextTxId(),
      at: new Date(this.clock()).toISOString(),
      events,
    };
    this.fault("before-event-append", transaction.txId);
    const fd = this.ensureEventFd();
    writeAll(fd, `${stableStringify(transaction)}\n`);
    if (this.durability === "fsync") fsyncSync(fd);
    this.fault("after-event-append", transaction.txId);

    for (const event of transaction.events) applyEvent(this.projection, event, transaction.at);
    this.projection.updatedAt = transaction.at;
    this.projection.lastEventAt = transaction.at;
    this.projection.lastSeq = transaction.seq;
    return transaction;
  }

  private fault(point: FaultPoint, txId: string): void {
    this.faultInjector?.({ fault: point, runId: this.runId, txId });
  }

  private maybeSnapshot(): void {
    if (this.writeSnapshotOnMutation) this.checkpoint();
  }

  /**
   * Rewrites the derived snapshot by atomic replacement. Deliberately NOT called
   * per unit completion: the snapshot is O(run size), so writing it on every
   * completion is O(n^2) bytes written for linear work. Call it at stage
   * boundaries, after bursts of work, and on close.
   */
  checkpoint(): RunSnapshot {
    this.assertOpen();
    this.fault("before-snapshot", "snapshot");
    writeFileAtomic(
      this.paths.snapshotPath,
      `${stableStringify(this.snapshot(), 2)}\n`,
      this.durability === "fsync",
    );
    this.fault("after-snapshot", "snapshot");
    return this.snapshot();
  }

  // -- read-only views ----------------------------------------------------------------------------

  /** Frozen, rebuilt-from-events view. Never the live internal state. */
  snapshot(): RunSnapshot {
    const projection = this.projection;
    const completedUnitIds = projection.unitOrder.filter((unitId) => projection.units.get(unitId)?.completedAt);
    const snapshot: RunSnapshot = {
      storeVersion: RUN_STORE_VERSION,
      runId: projection.runId,
      seed: projection.config.seed,
      configDigest: projection.configDigest,
      config: projection.config,
      gitCommit: projection.config.gitCommit,
      sourceDigest: projection.config.sourceDigest,
      state: projection.state,
      startedAt: projection.startedAt === "" ? this.openedAt : projection.startedAt,
      updatedAt: projection.updatedAt === "" ? this.openedAt : projection.updatedAt,
      lastEventAt: projection.lastEventAt,
      budget: projection.budget,
      spend: this.spendInternal(),
      totalUnits: projection.totalUnits,
      completedUnits: completedUnitIds.length,
      completedUnitIds,
      stagesCompleted: RUN_STAGES.filter((stage) => projection.stages.has(stage)),
      resumeFromStage: RUN_STAGES.find((stage) => !projection.stages.has(stage)) ?? "done",
      notes: projection.notes,
      budgetAmendments: projection.budgetAmendments,
      planAmendments: projection.planAmendments,
      unitIds: projection.unitOrder,
      diagnostics: this.diagnostics,
    };
    return frozenCopy(snapshot);
  }

  config(): RunConfig {
    return frozenCopy(this.projection.config);
  }

  budget(): RunBudget {
    return frozenCopy(this.projection.budget);
  }

  state(): RunState {
    return this.projection.state;
  }

  seed(): string {
    return this.projection.config.seed;
  }

  /** The stage a resume would pick up from. */
  get resumeFromStage(): RunStage {
    return RUN_STAGES.find((stage) => !this.projection.stages.has(stage)) ?? "done";
  }

  hasCompletedStage(stage: RunStage): boolean {
    return this.projection.stages.has(stage);
  }

  hasCompletedUnit(unitId: string): boolean {
    return this.projection.units.get(unitId)?.completedAt != null;
  }

  hasAttempt(attemptId: string): boolean {
    return this.findAttemptInternal(attemptId) !== null;
  }

  /**
   * Content-level duplicate probe. Informational only: a repair legitimately
   * reuses its predecessor's record id, so this MUST NOT gate registration.
   */
  hasRecord(recordId: string): boolean {
    return this.projection.unitOrder.some((unitId) =>
      [...(this.projection.units.get(unitId)?.attempts.values() ?? [])].some(
        (attempt) => attempt.recordId === recordId,
      ),
    );
  }

  findAttempt(attemptId: string): UnitCandidate | null {
    this.assertOpen();
    const attempt = this.findAttemptInternal(attemptId);
    if (!attempt) return null;
    return this.toCandidate(attempt.unitId, attempt);
  }

  attempts(unitId: string): readonly UnitCandidate[] {
    this.assertOpen();
    const unit = this.projection.units.get(unitId);
    if (!unit) return [];
    return frozenCopy(unit.order.map((id) => this.toCandidate(unitId, unit.attempts.get(id)!)));
  }

  unit(unitId: string): UnitSummary | null {
    this.assertOpen();
    const unit = this.projection.units.get(unitId);
    if (!unit) return null;
    const attempts = unit.order.map((id) => this.toCandidate(unitId, unit.attempts.get(id)!));
    const effective =
      unit.finalizedAttemptId !== null
        ? (attempts.find((candidate) => candidate.attemptId === unit.finalizedAttemptId) ?? null)
        : this.latestEligibleCandidate(unitId);
    const summary: UnitSummary = {
      unitId,
      attemptCount: attempts.length,
      attempts,
      finalizedAttemptId: unit.finalizedAttemptId,
      completed: unit.completedAt !== null,
      completedAt: unit.completedAt,
      effective,
    };
    return frozenCopy(summary);
  }

  /**
   * The attempt that currently represents the unit.
   *
   * "Latest" is the deepest unsuperseded attempt; "eligible" excludes `rejected`
   * (a rejected attempt is dead and must be replaced, not revised in place), and
   * a finalized unit always resolves to its pinned attempt. This is what lets a
   * pending-review candidate be superseded by an admitted revision carrying the
   * SAME record id — the lifecycle the old record-id dedup made impossible.
   */
  latestEligibleCandidate(unitId: string): UnitCandidate | null {
    const unit = this.projection.units.get(unitId);
    if (!unit) return null;
    if (unit.finalizedAttemptId !== null) {
      const pinned = unit.attempts.get(unit.finalizedAttemptId);
      return pinned ? this.toCandidate(unitId, pinned) : null;
    }
    for (let index = unit.order.length - 1; index >= 0; index -= 1) {
      const attempt = unit.attempts.get(unit.order[index]!);
      if (!attempt || attempt.supersededBy !== null) continue;
      if (!ELIGIBLE_STATUSES.has(attempt.status)) continue;
      return this.toCandidate(unitId, attempt);
    }
    return null;
  }

  /**
   * Pins the unit's final attempt. Explicit by design: "the run moved on" is a
   * claim worth making, and a finalized unit refuses further revisions.
   */
  finalizeUnit(unitId: string, attemptId?: string): UnitCandidate {
    this.assertOpen();
    const unit = this.projection.units.get(unitId);
    if (!unit) throw new UnknownUnitError(unitId);
    if (unit.finalizedAttemptId !== null) {
      if (attemptId !== undefined && attemptId !== unit.finalizedAttemptId) {
        throw new UnitFinalizedError(unitId, unit.finalizedAttemptId);
      }
      const pinned = unit.attempts.get(unit.finalizedAttemptId);
      if (!pinned) throw new UnknownUnitError(unitId);
      return this.toCandidate(unitId, pinned);
    }
    const target = attemptId ?? this.latestEligibleCandidate(unitId)?.attemptId;
    if (target === undefined) {
      // Name the statuses so the operator can tell "nothing registered" from
      // "everything registered was rejected" without reading the ledger.
      const seen = unit.order
        .map((id) => `${id}=${unit.attempts.get(id)?.status ?? "unknown"}`)
        .join(", ");
      throw new InvalidAttemptError(
        `unit ${JSON.stringify(unitId)} has no eligible attempt to finalize ` +
          `(registered: ${seen === "" ? "none" : seen}); ` +
          `register or supersede with an admitted or pending-review attempt first`,
      );
    }
    const attempt = unit.attempts.get(target);
    if (!attempt) {
      throw new InvalidAttemptError(`unit ${JSON.stringify(unitId)} has no attempt ${JSON.stringify(target)}`);
    }
    if (!ELIGIBLE_STATUSES.has(attempt.status)) {
      throw new InvalidAttemptError(
        `attempt ${JSON.stringify(target)} is ${attempt.status} and is not eligible to be finalized`,
      );
    }
    this.append([{ type: "unit.finalized", unitId, attemptId: target }]);
    this.maybeSnapshot();
    return this.toCandidate(unitId, attempt);
  }

  /** The derived per-unit ledger, one row per attempt, in event order. */
  ledger(): readonly LedgerEntry[] {
    const rows: LedgerEntry[] = [];
    for (const unitId of this.projection.unitOrder) {
      const unit = this.projection.units.get(unitId);
      if (!unit) continue;
      for (const attemptId of unit.order) {
        const attempt = unit.attempts.get(attemptId);
        if (!attempt) continue;
        rows.push({
          unitId,
          attemptId,
          parentAttemptId: attempt.parentAttemptId,
          recordId: attempt.recordId,
          family: attempt.family,
          scenarioSeed: attempt.scenarioSeed,
          contentDigest: attempt.contentDigest,
          admissionStatus: attempt.status,
          reasons: attempt.reasons,
          finalized: unit.finalizedAttemptId === attemptId,
          completed: unit.completedAt !== null,
          superseded: attempt.supersededBy !== null,
          ordinal: attempt.ordinal,
          writtenAt: attempt.registeredAt,
        });
      }
    }
    return frozenCopy(rows);
  }

  /** Digest of the logical result set: stable across identical runs at different times. */
  logicalResultsDigest(): string {
    return logicalResultsDigest(this.ledger());
  }

  /** Digest including timestamps, for audit rather than reproducibility comparison. */
  auditResultsDigest(): string {
    return auditResultsDigest(this.ledger());
  }

  // -- lifecycle mutations ------------------------------------------------------------------------

  setState(state: RunState): void {
    this.assertOpen();
    if (this.projection.state === state) return;
    this.append([{ type: "run.state", from: this.projection.state, to: state }]);
    this.maybeSnapshot();
  }

  addNote(note: string): void {
    this.assertOpen();
    requireNonEmptyString(note, "note");
    if (this.projection.notes.includes(note)) return;
    this.append([{ type: "run.note", note }]);
    this.maybeSnapshot();
  }

  /**
   * Advances the resume point. O(1) append; the snapshot is refreshed because a
   * stage transition is rare and is exactly when an operator inspects the run.
   */
  markStageComplete(stage: RunStage): void {
    this.assertOpen();
    if (!isRunStage(stage)) throw new InvalidUsageError(`unknown stage ${JSON.stringify(stage)}`);
    if (this.projection.stages.has(stage)) return;
    this.append([{ type: "stage.completed", stage }]);
    this.checkpoint();
  }

  /** Explicit budget change. Recorded as an event, never applied silently. */
  amendBudget(budget: RunBudget, reason: string | null = null): RunBudget {
    this.assertOpen();
    const next = resolveRunBudget(budget);
    if (stableStringify(this.projection.budget) === stableStringify(next)) return this.budget();
    this.append([{ type: "budget.amended", before: this.projection.budget, after: next, reason }]);
    this.checkpoint();
    return this.budget();
  }

  amendTotalUnits(totalUnits: number, reason: string | null = null): number {
    this.assertOpen();
    const next = requireTokenCount(totalUnits, "totalUnits");
    if (this.projection.totalUnits === next) return this.projection.totalUnits;
    this.append([{ type: "plan.amended", before: this.projection.totalUnits, after: next, reason }]);
    this.checkpoint();
    return this.projection.totalUnits;
  }

  /** Marks a unit done so a later resume skips it. One append, no snapshot rewrite. */
  markUnitComplete(unitId: string): boolean {
    this.assertOpen();
    const unit = this.projection.units.get(unitId);
    if (!unit) throw new UnknownUnitError(unitId);
    if (unit.completedAt !== null) return false;
    this.append([{ type: "unit.completed", unitId }]);
    this.maybeSnapshot();
    return true;
  }

  // -- candidate commits --------------------------------------------------------------------------

  /**
   * Registers an attempt, writes its admission state, and optionally finalizes
   * and completes the unit — all in ONE transaction.
   *
   * The payload is renamed into place first; if the process dies in between, the
   * orphan file is unreachable (no event claims it) and an identical retry
   * rewrites the same bytes to the same path. That is the whole fix for the
   * duplicate-candidate defect, and it is why the dedup key is the attempt id.
   */
  commitCandidate(input: CommitCandidateInput): CommitCandidateResult {
    this.assertOpen();
    const unitId = requireNonEmptyString(input.unitId, "unitId");
    const attemptId = requireNonEmptyString(input.attemptId, "attemptId");
    const record = input.record;
    if (!isJsonObject(record) || typeof record.recordId !== "string") {
      throw new InvalidUsageError("record must be a CandidateRecord carrying a string recordId");
    }

    const existingUnit = this.projection.units.get(unitId);
    if (existingUnit?.finalizedAttemptId != null) {
      throw new UnitFinalizedError(unitId, existingUnit.finalizedAttemptId);
    }
    const existingAttempt = existingUnit?.attempts.get(attemptId);
    const payloadDigest = sha256(stableStringify(record));

    if (existingAttempt) {
      // Idempotent replay. Reusing an attempt id for DIFFERENT content would
      // silently invalidate a committed digest, so it is refused outright.
      if (existingAttempt.payloadDigest !== payloadDigest) {
        throw new InvalidAttemptError(
          `attempt ${JSON.stringify(attemptId)} is already registered with different bytes ` +
            `(registered digest ${existingAttempt.payloadDigest}, offered ${payloadDigest})`,
        );
      }
      // Re-materialise the payload so a crash that lost the file between rename
      // and append self-heals instead of leaving a row pointing at nothing.
      this.writePayload(unitId, attemptId, existingAttempt.parentAttemptId, record, payloadDigest);
      const result: CommitCandidateResult = {
        committed: false,
        unitId,
        attemptId,
        status: existingAttempt.status,
        supersededAttemptId: existingAttempt.parentAttemptId,
        payloadFile: existingAttempt.payloadFile,
        alreadyRegistered: true,
      };
      return result;
    }

    const parentAttemptId = input.parentAttemptId ?? null;
    if (parentAttemptId !== null) {
      const parent = existingUnit?.attempts.get(parentAttemptId);
      if (!parent) {
        throw new InvalidAttemptError(
          `parent attempt ${JSON.stringify(parentAttemptId)} is not registered for unit ${JSON.stringify(unitId)}`,
        );
      }
      if (parent.supersededBy !== null) {
        throw new InvalidAttemptError(
          `parent attempt ${JSON.stringify(parentAttemptId)} was already superseded by ${JSON.stringify(parent.supersededBy)}`,
        );
      }
    }

    this.writePayload(unitId, attemptId, parentAttemptId, record, payloadDigest);

    const decision = resolveAdmission(record, input.admission);
    const events: RunEventBody[] = [
      {
        type: "attempt.registered",
        unitId,
        attemptId,
        parentAttemptId,
        recordId: record.recordId,
        family: record.family,
        scenarioSeed: record.scenarioSeed,
        contentDigest: record.contentDigest,
        payloadDigest,
        payloadFile: attemptPayloadFileName(attemptId),
        status: decision.status,
        reasons: decision.reasons,
        findings: decision.findings,
        review: decision.review,
      },
    ];
    if (input.finalize === true) events.push({ type: "unit.finalized", unitId, attemptId });
    if (input.completeUnit === true) events.push({ type: "unit.completed", unitId });

    this.append(events);
    this.maybeSnapshot();

    const result: CommitCandidateResult = {
      committed: true,
      unitId,
      attemptId,
      status: decision.status,
      supersededAttemptId: parentAttemptId,
      payloadFile: attemptPayloadFileName(attemptId),
      alreadyRegistered: false,
    };
    return result;
  }

  /**
   * Revises the admission state of an already-registered attempt, e.g. when an
   * independent review promotes `pending-review` to `admitted`. Distinct from
   * registering a repair, which is the correct move for changed record bytes.
   */
  updateAdmission(unitId: string, attemptId: string, decision: AdmissionDecision): UnitCandidate {
    this.assertOpen();
    const unit = this.projection.units.get(unitId);
    if (!unit) throw new UnknownUnitError(unitId);
    const attempt = unit.attempts.get(attemptId);
    if (!attempt) {
      throw new InvalidAttemptError(`unit ${JSON.stringify(unitId)} has no attempt ${JSON.stringify(attemptId)}`);
    }
    const status = requireAdmissionStatus(decision.status);
    const admittedAt = status === "admitted" ? new Date(this.clock()).toISOString() : null;
    this.append([
      {
        type: "attempt.admitted",
        unitId,
        attemptId,
        status,
        reasons: normalizeReasons(decision.reasons),
        findings: decision.findings ?? {},
        review: decision.review ?? null,
        admittedAt,
      },
    ]);
    this.maybeSnapshot();
    const updated = this.projection.units.get(unitId)?.attempts.get(attemptId);
    if (!updated) throw new UnknownAttemptError(attemptId);
    return this.toCandidate(unitId, updated);
  }

  /** Reads and integrity-checks one stored candidate payload. */
  readCandidate(attemptId: string): CandidateRecord | null {
    this.assertOpen();
    const attempt = this.findAttemptInternal(attemptId);
    return attempt ? this.readPayload(attempt).record : null;
  }

  /** Every registered attempt's record, in deterministic (unit, ordinal) order. */
  candidates(): readonly CandidateRecord[] {
    this.assertOpen();
    const records: CandidateRecord[] = [];
    for (const unitId of this.projection.unitOrder) {
      const unit = this.projection.units.get(unitId);
      if (!unit) continue;
      for (const attemptId of unit.order) {
        const attempt = unit.attempts.get(attemptId);
        if (attempt) records.push(this.readPayload(attempt).record);
      }
    }
    return frozenCopy(records);
  }

  // -- metered accounting -------------------------------------------------------------------------

  /**
   * Reserves worst-case capacity BEFORE dispatch, covering every planned retry.
   *
   * Throws `BudgetExceededError` when the reservation would breach a cap, so the
   * caller is stopped *before* the money is committed rather than after. An
   * identical replay is a no-op; a replay that disagrees about the worst case is
   * a conflict, not an adjustment.
   */
  reserveAttempt(input: {
    readonly attemptId: string;
    readonly requestDigest: string;
    readonly worstCaseTokens: number;
    readonly worstCaseCostUsd: number;
  }): Reservation {
    this.assertOpen();
    const attemptId = requireNonEmptyString(input.attemptId, "attemptId");
    const requestDigest = requireNonEmptyString(input.requestDigest, "requestDigest");
    const worstCaseTokens = requireTokenCount(input.worstCaseTokens, "worstCaseTokens");
    const worstCaseCostUsd = requireCostUsd(input.worstCaseCostUsd, "worstCaseCostUsd");

    const existing = this.projection.meters.get(attemptId);
    if (existing) {
      if (
        existing.requestDigest !== requestDigest ||
        existing.worstCaseTokens !== worstCaseTokens ||
        existing.worstCaseCostUsd !== worstCaseCostUsd
      ) {
        throw new InvalidUsageError(
          `attempt ${JSON.stringify(attemptId)} is already reserved for a different request ` +
            `(digest ${existing.requestDigest ?? "none"}, worst case ${existing.worstCaseTokens} tokens / ` +
            `$${existing.worstCaseCostUsd}); use a new attempt id for a different request`,
        );
      }
      const replay: Reservation = {
        attemptId,
        requestDigest,
        worstCaseTokens,
        worstCaseCostUsd,
        reservedAt: existing.reservedAt,
        replayed: true,
      };
      return frozenCopy(replay);
    }

    const spend = this.spendInternal();
    const budget = this.projection.budget;
    const projectedRequests = spend.providerRequests + spend.outstandingReservations + 1;
    if (projectedRequests > budget.maxProviderRequests) {
      throw new BudgetExceededError("max-provider-requests", projectedRequests, budget.maxProviderRequests);
    }
    const projectedTokens = spend.settledTokens + spend.reservedTokens + worstCaseTokens;
    if (projectedTokens > budget.maxTotalTokens) {
      throw new BudgetExceededError("max-total-tokens", projectedTokens, budget.maxTotalTokens);
    }
    if (budget.maxCostUsd !== null) {
      const projectedCost = roundUsd(spend.settledCostUsd + spend.reservedCostUsd + worstCaseCostUsd);
      if (projectedCost > budget.maxCostUsd) {
        throw new BudgetExceededError("max-cost-usd", projectedCost, budget.maxCostUsd);
      }
    }

    this.append([
      { type: "attempt.reserved", attemptId, requestDigest, worstCaseTokens, worstCaseCostUsd },
    ]);
    this.maybeSnapshot();
    const reservation: Reservation = {
      attemptId,
      requestDigest,
      worstCaseTokens,
      worstCaseCostUsd,
      reservedAt: this.projection.meters.get(attemptId)?.reservedAt ?? new Date(this.clock()).toISOString(),
      replayed: false,
    };
    return frozenCopy(reservation);
  }

  /**
   * Settles a reservation exactly once. An identical replay returns the first
   * result without writing anything; a replay that DISAGREES about the response
   * is an upstream bug and is refused rather than silently overwriting a charge.
   */
  settleAttempt(input: {
    readonly attemptId: string;
    readonly responseId: string;
    readonly measuredTokens: number;
    readonly measuredCostUsd: number;
  }): Settlement {
    this.assertOpen();
    const attemptId = requireNonEmptyString(input.attemptId, "attemptId");
    const responseId = requireNonEmptyString(input.responseId, "responseId");
    const measuredTokens = requireTokenCount(input.measuredTokens, "measuredTokens");
    const measuredCostUsd = requireCostUsd(input.measuredCostUsd, "measuredCostUsd");

    const meter = this.projection.meters.get(attemptId);
    if (!meter) throw new UnknownAttemptError(attemptId);
    const deltaTokens = measuredTokens - meter.worstCaseTokens;
    const deltaCostUsd = roundUsd(measuredCostUsd - meter.worstCaseCostUsd);

    if (meter.state === "settled") {
      if (
        meter.responseId !== responseId ||
        meter.measuredTokens !== measuredTokens ||
        meter.measuredCostUsd !== measuredCostUsd
      ) {
        throw new ConflictingSettlementError(
          attemptId,
          `already settled as ${JSON.stringify(meter.responseId)} for ${meter.measuredTokens} tokens / ` +
            `$${meter.measuredCostUsd}; refusing to overwrite with ${JSON.stringify(responseId)} for ` +
            `${measuredTokens} tokens / $${measuredCostUsd}`,
        );
      }
      const replay: Settlement = {
        attemptId,
        responseId: meter.responseId,
        measuredTokens: meter.measuredTokens,
        measuredCostUsd: meter.measuredCostUsd,
        deltaTokens,
        deltaCostUsd,
        settledAt: meter.settledAt ?? "",
        replayed: true,
      };
      return frozenCopy(replay);
    }

    this.append([{ type: "attempt.settled", attemptId, responseId, measuredTokens, measuredCostUsd }]);
    this.maybeSnapshot();
    const settlement: Settlement = {
      attemptId,
      responseId,
      measuredTokens,
      measuredCostUsd,
      deltaTokens,
      deltaCostUsd,
      settledAt: this.projection.meters.get(attemptId)?.settledAt ?? new Date(this.clock()).toISOString(),
      replayed: false,
    };
    return frozenCopy(settlement);
  }

  /**
   * Records that the payment outcome is UNKNOWN — a timeout, a dropped socket, a
   * provider that may have charged and not responded.
   *
   * The reservation is RETAINED and keeps consuming budget, because assuming a
   * refund is how a run spends money it never got back. A later `settleAttempt`
   * may still resolve the attempt; until then the worst case is committed.
   */
  markAttemptUncertain(attemptId: string): void {
    this.assertOpen();
    requireNonEmptyString(attemptId, "attemptId");
    const meter = this.projection.meters.get(attemptId);
    if (!meter) throw new UnknownAttemptError(attemptId);
    if (meter.state === "settled") {
      throw new ConflictingSettlementError(attemptId, "already settled; an outcome that is known cannot become unknown");
    }
    if (meter.state === "uncertain") return;
    this.append([{ type: "attempt.uncertain", attemptId }]);
    this.maybeSnapshot();
  }

  accounting(): readonly AttemptAccounting[] {
    const rows: AttemptAccounting[] = [];
    for (const meter of this.projection.meters.values()) {
      rows.push({
        attemptId: meter.attemptId,
        requestDigest: meter.requestDigest,
        worstCaseTokens: meter.worstCaseTokens,
        worstCaseCostUsd: meter.worstCaseCostUsd,
        state: meter.state,
        responseId: meter.responseId,
        measuredTokens: meter.measuredTokens,
        measuredCostUsd: meter.measuredCostUsd,
        settledAt: meter.settledAt,
        markedUncertainAt: meter.markedUncertainAt,
      });
    }
    return frozenCopy(rows);
  }

  spend(): SpendSummary {
    return frozenCopy(this.spendInternal());
  }

  /**
   * Exhaustion over committed AND reserved capacity. The previous check could
   * only see money already spent, so it could not stop the request that would
   * have crossed the line.
   */
  budgetExhausted(): BudgetExhaustionReason | null {
    const spend = this.spendInternal();
    const budget = this.projection.budget;
    if (spend.providerRequests + spend.outstandingReservations >= budget.maxProviderRequests) {
      return "max-provider-requests";
    }
    if (spend.settledTokens + spend.reservedTokens >= budget.maxTotalTokens) return "max-total-tokens";
    if (budget.maxCostUsd !== null && spend.settledCostUsd + spend.reservedCostUsd >= budget.maxCostUsd) {
      return "max-cost-usd";
    }
    const startedMs = this.projection.startedAt === "" ? Date.parse(this.openedAt) : Date.parse(this.projection.startedAt);
    if (Number.isFinite(startedMs) && this.clock() - startedMs >= budget.maxWallClockMs) return "max-wall-clock";
    return null;
  }

  private spendInternal(): SpendSummary {
    let settledAttempts = 0;
    let uncertainAttempts = 0;
    let outstandingReservations = 0;
    let settledTokens = 0;
    let settledCostUsd = 0;
    let providerMeasuredTokens = 0;
    let locallyEstimatedTokens = 0;
    let reservedTokens = 0;
    let reservedCostUsd = 0;
    let overshootTokens = 0;
    let overshootCostUsd = 0;

    for (const meter of this.projection.meters.values()) {
      if (meter.state === "settled") {
        settledAttempts += 1;
        const measured = meter.measuredTokens ?? 0;
        const cost = meter.measuredCostUsd ?? 0;
        settledTokens += measured;
        settledCostUsd = roundUsd(settledCostUsd + cost);
        // `turnBudget.ts` separates provider-reported usage from local
        // estimation so a token regression is diagnosable rather than merely
        // visible. A settlement carrying a response id is provider-measured;
        // anything else is a locally estimated charge, and both stay counted.
        if (meter.responseId !== null) providerMeasuredTokens += measured;
        else locallyEstimatedTokens += measured;
        const overTokens = measured - meter.worstCaseTokens;
        if (overTokens > 0) overshootTokens += overTokens;
        const overCost = roundUsd(cost - meter.worstCaseCostUsd);
        if (overCost > 0) overshootCostUsd = roundUsd(overshootCostUsd + overCost);
        continue;
      }
      // `reserved` and `uncertain` both hold their capacity: uncertain means the
      // payment outcome is unknown, so the worst case is still committed money.
      if (meter.state === "uncertain") uncertainAttempts += 1;
      else outstandingReservations += 1;
      reservedTokens += meter.worstCaseTokens;
      reservedCostUsd = roundUsd(reservedCostUsd + meter.worstCaseCostUsd);
    }

    return {
      providerRequests: settledAttempts + uncertainAttempts,
      settledAttempts,
      uncertainAttempts,
      outstandingReservations,
      settledTokens,
      settledCostUsd,
      providerMeasuredTokens,
      locallyEstimatedTokens,
      reservedTokens,
      reservedCostUsd,
      overshootTokens,
      overshootCostUsd,
    };
  }

  // -- internals ----------------------------------------------------------------------------------

  private toCandidate(unitId: string, attempt: AttemptProjection): UnitCandidate {
    return frozenCopy({
      unitId,
      attemptId: attempt.attemptId,
      parentAttemptId: attempt.parentAttemptId,
      recordId: attempt.recordId,
      family: attempt.family,
      scenarioSeed: attempt.scenarioSeed,
      contentDigest: attempt.contentDigest,
      status: attempt.status,
      reasons: attempt.reasons,
      ordinal: attempt.ordinal,
      finalized: this.projection.units.get(unitId)?.finalizedAttemptId === attempt.attemptId,
      superseded: attempt.supersededBy !== null,
      payloadFile: attempt.payloadFile,
      payloadDigest: attempt.payloadDigest,
      registeredAt: attempt.registeredAt,
    });
  }

  private findAttemptInternal(attemptId: string): AttemptProjection | null {
    for (const unitId of this.projection.unitOrder) {
      const attempt = this.projection.units.get(unitId)?.attempts.get(attemptId);
      if (attempt) return attempt;
    }
    return null;
  }

  private writePayload(
    unitId: string,
    attemptId: string,
    parentAttemptId: string | null,
    record: CandidateRecord,
    payloadDigest: string,
  ): void {
    this.fault("before-payload-write", `payload:${attemptId}`);
    const payload: StoredAttemptPayload = {
      storeVersion: RUN_STORE_VERSION,
      attemptId,
      unitId,
      parentAttemptId,
      payloadDigest,
      writtenAt: new Date(this.clock()).toISOString(),
      record,
    };
    writeFileAtomic(
      join(this.paths.attemptsDir, attemptPayloadFileName(attemptId)),
      `${stableStringify(payload)}\n`,
      this.durability === "fsync",
    );
    this.fault("after-payload-write", `payload:${attemptId}`);
  }

  private readPayload(attempt: AttemptProjection): StoredAttemptPayload {
    const path = join(this.paths.attemptsDir, attempt.payloadFile);
    if (!existsSync(path)) {
      throw new CorruptPayloadError(
        attempt.attemptId,
        `registered payload file ${attempt.payloadFile} is missing; the run directory is incomplete`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new CorruptPayloadError(
        attempt.attemptId,
        `${attempt.payloadFile} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
    if (!isJsonObject(parsed) || parsed.attemptId !== attempt.attemptId) {
      throw new CorruptPayloadError(
        attempt.attemptId,
        `${attempt.payloadFile} does not contain attempt ${JSON.stringify(attempt.attemptId)}`,
      );
    }
    if (parsed.payloadDigest !== attempt.payloadDigest) {
      throw new CorruptPayloadError(
        attempt.attemptId,
        `${attempt.payloadFile} digest ${String(parsed.payloadDigest)} does not match the registered digest ${attempt.payloadDigest}`,
      );
    }
    return parsed as unknown as StoredAttemptPayload;
  }

  // -- shutdown -----------------------------------------------------------------------------------

  close(): RunSnapshot {
    if (this.closed) return this.snapshot();
    this.fault("before-close", "close");
    this.checkpoint();
    this.closed = true;
    if (this.eventFd !== null) {
      const fd = this.eventFd;
      this.eventFd = null;
      closeSync(fd);
    }
    releaseLease(this.paths, { pid: process.pid, acquiredAtMs: this.lockAcquiredAtMs, runId: this.runId });
    this.fault("after-close", "close");
    return this.snapshot();
  }
}

function resolveAdmission(
  record: CandidateRecord,
  decision?: AdmissionDecision,
): {
  status: AdmissionStatus;
  reasons: string[];
  findings: Record<string, unknown> | null;
  review: ReviewScores | null;
} {
  const source: AdmissionDecision = decision ?? {
    status: record.admission.status,
    reasons: record.admission.reasons,
    findings: record.admission.findings,
    review: record.admission.review,
  };
  return {
    status: requireAdmissionStatus(source.status),
    reasons: normalizeReasons(source.reasons),
    findings: source.findings ?? {},
    review: source.review ?? null,
  };
}

// -------------------------------------------------------------------------------------------------
// Single-writer lease
// -------------------------------------------------------------------------------------------------

interface LeaseIdentity {
  pid: number;
  acquiredAtMs: number;
  runId: string;
}

interface LeaseAcquireResult {
  tookOver: boolean;
  staleHolderPid: number | null;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the existence and permission check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLease(path: string): { pid: number; acquiredAtMs: number } | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(parsed)) return null;
    const { pid, acquiredAtMs } = parsed;
    if (typeof pid !== "number" || typeof acquiredAtMs !== "number") return null;
    return { pid, acquiredAtMs };
  } catch {
    // An unparsable lease belongs to a process that died mid-write.
    return null;
  }
}

/**
 * Single-writer lease, created with `O_EXCL` so acquisition is atomic against a
 * concurrent opener even where advisory locking is unreliable.
 *
 * A holder is presumed dead when its pid is gone OR when the lease has aged past
 * `staleLockMs`. Either condition alone can be wrong (a recycled pid, a clock
 * jump), so a lease is only reclaimed when at least one is decisively satisfied
 * and the reclaim itself races through `O_EXCL` again.
 */
function acquireLease(
  paths: RunStorePaths,
  identity: LeaseIdentity,
  staleLockMs: number,
  nowMs: number,
): LeaseAcquireResult {
  const payload = `${stableStringify({
    pid: identity.pid,
    platform: process.platform,
    acquiredAtMs: identity.acquiredAtMs,
    acquiredAt: new Date(identity.acquiredAtMs).toISOString(),
    runId: identity.runId,
    storeVersion: RUN_STORE_VERSION,
  })}\n`;

  const claim = (): void => {
    const fd = openSync(paths.lockPath, "wx");
    try {
      writeAll(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  try {
    claim();
    return { tookOver: false, staleHolderPid: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = readLease(paths.lockPath);
  const staleByPid = existing === null || !processIsAlive(existing.pid);
  const staleByAge = existing !== null && nowMs - existing.acquiredAtMs > staleLockMs;
  if (!staleByPid && !staleByAge) {
    throw new RunLockError(identity.runId, existing?.pid ?? null, existing?.acquiredAtMs ?? null);
  }

  // Move the abandoned lease aside first, so a racing opener observes a missing
  // lock and retries `claim()` itself. That is the only interleaving in which two
  // processes could both believe they won.
  const quarantine = `${paths.lockPath}.stale-${randomSuffix()}`;
  try {
    renameSync(paths.lockPath, quarantine);
  } catch {
    if (!existsSync(paths.lockPath)) {
      throw new RunLockError(identity.runId, existing?.pid ?? null, existing?.acquiredAtMs ?? null);
    }
  }
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const holder = readLease(paths.lockPath);
      throw new RunLockError(identity.runId, holder?.pid ?? null, holder?.acquiredAtMs ?? null);
    }
    throw error;
  }
  return { tookOver: true, staleHolderPid: existing?.pid ?? null };
}

function releaseLease(paths: RunStorePaths, identity: LeaseIdentity): void {
  const existing = readLease(paths.lockPath);
  // Only ever remove a lease we still hold, so a process that lost its lease to a
  // stale takeover cannot unlease the new owner.
  if (existing !== null && existing.pid !== identity.pid) return;
  try {
    unlinkSync(paths.lockPath);
  } catch {
    // Already gone; releasing twice is not an error.
  }
}

// -------------------------------------------------------------------------------------------------
// Factory
// -------------------------------------------------------------------------------------------------

export function openRunStore(options: OpenRunStoreOptions): RunStore {
  return RunStore.open(options);
}