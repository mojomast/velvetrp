/**
 * Durable request/response checkpoints under the run-store lease. No billing estimates.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A provider call is the one irreversible step in the pipeline. Everything else
 * is a local computation that can be repeated. So this journal answers exactly
 * one question on every resume: "has this physical request already been sent?"
 *
 * It is deliberately stricter than the teacher client, because the client cannot
 * see the future:
 *
 *  1. ONE PHYSICAL REQUEST, ONE CHECKPOINT, WRITTEN FIRST. The observer passed
 *     to `client.complete` is awaited BEFORE each socket opens, so the marker is
 *     durable before any byte can be billed.
 *  2. THE RETURNED BYTES ARE RETAINED BEFORE PARSING. A provider that answered
 *     with an unusable body is a KNOWN outcome with KNOWN bytes, durably stored.
 *     A later invocation replays those exact bytes through the same pure decoder
 *     and reaches the identical result without resending anything.
 *  3. AN UNCERTAIN OUTCOME IS NEVER GUESSED AT. A socket failure, a timeout or a
 *     crash between the marker and the response leaves the dispatch unresolved.
 *     Resume refuses with `UncertainDispatchError`. The run needs provider-side
 *     evidence, not a second guess with a second bill.
 *  4. AN EXPLICIT RATE LIMIT IS NOT UNCERTAIN. A 429
 *     is the relay answering "not now", so a later invocation may send again.
 *  5. THE LEASE IS HELD ACROSS THE WHOLE CALL. A heartbeat renews it while the
 *     request is outstanding, and the observer re-checks ownership before every
 *     physical send, so a replaced owner cannot keep spending after it lost the
 *     run.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableStringify } from "./spec.js";
import {
  replayCapturedTeacherResponse,
  TeacherHttpError,
  sha256Hex,
  type TeacherClient,
  type TeacherCompletion,
  type TeacherCompletionRequest,
  type TeacherDispatchObservation,
} from "./teacher.js";
import type { RunStore } from "./runstore.js";

export class UncertainDispatchError extends Error {
  readonly attemptId: string;
  readonly detail: string | null;

  constructor(attemptId: string, detail: string | null = null) {
    super(
      `dispatch outcome is unknown for ${attemptId}; resume will not send it twice` +
        `${detail === null ? "" : ` (${detail})`}`,
    );
    this.name = "UncertainDispatchError";
    this.attemptId = attemptId;
    this.detail = detail;
  }
}

function readCheckpoint<T>(root: string, key: string): T | null {
  const path = join(root, `${sha256Hex(key)}.json`);
  if (!existsSync(path)) return null;
  const envelope = JSON.parse(readFileSync(path, "utf8")) as { key: string; digest: string; value: T };
  if (envelope.key !== key || envelope.digest !== sha256Hex(stableStringify(envelope.value))) throw new Error("pipeline checkpoint checksum/key mismatch");
  return envelope.value;
}

/** Read-only inspection for an independent artifact/certificate approval process. */
export function inspectPipelineCheckpoint<T>(store: RunStore, key: string): T | null {
  return readCheckpoint<T>(join(store.paths.runDir, "pipeline"), key);
}

/** Marks one physical request. Monotonic per logical attempt across every invocation. */
export interface CapturedPhysicalRequest {
  readonly attemptId: string;
  /** Absolute physical-request index for this logical attempt, starting at 1. */
  readonly index: number;
  /** The client's own attempt number within the `complete()` call that made it. */
  readonly requestNumber: number;
}

/** What one physical request actually did, captured before anything parsed it. */
export interface CapturedOutcome extends CapturedPhysicalRequest {
  /**
   * `response` — the relay answered 2xx and the raw body is retained.
   * `rejection` — explicit non-2xx refusal; only 429 may be repeated. Permanent
   *   refusals are replayed as errors without a new request.
   * `uncertain` — no usable execution outcome, including upstream 5xx.
   */
  readonly kind: "response" | "rejection" | "uncertain";
  readonly status: number | null;
  /** Credential-scrubbed relay bytes: whole for a 2xx, an excerpt for a rejection. */
  readonly body: string | null;
  /** Digest of the bytes as returned, so a redacted replay is detectable. */
  readonly bodyDigest: string | null;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
  /** Digest of the logical request, so a replay reproduces the same completion. */
  readonly requestDigest: string | null;
}

export interface PipelineJournalOptions {
  /**
   * How often an outstanding dispatch renews the lease. The default is far below
   * `DEFAULT_STALE_LOCK_MS`; a long teacher completion must not age the run out
   * from under itself.
   */
  readonly heartbeatMs?: number | undefined;
}

export const DEFAULT_JOURNAL_HEARTBEAT_MS = 30_000;

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * The request identity a resume must match. The runtime-only `observer` is
 * deliberately absent: it is not an input to the request, and a function is not
 * request identity.
 */
function requestIdentity(request: TeacherCompletionRequest): Record<string, unknown> {
  return {
    attemptId: request.attemptId,
    system: request.system,
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  };
}

export class PipelineJournal {
  private readonly root: string;
  private readonly heartbeatMs: number;

  constructor(private readonly store: RunStore, binding: unknown, options: PipelineJournalOptions = {}) {
    this.root = join(store.paths.runDir, "pipeline");
    const created = !existsSync(this.root);
    mkdirSync(this.root, { recursive: true });
    if (created) {
      // The checkpoint directory's own entry must outlive a crash, otherwise a
      // "durable" dispatch marker can vanish with the directory that held it.
      fsyncDirectory(dirname(this.root));
    }
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_JOURNAL_HEARTBEAT_MS;
    const digest = sha256Hex(stableStringify(binding));
    const note = `pipeline-binding-v1:${digest}`;
    const previous = store.snapshot().notes.find((entry) => entry.startsWith("pipeline-binding-v1:"));
    if (previous && previous !== note) throw new Error("pipeline configuration/plan drift on resume");
    // The event log authenticates the expected file checksum on every reopen.
    if (!previous) {
      if (store.ledger().length) throw new Error("cannot resume pre-journal attempts without a bound runner plan");
      store.addNote(note);
    }
    this.save("binding", binding);
  }

  private path(key: string): string { return join(this.root, `${sha256Hex(key)}.json`); }
  read<T>(key: string): T | null {
    return readCheckpoint<T>(this.root, key);
  }

  save(key: string, value: unknown): void {
    this.store.withDurableWriter(() => {
    this.store.renewLease();
    const previous = this.read<unknown>(key);
    if (previous !== null) {
      if (stableStringify(previous) !== stableStringify(value)) throw new Error("immutable pipeline checkpoint changed");
      return;
    }
    const path = this.path(key);
    const temp = `${path}.tmp`;
    writeFileSync(temp, stableStringify({ key, digest: sha256Hex(stableStringify(value)), value }) + "\n", { encoding: "utf8" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    fsyncDirectory(this.root);
    });
  }

  hasResponse(attemptId: string): boolean { return this.read(`response:${attemptId}`) !== null; }

  /** How many physical requests this logical attempt has already made. */
  physicalRequestCount(attemptId: string): number {
    let index = 1;
    while (existsSync(this.path(`physical:${attemptId}:${index}`))) index += 1;
    return index - 1;
  }

  /** The most recent physical request's captured outcome, if one was recorded. */
  lastOutcome(attemptId: string): CapturedOutcome | null {
    const index = this.physicalRequestCount(attemptId);
    if (index === 0) return null;
    return this.read<CapturedOutcome>(`outcome:${attemptId}:${index}`);
  }

  /** Reconcile the earliest durable HTTP boundary before ANY new paid work. */
  reconcileCompletion(client: TeacherClient, attemptId: string): TeacherCompletion | null {
    const dispatch = this.read<{ identity: unknown; request: TeacherCompletionRequest }>(`dispatch:${attemptId}`);
    if (!dispatch) return null;
    if (stableStringify(dispatch.identity) !== stableStringify(client.identity)) throw new Error("persisted dispatch identity drift");
    const completion = this.read<TeacherCompletion>(`response:${attemptId}`);
    if (completion) return completion;
    const outcome = this.lastOutcome(attemptId);
    if (!outcome || outcome.kind === "uncertain") throw new UncertainDispatchError(attemptId, outcome?.errorMessage ?? null);
    if (outcome.kind === "rejection") {
      if (outcome.status === 429) return null;
      throw new TeacherHttpError(outcome.status ?? 400, outcome.body ?? "", false, client.baseUrlDigest);
    }
    if (outcome.body === null || outcome.bodyDigest === null) throw new UncertainDispatchError(attemptId, "captured raw response bytes are incomplete");
    const recovered = replayCapturedTeacherResponse({ body: outcome.body, bodyDigest: outcome.bodyDigest },
      { attemptId, requestNumber: outcome.requestNumber, requestDigest: outcome.requestDigest ?? "" });
    this.save(`response:${attemptId}`, recovered);
    return recovered;
  }

  async complete(client: TeacherClient, request: TeacherCompletionRequest, onDispatch?: () => void): Promise<TeacherCompletion> {
    const key = request.attemptId;
    const binding = { request: requestIdentity(request), identity: client.identity };
    const existing = this.read<typeof binding>(`dispatch:${key}`);
    if (existing && stableStringify(existing) !== stableStringify(binding)) throw new Error("persisted dispatch request/identity drift");
    const response = this.read<TeacherCompletion>(`response:${key}`);
    if (response) {
      if (!existing) throw new Error("response checkpoint has no dispatch binding");
      return response;
    }

    const captured = this.lastOutcome(key);
    if (captured?.kind === "response") {
      // The relay DID answer and those exact bytes are durable. Replaying the
      // pure decoder reaches the identical completion — or the identical
      // `TeacherResponseError` — with no second bill.
      if (!existing) throw new Error("response checkpoint has no dispatch binding");
      if (captured.body === null || captured.bodyDigest === null) {
        throw new UncertainDispatchError(key, "the captured relay body is missing its bytes or digest");
      }
      const recovered = replayCapturedTeacherResponse(
        { body: captured.body, bodyDigest: captured.bodyDigest },
        { attemptId: key, requestNumber: captured.requestNumber, requestDigest: captured.requestDigest ?? "" },
      );
      this.save(`response:${key}`, recovered);
      return recovered;
    }
    if (captured?.kind === "rejection" && captured.status !== 429) {
      throw new TeacherHttpError(captured.status ?? 400, captured.body ?? "", false, client.baseUrlDigest);
    }
    if (captured?.kind === "uncertain") {
      throw new UncertainDispatchError(key, captured.errorMessage ?? captured.errorName ?? "no response was observed");
    }
    // A dispatch marker with no captured outcome is a crash between the marker and
    // the answer. The request may have been billed; resume must not guess.
    if (existing && !captured) throw new UncertainDispatchError(key);

    this.store.renewLease();
    this.save(`dispatch:${key}`, binding);
    onDispatch?.();

    const baseIndex = this.physicalRequestCount(key);
    let lost: unknown = null;
    // The lease is a cross-process protocol with a real timeout. A 660s
    // completion must not age the run out from under its own owner.
    const heartbeat = setInterval(() => {
      if (lost !== null) return;
      try {
        this.store.renewLease();
      } catch (error) {
        lost = error;
      }
    }, this.heartbeatMs);
    heartbeat.unref?.();

    const observer = async (observation: TeacherDispatchObservation): Promise<void> => {
      if (lost !== null) throw lost;
      const index = baseIndex + observation.requestNumber;
      const physical: CapturedPhysicalRequest = { attemptId: key, index, requestNumber: observation.requestNumber };
      if (observation.phase === "before-send") {
        // Ownership first, then the marker: a replaced owner must be stopped
        // BEFORE a socket opens, not after it has already been billed.
        this.store.renewLease();
        this.save(`physical:${key}:${index}`, physical);
        return;
      }
      const success = observation.status !== null && observation.status >= 200 && observation.status < 300;
      const outcome: CapturedOutcome = {
        ...physical,
        kind: observation.phase === "uncertain" || (observation.status !== null && observation.status >= 500) ? "uncertain" : success ? "response" : "rejection",
        status: observation.status,
        body: observation.body,
        bodyDigest: observation.bodyDigest,
        errorName: observation.errorName,
        errorMessage: observation.errorMessage,
        requestDigest: observation.requestDigest,
      };
      this.save(`physical:${key}:${index}`, physical);
      this.save(`outcome:${key}:${index}`, outcome);
    };

    try {
      const completion = await client.complete({ ...request, observer });
      // `save` re-checks ownership: a replaced owner cannot publish a response
      // into the replacement's run.
      this.save(`response:${key}`, completion);
      return completion;
    } finally {
      clearInterval(heartbeat);
    }
  }
}
