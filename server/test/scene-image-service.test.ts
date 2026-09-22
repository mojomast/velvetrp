import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SceneImageError,
  createSceneImageService,
  type SceneImageAuthorizer,
  type SceneImageEnqueueInput,
  type SceneImageJob,
  type SceneImageRole,
  type SceneImageService,
  type SceneImageWorkerOptions,
} from "../src/image/service.js";
import type { SceneImageSettingsPatch } from "../src/image/settings.js";
import type { Clock } from "../src/runtime.js";
import {
  Supra2ImageHttpError,
  Supra2ImageRateLimitError,
  type Supra2BatchRequestInput,
  type Supra2BatchResult,
  type Supra2DownloadedImage,
  type Supra2GenerateRequestInput,
  type Supra2GenerateResult,
  type Supra2ImageClient,
  type Supra2ImageHealth,
  type Supra2ImageJob,
  type Supra2JobPollResult,
  type Supra2JobStatus,
  type Supra2PollOptions,
  type Supra2ServiceStatus,
} from "../src/provider/supra2ImageService.js";

const CAMPAIGN = "camp-1";
const START = Date.parse("2030-01-01T00:00:00.000Z");

interface TestClock extends Clock {
  advance(ms: number): void;
}

function createClock(start = START): TestClock {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

let idSeq = 0;
function createIds() {
  return { nextId: () => `id-${String((idSeq += 1)).padStart(4, "0")}` };
}

let keySeq = 0;
function key(prefix: string): string {
  keySeq += 1;
  return `${prefix}-${keySeq}`;
}

let markerSeq = 0;

function pngBytes(width: number, height: number, marker: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  view.setUint32(29, marker);
  return bytes;
}

function sceneError(run: () => unknown): SceneImageError {
  try {
    run();
  } catch (error) {
    if (error instanceof SceneImageError) return error;
    throw error;
  }
  throw new Error("Expected a SceneImageError");
}

type SubmissionBehavior =
  | { kind: "accepted" }
  | { kind: "accepted-ids"; ids: string[] }
  | { kind: "uncertain" }
  | { kind: "rate-limit" }
  | { kind: "http"; status: number };

interface FakeState {
  generateCalls: Supra2GenerateRequestInput[];
  batchCalls: Supra2BatchRequestInput[];
  pollCalls: Array<{ ids: string[]; options: Supra2PollOptions | undefined }>;
  downloadCalls: string[];
  behaviors: SubmissionBehavior[];
  jobs: Map<string, Supra2ImageJob>;
  downloads: Map<string, Uint8Array>;
  serviceSeq: number;
}

function createFakeClient() {
  const state: FakeState = {
    generateCalls: [],
    batchCalls: [],
    pollCalls: [],
    downloadCalls: [],
    behaviors: [],
    jobs: new Map(),
    downloads: new Map(),
    serviceSeq: 0,
  };
  const nextServiceId = () => `svc-${(state.serviceSeq += 1)}`;
  const register = (id: string, prompt: string, seed: number, steps: number, cfg: number): void => {
    state.jobs.set(id, { id, batch: "batch-1", prompt, seed, steps, cfg, status: "queued", created: state.serviceSeq });
  };
  const client: Supra2ImageClient = {
    async health(): Promise<Supra2ImageHealth> {
      return { ok: true, release: "test" };
    },
    async status(): Promise<Supra2ServiceStatus> {
      return {
        busy: false,
        device: "cpu",
        mode: "test",
        worker: { loaded: false, threads: 0, idleUnloadSeconds: 0 },
        jobs: [...state.jobs.values()],
      };
    },
    async generate(request: Supra2GenerateRequestInput): Promise<Supra2GenerateResult> {
      state.generateCalls.push(request);
      const behavior = state.behaviors.shift() ?? { kind: "accepted" };
      if (behavior.kind === "rate-limit") throw new Supra2ImageRateLimitError(null);
      if (behavior.kind === "uncertain") return { outcome: "uncertain", reason: "timeout" };
      if (behavior.kind === "http") throw new Supra2ImageHttpError(behavior.status);
      const ids = behavior.kind === "accepted-ids" ? behavior.ids : [nextServiceId()];
      const id = ids[0];
      if (!id) throw new Error("fake client requires at least one service id");
      for (const serviceId of ids) register(serviceId, request.prompt, request.seed ?? 0, request.steps ?? 50, request.cfg ?? 3);
      return { outcome: "accepted", id, batch: "batch-1" };
    },
    async batch(request: Supra2BatchRequestInput): Promise<Supra2BatchResult> {
      state.batchCalls.push(request);
      const behavior = state.behaviors.shift() ?? { kind: "accepted" };
      if (behavior.kind === "rate-limit") throw new Supra2ImageRateLimitError(null);
      if (behavior.kind === "uncertain") return { outcome: "uncertain", reason: "timeout" };
      if (behavior.kind === "http") throw new Supra2ImageHttpError(behavior.status);
      const count = request.count ?? 1;
      const ids = behavior.kind === "accepted-ids"
        ? behavior.ids
        : Array.from({ length: count }, () => nextServiceId());
      const id = ids[0];
      if (!id) throw new Error("fake client requires at least one service id");
      for (const serviceId of ids) {
        register(serviceId, request.prompt, 0, request.steps?.[0] ?? 50, request.guidance?.[0] ?? 3);
      }
      return { outcome: "accepted", id, batch: "batch-1", ids };
    },
    async downloadImage(relativePath: string): Promise<Supra2DownloadedImage> {
      state.downloadCalls.push(relativePath);
      const bytes = state.downloads.get(relativePath);
      if (!bytes) throw new Supra2ImageHttpError(404);
      return { bytes, contentType: "image/png" };
    },
    async pollJobs(ids: readonly string[], options?: Supra2PollOptions): Promise<Supra2JobPollResult> {
      state.pollCalls.push({ ids: [...ids], options });
      const jobs = ids.flatMap((id) => {
        const job = state.jobs.get(id);
        return job ? [job] : [];
      });
      const complete = ids.every((id) => {
        const job = state.jobs.get(id);
        return job !== undefined && (job.status === "done" || job.status === "failed" || job.status === "cancelled");
      });
      return {
        complete,
        jobs,
        missingIds: ids.filter((id) => !state.jobs.has(id)),
        attempts: 1,
        rateLimited: 0,
        elapsedMs: 1,
      };
    },
    async cancelAll(): Promise<void> {
      // Deliberately a no-op: the service must never cancel the shared lane.
    },
  };
  return {
    client,
    state,
    settle(id: string, status: Supra2JobStatus): void {
      const job = state.jobs.get(id);
      if (!job) throw new Error(`unknown service job ${id}`);
      state.jobs.set(id, { ...job, status });
    },
    attachImage(id: string, image: string): void {
      const job = state.jobs.get(id);
      if (!job) throw new Error(`unknown service job ${id}`);
      state.jobs.set(id, { ...job, image });
    },
  };
}

interface Harness {
  service: SceneImageService;
  fake: ReturnType<typeof createFakeClient>;
  clock: TestClock;
  dir: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createHarness(options: {
  roles?: Record<string, SceneImageRole | null>;
  deniedCampaigns?: string[];
  worker?: Partial<SceneImageWorkerOptions>;
  authorize?: SceneImageAuthorizer;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "velvet-scene-image-"));
  const fake = createFakeClient();
  const clock = createClock();
  const roles: Record<string, SceneImageRole | null> = options.roles ?? { owner: "owner", gm: "gm", player: "player" };
  const denied = new Set(options.deniedCampaigns ?? []);
  const authorize: SceneImageAuthorizer = options.authorize ?? {
    role: (principalId, campaignId) => denied.has(campaignId) ? null : roles[principalId] ?? null,
  };
  const service = createSceneImageService({
    dataDir: dir,
    client: fake.client,
    clock,
    ids: createIds(),
    ...(options.worker ? { worker: options.worker } : {}),
    authorize,
  });
  cleanups.push(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, fake, clock, dir };
}

function enable(harness: Harness, patch: SceneImageSettingsPatch = {}) {
  return harness.service.updateSettings("owner", CAMPAIGN, {
    patch: { ...patch, enabled: true, mode: patch.mode ?? "manual" },
    expectedRevision: harness.service.getSettings("owner", CAMPAIGN).revision,
    idempotencyKey: key("settings"),
  });
}

function sampleEnqueue(overrides: Partial<SceneImageEnqueueInput> = {}): SceneImageEnqueueInput {
  return {
    sessionId: "session-1",
    sceneKey: "scene-1",
    sceneRevision: 1,
    prompt: "a ruined mill above a still pond",
    steps: 20,
    guidance: 3,
    kind: "single",
    auto: false,
    ...overrides,
  };
}

function enqueueOk(harness: Harness, prompt: string, overrides: Partial<SceneImageEnqueueInput> = {}): SceneImageJob {
  const result = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ prompt, ...overrides }), key("enqueue"));
  if (!result.job) throw new Error(`enqueue refused: ${result.refusal?.code ?? "unknown"}`);
  return result.job;
}

function attachDone(harness: Harness, serviceId: string): string {
  const path = `/images/${serviceId}.png`;
  harness.fake.state.downloads.set(path, pngBytes(256, 256, (markerSeq += 1)));
  harness.fake.attachImage(serviceId, path);
  harness.fake.settle(serviceId, "done");
  return path;
}

/** Submits the queued job, completes its first service job, and reconciles it. */
async function submitAndSettle(harness: Harness, jobId: string): Promise<SceneImageJob> {
  await harness.service.tick();
  const submitted = harness.service.getJob("owner", CAMPAIGN, jobId).job;
  const serviceId = submitted.serviceJobIds[0];
  if (!serviceId) throw new Error("expected a tracked service job");
  attachDone(harness, serviceId);
  await harness.service.tick();
  return harness.service.getJob("owner", CAMPAIGN, jobId).job;
}

describe("scene image settings", () => {
  it("round-trips settings with optimistic revisions and replay-safe updates", () => {
    const harness = createHarness();
    const initial = harness.service.getSettings("owner", CAMPAIGN);
    expect(initial.revision).toBe(0);
    expect(initial.settings).toMatchObject({ enabled: false, mode: "off", steps: 20, guidance: 3 });

    const first = harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { enabled: true, mode: "automatic", autoPerSessionLimit: 2 },
      expectedRevision: 0,
      idempotencyKey: "settings-1",
    });
    expect(first.revision).toBe(1);
    expect(first.settings).toMatchObject({ enabled: true, mode: "automatic", autoPerSessionLimit: 2 });
    expect(first.receipt).toMatchObject({ revisionBefore: 0, revisionAfter: 1, replayed: false });
    expect(harness.service.getSettings("owner", CAMPAIGN).settings.mode).toBe("automatic");

    const stale = sceneError(() => harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { mode: "manual" },
      expectedRevision: 0,
      idempotencyKey: "settings-stale",
    }));
    expect(stale.statusCode).toBe(409);

    const replay = harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { enabled: true, mode: "automatic", autoPerSessionLimit: 2 },
      expectedRevision: 0,
      idempotencyKey: "settings-1",
    });
    expect(replay.revision).toBe(1);
    expect(replay.receipt.replayed).toBe(true);

    expect(sceneError(() => harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { mode: "manual" },
      expectedRevision: 0,
      idempotencyKey: "settings-1",
    })).statusCode).toBe(409);
    expect(sceneError(() => harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { mode: "sometimes" } as unknown as SceneImageSettingsPatch,
      expectedRevision: 1,
      idempotencyKey: "settings-invalid",
    })).statusCode).toBe(400);
    expect(sceneError(() => harness.service.getSettings("player", CAMPAIGN)).statusCode).toBe(403);
    expect(sceneError(() => harness.service.updateSettings("player", CAMPAIGN, {
      patch: { enabled: true },
      expectedRevision: 1,
      idempotencyKey: "settings-player",
    })).statusCode).toBe(403);

    const gmUpdate = harness.service.updateSettings("gm", CAMPAIGN, {
      patch: { guidance: 1 },
      expectedRevision: 1,
      idempotencyKey: "settings-gm",
    });
    expect(gmUpdate.revision).toBe(2);
    expect(gmUpdate.settings).toMatchObject({ enabled: true, mode: "automatic", guidance: 1 });
  });

  it("authorizes through the repository database and locks the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "velvet-scene-image-repo-"));
    const repo = new Database(join(dir, "velvet.sqlite"));
    repo.exec("CREATE TABLE campaign_memberships(campaign_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL)");
    const insert = repo.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role) VALUES(?,?,?)");
    insert.run(CAMPAIGN, "owner", "owner");
    insert.run(CAMPAIGN, "gm", "gm");
    insert.run(CAMPAIGN, "player", "player");
    repo.close();

    const fake = createFakeClient();
    const service = createSceneImageService({ dataDir: dir, client: fake.client, clock: createClock(), ids: createIds() });
    const emptyDir = mkdtempSync(join(tmpdir(), "velvet-scene-image-empty-"));
    const lonely = createSceneImageService({ dataDir: emptyDir, client: fake.client, clock: createClock(), ids: createIds() });
    cleanups.push(() => {
      service.close();
      lonely.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(emptyDir, { recursive: true, force: true });
    });
    expect(service.getSettings("owner", CAMPAIGN).revision).toBe(0);
    expect(service.getSettings("gm", CAMPAIGN).revision).toBe(0);
    expect(sceneError(() => service.getSettings("player", CAMPAIGN)).statusCode).toBe(403);
    expect(sceneError(() => service.getSettings("outsider", CAMPAIGN)).statusCode).toBe(404);

    const second = sceneError(() => createSceneImageService({
      dataDir: dir,
      client: fake.client,
      clock: createClock(),
      ids: createIds(),
    }));
    expect(second.statusCode).toBe(503);
    expect(second.message).toMatch(/already owned/);

    expect(sceneError(() => lonely.getSettings("owner", CAMPAIGN)).statusCode).toBe(404);
  });
});

describe("scene image enqueue", () => {
  it("requires a DM in the campaign and validates the request", () => {
    const harness = createHarness({ deniedCampaigns: ["camp-9"] });
    enable(harness);
    expect(sceneError(() => harness.service.enqueue("player", CAMPAIGN, sampleEnqueue(), key("enqueue"))).statusCode).toBe(403);
    expect(sceneError(() => harness.service.enqueue("owner", "camp-9", sampleEnqueue(), key("enqueue"))).statusCode).toBe(404);
    expect(sceneError(() => harness.service.getSettings("owner", "camp-9")).statusCode).toBe(404);
    expect(sceneError(() => harness.service.getJob("owner", "camp-9", "id-0001")).statusCode).toBe(404);
    expect(sceneError(() => harness.service.enqueue("owner", CAMPAIGN, { ...sampleEnqueue(), prompt: "  " }, key("enqueue"))).statusCode).toBe(400);
    expect(sceneError(() => harness.service.enqueue("owner", CAMPAIGN, { ...sampleEnqueue(), steps: 5 }, key("enqueue"))).statusCode).toBe(400);
    expect(sceneError(() => harness.service.enqueue("owner", CAMPAIGN, { ...sampleEnqueue(), guidance: 12 }, key("enqueue"))).statusCode).toBe(400);
    expect(sceneError(() => harness.service.enqueue("owner", CAMPAIGN, { ...sampleEnqueue(), kind: "batch", count: 33 }, key("enqueue"))).statusCode).toBe(400);
    expect(sceneError(() => harness.service.enqueue("owner", CAMPAIGN, { ...sampleEnqueue(), kind: "single", count: 2 }, key("enqueue"))).statusCode).toBe(400);
    expect(harness.fake.state.generateCalls).toHaveLength(0);
  });

  it("refuses automatic jobs under disabled, manual, session-limit, and cooldown policy", async () => {
    const harness = createHarness();
    const disabled = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    expect(disabled.job).toBeNull();
    expect(disabled.refusal?.code).toBe("disabled");
    expect(harness.service.listGallery("owner", CAMPAIGN).jobs ?? []).toHaveLength(0);

    enable(harness, { mode: "manual" });
    const manualMode = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    expect(manualMode.refusal?.code).toBe("manual");

    harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { mode: "automatic", autoPerSessionLimit: 1, cooldownSeconds: 120 },
      expectedRevision: 1,
      idempotencyKey: key("settings"),
    });
    const first = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    if (!first.job) throw new Error(`expected an automatic job, got ${first.refusal?.code ?? "unknown"}`);
    const limited = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    expect(limited.refusal?.code).toBe("session-limit");
    expect(limited.refusal?.remaining).toBe(0);

    await submitAndSettle(harness, first.job.jobId);
    harness.clock.advance(30_000);
    harness.service.updateSettings("owner", CAMPAIGN, {
      patch: { autoPerSessionLimit: 3 },
      expectedRevision: 2,
      idempotencyKey: key("settings"),
    });
    const cooling = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    expect(cooling.refusal?.code).toBe("cooldown");
    expect(cooling.refusal?.cooldownEndsAt).toBe("2030-01-01T00:02:00.000Z");

    const manualBypass = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ prompt: "manual bypass" }), key("enqueue"));
    expect(manualBypass.refusal).toBeNull();
    expect(manualBypass.job?.status).toBe("queued");

    harness.clock.advance(121_000);
    const warmed = harness.service.enqueue("owner", CAMPAIGN, sampleEnqueue({ auto: true }), key("enqueue"));
    expect(warmed.refusal).toBeNull();
    expect(warmed.job?.status).toBe("queued");
  });
});

describe("scene image queue and cache", () => {
  it("submits one batch at a time and never duplicates a tracked submission", async () => {
    const harness = createHarness();
    enable(harness);
    const first = enqueueOk(harness, "first scene prompt");
    const second = enqueueOk(harness, "second scene prompt");

    await harness.service.tick();
    const firstJob = harness.service.getJob("owner", CAMPAIGN, first.jobId).job;
    expect(firstJob.status).toBe("submitted");
    expect(firstJob.serviceBatchId).toBe("batch-1");
    expect(firstJob.serviceJobIds).toHaveLength(1);
    expect(firstJob.submittedAt).not.toBeNull();
    expect(harness.fake.state.generateCalls).toHaveLength(1);
    expect(harness.fake.state.pollCalls).toHaveLength(0);
    expect(harness.service.getJob("owner", CAMPAIGN, second.jobId).job.status).toBe("queued");

    attachDone(harness, firstJob.serviceJobIds[0] ?? "");
    await harness.service.tick();
    expect(harness.service.getJob("owner", CAMPAIGN, first.jobId).job.status).toBe("done");
    expect(harness.fake.state.generateCalls).toHaveLength(2);
    expect(harness.fake.state.pollCalls.at(-1)?.ids).toEqual([firstJob.serviceJobIds[0]]);
    expect(harness.fake.state.pollCalls.at(-1)?.options).toMatchObject({ maxAttempts: 1 });
    expect(harness.service.getJob("owner", CAMPAIGN, second.jobId).job.status).toBe("submitted");

    await harness.service.tick();
    expect(harness.fake.state.generateCalls).toHaveLength(2);
    expect(harness.service.getJob("owner", CAMPAIGN, second.jobId).job.serviceJobIds).toHaveLength(1);
  });

  it("links a cached asset instead of submitting and replays enqueue idempotently", async () => {
    const harness = createHarness();
    enable(harness);
    const request = sampleEnqueue({ prompt: "a ruined mill", seed: 7, sceneRevision: 3 });
    const first = harness.service.enqueue("owner", CAMPAIGN, request, "cache-key-1");
    if (!first.job) throw new Error("expected the first job");
    const firstDone = await submitAndSettle(harness, first.job.jobId);
    expect(firstDone.status).toBe("done");
    expect(firstDone.assetId).not.toBeNull();

    const second = harness.service.enqueue("owner", CAMPAIGN, request, key("enqueue"));
    expect(second.deduped).toBe(true);
    expect(second.job?.status).toBe("done");
    expect(second.job?.assetId).toBe(firstDone.assetId);
    expect(harness.fake.state.generateCalls).toHaveLength(1);
    expect(harness.service.listGallery("owner", CAMPAIGN).images).toHaveLength(1);

    const replay = harness.service.enqueue("owner", CAMPAIGN, request, "cache-key-1");
    expect(replay.deduped).toBe(true);
    expect(replay.job?.jobId).toBe(first.job.jobId);
    expect(harness.fake.state.generateCalls).toHaveLength(1);
  });

  it("persists every image from a batch submission", async () => {
    const harness = createHarness();
    enable(harness);
    const batch = enqueueOk(harness, "a harbor at dawn", { kind: "batch", count: 2, sceneRevision: 4 });
    await harness.service.tick();
    expect(harness.fake.state.generateCalls).toHaveLength(0);
    expect(harness.fake.state.batchCalls).toHaveLength(1);
    expect(harness.fake.state.batchCalls[0]).toMatchObject({
      prompt: "a harbor at dawn",
      count: 2,
      steps: [20],
      guidance: [3],
    });
    const submitted = harness.service.getJob("owner", CAMPAIGN, batch.jobId).job;
    expect(submitted.serviceJobIds).toHaveLength(2);
    for (const serviceId of submitted.serviceJobIds) attachDone(harness, serviceId);
    await harness.service.tick();
    const done = harness.service.getJob("owner", CAMPAIGN, batch.jobId).job;
    expect(done.status).toBe("done");
    const gallery = harness.service.listGallery("owner", CAMPAIGN);
    expect(gallery.images).toHaveLength(2);
    expect(gallery.images.every((image) => image.width === 256 && image.height === 256)).toBe(true);
    expect(gallery.images.filter((image) => image.selected)).toHaveLength(1);
    expect(gallery.images.find((image) => image.assetId === done.assetId)?.selected).toBe(true);
  });

  it("marks failed and cancelled service jobs without resubmitting", async () => {
    const harness = createHarness();
    enable(harness);
    const failing = enqueueOk(harness, "failing prompt");
    await harness.service.tick();
    const failingId = harness.service.getJob("owner", CAMPAIGN, failing.jobId).job.serviceJobIds[0] ?? "";
    harness.fake.settle(failingId, "failed");
    await harness.service.tick();
    const failed = harness.service.getJob("owner", CAMPAIGN, failing.jobId).job;
    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("service-failed");
    expect(harness.fake.state.downloadCalls).toHaveLength(0);
    await harness.service.tick();
    expect(harness.fake.state.generateCalls).toHaveLength(1);

    const cancelling = enqueueOk(harness, "cancelled prompt");
    await harness.service.tick();
    const cancellingId = harness.service.getJob("owner", CAMPAIGN, cancelling.jobId).job.serviceJobIds[0] ?? "";
    harness.fake.settle(cancellingId, "cancelled");
    await harness.service.tick();
    const cancelled = harness.service.getJob("owner", CAMPAIGN, cancelling.jobId).job;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorCode).toBe("service-cancelled");
  });

  it("keeps ambiguous submissions uncertain and never retries them", async () => {
    const harness = createHarness();
    enable(harness);
    harness.fake.state.behaviors.push({ kind: "uncertain" });
    const job = enqueueOk(harness, "ambiguous prompt");
    const summary = await harness.service.tick();
    const uncertain = harness.service.getJob("owner", CAMPAIGN, job.jobId).job;
    expect(uncertain.status).toBe("uncertain");
    expect(uncertain.errorCode).toBe("submission-uncertain");
    expect(uncertain.attempts).toBe(1);
    expect(summary.uncertain).toBe(1);

    await harness.service.tick();
    expect(harness.fake.state.generateCalls).toHaveLength(1);
    expect(harness.service.getJob("owner", CAMPAIGN, job.jobId).job.status).toBe("uncertain");
  });

  it("leaves rate-limited jobs queued and retries on a later tick", async () => {
    const harness = createHarness();
    enable(harness);
    harness.fake.state.behaviors.push({ kind: "rate-limit" });
    const job = enqueueOk(harness, "busy prompt");
    await harness.service.tick();
    const queued = harness.service.getJob("owner", CAMPAIGN, job.jobId).job;
    expect(queued.status).toBe("queued");
    expect(queued.errorCode).toBe("rate-limited");
    expect(queued.attempts).toBe(1);
    expect(queued.serviceJobIds).toHaveLength(0);
    expect(harness.fake.state.generateCalls).toHaveLength(1);

    await harness.service.tick();
    expect(harness.fake.state.generateCalls).toHaveLength(2);
    expect(harness.service.getJob("owner", CAMPAIGN, job.jobId).job.status).toBe("submitted");
  });

  it("marks an outrun job stale and never overwrites the active selection", async () => {
    const harness = createHarness();
    enable(harness);
    const fresh = enqueueOk(harness, "current scene", { sceneRevision: 5, seed: 11 });
    const freshDone = await submitAndSettle(harness, fresh.jobId);
    expect(freshDone.status).toBe("done");
    const activeAsset = freshDone.assetId;
    expect(harness.service.listGallery("owner", CAMPAIGN).images.find((image) => image.assetId === activeAsset)?.selected).toBe(true);

    const stale = enqueueOk(harness, "old scene", { sceneRevision: 4, seed: 12 });
    const staleDone = await submitAndSettle(harness, stale.jobId);
    expect(staleDone.status).toBe("stale");
    expect(staleDone.errorCode).toBe("stale-scene");
    expect(staleDone.assetId).not.toBeNull();
    const gallery = harness.service.listGallery("owner", CAMPAIGN);
    expect(gallery.images).toHaveLength(2);
    expect(gallery.images.find((image) => image.assetId === activeAsset)?.selected).toBe(true);
    expect(gallery.images.find((image) => image.assetId === staleDone.assetId)?.selected).toBe(false);
  });
});

describe("scene image retention and reads", () => {
  it("prunes history and unselected assets but never the selected asset", async () => {
    const harness = createHarness({ worker: { historyLimit: 2, assetLimit: 1 } });
    enable(harness);
    const first = enqueueOk(harness, "retention one", { seed: 1 });
    await submitAndSettle(harness, first.jobId);
    const second = enqueueOk(harness, "retention two", { seed: 2 });
    await submitAndSettle(harness, second.jobId);
    const third = enqueueOk(harness, "retention three", { seed: 3 });
    const thirdDone = await submitAndSettle(harness, third.jobId);
    expect(thirdDone.assetId).not.toBeNull();

    const pruned = harness.service.prune();
    expect(pruned.assets).toBeGreaterThanOrEqual(1);
    expect(pruned.jobs).toBeGreaterThanOrEqual(1);
    const gallery = harness.service.listGallery("owner", CAMPAIGN);
    expect(gallery.images).toHaveLength(1);
    expect(gallery.images[0]?.assetId).toBe(thirdDone.assetId);
    expect(gallery.images[0]?.selected).toBe(true);
    expect(gallery.jobs).toHaveLength(2);

    const before = harness.service.readAsset("owner", CAMPAIGN, thirdDone.assetId ?? "");
    expect(before.bytes.byteLength).toBeGreaterThan(0);
    expect(harness.service.prune()).toEqual({ assets: 0, jobs: 0, receipts: 0 });
    const after = harness.service.readAsset("owner", CAMPAIGN, thirdDone.assetId ?? "");
    expect(after.bytes.equals(before.bytes)).toBe(true);
  });

  it("scopes gallery and asset reads to campaign membership and selection", async () => {
    const harness = createHarness({ deniedCampaigns: ["camp-9"] });
    enable(harness);
    const job = enqueueOk(harness, "published scene", { seed: 21 });
    const done = await submitAndSettle(harness, job.jobId);
    const assetId = done.assetId ?? "";
    expect(assetId).not.toBe("");

    const dmGallery = harness.service.listGallery("owner", CAMPAIGN);
    expect(dmGallery.images).toHaveLength(1);
    expect(dmGallery.images[0]?.selected).toBe(true);
    expect(dmGallery.jobs).toHaveLength(1);
    expect(harness.service.listGallery("player", CAMPAIGN, { sessionId: "session-1" }).images.map((image) => image.assetId)).toEqual([assetId]);
    expect(harness.service.listGallery("player", CAMPAIGN, { sessionId: "session-2" }).images).toHaveLength(0);
    expect(sceneError(() => harness.service.listGallery("player", CAMPAIGN)).statusCode).toBe(400);
    expect(sceneError(() => harness.service.getJob("player", CAMPAIGN, job.jobId)).statusCode).toBe(403);

    const bytes = harness.service.readAsset("player", CAMPAIGN, assetId);
    expect(bytes.contentType).toBe("image/png");
    expect(bytes.bytes.byteLength).toBeGreaterThan(0);

    const stale = enqueueOk(harness, "unpublished scene", { seed: 22, sceneRevision: 0 });
    const staleDone = await submitAndSettle(harness, stale.jobId);
    expect(staleDone.status).toBe("stale");
    expect(sceneError(() => harness.service.readAsset("player", CAMPAIGN, staleDone.assetId ?? "")).statusCode).toBe(403);
    expect(harness.service.readAsset("owner", CAMPAIGN, staleDone.assetId ?? "").bytes.byteLength).toBeGreaterThan(0);

    expect(sceneError(() => harness.service.readAsset("owner", "camp-9", assetId)).statusCode).toBe(404);
    expect(sceneError(() => harness.service.readAsset("player", "camp-9", assetId)).statusCode).toBe(404);
  });
});
