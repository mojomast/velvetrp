import { idempotencyKeySchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  SceneImageError,
  type SceneImageAssetBytes,
  type SceneImageEnqueueInput,
  type SceneImageEnqueueRefusal,
  type SceneImageEnqueueRefusalCode,
  type SceneImageEnqueueResult,
  type SceneImageGallery,
  type SceneImageGalleryImage,
  type SceneImageJob,
  type SceneImageJobStatus,
  type SceneImageSelectionResult,
  type SceneImageSettingsRead,
  type SceneImageSettingsUpdate,
} from "../../../image/service.js";
import { buildScenePrompt } from "../../../image/scenePrompt.js";
import {
  SCENE_IMAGE_GUIDANCE_MAX,
  SCENE_IMAGE_GUIDANCE_MIN,
  SCENE_IMAGE_MAX_SEED,
  SCENE_IMAGE_MIN_SEED,
  SCENE_IMAGE_STEPS_MAX,
  SCENE_IMAGE_STEPS_MIN,
  SCENE_IMAGE_VARIATION_MAX,
  SCENE_IMAGE_VARIATION_MIN,
  type SceneImageSettings,
  type SceneImageSettingsPatch,
} from "../../../image/settings.js";

/**
 * Scene-image HTTP lane.
 *
 * Frozen contract under `/api/rpg/v1/campaigns/:campaignId/scene-images`. The
 * fixed trusted-local principal `local-owner` is the only caller identity; the
 * sidecar service owns campaign membership/role authorization and the Supra2
 * client is never reachable from a browser. Routes add request hygiene, the
 * disabled-installation refusal, the route-level session scope for asset bytes,
 * and a bounded projection of the service's durable jobs (the client contract
 * uses `ready`/`running`, while the sidecar persists `done`/`submitted`).
 */

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

/** Structural service seam; the concrete `SceneImageService` satisfies it. */
export interface SceneImageRouteService {
  getSettings(principalId: string, campaignId: string): SceneImageSettingsRead;
  updateSettings(principalId: string, campaignId: string,
    input: { patch: SceneImageSettingsPatch; expectedRevision: number; idempotencyKey: string }): SceneImageSettingsUpdate;
  enqueue(principalId: string, campaignId: string, input: SceneImageEnqueueInput, idempotencyKey: string): SceneImageEnqueueResult;
  listGallery(principalId: string, campaignId: string, query?: { sessionId?: string; limit?: number }): SceneImageGallery;
  selectImage(principalId: string, campaignId: string,
    input: { sessionId: string; sceneKey: string; assetId: string; expectedRevision: number; idempotencyKey: string }): SceneImageSelectionResult;
  getJob(principalId: string, campaignId: string, jobId: string): { job: SceneImageJob };
  readAsset(principalId: string, campaignId: string, assetId: string): SceneImageAssetBytes;
  /** Optional worker lifecycle; injected fakes may omit it. */
  start?(): void;
  stop?(): void;
  close?(): void;
}

/**
 * Authoritative scene facts for one room. `sceneKey` mirrors the play surface's
 * active-scene identity (`location:<locationId>`, or `session:<sessionId>` while
 * no location is known) so generated images group under the scene the table is
 * actually on. The resolver is expected to be cheap, synchronous, and fail
 * closed by returning null.
 */
export interface SceneImageSceneSnapshot {
  readonly sceneKey: string;
  readonly sceneRevision: number;
  readonly locationLabel: string | null;
  readonly locationDescription: string | null;
}

export type SceneImageSceneResolver = (campaignId: string, sessionId: string, actorId?: string) => SceneImageSceneSnapshot | null;

export interface SceneImagesHttpOptions {
  /** Lazily resolves the app-owned sidecar; null when it cannot be opened. */
  serviceAccessor: () => SceneImageRouteService | null;
  /** Exact installation opt-in (`VELVET_SCENE_IMAGES_ENABLED:true`); injected services default to true. */
  installationEnabled: () => boolean;
  /** Optional authoritative scene source for revisions, prompt fallback, and the narration hook. */
  resolveScene?: SceneImageSceneResolver;
}

const sceneKeySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const sessionIdSchema = resourceIdSchema;
const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["off", "manual", "automatic"]).optional(),
  stylePresetId: z.string().min(1).max(64).optional(),
  stylePhrase: z.string().max(200).optional(),
  promptOverrides: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
  steps: z.number().int().min(SCENE_IMAGE_STEPS_MIN).max(SCENE_IMAGE_STEPS_MAX).optional(),
  guidance: z.number().min(SCENE_IMAGE_GUIDANCE_MIN).max(SCENE_IMAGE_GUIDANCE_MAX).optional(),
  seedMode: z.enum(["random", "fixed"]).optional(),
  fixedSeed: z.number().int().min(SCENE_IMAGE_MIN_SEED).max(SCENE_IMAGE_MAX_SEED).optional(),
  variationCount: z.number().int().min(SCENE_IMAGE_VARIATION_MIN).max(SCENE_IMAGE_VARIATION_MAX).optional(),
  autoPerSessionLimit: z.number().int().min(0).max(32).optional(),
  cooldownSeconds: z.number().int().min(0).max(3_600).optional(),
  bandwidth: z.enum(["full", "reduced", "text-only"]).optional(),
  hideImages: z.boolean().optional(),
  advancedOnlyDm: z.boolean().optional(),
}).strict();
const settingsWriteSchema = z.object({
  expectedRevision: z.number().int().min(0),
  idempotencyKey: idempotencyKeySchema,
  settings: settingsPatchSchema,
}).strict();
const generateRequestSchema = z.object({
  sessionId: sessionIdSchema,
  sceneKey: sceneKeySchema,
  prompt: z.string().min(1).max(1_000).optional(),
  seed: z.number().int().min(SCENE_IMAGE_MIN_SEED).max(SCENE_IMAGE_MAX_SEED).optional(),
  steps: z.number().int().min(SCENE_IMAGE_STEPS_MIN).max(SCENE_IMAGE_STEPS_MAX).optional(),
  guidance: z.number().min(SCENE_IMAGE_GUIDANCE_MIN).max(SCENE_IMAGE_GUIDANCE_MAX).optional(),
  count: z.number().int().min(SCENE_IMAGE_VARIATION_MIN).max(SCENE_IMAGE_VARIATION_MAX).optional(),
  auto: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict();
const selectRequestSchema = z.object({
  sessionId: sessionIdSchema,
  sceneKey: sceneKeySchema,
  assetId: sessionIdSchema,
  expectedRevision: z.number().int().min(0),
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Persisted sidecar statuses projected onto the frozen client vocabulary. */
const JOB_STATUS_PROJECTION: Readonly<Record<SceneImageJobStatus, string>> = {
  queued: "queued",
  submitted: "running",
  running: "running",
  done: "ready",
  stale: "ready",
  failed: "failed",
  uncertain: "failed",
  cancelled: "cancelled",
};

interface ProjectedJob {
  jobId: string;
  sessionId: string;
  sceneKey: string;
  assetId: string | null;
  prompt: string;
  seed: number;
  steps: number;
  guidance: number;
  status: string;
  seconds: null;
  createdAt: string;
}

function projectJob(job: SceneImageJob): ProjectedJob {
  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    sceneKey: job.sceneKey,
    assetId: job.assetId,
    prompt: job.prompt,
    seed: job.seed,
    steps: job.steps,
    guidance: job.guidance,
    status: JOB_STATUS_PROJECTION[job.status],
    seconds: null,
    createdAt: job.createdAt,
  };
}

/**
 * Gallery row projection. DM reads include the durable job rows, so a row can
 * carry its exact job id, status, and scene key. The sidecar's player
 * projection omits job rows on purpose; the asset id is then the only stable
 * row identity the route was given, so it is reused as `jobId` rather than
 * inventing a durable id, and the row reads as a finished candidate.
 */
function projectGalleryImage(image: SceneImageGalleryImage, jobs: readonly SceneImageJob[]) {
  const job = jobs.find((entry) => entry.assetId === image.assetId);
  return {
    assetId: image.assetId,
    jobId: job?.jobId ?? image.assetId,
    prompt: image.prompt,
    seed: image.seed,
    steps: image.steps,
    guidance: image.guidance,
    status: job ? JOB_STATUS_PROJECTION[job.status] : "ready",
    seconds: null,
    createdAt: image.createdAt,
    selected: image.selected,
    selections: image.selections ?? [],
    ...(job ? { sceneKey: job.sceneKey } : {}),
  };
}

function problemForRefusal(refusal: SceneImageEnqueueRefusal): { status: 409 | 422; code: string } {
  const codes: Readonly<Record<SceneImageEnqueueRefusalCode, { status: 409 | 422; code: string }>> = {
    disabled: { status: 422, code: "RPG_SCENE_IMAGE_DISABLED" },
    manual: { status: 409, code: "RPG_SCENE_IMAGE_MANUAL" },
    "session-limit": { status: 409, code: "RPG_SCENE_IMAGE_SESSION_LIMIT" },
    cooldown: { status: 409, code: "RPG_SCENE_IMAGE_COOLDOWN" },
  };
  return codes[refusal.code];
}

/** Maps a sidecar failure without ever echoing prompts, bytes, or foreign data. */
function mapSceneImageFailure(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SceneImageError) {
    if (error.statusCode === 400) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", error.message);
    if (error.statusCode === 403) return sendApiProblem(request, reply, 403, "RPG_SCENE_IMAGE_FORBIDDEN", "Scene image management requires the campaign owner or GM");
    if (error.statusCode === 404) return sendApiProblem(request, reply, 404, "RPG_SCENE_IMAGE_NOT_FOUND", "Scene image resource not found");
    if (error.statusCode === 409) return sendApiProblem(request, reply, 409, "RPG_SCENE_IMAGE_CONFLICT", error.message);
    if (error.statusCode === 503) return sendApiProblem(request, reply, 503, "RPG_SCENE_IMAGE_UNAVAILABLE", "Scene images are unavailable; no image work was started");
  }
  request.log.error({ operation: "scene-images", method: request.method, route: request.routeOptions.url }, "scene image operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Scene image operation could not be completed");
}

function hasQueryValue(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function notFound(request: FastifyRequest, reply: FastifyReply, detail = "Scene image resource not found"): FastifyReply {
  return sendApiProblem(request, reply, 404, "RPG_SCENE_IMAGE_NOT_FOUND", detail);
}

/**
 * Fire-and-forget automatic-mode hook.
 *
 * Called after a completed original adventure turn durably settles narration.
 * Everything here is synchronous and swallowed: an unavailable sidecar,
 * campaign settings that are off/manual, any refusal, or any internal failure
 * must never delay, fail, or alter the turn response. Scene change detection is
 * delegated to the sidecar's content-key cache (`deduped` completions) and its
 * per-session automatic limit, so no durable hook state is written that could
 * block narration; nothing is logged that could carry narration or prompts.
 */
export function createSceneImageNarrationHook(options: {
  serviceAccessor: () => SceneImageRouteService | null;
  installationEnabled: () => boolean;
  resolveScene: SceneImageSceneResolver;
}): (settled: { campaignId: string; sessionId: string; actorId: string; turnId: string; declaration: string }) => void {
  return (settled) => {
    try {
      if (!options.installationEnabled()) return;
      const service = options.serviceAccessor();
      if (!service) return;
      const settings = service.getSettings(OWNER, settled.campaignId).settings;
      if (!settings.enabled || settings.mode !== "automatic") return;
      const scene = options.resolveScene(settled.campaignId, settled.sessionId, settled.actorId);
      const sceneKey = scene?.sceneKey ?? `session:${settled.sessionId}`;
      const override = settings.promptOverrides[sceneKey];
      const prompt = override && override.trim().length > 0
        ? override.trim()
        : buildScenePrompt({
            locationName: scene?.locationLabel ?? sceneKey,
            focalFeature: scene?.locationDescription ?? "",
            composition: "",
            lighting: "",
            materials: [],
            stylePhrase: settings.stylePhrase,
            facts: [],
          });
      service.enqueue(OWNER, settled.campaignId, {
        sessionId: settled.sessionId,
        sceneKey,
        sceneRevision: scene?.sceneRevision ?? 0,
        narrationEventId: settled.turnId,
        prompt,
        steps: settings.steps,
        guidance: settings.guidance,
        kind: "single",
        auto: true,
      }, `auto-narration:${settled.turnId}`);
    } catch {
      // The hook is best-effort by contract: never surface failure.
    }
  };
}

function resolveGenerationPrompt(
  requested: { prompt?: string; sceneKey: string },
  settings: SceneImageSettings,
  scene: SceneImageSceneSnapshot | null,
): string {
  const prompt = requested.prompt?.trim();
  if (prompt && prompt.length > 0) return prompt;
  const override = settings.promptOverrides[requested.sceneKey];
  if (override && override.trim().length > 0) return override.trim();
  return buildScenePrompt({
    locationName: scene?.locationLabel ?? requested.sceneKey,
    focalFeature: scene?.locationDescription ?? "",
    composition: "",
    lighting: "",
    materials: [],
    stylePhrase: settings.stylePhrase,
    facts: [],
  });
}

export const sceneImagesHttpRoutes: FastifyPluginAsync<SceneImagesHttpOptions> = async (app, options) => {
  const base = "/campaigns/:campaignId/scene-images";
  const getService = (): SceneImageRouteService | null => {
    try {
      return options.serviceAccessor();
    } catch {
      return null;
    }
  };
  const installationEnabled = (): boolean => {
    try {
      return options.installationEnabled();
    } catch {
      return false;
    }
  };
  const resolveScene = (campaignId: string, sessionId: string, actorId?: string): SceneImageSceneSnapshot | null => {
    try {
      return actorId === undefined
        ? options.resolveScene?.(campaignId, sessionId) ?? null
        : options.resolveScene?.(campaignId, sessionId, actorId) ?? null;
    } catch {
      return null;
    }
  };
  const unavailable = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    sendApiProblem(request, reply, 503, "RPG_SCENE_IMAGE_UNAVAILABLE", "Scene images are unavailable; no image work was started");
  const guard = (request: FastifyRequest, reply: FastifyReply, rejectQuery = true): boolean => {
    reply.header("cache-control", "no-store");
    if (!readRpgFeatureFlags().campaign) {
      sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (rejectQuery && hasQueryValue(request)) {
      sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Scene image route does not accept query parameters");
      return false;
    }
    return true;
  };
  const requireJson = async (request: FastifyRequest, reply: FastifyReply, name: string): Promise<void> => {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_TYPE.test(contentType)) {
      await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", `${name} requires application/json`);
    }
  };
  const malformedBody = (request: FastifyRequest, reply: FastifyReply, detail: string): FastifyReply =>
    sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    `${base}/settings`, { exposeHeadRoute: false, onRequest: async (request, reply) => { guard(request, reply); } },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return notFound(request, reply);
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const read = service.getSettings(OWNER, campaignId.data);
        return reply.send({ settings: read.settings, revision: read.revision });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.put<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    `${base}/settings`, {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!guard(request, reply)) return;
        await requireJson(request, reply, "Scene image settings");
      },
      errorHandler: (_error, request, reply) => malformedBody(request, reply, "Scene image settings request is invalid"),
    },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return notFound(request, reply);
      const body = settingsWriteSchema.safeParse(request.body);
      if (!body.success) return malformedBody(request, reply, "Scene image settings request is invalid");
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const updated = service.updateSettings(OWNER, campaignId.data, {
          patch: Object.fromEntries(Object.entries(body.data.settings).filter(([, value]) => value !== undefined)) as Partial<SceneImageSettings>,
          expectedRevision: body.data.expectedRevision,
          idempotencyKey: body.data.idempotencyKey,
        });
        return reply.send({ settings: updated.settings, revision: updated.revision, receipt: updated.receipt });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    `${base}/generate`, {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!guard(request, reply)) return;
        await requireJson(request, reply, "Scene image generation");
      },
      errorHandler: (_error, request, reply) => malformedBody(request, reply, "Scene image generation request is invalid"),
    },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return notFound(request, reply);
      const body = generateRequestSchema.safeParse(request.body);
      if (!body.success) return malformedBody(request, reply, "Scene image generation request is invalid");
      // The installation-level opt-in precedes every sidecar/network surface.
      if (!installationEnabled()) {
        return sendApiProblem(request, reply, 422, "RPG_SCENE_IMAGE_DISABLED", "Scene image generation is disabled for this installation");
      }
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const settings = service.getSettings(OWNER, campaignId.data).settings;
        const scene = resolveScene(campaignId.data, body.data.sessionId);
        const count = body.data.count ?? 1;
        const input: SceneImageEnqueueInput = {
          sessionId: body.data.sessionId,
          sceneKey: body.data.sceneKey,
          sceneRevision: scene?.sceneRevision ?? 0,
          prompt: resolveGenerationPrompt({ sceneKey: body.data.sceneKey, ...(body.data.prompt !== undefined ? { prompt: body.data.prompt } : {}) }, settings, scene),
          steps: body.data.steps ?? settings.steps,
          guidance: body.data.guidance ?? settings.guidance,
          kind: count > 1 ? "batch" : "single",
          count,
          auto: body.data.auto ?? false,
          ...(body.data.seed !== undefined ? { seed: body.data.seed } : {}),
        };
        const result = service.enqueue(OWNER, campaignId.data, input, body.data.idempotencyKey);
        if (result.job === null) {
          const problem = problemForRefusal(result.refusal);
          return sendApiProblem(request, reply, problem.status, problem.code, result.refusal.message);
        }
        return reply.code(202).send({ job: projectJob(result.job), deduped: result.deduped });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    `${base}/gallery`, {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!readRpgFeatureFlags().campaign) {
          sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        const query = request.query as Record<string, unknown>;
        if (Object.keys(query).some((key) => key !== "sessionId")) {
          sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Scene image gallery does not accept query parameters");
          return;
        }
        if (typeof query.sessionId !== "string" || !sessionIdSchema.safeParse(query.sessionId).success) {
          sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Scene image gallery requires a valid sessionId");
        }
      },
    },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return notFound(request, reply);
      const query = request.query as Record<string, unknown>;
      if (typeof query.sessionId !== "string") return malformedBody(request, reply, "Scene image gallery requires a valid sessionId");
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const gallery = service.listGallery(OWNER, campaignId.data, { sessionId: query.sessionId });
        const jobs = gallery.jobs ?? [];
        return reply.send({ images: gallery.images.map((image) => projectGalleryImage(image, jobs)), ...(gallery.jobs ? { jobs: jobs.filter((job) => job.sessionId === query.sessionId).map(projectJob) } : {}) });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    `${base}/select`, {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!guard(request, reply)) return;
        await requireJson(request, reply, "Scene image selection");
      },
      errorHandler: (_error, request, reply) => malformedBody(request, reply, "Scene image selection request is invalid"),
    },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      if (!campaignId.success) return notFound(request, reply);
      const body = selectRequestSchema.safeParse(request.body);
      if (!body.success) return malformedBody(request, reply, "Scene image selection request is invalid");
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const result = service.selectImage(OWNER, campaignId.data, {
          sessionId: body.data.sessionId,
          sceneKey: body.data.sceneKey,
          assetId: body.data.assetId,
          expectedRevision: body.data.expectedRevision,
          idempotencyKey: body.data.idempotencyKey,
        });
        return reply.send({ selection: result.selection, receipt: result.receipt });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.get<{ Params: { campaignId: string; jobId: string }; Querystring: Record<string, unknown> }>(
    `${base}/jobs/:jobId`, { exposeHeadRoute: false, onRequest: async (request, reply) => { guard(request, reply); } },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const jobId = resourceIdSchema.safeParse(request.params.jobId);
      if (!campaignId.success || !jobId.success) return notFound(request, reply);
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        return reply.send({ job: projectJob(service.getJob(OWNER, campaignId.data, jobId.data).job) });
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });

  app.get<{ Params: { campaignId: string; assetId: string }; Querystring: Record<string, unknown> }>(
    `${base}/assets/:assetId`, {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        // Bytes are candidate material: never shared-cached and never sniffed.
        reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff");
        if (!readRpgFeatureFlags().campaign) {
          sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
          return;
        }
        const query = request.query as Record<string, unknown>;
        if (Object.keys(query).some((key) => key !== "sessionId")) {
          sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Scene image asset does not accept query parameters");
          return;
        }
        if (query.sessionId !== undefined
          && (typeof query.sessionId !== "string" || !sessionIdSchema.safeParse(query.sessionId).success)) {
          sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Scene image asset session is invalid");
        }
      },
    },
    async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const assetId = resourceIdSchema.safeParse(request.params.assetId);
      if (!campaignId.success || !assetId.success) return notFound(request, reply);
      const service = getService();
      if (!service) return unavailable(request, reply);
      try {
        const query = request.query as Record<string, unknown>;
        const sessionId = typeof query.sessionId === "string" ? query.sessionId : null;
        if (sessionId !== null) {
          // Route-level session scope: the sidecar's readAsset takes no session
          // argument, so a named session may only read an asset selected for
          // that exact session. DM reads without a session stay unrestricted.
          const gallery = service.listGallery(OWNER, campaignId.data, { sessionId });
          if (!gallery.images.some((image) => image.assetId === assetId.data)) return notFound(request, reply);
        }
        const bytes = service.readAsset(OWNER, campaignId.data, assetId.data);
        return reply.type(bytes.contentType).send(bytes.bytes);
      } catch (error) {
        return mapSceneImageFailure(request, reply, error);
      }
    });
};
