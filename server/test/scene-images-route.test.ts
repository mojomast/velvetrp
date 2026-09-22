import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  SceneImageError,
  type SceneImageAssetBytes,
  type SceneImageGallery,
  type SceneImageGalleryImage,
  type SceneImageJob,
  type SceneImageSelectionResult,
  type SceneImageSettingsRead,
  type SceneImageSettingsUpdate,
} from "../src/image/service.js";
import { DEFAULT_SCENE_IMAGE_SETTINGS, type SceneImageSettings } from "../src/image/settings.js";
import {
  createSceneImageNarrationHook,
  type SceneImageRouteService,
  type SceneImageSceneResolver,
} from "../src/routes/rpg/v1/sceneImages.js";

const CAMPAIGN = "campaign";
const AT = "2030-01-01T00:00:00.000Z";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  delete process.env.VELVET_SCENE_IMAGES_ENABLED;
});

const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; };

function makeSettings(overrides: Partial<SceneImageSettings> = {}): SceneImageSettings {
  return { ...DEFAULT_SCENE_IMAGE_SETTINGS, ...overrides };
}

function makeJob(overrides: Partial<SceneImageJob> = {}): SceneImageJob {
  return {
    jobId: "job-1", campaignId: CAMPAIGN, sessionId: "session-1", sceneKey: "location:loc-1", sceneRevision: 5,
    narrationEventId: null, prompt: "a ruined mill above a still pond", seed: 7, steps: 20, guidance: 3,
    kind: "single", count: 1, serviceBatchId: "batch-1", serviceJobIds: ["svc-1"], status: "done", attempts: 1,
    errorCode: null, createdAt: AT, updatedAt: AT, submittedAt: AT, completedAt: AT, assetId: "asset-1",
    ...overrides,
  };
}

function makeGalleryImage(overrides: Partial<SceneImageGalleryImage> = {}): SceneImageGalleryImage {
  return {
    assetId: "asset-1", campaignId: CAMPAIGN, prompt: "a ruined mill above a still pond", seed: 7, steps: 20,
    guidance: 3, contentType: "image/png", width: 256, height: 256, byteSize: 3, createdAt: AT, lastUsedAt: AT,
    selected: true, ...overrides,
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createFakeService(overrides: Partial<SceneImageRouteService> = {}): SceneImageRouteService {
  return {
    getSettings: vi.fn((): SceneImageSettingsRead => ({ settings: makeSettings(), revision: 0 })),
    updateSettings: vi.fn((): SceneImageSettingsUpdate => ({
      settings: makeSettings({ enabled: true, mode: "automatic" }), revision: 1,
      receipt: { idempotencyKey: "settings-1", revisionBefore: 0, revisionAfter: 1, occurredAt: AT, replayed: false },
    })),
    enqueue: vi.fn(() => ({ job: makeJob({ status: "queued", assetId: null, serviceBatchId: null, serviceJobIds: [], completedAt: null, submittedAt: null }), deduped: false, refusal: null as null })),
    listGallery: vi.fn((): SceneImageGallery => ({ images: [makeGalleryImage()], jobs: [makeJob()] })),
    selectImage: vi.fn((): SceneImageSelectionResult => ({
      selection: { campaignId: CAMPAIGN, sessionId: "session-1", sceneKey: "location:loc-1", assetId: "asset-1", revision: 0, updatedAt: AT },
      receipt: { idempotencyKey: "select-1", revisionBefore: 0, revisionAfter: 0, occurredAt: AT, replayed: false },
    })),
    getJob: vi.fn(() => ({ job: makeJob() })),
    readAsset: vi.fn((): SceneImageAssetBytes => ({ bytes: PNG_BYTES, contentType: "image/png" })),
    start: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

const sceneResolver: SceneImageSceneResolver = () => ({
  sceneKey: "location:loc-1", sceneRevision: 5, locationLabel: "The Mill", locationDescription: "a ruined mill above a still pond",
});

function sceneImageApp(options: {
  service?: SceneImageRouteService;
  installationEnabled?: () => boolean;
  resolveScene?: SceneImageSceneResolver;
} = {}) {
  return buildApp({
    sceneImageService: options.service ?? createFakeService(),
    sceneImageSceneResolver: options.resolveScene ?? sceneResolver,
    ...(options.installationEnabled ? { sceneImageInstallationEnabled: options.installationEnabled } : {}),
  });
}

const paths = {
  settings: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/settings`,
  generate: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/generate`,
  gallery: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/gallery?sessionId=session-1`,
  select: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/select`,
  job: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/jobs/job-1`,
  asset: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/assets/asset-1`,
};

const generateBody = {
  sessionId: "session-1", sceneKey: "location:loc-1", idempotencyKey: "generate-1",
};

describe("scene image routes", () => {
  it("gates every route on the campaign feature before touching the service", async () => {
    delete process.env.FEATURE_RPG_CAMPAIGN;
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const requests = [
      { method: "GET" as const, url: paths.settings },
      { method: "PUT" as const, url: paths.settings, payload: { expectedRevision: 0, idempotencyKey: "k", settings: {} } },
      { method: "GET" as const, url: paths.gallery },
      { method: "POST" as const, url: paths.generate, payload: generateBody },
      { method: "POST" as const, url: paths.select, payload: { sessionId: "session-1", sceneKey: "location:loc-1", assetId: "asset-1", expectedRevision: 0, idempotencyKey: "k" } },
      { method: "GET" as const, url: paths.job },
      { method: "GET" as const, url: paths.asset },
    ];
    for (const request of requests) {
      const result = await app.inject({ ...request, headers: { "content-type": "application/json" } });
      expect(result.statusCode, `${request.method} ${request.url}`).toBe(404);
      expect(result.json(), `${request.method} ${request.url}`).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
      expect(result.headers["cache-control"], `${request.method} ${request.url}`).toMatch(/no-store/);
    }
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.enqueue).not.toHaveBeenCalled();
    expect(service.listGallery).not.toHaveBeenCalled();
    expect(service.readAsset).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects queries and malformed paths without reflecting identifiers", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const rejects = [
      { method: "GET" as const, url: `${paths.settings}?x=1` },
      { method: "GET" as const, url: `${paths.job}?x=1` },
      { method: "POST" as const, url: `${paths.generate}?x=1`, payload: generateBody },
      { method: "GET" as const, url: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/gallery` },
      { method: "GET" as const, url: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/gallery?sessionId=session-1&limit=2` },
      { method: "GET" as const, url: `${paths.asset}?private=1` },
      { method: "GET" as const, url: `${paths.asset}?sessionId=%zz` },
    ];
    for (const request of rejects) {
      const result = await app.inject({ ...request, headers: { "content-type": "application/json" } });
      expect(result.statusCode, `${request.method} ${request.url}`).toBe(400);
      expect(result.json(), `${request.method} ${request.url}`).toMatchObject({ code: "RPG_INVALID_REQUEST" });
      expect(result.body).not.toContain("private=1");
    }
    const malformed = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/%zz/scene-images/settings" });
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
    expect(malformed.body).not.toContain("%zz");
    const head = await app.inject({ method: "HEAD", url: paths.settings });
    expect(head.statusCode).toBe(404);
    expect(head.headers["cache-control"]).toBe("no-store");
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("round-trips settings and requires JSON for writes", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const read = await app.inject({ method: "GET", url: paths.settings });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toEqual({ settings: makeSettings(), revision: 0 });
    expect(service.getSettings).toHaveBeenCalledWith("local-owner", CAMPAIGN);

    const body = { expectedRevision: 0, idempotencyKey: "settings-1", settings: { enabled: true, mode: "automatic" } };
    const written = await app.inject({ method: "PUT", url: paths.settings, payload: body, headers: { "content-type": "application/json" } });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ revision: 1, settings: { enabled: true, mode: "automatic" } });
    expect(service.updateSettings).toHaveBeenCalledWith("local-owner", CAMPAIGN, {
      patch: body.settings, expectedRevision: 0, idempotencyKey: "settings-1",
    });

    const unsupported = await app.inject({ method: "PUT", url: paths.settings, payload: body, headers: { "content-type": "text/plain" } });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json()).toMatchObject({ code: "RPG_UNSUPPORTED_MEDIA_TYPE" });
    const malformed = await app.inject({ method: "PUT", url: paths.settings, payload: "{", headers: { "content-type": "application/json" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "RPG_INVALID_REQUEST" });
    const unknownKey = await app.inject({
      method: "PUT", url: paths.settings, headers: { "content-type": "application/json" },
      payload: { expectedRevision: 0, idempotencyKey: "settings-2", settings: { providerSecret: "leak" } },
    });
    expect(unknownKey.statusCode).toBe(400);
    await app.close();
  });

  it("returns 202 with the projected job and typed refusals", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const accepted = await app.inject({ method: "POST", url: paths.generate, payload: generateBody, headers: { "content-type": "application/json" } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(accepted.json()).toMatchObject({
      deduped: false,
      job: { jobId: "job-1", sceneKey: "location:loc-1", status: "queued", seed: 7, steps: 20, guidance: 3 },
    });
    expect(service.enqueue).toHaveBeenCalledWith("local-owner", CAMPAIGN, expect.objectContaining({
      sessionId: "session-1", sceneKey: "location:loc-1", sceneRevision: 5,
      prompt: expect.stringContaining("The Mill"), steps: 20, guidance: 3, kind: "single", count: 1, auto: false,
    }), "generate-1");

    const refusalCases = [
      ["disabled", 422, "RPG_SCENE_IMAGE_DISABLED"],
      ["manual", 409, "RPG_SCENE_IMAGE_MANUAL"],
      ["session-limit", 409, "RPG_SCENE_IMAGE_SESSION_LIMIT"],
      ["cooldown", 409, "RPG_SCENE_IMAGE_COOLDOWN"],
    ] as const;
    for (const [code, status, problem] of refusalCases) {
      const refusalService = createFakeService({
        enqueue: vi.fn(() => ({ job: null, deduped: false as const, refusal: { code, message: "refused", remaining: 0, cooldownEndsAt: null } })),
      });
      const refusalApp = sceneImageApp({ service: refusalService });
      const result = await refusalApp.inject({ method: "POST", url: paths.generate, payload: generateBody, headers: { "content-type": "application/json" } });
      expect(result.statusCode, code).toBe(status);
      expect(result.json(), code).toMatchObject({ code: problem });
      await refusalApp.close();
    }
    await app.close();
  });

  it("refuses generation with the disabled code when the installation opt-in is off", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service, installationEnabled: () => false });
    const result = await app.inject({ method: "POST", url: paths.generate, payload: generateBody, headers: { "content-type": "application/json" } });
    expect(result.statusCode).toBe(422);
    expect(result.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_DISABLED" });
    expect(service.enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("scopes the gallery by role through the service and never leaks jobs to players", async () => {
    enable();
    const dmGallery: SceneImageGallery = { images: [makeGalleryImage()], jobs: [makeJob()] };
    const dmService = createFakeService({ listGallery: vi.fn(() => dmGallery) });
    const dmApp = sceneImageApp({ service: dmService });
    const dmRead = await dmApp.inject({ method: "GET", url: paths.gallery });
    expect(dmRead.statusCode).toBe(200);
    expect(dmRead.json().jobs).toEqual([expect.objectContaining({ jobId: "job-1" })]);
    expect(dmRead.json()).toMatchObject({
      images: [{
        assetId: "asset-1", jobId: "job-1", prompt: "a ruined mill above a still pond", seed: 7, steps: 20,
        guidance: 3, status: "ready", seconds: null, createdAt: AT, selected: true, sceneKey: "location:loc-1", selections: [],
      }],
    });
    expect(dmService.listGallery).toHaveBeenCalledWith("local-owner", CAMPAIGN, { sessionId: "session-1" });
    await dmApp.close();

    const playerGallery: SceneImageGallery = {
      images: [makeGalleryImage({ selected: true }), makeGalleryImage({ assetId: "asset-2", selected: false })],
    };
    const playerService = createFakeService({ listGallery: vi.fn(() => playerGallery) });
    const playerApp = sceneImageApp({ service: playerService });
    const playerRead = await playerApp.inject({ method: "GET", url: paths.gallery });
    expect(playerRead.statusCode).toBe(200);
    expect(playerRead.json().images.map((image: { assetId: string }) => image.assetId)).toEqual(["asset-1", "asset-2"]);
    expect(playerRead.json().images[0]).toMatchObject({ jobId: "asset-1", status: "ready" });
    await playerApp.close();

    const forbidden = createFakeService({ getSettings: vi.fn(() => { throw new SceneImageError(403, "Scene image management requires the campaign owner or GM"); }) });
    const forbiddenApp = sceneImageApp({ service: forbidden });
    const settingsRead = await forbiddenApp.inject({ method: "GET", url: paths.settings });
    expect(settingsRead.statusCode).toBe(403);
    expect(settingsRead.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_FORBIDDEN" });
    await forbiddenApp.close();

    const missing = createFakeService({ listGallery: vi.fn(() => { throw new SceneImageError(404, "Campaign scene images are unavailable"); }) });
    const missingApp = sceneImageApp({ service: missing });
    const missingRead = await missingApp.inject({ method: "GET", url: paths.gallery });
    expect(missingRead.statusCode).toBe(404);
    expect(missingRead.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_NOT_FOUND" });
    await missingApp.close();
  });

  it("selects an asset and maps stale revisions to a conflict", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const body = { sessionId: "session-1", sceneKey: "location:loc-1", assetId: "asset-1", expectedRevision: 0, idempotencyKey: "select-1" };
    const selected = await app.inject({ method: "POST", url: paths.select, payload: body, headers: { "content-type": "application/json" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      selection: { assetId: "asset-1", sceneKey: "location:loc-1" },
      receipt: { idempotencyKey: "select-1" },
    });
    expect(service.selectImage).toHaveBeenCalledWith("local-owner", CAMPAIGN, body);
    await app.close();

    const stale = createFakeService({ selectImage: vi.fn(() => { throw new SceneImageError(409, "Scene image selection changed; refresh first"); }) });
    const staleApp = sceneImageApp({ service: stale });
    const staleResult = await staleApp.inject({ method: "POST", url: paths.select, payload: body, headers: { "content-type": "application/json" } });
    expect(staleResult.statusCode).toBe(409);
    expect(staleResult.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_CONFLICT" });
    await staleApp.close();
  });

  it("reads one exact job and masks missing or foreign jobs", async () => {
    enable();
    const running = createFakeService({ getJob: vi.fn(() => ({ job: makeJob({ status: "running", completedAt: null }) })) });
    const runningApp = sceneImageApp({ service: running });
    const read = await runningApp.inject({ method: "GET", url: paths.job });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ job: { jobId: "job-1", status: "running" } });
    expect(running.getJob).toHaveBeenCalledWith("local-owner", CAMPAIGN, "job-1");
    await runningApp.close();

    const missing = createFakeService({ getJob: vi.fn(() => { throw new SceneImageError(404, "Scene image job is unavailable"); }) });
    const missingApp = sceneImageApp({ service: missing });
    expect((await missingApp.inject({ method: "GET", url: paths.job })).statusCode).toBe(404);
    await missingApp.close();

    const malformedApp = sceneImageApp();
    const malformed = await malformedApp.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${CAMPAIGN}/scene-images/jobs/%zz` });
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
    await malformedApp.close();
  });

  it("serves PNG bytes with private no-store and scopes a named session at the route", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    const bytes = await app.inject({ method: "GET", url: paths.asset });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers["content-type"]).toMatch(/^image\/png/);
    expect(bytes.headers["cache-control"]).toBe("private, no-store");
    expect(bytes.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(bytes.rawPayload).equals(PNG_BYTES)).toBe(true);
    expect(service.readAsset).toHaveBeenCalledWith("local-owner", CAMPAIGN, "asset-1");
    await app.close();

    const sessionService = createFakeService({
      listGallery: vi.fn((_principal, _campaign, query) => query?.sessionId === "session-1"
        ? { images: [makeGalleryImage()] }
        : { images: [] }),
    });
    const sessionApp = sceneImageApp({ service: sessionService });
    const scoped = await sessionApp.inject({ method: "GET", url: `${paths.asset}?sessionId=session-1` });
    expect(scoped.statusCode).toBe(200);
    expect(sessionService.readAsset).toHaveBeenCalledTimes(1);
    const foreign = await sessionApp.inject({ method: "GET", url: `${paths.asset}?sessionId=session-2` });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_NOT_FOUND" });
    expect(sessionService.readAsset).toHaveBeenCalledTimes(1);
    await sessionApp.close();

    const unpublished = createFakeService({ readAsset: vi.fn(() => { throw new SceneImageError(403, "Scene image asset is not published to players"); }) });
    const unpublishedApp = sceneImageApp({ service: unpublished });
    const denied = await unpublishedApp.inject({ method: "GET", url: paths.asset });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "RPG_SCENE_IMAGE_FORBIDDEN" });
    await unpublishedApp.close();
  });

  it("starts an injected worker at ready and stops it on close", async () => {
    enable();
    const service = createFakeService();
    const app = sceneImageApp({ service });
    await app.inject({ method: "GET", url: paths.settings });
    expect(service.start).toHaveBeenCalledTimes(1);
    await app.close();
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.close).not.toHaveBeenCalled();
  });
});

describe("scene image narration hook", () => {
  it("enqueues one automatic scene image after narration settles", () => {
    const service = createFakeService({
      getSettings: vi.fn(() => ({ settings: makeSettings({ enabled: true, mode: "automatic", steps: 20, guidance: 3 }), revision: 1 })),
    });
    const hook = createSceneImageNarrationHook({
      serviceAccessor: () => service, installationEnabled: () => true, resolveScene: sceneResolver,
    });
    hook({ campaignId: CAMPAIGN, sessionId: "session-1", actorId: "actor-1", turnId: "turn-1", declaration: "look around" });
    expect(service.enqueue).toHaveBeenCalledWith("local-owner", CAMPAIGN, expect.objectContaining({
      sessionId: "session-1", sceneKey: "location:loc-1", sceneRevision: 5, narrationEventId: "turn-1",
      prompt: expect.stringContaining("The Mill"), steps: 20, guidance: 3, kind: "single", auto: true,
    }), "auto-narration:turn-1");
  });

  it("never touches the sidecar when installation, settings, or narration refuse", () => {
    const manual = createFakeService({ getSettings: vi.fn(() => ({ settings: makeSettings({ enabled: true, mode: "manual" }), revision: 1 })) });
    const manualHook = createSceneImageNarrationHook({ serviceAccessor: () => manual, installationEnabled: () => true, resolveScene: sceneResolver });
    manualHook({ campaignId: CAMPAIGN, sessionId: "session-1", actorId: "actor-1", turnId: "turn-1", declaration: "look" });
    expect(manual.enqueue).not.toHaveBeenCalled();

    const off = createFakeService();
    const offHook = createSceneImageNarrationHook({ serviceAccessor: () => off, installationEnabled: () => false, resolveScene: sceneResolver });
    offHook({ campaignId: CAMPAIGN, sessionId: "session-1", actorId: "actor-1", turnId: "turn-1", declaration: "look" });
    expect(off.getSettings).not.toHaveBeenCalled();
    expect(off.enqueue).not.toHaveBeenCalled();

    const failing = createFakeService({
      getSettings: vi.fn(() => ({ settings: makeSettings({ enabled: true, mode: "automatic" }), revision: 1 })),
      enqueue: vi.fn(() => { throw new Error("sidecar down"); }),
    });
    const failingHook = createSceneImageNarrationHook({ serviceAccessor: () => failing, installationEnabled: () => true, resolveScene: sceneResolver });
    expect(() => failingHook({ campaignId: CAMPAIGN, sessionId: "session-1", actorId: "actor-1", turnId: "turn-1", declaration: "look" }))
      .not.toThrow();
  });
});
