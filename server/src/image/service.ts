import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock, IdGenerator } from "../runtime.js";
import {
  SUPRA2_IMAGE_MAX_PROMPT_CHARS,
  Supra2ImageRateLimitError,
  type Supra2DownloadedImage,
  type Supra2ImageClient,
  type Supra2ImageJob,
  type Supra2JobPollResult,
} from "../provider/supra2ImageService.js";
import { SCENE_BATCH_MAX_COUNT } from "./scenePrompt.js";
import {
  DEFAULT_SCENE_IMAGE_SETTINGS,
  SCENE_IMAGE_GUIDANCE_MAX,
  SCENE_IMAGE_GUIDANCE_MIN,
  SCENE_IMAGE_MAX_SEED,
  SCENE_IMAGE_MIN_SEED,
  SCENE_IMAGE_STEPS_MAX,
  SCENE_IMAGE_STEPS_MIN,
  SceneImageSettingsValidationError,
  mergeSceneImageSettings,
  parseSceneImageSettings,
  sceneImageCacheKey,
  withinAutoLimits,
  type SceneImageAutoLimitDecision,
  type SceneImageAutoLimitReason,
  type SceneImageSettings,
  type SceneImageSettingsPatch,
  type SceneImageUsageState,
} from "./settings.js";

/**
 * Scene-image sidecar service.
 *
 * Storage is a dedicated SQLite sidecar (`<dataDir>/images/presentation.sqlite`)
 * with private permissions and a bounded asset/history cache, mirroring the
 * voice sidecar (`server/src/voice/service.ts`). The canonical game database is
 * never extended: campaign membership is read (or injected) through
 * `SceneImageAuthorizer`, and the Supra2 client is injected so tests never touch
 * the network.
 *
 * Queue rules:
 * - A submission is one `generate` or `batch` call. Only one submission is in
 *   flight at a time; `tick()` reconciles every tracked service job before it
 *   submits up to `maxPerTick` queued jobs, and stops after one acceptance.
 * - `done` service jobs are downloaded and persisted as campaign assets.
 * - Ambiguous submissions become `uncertain` and are never retried.
 * - Rate limiting leaves the job queued (the client already backs off) and
 *   never duplicates a submission that has a tracked service job ID.
 *
 * Scene binding:
 * `scene_image_selections.revision` is the scene revision the current selection
 * represents. A completed job binds its primary asset when the selection is
 * absent or not newer than the job's `scene_revision`; a newer active selection
 * makes the job `stale`, and the selection is never overwritten. Manual
 * `selectImage` is an optimistic update on that same value (`expectedRevision`
 * must equal the current selection revision, or 0 when none exists).
 */

export const SCENE_IMAGE_SIDECAR_VERSION = 1;
export const SCENE_IMAGE_DEFAULT_MAX_PER_TICK = 1;
export const SCENE_IMAGE_DEFAULT_POLL_INTERVAL_MS = 2_000;
export const SCENE_IMAGE_DEFAULT_HISTORY_LIMIT = 256;
export const SCENE_IMAGE_DEFAULT_ASSET_LIMIT = 256;
export const SCENE_IMAGE_DEFAULT_ASSET_BYTE_LIMIT = 192 * 1024 * 1024;
export const SCENE_IMAGE_MAX_IDEMPOTENCY_KEY_CHARS = 200;
export const SCENE_IMAGE_MAX_LIMIT = 200;
export const SCENE_IMAGE_DEFAULT_LIMIT = 50;
export const SCENE_IMAGE_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SCENE_IMAGE_MAX_PNG_DIMENSION = 16_384;

/** Failure with an HTTP-ish status; messages never include prompts or bytes. */
export class SceneImageError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "SceneImageError";
    this.statusCode = statusCode;
  }
}

export type SceneImageRole = "owner" | "gm" | "player" | "observer";

/** Campaign-membership seam; the default reads the canonical repository database. */
export interface SceneImageAuthorizer {
  role(principalId: string, campaignId: string): SceneImageRole | null;
}

export interface SceneImageAuthorizerHandle extends SceneImageAuthorizer {
  close(): void;
}

export type SceneImageJobStatus =
  | "queued"
  | "submitted"
  | "running"
  | "done"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "stale";

export type SceneImageJobKind = "single" | "batch";

export interface SceneImageJob {
  readonly jobId: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly sceneKey: string;
  readonly sceneRevision: number;
  readonly narrationEventId: string | null;
  readonly prompt: string;
  readonly seed: number;
  readonly steps: number;
  readonly guidance: number;
  readonly kind: SceneImageJobKind;
  readonly count: number;
  readonly serviceBatchId: string | null;
  readonly serviceJobIds: readonly string[];
  readonly status: SceneImageJobStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly completedAt: string | null;
  readonly assetId: string | null;
}

export interface SceneImageSelection {
  readonly campaignId: string;
  readonly sessionId: string;
  readonly sceneKey: string;
  readonly assetId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface SceneImageReceipt {
  readonly idempotencyKey: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly occurredAt: string;
  readonly replayed: boolean;
}

export interface SceneImageSettingsRead {
  readonly settings: SceneImageSettings;
  readonly revision: number;
}

export interface SceneImageSettingsUpdate extends SceneImageSettingsRead {
  readonly receipt: SceneImageReceipt;
}

export interface SceneImageSettingsInput {
  readonly patch: SceneImageSettingsPatch;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export type SceneImageEnqueueRefusalCode = Exclude<SceneImageAutoLimitReason, "allowed">;

export interface SceneImageEnqueueRefusal {
  readonly code: SceneImageEnqueueRefusalCode;
  readonly message: string;
  readonly remaining: number;
  readonly cooldownEndsAt: string | null;
}

export interface SceneImageEnqueueInput {
  readonly sessionId: string;
  readonly sceneKey: string;
  readonly sceneRevision: number;
  readonly narrationEventId?: string;
  readonly prompt: string;
  readonly seed?: number;
  readonly steps: number;
  readonly guidance: number;
  readonly kind: SceneImageJobKind;
  readonly count?: number;
  readonly auto: boolean;
}

export type SceneImageEnqueueResult =
  | { readonly job: SceneImageJob; readonly deduped: boolean; readonly refusal: null }
  | { readonly job: null; readonly deduped: false; readonly refusal: SceneImageEnqueueRefusal };

export interface SceneImageGalleryQuery {
  readonly sessionId?: string;
  readonly limit?: number;
}

export interface SceneImageGalleryImage {
  readonly selections?: readonly { sceneKey: string; revision: number }[];
  readonly assetId: string;
  readonly campaignId: string;
  readonly prompt: string;
  readonly seed: number;
  readonly steps: number;
  readonly guidance: number;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly selected: boolean;
}

export interface SceneImageGallery {
  readonly images: readonly SceneImageGalleryImage[];
  readonly jobs?: readonly SceneImageJob[];
}

export interface SceneImageSelectInput {
  readonly sessionId: string;
  readonly sceneKey: string;
  readonly assetId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface SceneImageSelectionResult {
  readonly selection: SceneImageSelection;
  readonly receipt: SceneImageReceipt;
}

export interface SceneImageAssetBytes {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface SceneImageWorkerOptions {
  /** Submissions attempted per tick (one acceptance ends the tick). */
  readonly maxPerTick: number;
  /** `start()` interval; also the poll interval hinted to the client. */
  readonly pollIntervalMs: number;
  /** Terminal jobs kept before the oldest are pruned. */
  readonly historyLimit: number;
  /** Assets kept before the least-recently-used unselected ones are pruned. */
  readonly assetLimit: number;
  /** Total asset bytes kept before the least-recently-used unselected are pruned. */
  readonly assetByteLimit: number;
}

export interface SceneImagePruneResult {
  readonly assets: number;
  readonly jobs: number;
  readonly receipts: number;
}

export interface SceneImageTickResult {
  readonly reconciled: number;
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly stale: number;
  readonly uncertain: number;
  readonly persisted: number;
}

export interface SceneImageServiceOptions {
  dataDir: string;
  client: Supra2ImageClient;
  clock: Clock;
  ids: IdGenerator;
  worker?: Partial<SceneImageWorkerOptions>;
  /** Test/route seam; defaults to reading `campaign_memberships` from `<dataDir>/velvet.sqlite`. */
  authorize?: SceneImageAuthorizer;
}

interface SettingsRow {
  campaign_id: string;
  settings_json: string;
  revision: number;
  updated_at: string;
}

interface JobRow {
  job_id: string;
  campaign_id: string;
  session_id: string;
  scene_key: string;
  scene_revision: number;
  narration_event_id: string | null;
  prompt: string;
  seed: number;
  steps: number;
  guidance: number;
  kind: string;
  count: number;
  service_batch_id: string | null;
  service_job_ids_json: string | null;
  status: string;
  attempts: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  asset_id: string | null;
}

interface AssetRow {
  asset_id: string;
  campaign_id: string;
  cache_key: string;
  prompt: string;
  seed: number;
  steps: number;
  guidance: number;
  content_type: string;
  width: number;
  height: number;
  bytes: Buffer;
  byte_size: number;
  created_at: string;
  last_used_at: string;
}

interface SelectionRow {
  campaign_id: string;
  session_id: string;
  scene_key: string;
  asset_id: string;
  revision: number;
  updated_at: string;
}

interface ReceiptRow {
  principal_id: string;
  campaign_id: string;
  operation: string;
  idempotency_key: string;
  request_digest: string;
  response_json: string;
  created_at: string;
}

const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SCENE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const JOB_STATUSES = [
  "queued",
  "submitted",
  "running",
  "done",
  "failed",
  "uncertain",
  "cancelled",
  "stale",
] as const satisfies readonly SceneImageJobStatus[];
const ACTIVE_SQL = "('submitted','running')";
const SETTLED_SQL = "('done','failed','uncertain','cancelled','stale')";
const COUNTED_SQL = "('queued','submitted','running','done','stale')";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scene_image_settings(
  campaign_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scene_image_jobs(
  job_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scene_key TEXT NOT NULL,
  scene_revision INTEGER NOT NULL,
  narration_event_id TEXT,
  prompt TEXT NOT NULL,
  seed INTEGER NOT NULL,
  steps INTEGER NOT NULL,
  guidance REAL NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  service_batch_id TEXT,
  service_job_ids_json TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT,
  asset_id TEXT
);
CREATE INDEX IF NOT EXISTS scene_image_jobs_campaign_idx ON scene_image_jobs(campaign_id, created_at, job_id);
CREATE INDEX IF NOT EXISTS scene_image_jobs_status_idx ON scene_image_jobs(status, created_at, job_id);
CREATE TABLE IF NOT EXISTS scene_image_assets(
  asset_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  seed INTEGER NOT NULL,
  steps INTEGER NOT NULL,
  guidance REAL NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  UNIQUE(campaign_id, cache_key)
);
CREATE INDEX IF NOT EXISTS scene_image_assets_campaign_idx ON scene_image_assets(campaign_id, created_at, asset_id);
CREATE TABLE IF NOT EXISTS scene_image_selections(
  campaign_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scene_key TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(campaign_id, session_id, scene_key)
);
CREATE INDEX IF NOT EXISTS scene_image_selections_asset_idx ON scene_image_selections(campaign_id, asset_id);
CREATE TABLE IF NOT EXISTS scene_image_receipts(
  principal_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_id, campaign_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS scene_image_receipts_created_idx ON scene_image_receipts(created_at);
PRAGMA user_version=${SCENE_IMAGE_SIDECAR_VERSION};
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIdentity(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw new SceneImageError(400, `${name} must be 1-128 characters of letters, digits, dot, underscore, colon, or dash`);
  }
  return value;
}

function requireSceneId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SCENE_ID_PATTERN.test(value)) {
    throw new SceneImageError(400, `${name} must be 1-200 characters of letters, digits, dot, underscore, colon, or dash`);
  }
  return value;
}

function requirePrompt(value: unknown): string {
  if (typeof value !== "string") throw new SceneImageError(400, "prompt must be a string");
  const prompt = value.trim();
  if (prompt.length < 1 || prompt.length > SUPRA2_IMAGE_MAX_PROMPT_CHARS) {
    throw new SceneImageError(400, `prompt must be 1-${SUPRA2_IMAGE_MAX_PROMPT_CHARS} characters after trimming`);
  }
  return prompt;
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SceneImageError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new SceneImageError(400, `${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function requireRevision(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SceneImageError(400, `${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") throw new SceneImageError(400, "idempotencyKey must be a string");
  const key = value.trim();
  if (key.length < 1 || key.length > SCENE_IMAGE_MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new SceneImageError(400, `idempotencyKey must be 1-${SCENE_IMAGE_MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  }
  return key;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deriveSeed(campaignId: string, idempotencyKey: string): number {
  const digest = createHash("sha256").update(`scene-image-seed\0${campaignId}\0${idempotencyKey}`).digest();
  return digest.readUInt32BE(0) % (SCENE_IMAGE_MAX_SEED + 1);
}

function parseSettingsJson(json: string): SceneImageSettings {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new SceneImageError(500, "Stored scene image settings are corrupt");
  }
  try {
    return parseSceneImageSettings(value);
  } catch {
    throw new SceneImageError(500, "Stored scene image settings are corrupt");
  }
}

function parseServiceIds(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function toJobStatus(value: string): SceneImageJobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value) ? (value as SceneImageJobStatus) : "failed";
}

function toJobKind(value: string): SceneImageJobKind {
  return value === "batch" ? "batch" : "single";
}

function isJobKind(value: unknown): value is SceneImageJobKind {
  return value === "single" || value === "batch";
}

function mapJob(row: JobRow): SceneImageJob {
  return {
    jobId: row.job_id,
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    sceneKey: row.scene_key,
    sceneRevision: row.scene_revision,
    narrationEventId: row.narration_event_id,
    prompt: row.prompt,
    seed: row.seed,
    steps: row.steps,
    guidance: row.guidance,
    kind: toJobKind(row.kind),
    count: row.count,
    serviceBatchId: row.service_batch_id,
    serviceJobIds: parseServiceIds(row.service_job_ids_json),
    status: toJobStatus(row.status),
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    assetId: row.asset_id,
  };
}

function mapSelection(row: SelectionRow): SceneImageSelection {
  return {
    campaignId: row.campaign_id,
    sessionId: row.session_id,
    sceneKey: row.scene_key,
    assetId: row.asset_id,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function mapGalleryImage(row: AssetRow, selected: boolean): SceneImageGalleryImage {
  return {
    assetId: row.asset_id,
    campaignId: row.campaign_id,
    prompt: row.prompt,
    seed: row.seed,
    steps: row.steps,
    guidance: row.guidance,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    selected,
  };
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > SCENE_IMAGE_MAX_PNG_DIMENSION || height > SCENE_IMAGE_MAX_PNG_DIMENSION) {
    return null;
  }
  return { width, height };
}

function refusalOf(decision: SceneImageAutoLimitDecision): SceneImageEnqueueRefusal {
  const reason: SceneImageEnqueueRefusalCode = decision.reason === "allowed" ? "disabled" : decision.reason;
  const messages: Record<SceneImageEnqueueRefusalCode, string> = {
    disabled: "Scene images are disabled for this campaign",
    manual: "Scene image generation is manual for this campaign",
    "session-limit": "This session reached its automatic scene-image limit",
    cooldown: "Scene image generation is cooling down",
  };
  return {
    code: reason,
    message: messages[reason],
    remaining: decision.remaining,
    cooldownEndsAt: decision.cooldownEndsAt,
  };
}

interface MutableTickSummary {
  reconciled: number;
  submitted: number;
  completed: number;
  failed: number;
  cancelled: number;
  stale: number;
  uncertain: number;
  persisted: number;
}

interface NormalizedEnqueueInput {
  sessionId: string;
  sceneKey: string;
  sceneRevision: number;
  narrationEventId: string | null;
  prompt: string;
  seed: number | null;
  steps: number;
  guidance: number;
  kind: SceneImageJobKind;
  count: number;
  auto: boolean;
}

function normalizeEnqueueInput(input: unknown): NormalizedEnqueueInput {
  if (!isRecord(input)) throw new SceneImageError(400, "Scene image enqueue input must be an object");
  const sessionId = requireSceneId(input.sessionId, "sessionId");
  const sceneKey = requireSceneId(input.sceneKey, "sceneKey");
  const sceneRevision = requireRevision(input.sceneRevision, "sceneRevision");
  const narrationEventId = input.narrationEventId === undefined || input.narrationEventId === null
    ? null
    : requireSceneId(input.narrationEventId, "narrationEventId");
  const prompt = requirePrompt(input.prompt);
  const seed = input.seed === undefined || input.seed === null
    ? null
    : requireInteger(input.seed, "seed", SCENE_IMAGE_MIN_SEED, SCENE_IMAGE_MAX_SEED);
  const steps = requireInteger(input.steps, "steps", SCENE_IMAGE_STEPS_MIN, SCENE_IMAGE_STEPS_MAX);
  const guidance = requireNumber(input.guidance, "guidance", SCENE_IMAGE_GUIDANCE_MIN, SCENE_IMAGE_GUIDANCE_MAX);
  const kind = input.kind;
  if (!isJobKind(kind)) throw new SceneImageError(400, "kind must be single or batch");
  const auto = input.auto;
  if (typeof auto !== "boolean") throw new SceneImageError(400, "auto must be a boolean");
  let count = 1;
  if (kind === "batch") {
    count = requireInteger(input.count === undefined ? 1 : input.count, "count", 1, SCENE_BATCH_MAX_COUNT);
  } else if (input.count !== undefined && input.count !== 1) {
    throw new SceneImageError(400, "single scene image jobs generate exactly one image");
  }
  return {
    sessionId,
    sceneKey,
    sceneRevision,
    narrationEventId,
    prompt,
    seed,
    steps,
    guidance,
    kind,
    count,
    auto,
  };
}

function resolveWorkerOptions(options: Partial<SceneImageWorkerOptions> | undefined): SceneImageWorkerOptions {
  const resolved: SceneImageWorkerOptions = {
    maxPerTick: options?.maxPerTick ?? SCENE_IMAGE_DEFAULT_MAX_PER_TICK,
    pollIntervalMs: options?.pollIntervalMs ?? SCENE_IMAGE_DEFAULT_POLL_INTERVAL_MS,
    historyLimit: options?.historyLimit ?? SCENE_IMAGE_DEFAULT_HISTORY_LIMIT,
    assetLimit: options?.assetLimit ?? SCENE_IMAGE_DEFAULT_ASSET_LIMIT,
    assetByteLimit: options?.assetByteLimit ?? SCENE_IMAGE_DEFAULT_ASSET_BYTE_LIMIT,
  };
  requireInteger(resolved.maxPerTick, "worker.maxPerTick", 1, 1_000);
  requireInteger(resolved.pollIntervalMs, "worker.pollIntervalMs", 1, 600_000);
  requireInteger(resolved.historyLimit, "worker.historyLimit", 1, 100_000);
  requireInteger(resolved.assetLimit, "worker.assetLimit", 1, 100_000);
  requireInteger(resolved.assetByteLimit, "worker.assetByteLimit", 1_024, Number.MAX_SAFE_INTEGER);
  return resolved;
}

/**
 * Read-only campaign-membership authorization against the canonical repository
 * database. Absent database, absent table, or absent membership fails closed.
 * The connection is opened lazily so tests and installations without a
 * repository database can still inject their own `authorize`.
 */
export function createRepositorySceneImageAuthorizer(dataDir: string): SceneImageAuthorizerHandle {
  const databasePath = join(dataDir, "velvet.sqlite");
  let handle: Database.Database | null = null;
  let unavailable = false;
  const open = (): Database.Database | null => {
    if (handle) return handle;
    if (unavailable) return null;
    try {
      handle = new Database(databasePath, { readonly: true, fileMustExist: true });
      return handle;
    } catch {
      unavailable = true;
      return null;
    }
  };
  return {
    role(principalId: string, campaignId: string): SceneImageRole | null {
      const database = open();
      if (!database) return null;
      try {
        const row = database
          .prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
          .get(campaignId, principalId) as { role?: string } | undefined;
        const role = row?.role;
        return role === "owner" || role === "gm" || role === "player" || role === "observer" ? role : null;
      } catch {
        return null;
      }
    },
    close(): void {
      handle?.close();
      handle = null;
    },
  };
}

export class SceneImageService {
  private readonly db: Database.Database;
  private owner: Database.Database | null = null;
  private readonly worker: SceneImageWorkerOptions;
  private readonly client: Supra2ImageClient;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly authorizer: SceneImageAuthorizer;
  private readonly ownAuthorizer: SceneImageAuthorizerHandle | null;
  private closed = false;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SceneImageServiceOptions) {
    this.client = options.client;
    this.clock = options.clock;
    this.ids = options.ids;
    this.worker = resolveWorkerOptions(options.worker);
    const path = join(options.dataDir, "images", "presentation.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    try {
      chmodSync(path, 0o600);
      // A dedicated connection holds an OS-backed exclusive lock for the
      // service lifetime; crash cleanup is automatic. Resolve symlinks so
      // alternate spellings share the same ownership boundary.
      const ownerPath = `${realpathSync(path)}.owner.sqlite`;
      this.owner = new Database(ownerPath, { timeout: 0 });
      chmodSync(ownerPath, 0o600);
      try {
        this.owner.exec("BEGIN EXCLUSIVE");
      } catch {
        throw new SceneImageError(503, "Scene image sidecar is already owned by another process");
      }
      this.db.pragma("journal_mode=WAL");
      this.db.pragma("busy_timeout=5000");
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version !== 0 && version !== SCENE_IMAGE_SIDECAR_VERSION) {
        throw new SceneImageError(503, "Unsupported scene image sidecar version");
      }
      this.db.transaction(() => {
        this.db.exec(SCHEMA);
      })();
      if (options.authorize) {
        this.authorizer = options.authorize;
        this.ownAuthorizer = null;
      } else {
        const authorizer = createRepositorySceneImageAuthorizer(options.dataDir);
        this.authorizer = authorizer;
        this.ownAuthorizer = authorizer;
      }
    } catch (error) {
      this.owner?.close();
      this.owner = null;
      if (this.db.open) this.db.close();
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new SceneImageError(503, "Scene image service is closed");
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private requireMember(principalId: string, campaignId: string): SceneImageRole {
    if (typeof principalId !== "string" || typeof campaignId !== "string"
      || !IDENTITY_PATTERN.test(principalId) || !IDENTITY_PATTERN.test(campaignId)) {
      throw new SceneImageError(400, "Invalid principal or campaign identity");
    }
    const role = this.authorizer.role(principalId, campaignId);
    if (role === null) throw new SceneImageError(404, "Campaign scene images are unavailable");
    return role;
  }

  private requireDm(principalId: string, campaignId: string): SceneImageRole {
    const role = this.requireMember(principalId, campaignId);
    if (role !== "owner" && role !== "gm") {
      throw new SceneImageError(403, "Scene image management requires the campaign owner or GM");
    }
    return role;
  }

  private settingsRow(campaignId: string): SettingsRow | undefined {
    return this.db
      .prepare("SELECT * FROM scene_image_settings WHERE campaign_id=?")
      .get(campaignId) as SettingsRow | undefined;
  }

  private jobRow(campaignId: string, jobId: string): JobRow | undefined {
    return this.db
      .prepare("SELECT * FROM scene_image_jobs WHERE campaign_id=? AND job_id=?")
      .get(campaignId, jobId) as JobRow | undefined;
  }

  private assetRow(campaignId: string, assetId: string): AssetRow | undefined {
    return this.db
      .prepare("SELECT * FROM scene_image_assets WHERE campaign_id=? AND asset_id=?")
      .get(campaignId, assetId) as AssetRow | undefined;
  }

  private assetRowByCacheKey(campaignId: string, cacheKey: string): AssetRow | undefined {
    return this.db
      .prepare("SELECT * FROM scene_image_assets WHERE campaign_id=? AND cache_key=?")
      .get(campaignId, cacheKey) as AssetRow | undefined;
  }

  private selectionRow(campaignId: string, sessionId: string, sceneKey: string): SelectionRow | undefined {
    return this.db
      .prepare("SELECT * FROM scene_image_selections WHERE campaign_id=? AND session_id=? AND scene_key=?")
      .get(campaignId, sessionId, sceneKey) as SelectionRow | undefined;
  }

  private readSettings(campaignId: string): SceneImageSettings {
    const row = this.settingsRow(campaignId);
    return row ? parseSettingsJson(row.settings_json) : parseSceneImageSettings(DEFAULT_SCENE_IMAGE_SETTINGS);
  }

  private findReceipt(
    operation: string,
    principalId: string,
    campaignId: string,
    idempotencyKey: string,
    requestDigest: string,
  ): ReceiptRow | null {
    const row = this.db
      .prepare(`SELECT * FROM scene_image_receipts
        WHERE principal_id=? AND campaign_id=? AND operation=? AND idempotency_key=?`)
      .get(principalId, campaignId, operation, idempotencyKey) as ReceiptRow | undefined;
    if (!row) return null;
    if (row.request_digest !== requestDigest) {
      throw new SceneImageError(409, "Idempotency key was reused for a different scene image request");
    }
    return row;
  }

  private saveReceipt(
    operation: string,
    principalId: string,
    campaignId: string,
    idempotencyKey: string,
    requestDigest: string,
    response: unknown,
  ): void {
    this.db
      .prepare(`INSERT INTO scene_image_receipts
        (principal_id,campaign_id,operation,idempotency_key,request_digest,response_json,created_at)
        VALUES(?,?,?,?,?,?,?)`)
      .run(principalId, campaignId, operation, idempotencyKey, requestDigest, JSON.stringify(response), this.now());
  }

  getSettings(principalId: string, campaignId: string): SceneImageSettingsRead {
    this.ensureOpen();
    this.requireDm(principalId, campaignId);
    const row = this.settingsRow(campaignId);
    if (!row) {
      return { settings: parseSceneImageSettings(DEFAULT_SCENE_IMAGE_SETTINGS), revision: 0 };
    }
    return { settings: parseSettingsJson(row.settings_json), revision: row.revision };
  }

  updateSettings(
    principalId: string,
    campaignId: string,
    input: SceneImageSettingsInput,
  ): SceneImageSettingsUpdate {
    this.ensureOpen();
    this.requireDm(principalId, campaignId);
    if (!isRecord(input)) throw new SceneImageError(400, "Scene image settings input must be an object");
    if (!isRecord(input.patch)) throw new SceneImageError(400, "settings patch must be a plain object");
    const expectedRevision = requireRevision(input.expectedRevision, "expectedRevision");
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const patch = input.patch as SceneImageSettingsPatch;
    const digest = digestOf({ operation: "update-settings", principalId, campaignId, patch, expectedRevision });
    const replay = this.findReceipt("update-settings", principalId, campaignId, idempotencyKey, digest);
    if (replay) {
      const stored = JSON.parse(replay.response_json) as SceneImageSettingsUpdate;
      return { ...stored, receipt: { ...stored.receipt, replayed: true } };
    }
    const current = this.settingsRow(campaignId);
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) {
      throw new SceneImageError(409, "Scene image settings changed; refresh first");
    }
    let merged: SceneImageSettings;
    try {
      merged = mergeSceneImageSettings(current ? parseSettingsJson(current.settings_json) : DEFAULT_SCENE_IMAGE_SETTINGS, patch);
    } catch (error) {
      if (error instanceof SceneImageSettingsValidationError) {
        throw new SceneImageError(400, `Invalid scene image settings: ${error.issues.join("; ")}`);
      }
      throw error;
    }
    const occurredAt = this.now();
    const receipt: SceneImageReceipt = {
      idempotencyKey,
      revisionBefore: revision,
      revisionAfter: revision + 1,
      occurredAt,
      replayed: false,
    };
    const response: SceneImageSettingsUpdate = { settings: merged, revision: revision + 1, receipt };
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO scene_image_settings(campaign_id,settings_json,revision,updated_at)
          VALUES(?,?,?,?)
          ON CONFLICT(campaign_id) DO UPDATE SET
            settings_json=excluded.settings_json,
            revision=excluded.revision,
            updated_at=excluded.updated_at`)
        .run(campaignId, JSON.stringify(merged), revision + 1, occurredAt);
      this.saveReceipt("update-settings", principalId, campaignId, idempotencyKey, digest, response);
    })();
    return response;
  }

  private usage(campaignId: string, sessionId: string): SceneImageUsageState {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS images, MAX(completed_at) AS last FROM scene_image_jobs
        WHERE campaign_id=? AND session_id=? AND status IN ${COUNTED_SQL}`)
      .get(campaignId, sessionId) as { images: number; last: string | null };
    return { imagesThisSession: row.images, lastGeneratedAt: row.last };
  }

  enqueue(
    principalId: string,
    campaignId: string,
    input: SceneImageEnqueueInput,
    idempotencyKey: string,
  ): SceneImageEnqueueResult {
    this.ensureOpen();
    this.requireDm(principalId, campaignId);
    const normalized = normalizeEnqueueInput(input);
    const key = requireIdempotencyKey(idempotencyKey);
    const digest = digestOf({ operation: "enqueue", principalId, campaignId, input: normalized });
    const replay = this.findReceipt("enqueue", principalId, campaignId, key, digest);
    if (replay) {
      const stored = JSON.parse(replay.response_json) as { job: SceneImageJob; deduped: boolean };
      const fresh = this.jobRow(campaignId, stored.job.jobId);
      return { job: fresh ? mapJob(fresh) : stored.job, deduped: true, refusal: null };
    }
    this.prune();
    const settings = this.readSettings(campaignId);
    // Automatic jobs enforce the campaign opt-in and the per-session
    // limit/cooldown. Manual generations are deliberate DM actions; they still
    // require the campaign feature to be enabled, but not the automatic limits.
    if (!settings.enabled) {
      return {
        job: null,
        deduped: false,
        refusal: {
          code: "disabled",
          message: "Scene images are disabled for this campaign",
          remaining: 0,
          cooldownEndsAt: null,
        },
      };
    }
    if (normalized.auto) {
      const decision = withinAutoLimits(this.usage(campaignId, normalized.sessionId), settings, this.clock.now());
      if (!decision.allowed) return { job: null, deduped: false, refusal: refusalOf(decision) };
    }
    const seed = normalized.seed ?? (settings.seedMode === "fixed" ? settings.fixedSeed : deriveSeed(campaignId, key));
    if (seed + normalized.count - 1 > SCENE_IMAGE_MAX_SEED) {
      throw new SceneImageError(400, "Scene image seed range exceeds the supported maximum");
    }
    const cacheKeys = Array.from({ length: normalized.count }, (_unused, index) => sceneImageCacheKey({
      prompt: normalized.prompt,
      seed: seed + index,
      steps: normalized.steps,
      guidance: normalized.guidance,
    }));
    const cachedAssets: AssetRow[] = [];
    let allCached = true;
    for (const cacheKey of cacheKeys) {
      const asset = this.assetRowByCacheKey(campaignId, cacheKey);
      if (asset) cachedAssets.push(asset);
      else allCached = false;
    }
    const jobId = this.ids.nextId();
    const createdAt = this.now();
    this.db
      .prepare(`INSERT INTO scene_image_jobs
        (job_id,campaign_id,session_id,scene_key,scene_revision,narration_event_id,prompt,seed,steps,guidance,kind,count,
         service_batch_id,service_job_ids_json,status,attempts,error_code,created_at,updated_at,submitted_at,completed_at,asset_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'queued',0,NULL,?,?,NULL,NULL,NULL)`)
      .run(
        jobId,
        campaignId,
        normalized.sessionId,
        normalized.sceneKey,
        normalized.sceneRevision,
        normalized.narrationEventId,
        normalized.prompt,
        seed,
        normalized.steps,
        normalized.guidance,
        normalized.kind,
        normalized.count,
        createdAt,
        createdAt,
      );
    const row = this.jobRow(campaignId, jobId);
    if (!row) throw new SceneImageError(500, "Scene image job could not be created");
    let deduped = false;
    if (allCached) {
      // Cache hit: link the existing asset(s) and complete without a submit.
      this.finishWithAssets(row, cachedAssets.map((asset) => asset.asset_id));
      deduped = true;
    }
    const job = this.jobRow(campaignId, jobId);
    const response: SceneImageEnqueueResult = {
      job: job ? mapJob(job) : mapJob(row),
      deduped,
      refusal: null,
    };
    this.saveReceipt("enqueue", principalId, campaignId, key, digest, response);
    return response;
  }

  listGallery(principalId: string, campaignId: string, query: SceneImageGalleryQuery = {}): SceneImageGallery {
    this.ensureOpen();
    const role = this.requireMember(principalId, campaignId);
    const sessionId = query.sessionId === undefined ? null : requireSceneId(query.sessionId, "sessionId");
    const limit = query.limit === undefined
      ? SCENE_IMAGE_DEFAULT_LIMIT
      : requireInteger(query.limit, "limit", 1, SCENE_IMAGE_MAX_LIMIT);
    if (role === "owner" || role === "gm") {
      const assets = this.db
        .prepare(`SELECT * FROM scene_image_assets WHERE campaign_id=? AND (
          asset_id IN (SELECT asset_id FROM scene_image_assets WHERE campaign_id=? ORDER BY created_at DESC, asset_id DESC LIMIT ?)
          OR asset_id IN (SELECT asset_id FROM scene_image_selections WHERE campaign_id=? AND (? IS NULL OR session_id=?)))
          ORDER BY created_at DESC, asset_id DESC`)
        .all(campaignId, campaignId, limit, campaignId, sessionId, sessionId) as AssetRow[];
      const selections = this.db
        .prepare("SELECT asset_id, session_id, scene_key, revision FROM scene_image_selections WHERE campaign_id=?")
        .all(campaignId) as Array<{ asset_id: string; session_id: string; scene_key: string; revision: number }>;
      const selected = new Set(
        selections.filter((row) => sessionId === null || row.session_id === sessionId).map((row) => row.asset_id),
      );
      const jobs = this.db
        .prepare("SELECT * FROM scene_image_jobs WHERE campaign_id=? ORDER BY created_at DESC, job_id DESC LIMIT ?")
        .all(campaignId, limit) as JobRow[];
      return { images: assets.map((row) => ({ ...mapGalleryImage(row, selected.has(row.asset_id)), selections: selections.filter((selection) => selection.asset_id === row.asset_id && selection.session_id === sessionId).map((selection) => ({ sceneKey: selection.scene_key, revision: selection.revision })) })), jobs: jobs.map(mapJob) };
    }
    if (role !== "player") throw new SceneImageError(403, "Scene image gallery is unavailable");
    if (sessionId === null) throw new SceneImageError(400, "Player scene image gallery requires a sessionId");
    const assets = this.db
      .prepare(`SELECT asset.*, selection.scene_key, selection.revision FROM scene_image_selections selection
        JOIN scene_image_assets asset ON asset.asset_id=selection.asset_id AND asset.campaign_id=selection.campaign_id
        WHERE selection.campaign_id=? AND selection.session_id=?
        ORDER BY selection.updated_at DESC, asset.asset_id DESC LIMIT ?`)
      .all(campaignId, sessionId, limit) as (AssetRow & { scene_key: string; revision: number })[];
    return { images: assets.map((row) => ({ ...mapGalleryImage(row, true), selections: [{ sceneKey: row.scene_key, revision: row.revision }] })) };
  }

  selectImage(
    principalId: string,
    campaignId: string,
    input: SceneImageSelectInput,
  ): SceneImageSelectionResult {
    this.ensureOpen();
    this.requireDm(principalId, campaignId);
    if (!isRecord(input)) throw new SceneImageError(400, "Scene image selection input must be an object");
    const sessionId = requireSceneId(input.sessionId, "sessionId");
    const sceneKey = requireSceneId(input.sceneKey, "sceneKey");
    const assetId = requireSceneId(input.assetId, "assetId");
    const expectedRevision = requireRevision(input.expectedRevision, "expectedRevision");
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const digest = digestOf({ operation: "select-image", principalId, campaignId, sessionId, sceneKey, assetId, expectedRevision });
    const replay = this.findReceipt("select-image", principalId, campaignId, idempotencyKey, digest);
    if (replay) {
      const stored = JSON.parse(replay.response_json) as SceneImageSelectionResult;
      return { ...stored, receipt: { ...stored.receipt, replayed: true } };
    }
    const asset = this.assetRow(campaignId, assetId);
    if (!asset) throw new SceneImageError(404, "Scene image asset is unavailable");
    return this.db.transaction(() => {
    const current = this.selectionRow(campaignId, sessionId, sceneKey);
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) {
      throw new SceneImageError(409, "Scene image selection changed; refresh first");
    }
    const updatedAt = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO scene_image_selections(campaign_id,session_id,scene_key,asset_id,revision,updated_at)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(campaign_id,session_id,scene_key) DO UPDATE SET
            asset_id=excluded.asset_id,
            revision=excluded.revision,
            updated_at=excluded.updated_at`)
        .run(campaignId, sessionId, sceneKey, assetId, expectedRevision + 1, updatedAt);
      this.touchAsset(assetId, updatedAt);
    })();
    const saved = this.selectionRow(campaignId, sessionId, sceneKey);
    const result: SceneImageSelectionResult = {
      selection: saved
        ? mapSelection(saved)
        : { campaignId, sessionId, sceneKey, assetId, revision: expectedRevision + 1, updatedAt },
      receipt: {
        idempotencyKey,
        revisionBefore: revision,
        revisionAfter: expectedRevision + 1,
        occurredAt: updatedAt,
        replayed: false,
      },
    };
    this.saveReceipt("select-image", principalId, campaignId, idempotencyKey, digest, result);
    return result;
    })();
  }

  readAsset(principalId: string, campaignId: string, assetId: string): SceneImageAssetBytes {
    this.ensureOpen();
    const role = this.requireMember(principalId, campaignId);
    const id = requireSceneId(assetId, "assetId");
    if (role !== "owner" && role !== "gm" && role !== "player") {
      throw new SceneImageError(403, "Scene image asset is unavailable");
    }
    const row = this.assetRow(campaignId, id);
    if (!row) throw new SceneImageError(404, "Scene image asset is unavailable");
    if (role === "player") {
      const selected = this.db
        .prepare("SELECT 1 AS present FROM scene_image_selections WHERE campaign_id=? AND asset_id=? LIMIT 1")
        .get(campaignId, id) as { present: number } | undefined;
      if (!selected) throw new SceneImageError(403, "Scene image asset is not published to players");
    }
    this.touchAsset(id, this.now());
    return { bytes: Buffer.from(row.bytes), contentType: row.content_type };
  }

  getJob(principalId: string, campaignId: string, jobId: string): { job: SceneImageJob } {
    this.ensureOpen();
    this.requireDm(principalId, campaignId);
    const id = requireSceneId(jobId, "jobId");
    const row = this.jobRow(campaignId, id);
    if (!row) throw new SceneImageError(404, "Scene image job is unavailable");
    return { job: mapJob(row) };
  }

  private touchAsset(assetId: string, at: string = this.now()): void {
    this.db.prepare("UPDATE scene_image_assets SET last_used_at=? WHERE asset_id=?").run(at, assetId);
  }

  private setErrorCode(jobId: string, errorCode: string): void {
    this.db
      .prepare("UPDATE scene_image_jobs SET error_code=?, updated_at=? WHERE job_id=?")
      .run(errorCode, this.now(), jobId);
  }

  private markStatus(jobId: string, status: SceneImageJobStatus): void {
    this.db
      .prepare("UPDATE scene_image_jobs SET status=?, updated_at=? WHERE job_id=?")
      .run(status, this.now(), jobId);
  }

  private markSubmitted(jobId: string, serviceBatchId: string, serviceJobIds: readonly string[]): void {
    const at = this.now();
    this.db
      .prepare(`UPDATE scene_image_jobs SET status='submitted', service_batch_id=?, service_job_ids_json=?,
        submitted_at=?, error_code=NULL, updated_at=? WHERE job_id=?`)
      .run(serviceBatchId, JSON.stringify(serviceJobIds), at, at, jobId);
  }

  private markUncertain(jobId: string, errorCode: string): void {
    const at = this.now();
    this.db
      .prepare(`UPDATE scene_image_jobs SET status='uncertain', error_code=?,
        completed_at=?, updated_at=? WHERE job_id=?`)
      .run(errorCode, at, at, jobId);
  }

  private markFailed(jobId: string, errorCode: string): void {
    const at = this.now();
    this.db
      .prepare(`UPDATE scene_image_jobs SET status='failed', error_code=?,
        completed_at=?, updated_at=? WHERE job_id=?`)
      .run(errorCode, at, at, jobId);
  }

  private finishTerminal(row: JobRow, status: "failed" | "cancelled", errorCode: string, persisted: readonly string[]): void {
    const at = this.now();
    this.db
      .prepare(`UPDATE scene_image_jobs SET status=?, error_code=?, asset_id=?, completed_at=?, updated_at=? WHERE job_id=?`)
      .run(status, errorCode, persisted.length > 0 ? persisted[0] ?? null : row.asset_id, at, at, row.job_id);
  }

  /**
   * Completes persisted candidates without publishing. Only explicit DM selection
   * can change player artwork; scene revisions never double as selection revisions.
   */
  private finishWithAssets(row: JobRow, assetIds: readonly string[]): void {
    const at = this.now();
    const primary = assetIds.length > 0 ? assetIds[0] ?? null : null;
    // Completion creates candidates only. Publication always requires an explicit
    // DM selection; scene content revisions and selection revisions are unrelated.
    const status: SceneImageJobStatus = "done";
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE scene_image_jobs SET status=?, asset_id=?, error_code=?, completed_at=?, updated_at=? WHERE job_id=?")
        .run(status, primary, null, at, at, row.job_id);
      if (primary) this.touchAsset(primary, at);

    })();
  }

  private variantSeed(row: JobRow, index: number): number {
    return row.seed + index;
  }

  private variantCacheKey(row: JobRow, index: number): string {
    return sceneImageCacheKey({
      prompt: row.prompt,
      seed: this.variantSeed(row, index),
      steps: row.steps,
      guidance: row.guidance,
    });
  }

  private async submit(row: JobRow, summary: MutableTickSummary): Promise<"accepted" | "retry" | "settled"> {
    this.db
      .prepare("UPDATE scene_image_jobs SET attempts=attempts+1, updated_at=? WHERE job_id=?")
      .run(this.now(), row.job_id);
    try {
      if (row.kind === "single") {
        const result = await this.client.generate({
          prompt: row.prompt,
          seed: row.seed,
          steps: row.steps,
          cfg: row.guidance,
        });
        if (result.outcome === "uncertain") {
          this.markUncertain(row.job_id, "submission-uncertain");
          summary.uncertain += 1;
          return "settled";
        }
        this.markSubmitted(row.job_id, result.batch, [result.id]);
        summary.submitted += 1;
        return "accepted";
      }
      const result = await this.client.batch({
        prompt: row.prompt,
        count: row.count,
        steps: [row.steps],
        guidance: [row.guidance],
      });
      if (result.outcome === "uncertain") {
        this.markUncertain(row.job_id, "submission-uncertain");
        summary.uncertain += 1;
        return "settled";
      }
      if (result.ids.length !== row.count) {
        this.markFailed(row.job_id, "service-count-mismatch");
        summary.failed += 1;
        return "settled";
      }
      this.markSubmitted(row.job_id, result.batch, result.ids);
      summary.submitted += 1;
      return "accepted";
    } catch (error) {
      if (error instanceof Supra2ImageRateLimitError) {
        // The client already applied its bounded backoff; keep the job queued
        // for a later tick instead of duplicating the submission.
        this.setErrorCode(row.job_id, "rate-limited");
        return "retry";
      }
      this.markFailed(row.job_id, "submission-failed");
      summary.failed += 1;
      return "settled";
    }
  }

  private async reconcile(row: JobRow, summary: MutableTickSummary): Promise<void> {
    const ids = parseServiceIds(row.service_job_ids_json);
    if (ids.length === 0) {
      this.markUncertain(row.job_id, "service-job-missing");
      summary.uncertain += 1;
      return;
    }
    let result: Supra2JobPollResult;
    try {
      result = await this.client.pollJobs(ids, { intervalMs: this.worker.pollIntervalMs, maxAttempts: 1 });
    } catch (error) {
      if (error instanceof Supra2ImageRateLimitError) this.setErrorCode(row.job_id, "rate-limited");
      else this.setErrorCode(row.job_id, "poll-failed");
      return;
    }
    const byId = new Map<string, Supra2ImageJob>();
    for (const job of result.jobs) byId.set(job.id, job);
    if (ids.some((id) => !byId.has(id))) {
      this.markUncertain(row.job_id, "service-job-missing");
      summary.uncertain += 1;
      return;
    }
    const persisted: string[] = [];
    const at = this.now();
    for (let index = 0; index < ids.length; index += 1) {
      const serviceJob = byId.get(ids[index] ?? "");
      if (!serviceJob || serviceJob.status !== "done") continue;
      const cacheKey = this.variantCacheKey(row, index);
      const existing = this.assetRowByCacheKey(row.campaign_id, cacheKey);
      if (existing) {
        this.touchAsset(existing.asset_id, at);
        persisted.push(existing.asset_id);
        continue;
      }
      if (!serviceJob.image) {
        this.markFailed(row.job_id, "service-image-missing");
        summary.failed += 1;
        return;
      }
      let downloaded: Supra2DownloadedImage;
      try {
        downloaded = await this.client.downloadImage(serviceJob.image);
      } catch {
        this.markFailed(row.job_id, "download-failed");
        summary.failed += 1;
        return;
      }
      const dimensions = readPngDimensions(downloaded.bytes);
      if (!dimensions) {
        this.markFailed(row.job_id, "invalid-png");
        summary.failed += 1;
        return;
      }
      const bytes = Buffer.from(downloaded.bytes);
      const assetId = this.ids.nextId();
      this.db
        .prepare(`INSERT INTO scene_image_assets
          (asset_id,campaign_id,cache_key,prompt,seed,steps,guidance,content_type,width,height,bytes,byte_size,created_at,last_used_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          assetId,
          row.campaign_id,
          cacheKey,
          row.prompt,
          this.variantSeed(row, index),
          row.steps,
          row.guidance,
          downloaded.contentType,
          dimensions.width,
          dimensions.height,
          bytes,
          bytes.byteLength,
          at,
          at,
        );
      persisted.push(assetId);
      summary.persisted += 1;
    }
    const statuses = ids.map((id) => byId.get(id)?.status);
    const allTerminal = statuses.every((status) => status === "done" || status === "failed" || status === "cancelled");
    if (!allTerminal) {
      this.markStatus(row.job_id, statuses.some((status) => status === "running") ? "running" : "submitted");
      return;
    }
    if (statuses.some((status) => status === "failed")) {
      this.finishTerminal(row, "failed", "service-failed", persisted);
      summary.failed += 1;
      return;
    }
    if (statuses.some((status) => status === "cancelled")) {
      this.finishTerminal(row, "cancelled", "service-cancelled", persisted);
      summary.cancelled += 1;
      return;
    }
    this.finishWithAssets(row, persisted);
    const settled = this.jobRow(row.campaign_id, row.job_id);
    if (settled?.status === "stale") summary.stale += 1;
    else summary.completed += 1;
  }

  /**
   * Processes tracked jobs once: reconcile every in-flight submission, then
   * submit queued work up to `maxPerTick`, stopping after one acceptance so a
   * previous submission is never pending while a new one is sent.
   */
  async tick(): Promise<SceneImageTickResult> {
    const summary: MutableTickSummary = {
      reconciled: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      stale: 0,
      uncertain: 0,
      persisted: 0,
    };
    this.ensureOpen();
    if (this.busy) return summary;
    this.busy = true;
    try {
      const active = this.db
        .prepare(`SELECT * FROM scene_image_jobs WHERE status IN ${ACTIVE_SQL} ORDER BY created_at, job_id`)
        .all() as JobRow[];
      for (const row of active) {
        summary.reconciled += 1;
        await this.reconcile(row, summary);
      }
      const stillActive = this.db
        .prepare(`SELECT 1 AS present FROM scene_image_jobs WHERE status IN ${ACTIVE_SQL} LIMIT 1`)
        .get() as { present: number } | undefined;
      if (stillActive) return summary;
      for (let index = 0; index < this.worker.maxPerTick; index += 1) {
        const next = this.db
          .prepare("SELECT * FROM scene_image_jobs WHERE status='queued' ORDER BY created_at, job_id LIMIT 1")
          .get() as JobRow | undefined;
        if (!next) break;
        const outcome = await this.submit(next, summary);
        if (outcome !== "settled") break;
      }
    } finally {
      this.busy = false;
    }
    return summary;
  }

  /** Starts the periodic worker. `tick()` stays callable directly for tests. */
  start(): void {
    this.ensureOpen();
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.worker.pollIntervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private pruneAssets(): number {
    let removed = 0;
    while (true) {
      const usage = this.db
        .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM scene_image_assets")
        .get() as { count: number; bytes: number };
      if (usage.count <= this.worker.assetLimit && usage.bytes <= this.worker.assetByteLimit) break;
      // Selected assets are never evicted, so an installation can temporarily
      // exceed its asset quota rather than lose a displayed image.
      const candidate = this.db
        .prepare(`SELECT asset_id FROM scene_image_assets
          WHERE asset_id NOT IN (SELECT asset_id FROM scene_image_selections)
          ORDER BY last_used_at ASC, created_at ASC, asset_id ASC LIMIT 1`)
        .get() as { asset_id: string } | undefined;
      if (!candidate) break;
      this.db.transaction(() => {
        this.db.prepare("UPDATE scene_image_jobs SET asset_id=NULL WHERE asset_id=?").run(candidate.asset_id);
        this.db.prepare("DELETE FROM scene_image_assets WHERE asset_id=?").run(candidate.asset_id);
      })();
      removed += 1;
    }
    return removed;
  }

  private pruneJobs(): number {
    const active = this.db
      .prepare("SELECT COUNT(*) AS count FROM scene_image_jobs WHERE status IN ('queued','submitted','running')")
      .get() as { count: number };
    const historyAllowance = Math.max(0, this.worker.historyLimit - active.count);
    const deleted = this.db
      .prepare(`DELETE FROM scene_image_jobs WHERE job_id IN (
        SELECT job_id FROM scene_image_jobs WHERE status IN ${SETTLED_SQL}
        ORDER BY created_at DESC, job_id DESC LIMIT -1 OFFSET ?)`)
      .run(historyAllowance);
    return deleted.changes;
  }

  private pruneReceipts(): number {
    const cutoff = new Date(this.clock.now().getTime() - SCENE_IMAGE_RECEIPT_RETENTION_MS).toISOString();
    const deleted = this.db
      .prepare("DELETE FROM scene_image_receipts WHERE created_at < ?")
      .run(cutoff);
    return deleted.changes;
  }

  /** Bounded retention for assets, job history, and idempotency receipts. */
  prune(): SceneImagePruneResult {
    this.ensureOpen();
    const assets = this.pruneAssets();
    const jobs = this.pruneJobs();
    const receipts = this.pruneReceipts();
    return { assets, jobs, receipts };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.db.close();
    this.owner?.close();
    this.owner = null;
    this.ownAuthorizer?.close();
  }
}

export function createSceneImageService(options: SceneImageServiceOptions): SceneImageService {
  return new SceneImageService(options);
}
