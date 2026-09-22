import { validateImageGenerationBaseUrl } from "./imageGeneration.js";

/**
 * Supra2-IMG native image-service adapter (phase 2).
 *
 * This client speaks the verified HTTP contract of the private, tailnet-only
 * Supra2-IMG service (`GET /health`, `GET /api/status`, `POST /api/generate`,
 * `POST /api/batch`, `POST /api/cancel`, and `GET /images/...` downloads). It
 * is server-side only: browsers never call the service directly.
 *
 * Safety rules encoded here:
 * - Submissions are never retried blindly. A timeout or transport failure whose
 *   request may have reached the service resolves to `{ outcome: "uncertain" }`.
 *   Callers reconcile by polling the returned IDs, or discard the submission;
 *   they must not resubmit the same work automatically.
 * - `GET /api/status` history is shared with every other Studio user. Jobs are
 *   only trusted after `selectJobsByIds` proves they belong to this caller.
 * - `POST /api/cancel` is service-wide and is exported only with an explicit
 *   never-wire warning.
 * - Errors never include the configured base URL, the Origin value, or
 *   response bodies (which may echo prompts). Prompts are never logged.
 *
 * The service serializes work on one GPU lane, native output is 256x256, and
 * completed-image history is bounded to 256 entries, so downloads must happen
 * promptly after a job reports done.
 */

/** Default deadline for one HTTP request to the image service. */
export const SUPRA2_IMAGE_DEFAULT_TIMEOUT_MS = 120_000;
/** Default decoded byte budget per downloaded PNG. */
export const SUPRA2_IMAGE_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const SUPRA2_IMAGE_MIN_TIMEOUT_MS = 1_000;
export const SUPRA2_IMAGE_MAX_TIMEOUT_MS = 600_000;
export const SUPRA2_IMAGE_MIN_MAX_BYTES = 1_024;
export const SUPRA2_IMAGE_MAX_MAX_BYTES = 64 * 1024 * 1024;

/** Adapter-side defaults; every submission still sends all four fields explicitly. */
export const SUPRA2_IMAGE_DEFAULT_SEED = 0;
export const SUPRA2_IMAGE_DEFAULT_STEPS = 50;
export const SUPRA2_IMAGE_DEFAULT_CFG = 3;

export const SUPRA2_IMAGE_MAX_PROMPT_CHARS = 1_000;
export const SUPRA2_IMAGE_MAX_SEED = 2_147_483_647;
export const SUPRA2_IMAGE_MIN_STEPS = 1;
export const SUPRA2_IMAGE_MAX_STEPS = 100;
export const SUPRA2_IMAGE_MIN_CFG = 1;
export const SUPRA2_IMAGE_MAX_CFG = 10;
export const SUPRA2_IMAGE_MAX_BATCH_COUNT = 32;
export const SUPRA2_IMAGE_MAX_BATCH_VARIANTS = 8;
export const SUPRA2_IMAGE_MAX_BATCH_IMAGES = 128;

/** The service retains 256 history entries; parsing accepts that plus headroom but stays bounded. */
export const SUPRA2_IMAGE_STATUS_JOB_LIMIT = 512;
/** Upper bound on IDs one `pollJobs` call may reconcile. */
export const SUPRA2_IMAGE_MAX_POLL_IDS = 256;

/** Bounded attempts for one submission before a 429 is surfaced. */
export const SUPRA2_IMAGE_SUBMIT_MAX_ATTEMPTS = 3;
/** Base exponential backoff for the shared batch lane. */
export const SUPRA2_IMAGE_RATE_LIMIT_BASE_DELAY_MS = 500;
/** Hard ceiling for any single backoff sleep. */
export const SUPRA2_IMAGE_RATE_LIMIT_MAX_DELAY_MS = 4_000;

export const SUPRA2_IMAGE_DEFAULT_POLL_INTERVAL_MS = 2_000;
export const SUPRA2_IMAGE_DEFAULT_POLL_DEADLINE_MS = 600_000;
export const SUPRA2_IMAGE_DEFAULT_POLL_MAX_ATTEMPTS = 300;

const HEALTH_PATH = "/health";
const STATUS_PATH = "/api/status";
const GENERATE_PATH = "/api/generate";
const BATCH_PATH = "/api/batch";
const CANCEL_PATH = "/api/cancel";

const HEALTH_BODY_LIMIT = 32 * 1024;
const STATUS_BODY_LIMIT = 1024 * 1024;
const ACCEPT_BODY_LIMIT = 64 * 1024;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;
const MAX_THREADS = 4_096;

/**
 * The phase-1 transport policy, re-exported under the Supra2 name: HTTPS to any
 * host, or HTTP only to loopback, RFC1918 private, or Tailscale CGNAT/
 * `*.ts.net` hosts. Public plain-HTTP destinations stay rejected.
 */
export { validateImageGenerationBaseUrl as validateSupra2ImageBaseUrl };

/** Effective Supra2-IMG settings after environment parsing. */
export interface Supra2ImageConfig {
  /** True only when `VELVET_SCENE_IMAGES_ENABLED` is the exact string `true` and a valid base URL is configured. */
  enabled: boolean;
  /** Normalized base URL without a trailing slash; empty when not validly configured. */
  baseUrl: string;
  /** Origin header sent on POSTs; defaults to the base URL origin. Empty only when the base URL is invalid. */
  origin: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
  /** Decoded byte budget for each downloaded PNG. */
  maxBytes: number;
}

/**
 * Normalizes an Origin header value to a bare `scheme://host[:port]`. Rejects
 * anything that is not an HTTP(S) origin, so a malformed value can never carry
 * path, credentials, or header-splitting bytes into a request.
 */
function normalizeSupra2Origin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Scene image origin must be a valid http(s) origin");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Scene image origin must be a valid http(s) origin");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Scene image origin must not include credentials, a path, a query, or a fragment");
  }
  return url.origin;
}

/** Normalized origin, or an empty string when the configured value is not a bare origin. */
function normalizeOriginOrEmpty(raw: string): string {
  try {
    return normalizeSupra2Origin(raw);
  } catch {
    return "";
  }
}

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  message: string,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(message);
  return value;
}

/**
 * Reads Supra2-IMG settings from the environment. Numeric deadlines and byte
 * budgets are always validated and rejected when malformed, even while the
 * integration is disabled. The integration is enabled only for the exact
 * string `true` plus a valid base URL; `VELVET_SCENE_IMAGES_ORIGIN` defaults to
 * the base URL origin and is validated whenever it is set.
 */
export function readSupra2ImageConfig(env: NodeJS.ProcessEnv = process.env): Supra2ImageConfig {
  const requested = env.VELVET_SCENE_IMAGES_ENABLED === "true";
  const timeoutMs = readBoundedInteger(
    env.VELVET_SCENE_IMAGES_TIMEOUT_MS,
    SUPRA2_IMAGE_DEFAULT_TIMEOUT_MS,
    SUPRA2_IMAGE_MIN_TIMEOUT_MS,
    SUPRA2_IMAGE_MAX_TIMEOUT_MS,
    "Scene image generation timeout must be an integer within 1000\u2013600000ms",
  );
  const maxBytes = readBoundedInteger(
    env.VELVET_SCENE_IMAGES_MAX_BYTES,
    SUPRA2_IMAGE_DEFAULT_MAX_BYTES,
    SUPRA2_IMAGE_MIN_MAX_BYTES,
    SUPRA2_IMAGE_MAX_MAX_BYTES,
    "Scene image byte budget must be an integer within 1024\u201367108864 bytes",
  );
  const rawBaseUrl = (env.VELVET_SCENE_IMAGES_BASE_URL ?? "").trim();
  const validation = validateImageGenerationBaseUrl(rawBaseUrl);
  const baseUrl = validation.ok ? rawBaseUrl.replace(/\/+$/, "") : "";
  const rawOrigin = (env.VELVET_SCENE_IMAGES_ORIGIN ?? "").trim();
  const origin = rawOrigin
    ? normalizeSupra2Origin(rawOrigin)
    : validation.ok
    ? new URL(baseUrl).origin
    : "";
  return {
    enabled: requested && validation.ok,
    baseUrl,
    origin,
    timeoutMs,
    maxBytes,
  };
}

/** Base class for classified Supra2-IMG adapter failures. */
export class Supra2ImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The adapter cannot produce a real, policy-compliant request. */
export class Supra2ImageConfigurationError extends Supra2ImageError {}

/** A download path was not a safe, same-service `/images/...` PNG path. */
export class Supra2ImagePathError extends Supra2ImageError {}

/** The service returned a non-successful HTTP status. */
export class Supra2ImageHttpError extends Supra2ImageError {
  readonly status: number;
  constructor(status: number) {
    super(`Supra2 image service HTTP ${status}`);
    this.status = status;
  }
}

/** The shared batch lane was busy (`429`) after the bounded backoff. */
export class Supra2ImageRateLimitError extends Supra2ImageHttpError {
  readonly retryAfter: string | null;
  constructor(retryAfter: string | null = null) {
    super(429);
    this.retryAfter = retryAfter;
  }
}

/** The configured deadline expired before a definite response. */
export class Supra2ImageTimeoutError extends Supra2ImageError {}

/** The response violated the declared contract or was not valid JSON. */
export class Supra2ImageProtocolError extends Supra2ImageError {}

/** The response exceeded the configured byte budget. */
export class Supra2ImagePayloadTooLargeError extends Supra2ImageError {}

/** The request failed before an HTTP response was available. */
export class Supra2ImageTransportError extends Supra2ImageError {}

/** `/health` answered, but the service reported that it is not healthy. */
export class Supra2ImageHealthError extends Supra2ImageError {}

export type Supra2JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

const JOB_STATUSES: readonly Supra2JobStatus[] = ["queued", "running", "done", "failed", "cancelled"];
const TERMINAL_JOB_STATUSES = new Set<Supra2JobStatus>(["done", "failed", "cancelled"]);

/** One job in the shared service history, restricted to IDs this caller submitted. */
export interface Supra2ImageJob {
  id: string;
  batch: string;
  prompt: string;
  seed: number;
  steps: number;
  cfg: number;
  status: Supra2JobStatus;
  created: number;
  started?: number;
  seconds?: number;
  /** Service-relative `/images/<file>.png` path, present once the job is done. */
  image?: string;
}

export interface Supra2WorkerStatus {
  loaded: boolean;
  threads: number;
  idleUnloadSeconds: number;
}

export interface Supra2ServiceStatus {
  busy: boolean;
  device: string;
  mode: string;
  worker: Supra2WorkerStatus;
  /** Shared history; callers must filter with `selectJobsByIds` before use. */
  jobs: Supra2ImageJob[];
}

export interface Supra2ImageHealth {
  ok: true;
  release: string;
}

export interface Supra2GenerateRequestInput {
  prompt: string;
  seed?: number;
  steps?: number;
  cfg?: number;
}

export interface Supra2GenerateRequest {
  prompt: string;
  seed: number;
  steps: number;
  cfg: number;
}

export interface Supra2BatchRequestInput {
  prompt: string;
  count?: number;
  steps?: readonly number[];
  guidance?: readonly number[];
}

export interface Supra2BatchRequest {
  prompt: string;
  count: number;
  steps: number[];
  guidance: number[];
}

/** Why a submission outcome is unknown; never contains prompts or URLs. */
export type Supra2UncertainReason = "timeout" | "transport" | "unreadable-acceptance";

/**
 * The service may or may not have accepted this submission. Callers must
 * reconcile through status polling by returned ID, or discard the submission;
 * they must not resubmit automatically.
 */
export interface Supra2UncertainSubmission {
  outcome: "uncertain";
  reason: Supra2UncertainReason;
}

export interface Supra2GenerateAccepted {
  outcome: "accepted";
  id: string;
  batch: string;
}

export interface Supra2BatchAccepted {
  outcome: "accepted";
  id: string;
  batch: string;
  ids: string[];
}

export type Supra2GenerateResult = Supra2GenerateAccepted | Supra2UncertainSubmission;
export type Supra2BatchResult = Supra2BatchAccepted | Supra2UncertainSubmission;

export interface Supra2DownloadedImage {
  bytes: Uint8Array;
  contentType: "image/png";
}

export interface Supra2PollOptions {
  /** Hard wall-clock cap for the whole poll. Defaults to 600000ms. */
  deadlineMs?: number;
  /** Delay between successful status snapshots. Defaults to 2000ms. */
  intervalMs?: number;
  /** Hard cap on status requests (including rate-limited ones). Defaults to 300. */
  maxAttempts?: number;
}

export interface Supra2JobPollResult {
  /** True when every requested ID was observed with a terminal status. */
  complete: boolean;
  /** Latest observed job per requested ID, in request order; missing IDs are absent. */
  jobs: Supra2ImageJob[];
  /** Requested IDs that never appeared in any status snapshot (possibly evicted). */
  missingIds: string[];
  /** Status requests attempted, including rate-limited ones. */
  attempts: number;
  /** Status requests rejected with `429`. */
  rateLimited: number;
  elapsedMs: number;
}

/** A client shape shared by the real adapter and deterministic doubles. */
export interface Supra2ImageClient {
  /** Liveness only: health does not establish authorization or model readiness. */
  health(): Promise<Supra2ImageHealth>;
  /** Full service status. Filter `jobs` with `selectJobsByIds` before trusting any entry. */
  status(): Promise<Supra2ServiceStatus>;
  generate(request: Supra2GenerateRequestInput): Promise<Supra2GenerateResult>;
  batch(request: Supra2BatchRequestInput): Promise<Supra2BatchResult>;
  downloadImage(relativePath: string): Promise<Supra2DownloadedImage>;
  pollJobs(ids: readonly string[], options?: Supra2PollOptions): Promise<Supra2JobPollResult>;
  /**
   * Cancels ALL queued service work for every Studio user.
   *
   * It MUST NEVER be wired to per-request or player cancellation, campaign
   * actions, or anything a player can trigger; it exists for an operator to
   * clear a stuck shared lane. If a specific submission must be abandoned,
   * discard it instead of calling this.
   */
  cancelAll(): Promise<void>;
}

export interface Supra2ImageClientOptions {
  config: Supra2ImageConfig;
  /** Injectable transport for deterministic tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable delay used by tests; defaults to an abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable monotonic clock used by tests; defaults to `performance.now`. */
  now?: () => number;
  /** Bounded attempts for a rate-limited submission (`1–6`); defaults to three. */
  maxSubmitAttempts?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaError(what: string): Supra2ImageProtocolError {
  return new Supra2ImageProtocolError(`Supra2 image service ${what} response did not match the declared schema`);
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw schemaError(what);
  return value;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, what: string): string {
  const value = requireString(record, key, what);
  if (value.length === 0) throw schemaError(what);
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, what: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw schemaError(what);
  return value;
}

function requireFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  what: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw schemaError(what);
  return value;
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  what: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw schemaError(what);
  return value;
}

/** The service may identify a batch with a string or a number; normalize to a string. */
function requireBatch(record: Record<string, unknown>, what: string): string {
  const value = record.batch;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw schemaError(what);
}

/**
 * A same-service image path: rooted at `/images/`, one or more conservative
 * segments, ending in `.png`. Rejects schemes, `//` hosts, traversal,
 * percent-encoding, queries, fragments, backslashes, and control bytes.
 */
function isSafeImagePath(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false;
  if (/[\u0000-\u001f\u007f\\%?#]/.test(value)) return false;
  if (!value.startsWith("/images/")) return false;
  const segments = value.slice(1).split("/");
  if (segments.length < 2) return false;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) return false;
  }
  return segments[segments.length - 1]!.toLowerCase().endsWith(".png");
}

function normalizeImagePath(raw: unknown): string {
  if (typeof raw !== "string") throw new Supra2ImagePathError("Supra2 image path must be a string");
  const value = raw.trim();
  if (!isSafeImagePath(value)) {
    throw new Supra2ImagePathError("Supra2 image path must be a same-service /images/... PNG path");
  }
  return value;
}

function isJobStatus(value: unknown): value is Supra2JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

function parseImageJob(value: unknown): Supra2ImageJob {
  if (!isRecord(value)) throw schemaError("status");
  if (!isJobStatus(value.status)) throw schemaError("status");
  const job: Supra2ImageJob = {
    id: requireNonEmptyString(value, "id", "status"),
    batch: requireBatch(value, "status"),
    prompt: requireNonEmptyString(value, "prompt", "status"),
    seed: requireInteger(value, "seed", "status", 0, SUPRA2_IMAGE_MAX_SEED),
    steps: requireInteger(value, "steps", "status", SUPRA2_IMAGE_MIN_STEPS, SUPRA2_IMAGE_MAX_STEPS),
    cfg: requireFiniteNumber(value, "cfg", "status", SUPRA2_IMAGE_MIN_CFG, SUPRA2_IMAGE_MAX_CFG),
    status: value.status,
    created: requireFiniteNumber(value, "created", "status", 0, Number.MAX_SAFE_INTEGER),
  };
  if (value.started !== undefined) {
    job.started = requireFiniteNumber(value, "started", "status", 0, Number.MAX_SAFE_INTEGER);
  }
  if (value.seconds !== undefined) {
    job.seconds = requireFiniteNumber(value, "seconds", "status", 0, Number.MAX_SAFE_INTEGER);
  }
  if (value.image !== undefined) {
    if (typeof value.image !== "string" || !isSafeImagePath(value.image)) throw schemaError("status");
    job.image = value.image;
  }
  return job;
}

function parseWorkerStatus(value: unknown): Supra2WorkerStatus {
  if (!isRecord(value)) throw schemaError("status");
  return {
    loaded: requireBoolean(value, "loaded", "status"),
    threads: requireInteger(value, "threads", "status", 0, MAX_THREADS),
    idleUnloadSeconds: requireFiniteNumber(value, "idle_unload_seconds", "status", 0, Number.MAX_SAFE_INTEGER),
  };
}

/** Strictly parses a `/api/status` body and bounds the shared job history. */
export function parseSupra2ServiceStatus(payload: unknown): Supra2ServiceStatus {
  if (!isRecord(payload)) throw schemaError("status");
  const jobs = payload.jobs;
  if (!Array.isArray(jobs)) throw schemaError("status");
  if (jobs.length > SUPRA2_IMAGE_STATUS_JOB_LIMIT) {
    throw new Supra2ImageProtocolError("Supra2 image service status exceeded the bounded job limit");
  }
  return {
    busy: requireBoolean(payload, "busy", "status"),
    device: requireString(payload, "device", "status"),
    mode: requireString(payload, "mode", "status"),
    worker: parseWorkerStatus(payload.worker),
    jobs: jobs.map(parseImageJob),
  };
}

function parseHealth(payload: unknown): Supra2ImageHealth {
  if (!isRecord(payload)) throw schemaError("health");
  if (typeof payload.ok !== "boolean") throw schemaError("health");
  if (payload.ok !== true) throw new Supra2ImageHealthError("Supra2 image service reported an unhealthy state");
  if (typeof payload.release !== "string") throw schemaError("health");
  return { ok: true, release: payload.release };
}

function parseAcceptedBase(payload: unknown): { id: string; batch: string } {
  if (!isRecord(payload)) throw schemaError("submission");
  return {
    id: requireNonEmptyString(payload, "id", "submission"),
    batch: requireBatch(payload, "submission"),
  };
}

function parseAcceptedIds(payload: Record<string, unknown>): string[] {
  const ids = payload.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > SUPRA2_IMAGE_MAX_BATCH_IMAGES) {
    throw schemaError("submission");
  }
  return ids.map((id) => {
    if (typeof id !== "string" || id.length === 0) throw schemaError("submission");
    return id;
  });
}

/**
 * Returns only the jobs whose IDs the caller submitted, in requested-ID order.
 *
 * This is the trust boundary for the shared `/api/status` history: jobs from
 * other Studio users must never be treated as ours, surfaced as results, or
 * used to reconcile a submission.
 */
export function selectJobsByIds(jobs: readonly Supra2ImageJob[], ids: readonly string[]): Supra2ImageJob[] {
  const byId = new Map<string, Supra2ImageJob>();
  for (const job of jobs) byId.set(job.id, job);
  const selected: Supra2ImageJob[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const job = byId.get(id);
    if (job) selected.push(job);
  }
  return selected;
}

function requirePrompt(value: unknown): string {
  if (typeof value !== "string") throw new Supra2ImageConfigurationError("Supra2 image prompt must be a string");
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > SUPRA2_IMAGE_MAX_PROMPT_CHARS) {
    throw new Supra2ImageConfigurationError(
      `Supra2 image prompt must be 1\u2013${SUPRA2_IMAGE_MAX_PROMPT_CHARS} characters after trimming`,
    );
  }
  return prompt;
}

function requireRequestInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Supra2ImageConfigurationError(`Supra2 image ${name} must be an integer within ${min}\u2013${max}`);
  }
  return value;
}

function requireRequestNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Supra2ImageConfigurationError(`Supra2 image ${name} must be a number within ${min}\u2013${max}`);
  }
  return value;
}

function requireVariantValues(value: unknown, name: string, min: number, max: number, integer: boolean): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUPRA2_IMAGE_MAX_BATCH_VARIANTS) {
    throw new Supra2ImageConfigurationError(
      `Supra2 image batch ${name} must be an array of 1\u2013${SUPRA2_IMAGE_MAX_BATCH_VARIANTS} values`,
    );
  }
  return value.map((entry) => {
    const validNumber = typeof entry === "number" && Number.isFinite(entry) && entry >= min && entry <= max;
    if (!validNumber || (integer && !Number.isInteger(entry))) {
      throw new Supra2ImageConfigurationError(
        `Supra2 image batch ${name} values must be ${integer ? "integers" : "numbers"} within ${min}\u2013${max}`,
      );
    }
    return entry as number;
  });
}

/** Validates and normalizes one `/api/generate` request; the trim is the prompt the service receives. */
export function parseSupra2GenerateRequest(input: Supra2GenerateRequestInput): Supra2GenerateRequest {
  if (!isRecord(input)) throw new Supra2ImageConfigurationError("Supra2 image generate request is invalid");
  return {
    prompt: requirePrompt(input.prompt),
    seed: input.seed === undefined
      ? SUPRA2_IMAGE_DEFAULT_SEED
      : requireRequestInteger(input.seed, "seed", 0, SUPRA2_IMAGE_MAX_SEED),
    steps: input.steps === undefined
      ? SUPRA2_IMAGE_DEFAULT_STEPS
      : requireRequestInteger(input.steps, "steps", SUPRA2_IMAGE_MIN_STEPS, SUPRA2_IMAGE_MAX_STEPS),
    cfg: input.cfg === undefined
      ? SUPRA2_IMAGE_DEFAULT_CFG
      : requireRequestNumber(input.cfg, "cfg", SUPRA2_IMAGE_MIN_CFG, SUPRA2_IMAGE_MAX_CFG),
  };
}

/** Validates one `/api/batch` request, including the 128-image combinatorics ceiling. */
export function parseSupra2BatchRequest(input: Supra2BatchRequestInput): Supra2BatchRequest {
  if (!isRecord(input)) throw new Supra2ImageConfigurationError("Supra2 image batch request is invalid");
  const prompt = requirePrompt(input.prompt);
  const count = input.count === undefined
    ? 1
    : requireRequestInteger(input.count, "count", 1, SUPRA2_IMAGE_MAX_BATCH_COUNT);
  const steps = input.steps === undefined
    ? [SUPRA2_IMAGE_DEFAULT_STEPS]
    : requireVariantValues(input.steps, "steps", SUPRA2_IMAGE_MIN_STEPS, SUPRA2_IMAGE_MAX_STEPS, true);
  const guidance = input.guidance === undefined
    ? [SUPRA2_IMAGE_DEFAULT_CFG]
    : requireVariantValues(input.guidance, "guidance", SUPRA2_IMAGE_MIN_CFG, SUPRA2_IMAGE_MAX_CFG, false);
  if (count * steps.length * guidance.length > SUPRA2_IMAGE_MAX_BATCH_IMAGES) {
    throw new Supra2ImageConfigurationError(
      `Supra2 image batch must not exceed ${SUPRA2_IMAGE_MAX_BATCH_IMAGES} images`,
    );
  }
  return { prompt, count, steps, guidance };
}

function requireEnabled(config: Supra2ImageConfig, origin: string): void {
  if (!config.enabled) throw new Supra2ImageConfigurationError("Supra2 image service is not enabled");
  if (!validateImageGenerationBaseUrl(config.baseUrl).ok) {
    throw new Supra2ImageConfigurationError("Supra2 image service base URL is not valid");
  }
  if (!origin) throw new Supra2ImageConfigurationError("Supra2 image service origin is not valid");
}

function readHeaders(): Record<string, string> {
  return { Accept: "application/json" };
}

function writeHeaders(origin: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    // The service requires its own origin on mutations; no credential is sent.
    Origin: origin,
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= REDIRECT_STATUS_MIN && status <= REDIRECT_STATUS_MAX;
}

function httpError(response: Response): Supra2ImageError {
  if (response.status === 429) return new Supra2ImageRateLimitError(response.headers.get("retry-after"));
  return new Supra2ImageHttpError(response.status);
}

function assertSuccessful(response: Response): void {
  if (isRedirectStatus(response.status)) throw new Supra2ImageTransportError("Supra2 image service redirect refused");
  if (!response.ok) throw httpError(response);
}

async function runWithTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Supra2ImageConfigurationError("Supra2 image service timeout must be positive");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new Supra2ImageTimeoutError("Supra2 image service request timed out", { cause: error });
    if (error instanceof Supra2ImageError) throw error;
    throw new Supra2ImageTransportError("Supra2 image service transport failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most `limit` bytes, enforcing both the declared and observed size. */
async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new Supra2ImagePayloadTooLargeError("Supra2 image service response exceeded the byte budget");
  }
  if (!response.body) throw new Supra2ImageProtocolError("Supra2 image service response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new Supra2ImagePayloadTooLargeError("Supra2 image service response exceeded the byte budget");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseJsonBody(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Supra2ImageProtocolError(`Supra2 image service ${what} response was not valid JSON`, { cause: error });
  }
}

function pngContentType(response: Response, what: string): "image/png" {
  const raw = response.headers.get("content-type");
  if (raw === null) return "image/png";
  const normalized = raw.split(";")[0]!.trim().toLowerCase();
  if (normalized !== "image/png") {
    throw new Supra2ImageProtocolError(`Supra2 image service ${what} response was not a PNG`);
  }
  return "image/png";
}

function hasPngMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Supra2ImageTransportError("Supra2 image service sleep was interrupted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Supra2ImageTransportError("Supra2 image service sleep was interrupted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Exponential backoff with equal jitter for the single shared batch lane. The
 * returned delay is always at most the capped exponential ceiling, so bounded
 * retries can never hold or interrupt the lane for another user for long.
 */
function rateLimitDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(
    SUPRA2_IMAGE_RATE_LIMIT_MAX_DELAY_MS,
    SUPRA2_IMAGE_RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.floor(ceiling / 2 + (ceiling / 2) * jitter);
}

function isTerminalStatus(status: Supra2JobStatus | undefined): boolean {
  return status !== undefined && TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Builds the native Supra2-IMG client. There is deliberately no blind POST
 * retry: only a `429` (a definite rejection from the shared lane) is retried,
 * under bounded backoff with jitter. Timeouts and transport failures during a
 * submission resolve to `{ outcome: "uncertain" }`.
 */
export function createSupra2ImageClient(options: Supra2ImageClientOptions): Supra2ImageClient {
  const { config } = options;
  const http = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());
  const origin = normalizeOriginOrEmpty(config.origin);
  const requestedAttempts = options.maxSubmitAttempts ?? SUPRA2_IMAGE_SUBMIT_MAX_ATTEMPTS;
  if (!Number.isInteger(requestedAttempts) || requestedAttempts < 1 || requestedAttempts > 6) {
    throw new Supra2ImageConfigurationError("Supra2 image submit attempts must be an integer within 1\u20136");
  }
  const maxSubmitAttempts = requestedAttempts;

  async function fetchStatus(timeoutMs: number): Promise<Supra2ServiceStatus> {
    return runWithTimeout(timeoutMs, async (signal) => {
      const response = await http(`${config.baseUrl}${STATUS_PATH}`, {
        method: "GET",
        headers: readHeaders(),
        signal,
        redirect: "error",
      });
      assertSuccessful(response);
      return parseSupra2ServiceStatus(parseJsonBody(await readBoundedBytes(response, STATUS_BODY_LIMIT), "status"));
    });
  }

  /**
   * Submits one JSON body. Returns the parsed acceptance on `202`; a `429` is
   * retried with bounded jittered backoff; any transport/timeout/parse failure
   * after the request may have been sent returns `uncertain` instead of
   * throwing, so callers can reconcile rather than duplicate GPU work.
   */
  async function submit<T extends { outcome: "accepted" }>(
    path: string,
    body: string,
    accept: (response: Response) => Promise<T>,
  ): Promise<T | Supra2UncertainSubmission> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    try {
      for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await http(`${config.baseUrl}${path}`, {
            method: "POST",
            headers: writeHeaders(origin),
            body,
            signal: controller.signal,
            redirect: "error",
          });
        } catch {
          return { outcome: "uncertain", reason: timedOut ? "timeout" : "transport" };
        }
        if (response.status === 429) {
          if (attempt >= maxSubmitAttempts) {
            throw new Supra2ImageRateLimitError(response.headers.get("retry-after"));
          }
          try {
            await sleep(rateLimitDelayMs(attempt, random), controller.signal);
          } catch (error) {
            if (timedOut) {
              throw new Supra2ImageTimeoutError("Supra2 image service submission timed out while waiting to retry", { cause: error });
            }
            if (error instanceof Supra2ImageError) throw error;
            throw new Supra2ImageTransportError("Supra2 image service submission was interrupted", { cause: error });
          }
          continue;
        }
        if (isRedirectStatus(response.status)) throw new Supra2ImageTransportError("Supra2 image service redirect refused");
        if (response.status !== 202) throw httpError(response);
        try {
          return await accept(response);
        } catch {
          // The service already accepted the work; losing the ID is uncertain,
          // never a clean failure.
          if (timedOut) return { outcome: "uncertain", reason: "timeout" };
          return { outcome: "uncertain", reason: "unreadable-acceptance" };
        }
      }
      throw new Supra2ImageTransportError("Supra2 image service submission failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function postCancel(): Promise<void> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    try {
      for (let attempt = 1; attempt <= maxSubmitAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await http(`${config.baseUrl}${CANCEL_PATH}`, {
            method: "POST",
            headers: writeHeaders(origin),
            body: "{}",
            signal: controller.signal,
            redirect: "error",
          });
        } catch (error) {
          if (timedOut) throw new Supra2ImageTimeoutError("Supra2 image service cancel timed out", { cause: error });
          throw new Supra2ImageTransportError("Supra2 image service cancel transport failed", { cause: error });
        }
        if (response.status === 429) {
          if (attempt >= maxSubmitAttempts) {
            throw new Supra2ImageRateLimitError(response.headers.get("retry-after"));
          }
          try {
            await sleep(rateLimitDelayMs(attempt, random), controller.signal);
          } catch (error) {
            if (timedOut) throw new Supra2ImageTimeoutError("Supra2 image service cancel timed out", { cause: error });
            if (error instanceof Supra2ImageError) throw error;
            throw new Supra2ImageTransportError("Supra2 image service cancel transport failed", { cause: error });
          }
          continue;
        }
        if (isRedirectStatus(response.status)) throw new Supra2ImageTransportError("Supra2 image service redirect refused");
        if (!response.ok) throw httpError(response);
        return;
      }
      throw new Supra2ImageTransportError("Supra2 image service cancel failed");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async health(): Promise<Supra2ImageHealth> {
      requireEnabled(config, origin);
      return runWithTimeout(config.timeoutMs, async (signal) => {
        const response = await http(`${config.baseUrl}${HEALTH_PATH}`, {
          method: "GET",
          headers: readHeaders(),
          signal,
          redirect: "error",
        });
        assertSuccessful(response);
        return parseHealth(parseJsonBody(await readBoundedBytes(response, HEALTH_BODY_LIMIT), "health"));
      });
    },

    async status(): Promise<Supra2ServiceStatus> {
      requireEnabled(config, origin);
      return fetchStatus(config.timeoutMs);
    },

    async generate(request: Supra2GenerateRequestInput): Promise<Supra2GenerateResult> {
      requireEnabled(config, origin);
      const parsed = parseSupra2GenerateRequest(request);
      return submit(GENERATE_PATH, JSON.stringify(parsed), async (response) => {
        const payload = parseJsonBody(await readBoundedBytes(response, ACCEPT_BODY_LIMIT), "submission");
        const accepted = parseAcceptedBase(payload);
        return { outcome: "accepted" as const, id: accepted.id, batch: accepted.batch };
      });
    },

    async batch(request: Supra2BatchRequestInput): Promise<Supra2BatchResult> {
      requireEnabled(config, origin);
      const parsed = parseSupra2BatchRequest(request);
      return submit(BATCH_PATH, JSON.stringify(parsed), async (response) => {
        const payload = parseJsonBody(await readBoundedBytes(response, ACCEPT_BODY_LIMIT), "submission");
        if (!isRecord(payload)) throw schemaError("submission");
        const accepted = parseAcceptedBase(payload);
        return { outcome: "accepted" as const, id: accepted.id, batch: accepted.batch, ids: parseAcceptedIds(payload) };
      });
    },

    async downloadImage(relativePath: string): Promise<Supra2DownloadedImage> {
      requireEnabled(config, origin);
      const path = normalizeImagePath(relativePath);
      return runWithTimeout(config.timeoutMs, async (signal) => {
        const url = `${config.baseUrl}${path}`;
        // Same-origin check: a crafted path can never redirect the request to a
        // foreign host even if the path validator is later relaxed.
        if (new URL(url).origin !== new URL(config.baseUrl).origin) {
          throw new Supra2ImagePathError("Supra2 image path must stay on the configured service origin");
        }
        const response = await http(url, {
          method: "GET",
          headers: { Accept: "image/png" },
          signal,
          redirect: "error",
        });
        assertSuccessful(response);
        const contentType = pngContentType(response, "image");
        const bytes = await readBoundedBytes(response, config.maxBytes);
        if (!hasPngMagic(bytes)) {
          throw new Supra2ImageProtocolError("Supra2 image service download was not a PNG");
        }
        return { bytes, contentType };
      });
    },

    async pollJobs(ids: readonly string[], pollOptions: Supra2PollOptions = {}): Promise<Supra2JobPollResult> {
      requireEnabled(config, origin);
      const requested = normalizePollIds(ids);
      const intervalMs = pollOption(pollOptions.intervalMs, SUPRA2_IMAGE_DEFAULT_POLL_INTERVAL_MS, "interval", 1, 600_000);
      const deadlineMs = pollOption(pollOptions.deadlineMs, SUPRA2_IMAGE_DEFAULT_POLL_DEADLINE_MS, "deadline", 1, 86_400_000);
      const maxAttempts = pollOption(pollOptions.maxAttempts, SUPRA2_IMAGE_DEFAULT_POLL_MAX_ATTEMPTS, "max attempts", 1, 10_000);
      const startedAt = now();
      const lastSeen = new Map<string, Supra2ImageJob>();
      let attempts = 0;
      let rateLimited = 0;
      let complete = false;

      while (attempts < maxAttempts) {
        const elapsed = now() - startedAt;
        if (elapsed >= deadlineMs) break;
        attempts += 1;
        let snapshot: Supra2ServiceStatus;
        try {
          snapshot = await fetchStatus(Math.min(config.timeoutMs, Math.max(1, deadlineMs - elapsed)));
        } catch (error) {
          if (error instanceof Supra2ImageRateLimitError) {
            rateLimited += 1;
            if (attempts >= maxAttempts || now() - startedAt >= deadlineMs) break;
            await sleep(rateLimitDelayMs(rateLimited, random));
            continue;
          }
          throw error;
        }
        for (const job of selectJobsByIds(snapshot.jobs, requested)) lastSeen.set(job.id, job);
        complete = requested.every((id) => isTerminalStatus(lastSeen.get(id)?.status));
        if (complete) break;
        if (attempts >= maxAttempts || now() - startedAt >= deadlineMs) break;
        await sleep(intervalMs);
      }

      const jobs = requested.flatMap((id) => {
        const job = lastSeen.get(id);
        return job ? [job] : [];
      });
      return {
        complete,
        jobs,
        missingIds: requested.filter((id) => !lastSeen.has(id)),
        attempts,
        rateLimited,
        elapsedMs: Math.max(0, Math.round(now() - startedAt)),
      };
    },

    async cancelAll(): Promise<void> {
      requireEnabled(config, origin);
      await postCancel();
    },
  };
}

function normalizePollIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > SUPRA2_IMAGE_MAX_POLL_IDS) {
    throw new Supra2ImageConfigurationError(
      `Supra2 image poll must name 1\u2013${SUPRA2_IMAGE_MAX_POLL_IDS} job IDs`,
    );
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Supra2ImageConfigurationError("Supra2 image poll job IDs must be non-empty strings");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function pollOption(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Supra2ImageConfigurationError(`Supra2 image poll ${name} must be an integer within ${min}\u2013${max}`);
  }
  return resolved;
}
