import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSupra2ImageClient,
  parseSupra2BatchRequest,
  parseSupra2GenerateRequest,
  readSupra2ImageConfig,
  selectJobsByIds,
  SUPRA2_IMAGE_MAX_PROMPT_CHARS,
  SUPRA2_IMAGE_RATE_LIMIT_MAX_DELAY_MS,
  SUPRA2_IMAGE_STATUS_JOB_LIMIT,
  Supra2ImageConfigurationError,
  Supra2ImageHealthError,
  Supra2ImageHttpError,
  Supra2ImagePathError,
  Supra2ImagePayloadTooLargeError,
  Supra2ImageProtocolError,
  Supra2ImageRateLimitError,
  type Supra2ImageConfig,
  type Supra2ImageJob,
  validateSupra2ImageBaseUrl,
} from "../src/provider/supra2ImageService.js";

const LOCAL_ORIGIN = "http://127.0.0.1:4363";

function config(overrides: Partial<Supra2ImageConfig> = {}): Supra2ImageConfig {
  return {
    enabled: true,
    baseUrl: LOCAL_ORIGIN,
    origin: LOCAL_ORIGIN,
    timeoutMs: 5_000,
    maxBytes: 64 * 1024,
    ...overrides,
  };
}

function recordingFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit);
  };
  return { calls, fetchImpl };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(text = "payload"): Uint8Array {
  const tail = new TextEncoder().encode(text);
  const bytes = new Uint8Array(PNG_SIGNATURE.length + tail.length);
  bytes.set(PNG_SIGNATURE);
  bytes.set(tail, PNG_SIGNATURE.length);
  return bytes;
}

function sampleJob(overrides: Partial<Supra2ImageJob> = {}): Supra2ImageJob {
  return {
    id: "ours-1",
    batch: "batch-1",
    prompt: "a weathered harbor lighthouse",
    seed: 7,
    steps: 30,
    cfg: 3,
    status: "done",
    created: 100,
    ...overrides,
  };
}

function statusPayload(jobs: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    device: "rocm",
    mode: "idle",
    worker: { loaded: true, threads: 8, idle_unload_seconds: 300 },
    jobs,
    ...overrides,
  };
}

describe("Supra2 image configuration", () => {
  it("allows https anywhere and http only on private or tailnet hosts", () => {
    for (const allowed of [
      "https://kimi.tailec998.ts.net:4363",
      "https://images.example.com/api",
      "http://127.0.0.1:4363",
      "http://localhost:4363",
      "http://10.1.2.3:4363",
      "http://172.20.0.4:4363",
      "http://192.168.1.20:4363",
      "http://100.101.102.103:4363",
      "http://gpu-host.tailnet.ts.net:4363",
    ]) {
      expect(validateSupra2ImageBaseUrl(allowed), allowed).toEqual({ ok: true });
    }
    for (const rejected of [
      "http://images.example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://100.128.0.1",
      "ftp://images.example.com",
      "not a url",
    ]) {
      expect(validateSupra2ImageBaseUrl(rejected).ok, rejected).toBe(false);
    }
  });

  it("stays disabled unless the flag is exact-true and the base URL is valid", () => {
    expect(readSupra2ImageConfig({}).enabled).toBe(false);
    expect(readSupra2ImageConfig({ VELVET_SCENE_IMAGES_BASE_URL: "https://kimi.tailec998.ts.net:4363" }).enabled).toBe(false);
    expect(readSupra2ImageConfig({
      VELVET_SCENE_IMAGES_ENABLED: "TRUE",
      VELVET_SCENE_IMAGES_BASE_URL: "https://kimi.tailec998.ts.net:4363",
    }).enabled).toBe(false);
    expect(readSupra2ImageConfig({
      VELVET_SCENE_IMAGES_ENABLED: "true",
      VELVET_SCENE_IMAGES_BASE_URL: "http://images.example.com",
    }).enabled).toBe(false);
    expect(readSupra2ImageConfig({ VELVET_SCENE_IMAGES_ENABLED: "true" }).enabled).toBe(false);
    expect(readSupra2ImageConfig({
      VELVET_SCENE_IMAGES_ENABLED: "true",
      VELVET_SCENE_IMAGES_BASE_URL: "https://kimi.tailec998.ts.net:4363/",
    })).toEqual({
      enabled: true,
      baseUrl: "https://kimi.tailec998.ts.net:4363",
      origin: "https://kimi.tailec998.ts.net:4363",
      timeoutMs: 120_000,
      maxBytes: 8_388_608,
    });
  });

  it("derives the origin from the base URL and accepts a normalized override", () => {
    const derived = readSupra2ImageConfig({
      VELVET_SCENE_IMAGES_ENABLED: "true",
      VELVET_SCENE_IMAGES_BASE_URL: "http://100.64.0.9:4363",
    });
    expect(derived.origin).toBe("http://100.64.0.9:4363");
    const override = readSupra2ImageConfig({
      VELVET_SCENE_IMAGES_ENABLED: "true",
      VELVET_SCENE_IMAGES_BASE_URL: "https://kimi.tailec998.ts.net:4363",
      VELVET_SCENE_IMAGES_ORIGIN: "https://kimi.tailec998.ts.net:4363/",
    });
    expect(override.origin).toBe("https://kimi.tailec998.ts.net:4363");
    expect(() => readSupra2ImageConfig({ VELVET_SCENE_IMAGES_ORIGIN: "not a url" })).toThrow();
    expect(() => readSupra2ImageConfig({ VELVET_SCENE_IMAGES_ORIGIN: "https://host/some/path" })).toThrow();
    expect(() => readSupra2ImageConfig({ VELVET_SCENE_IMAGES_ORIGIN: "ftp://host" })).toThrow();
  });

  it("rejects malformed deadlines and byte budgets even while disabled", () => {
    for (const value of ["0", "-1", "999", "600001", "abc", "1.5"]) {
      expect(() => readSupra2ImageConfig({ VELVET_SCENE_IMAGES_TIMEOUT_MS: value }), value).toThrow();
    }
    for (const value of ["0", "1023", "67108865", "abc", "1.5"]) {
      expect(() => readSupra2ImageConfig({ VELVET_SCENE_IMAGES_MAX_BYTES: value }), value).toThrow();
    }
    expect(readSupra2ImageConfig({ VELVET_SCENE_IMAGES_TIMEOUT_MS: "1000", VELVET_SCENE_IMAGES_MAX_BYTES: "1024" }))
      .toMatchObject({ enabled: false, timeoutMs: 1_000, maxBytes: 1_024 });
  });
});

describe("Supra2 request validation", () => {
  it("trims prompts and applies adapter defaults", () => {
    expect(parseSupra2GenerateRequest({ prompt: "  a moonlit harbor  " }))
      .toEqual({ prompt: "a moonlit harbor", seed: 0, steps: 50, cfg: 3 });
    expect(parseSupra2BatchRequest({ prompt: "  a brass bell  " }))
      .toEqual({ prompt: "a brass bell", count: 1, steps: [50], guidance: [3] });
  });

  it("rejects generate requests outside the service bounds", () => {
    for (const request of [
      { prompt: "" },
      { prompt: "   " },
      { prompt: "x".repeat(SUPRA2_IMAGE_MAX_PROMPT_CHARS + 1) },
      { prompt: "x", seed: -1 },
      { prompt: "x", seed: 1.5 },
      { prompt: "x", seed: 2_147_483_648 },
      { prompt: "x", seed: Number.NaN },
      { prompt: "x", steps: 0 },
      { prompt: "x", steps: 101 },
      { prompt: "x", steps: 2.5 },
      { prompt: "x", cfg: 0.5 },
      { prompt: "x", cfg: 10.5 },
      { prompt: "x", cfg: Number.POSITIVE_INFINITY },
      { prompt: "x", cfg: Number.NaN },
    ]) {
      expect(() => parseSupra2GenerateRequest(request), JSON.stringify(request).slice(0, 60)).toThrow(Supra2ImageConfigurationError);
    }
    expect(parseSupra2GenerateRequest({ prompt: "x", seed: 2_147_483_647, steps: 100, cfg: 10 }))
      .toEqual({ prompt: "x", seed: 2_147_483_647, steps: 100, cfg: 10 });
  });

  it("rejects batch requests outside count, array, and total bounds", () => {
    for (const request of [
      { prompt: "x", count: 0 },
      { prompt: "x", count: 33 },
      { prompt: "x", count: 1.5 },
      { prompt: "x", steps: [] },
      { prompt: "x", steps: Array.from({ length: 9 }, () => 10) },
      { prompt: "x", steps: [0] },
      { prompt: "x", steps: [101] },
      { prompt: "x", steps: [2.5] },
      { prompt: "x", guidance: [] },
      { prompt: "x", guidance: Array.from({ length: 9 }, () => 3) },
      { prompt: "x", guidance: [0.5] },
      { prompt: "x", guidance: [10.1] },
      { prompt: "x", count: 32, steps: [10, 20, 30, 40, 50, 60, 70, 80], guidance: [2] },
    ]) {
      expect(() => parseSupra2BatchRequest(request)).toThrow(Supra2ImageConfigurationError);
    }
    expect(parseSupra2BatchRequest({ prompt: "x", count: 32, steps: [10], guidance: [1, 2, 3, 4] }))
      .toEqual({ prompt: "x", count: 32, steps: [10], guidance: [1, 2, 3, 4] });
  });

  it("rejects invalid submissions before any fetch", async () => {
    let calls = 0;
    const client = createSupra2ImageClient({
      config: config(),
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    await expect(client.generate({ prompt: "   " })).rejects.toBeInstanceOf(Supra2ImageConfigurationError);
    await expect(client.batch({ prompt: "x", count: 33 })).rejects.toBeInstanceOf(Supra2ImageConfigurationError);
    await expect(client.pollJobs([])).rejects.toBeInstanceOf(Supra2ImageConfigurationError);
    expect(calls).toBe(0);
  });
});

describe("Supra2 submissions", () => {
  it("posts an exact generate body with required headers and accepts the 202", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ id: "job-7", batch: "batch-2" }, { status: 202 }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    const result = await client.generate({ prompt: "  a quiet harbor  ", seed: 7, steps: 30, cfg: 4.5 });
    expect(result).toEqual({ outcome: "accepted", id: "job-7", batch: "batch-2" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4363/api/generate");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe(LOCAL_ORIGIN);
    expect(JSON.parse(String(calls[0]!.init.body)))
      .toEqual({ prompt: "a quiet harbor", seed: 7, steps: 30, cfg: 4.5 });
  });

  it("posts an exact batch body and returns every accepted id", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ id: "batch-9", batch: "batch-9", ids: ["img-a", "img-b", "img-c"] }, { status: 202 }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    const result = await client.batch({ prompt: " p ", count: 3, steps: [10, 20], guidance: [2] });
    expect(result).toEqual({ outcome: "accepted", id: "batch-9", batch: "batch-9", ids: ["img-a", "img-b", "img-c"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4363/api/batch");
    expect(JSON.parse(String(calls[0]!.init.body)))
      .toEqual({ prompt: "p", count: 3, steps: [10, 20], guidance: [2] });
  });

  it("reports an unreadable 202 acceptance as uncertain without retrying", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => new Response("not json", { status: 202 }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    await expect(client.generate({ prompt: "x" }))
      .resolves.toEqual({ outcome: "uncertain", reason: "unreadable-acceptance" });
    expect(calls).toHaveLength(1);
  });

  it.each([400, 500, 503])("classifies HTTP %i without retrying", async (status) => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ detail: "rejected" }, { status }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    await expect(client.generate({ prompt: "x" })).rejects.toBeInstanceOf(Supra2ImageHttpError);
    expect(calls).toHaveLength(1);
  });

  it("retries a busy lane with bounded jittered backoff, then surfaces the rate limit", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ detail: "busy" }, { status: 429, headers: { "retry-after": "2" } }));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
      maxSubmitAttempts: 3,
    });

    const error = await client.generate({ prompt: "x" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Supra2ImageRateLimitError);
    expect((error as Supra2ImageRateLimitError).retryAfter).toBe("2");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
    expect(sleeps.reduce((total, ms) => total + ms, 0))
      .toBeLessThanOrEqual(SUPRA2_IMAGE_RATE_LIMIT_MAX_DELAY_MS * 2);
  });

  it("accepts a second attempt after one 429", async () => {
    let attempt = 0;
    const { calls, fetchImpl } = recordingFetch(async () => attempt++ === 0
      ? new Response(null, { status: 429 })
      : Response.json({ id: "job-1", batch: "b" }, { status: 202 }));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });

    await expect(client.generate({ prompt: "x" })).resolves.toEqual({ outcome: "accepted", id: "job-1", batch: "b" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it("reports a submission timeout as uncertain and calls fetch exactly once", async () => {
    let observedSignal: AbortSignal | undefined;
    const { calls, fetchImpl } = recordingFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init.signal ?? undefined;
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = createSupra2ImageClient({ config: config({ timeoutMs: 25 }), fetch: fetchImpl });

    await expect(client.generate({ prompt: "a lighthouse" }))
      .resolves.toEqual({ outcome: "uncertain", reason: "timeout" });
    expect(calls).toHaveLength(1);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("reports a transport failure as uncertain and calls fetch exactly once", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    await expect(client.batch({ prompt: "x" }))
      .resolves.toEqual({ outcome: "uncertain", reason: "transport" });
    expect(calls).toHaveLength(1);
  });

  it("refuses every call while disabled", async () => {
    let called = false;
    const client = createSupra2ImageClient({
      config: config({ enabled: false }),
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    const calls: Array<() => Promise<unknown>> = [
      () => client.health(),
      () => client.status(),
      () => client.generate({ prompt: "x" }),
      () => client.batch({ prompt: "x" }),
      () => client.downloadImage("/images/a.png"),
      () => client.pollJobs(["a"]),
      () => client.cancelAll(),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(Supra2ImageConfigurationError);
    }
    expect(called).toBe(false);
  });
});

describe("Supra2 status and polling", () => {
  it("maps status strictly and never trusts history we did not submit", async () => {
    const ours = { ...sampleJob(), status: "running" as const };
    const foreign = { ...sampleJob({ id: "foreign-1", prompt: "someone else's prompt" }), status: "queued" as const };
    const { calls, fetchImpl } = recordingFetch(async () => Response.json(statusPayload([ours, foreign])));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    const status = await client.status();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4363/api/status");
    expect(calls[0]!.init.method).toBe("GET");
    expect(status.worker).toEqual({ loaded: true, threads: 8, idleUnloadSeconds: 300 });
    expect(status.jobs.map((job) => job.id)).toEqual(["ours-1", "foreign-1"]);
    expect(selectJobsByIds(status.jobs, ["ours-1"])).toEqual([{ ...sampleJob(), status: "running" }]);
    expect(selectJobsByIds(status.jobs, ["ours-1", "ghost", "ours-1"]).map((job) => job.id))
      .toEqual(["ours-1"]);
  });

  it("returns selected jobs in requested order", () => {
    const first = sampleJob();
    const second = sampleJob({ id: "ours-2" });
    expect(selectJobsByIds([first, second], ["ours-2", "ours-1"]).map((job) => job.id))
      .toEqual(["ours-2", "ours-1"]);
  });

  it("rejects malformed status bodies", async () => {
    const badJob = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json(statusPayload([{ ...sampleJob(), status: "sleeping" }]))).fetchImpl,
    });
    await expect(badJob.status()).rejects.toBeInstanceOf(Supra2ImageProtocolError);
    const badShape = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json({ busy: false })).fetchImpl,
    });
    await expect(badShape.status()).rejects.toBeInstanceOf(Supra2ImageProtocolError);
  });

  it("bounds the shared job history", async () => {
    const jobs = Array.from({ length: SUPRA2_IMAGE_STATUS_JOB_LIMIT + 1 }, (_value, index) =>
      sampleJob({ id: `job-${index}` }));
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json(statusPayload(jobs))).fetchImpl,
    });
    await expect(client.status()).rejects.toThrow(/bounded job limit/);
  });

  it("polls our jobs until terminal and ignores foreign history", async () => {
    const states = ["queued", "running", "done"] as const;
    let attempt = 0;
    const { calls, fetchImpl } = recordingFetch(async () => Response.json(statusPayload([
      sampleJob({ status: states[Math.min(attempt++, states.length - 1)]! }),
      sampleJob({ id: "foreign-1", status: "done" }),
    ])));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const result = await client.pollJobs(["ours-1"], { intervalMs: 5, deadlineMs: 60_000, maxAttempts: 10 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([5, 5]);
    expect(result).toMatchObject({ complete: true, attempts: 3, missingIds: [], rateLimited: 0 });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ id: "ours-1", status: "done" });
  });

  it("reports missing IDs and stops at the attempt cap", async () => {
    const { fetchImpl } = recordingFetch(async () => Response.json(statusPayload([sampleJob()])));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    const result = await client.pollJobs(["ours-1", "ghost"], { intervalMs: 5, maxAttempts: 2, deadlineMs: 60_000 });
    expect(result.complete).toBe(false);
    expect(result.missingIds).toEqual(["ghost"]);
    expect(result.attempts).toBe(2);
    expect(result.jobs.map((job) => job.id)).toEqual(["ours-1"]);
    expect(sleeps).toEqual([5]);
  });

  it("stops at the poll deadline", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = recordingFetch(async () =>
      Response.json(statusPayload([sampleJob({ status: "running" })])));
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    });

    const result = await client.pollJobs(["ours-1"], { intervalMs: 10, deadlineMs: 15, maxAttempts: 10 });
    expect(result.complete).toBe(false);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([10, 10]);
    expect(result.elapsedMs).toBe(20);
  });

  it("backs off a rate-limited poll with jitter, then succeeds", async () => {
    let attempt = 0;
    const { calls, fetchImpl } = recordingFetch(async () => attempt++ === 0
      ? new Response(null, { status: 429 })
      : Response.json(statusPayload([sampleJob()])));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 1,
      now: () => 0,
    });

    const result = await client.pollJobs(["ours-1"], { intervalMs: 5, maxAttempts: 5, deadlineMs: 60_000 });
    expect(result.rateLimited).toBe(1);
    expect(result.complete).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("throws a typed error for non-429 status failures", async () => {
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => new Response("nope", { status: 500 })).fetchImpl,
    });
    await expect(client.pollJobs(["ours-1"])).rejects.toBeInstanceOf(Supra2ImageHttpError);
  });
});

describe("Supra2 downloads", () => {
  it("downloads a PNG and returns bytes with a validated content type", async () => {
    const bytes = pngBytes();
    const { calls, fetchImpl } = recordingFetch(async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "image/png" } }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    const result = await client.downloadImage("/images/abc-123.png");
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    expect(result.contentType).toBe("image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4363/images/abc-123.png");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("defaults to image/png when the service omits the content type", async () => {
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => new Response(pngBytes(), { status: 200 })).fetchImpl,
    });
    await expect(client.downloadImage("/images/a.png")).resolves.toMatchObject({ contentType: "image/png" });
  });

  it("rejects traversal, foreign-origin, and non-image paths before any fetch", async () => {
    const unsafe = [
      "",
      "   ",
      "images/a.png",
      "/other/a.png",
      "/images/../secret.png",
      "/images/..%2fsecret.png",
      "/images/a.png?x=1",
      "/images/a.png#frag",
      "/images/a\\b.png",
      "https://evil.example/images/a.png",
      "//evil.example/images/a.png",
      "/images/",
      "/images/.png",
    ];
    let called = false;
    const client = createSupra2ImageClient({
      config: config(),
      fetch: async () => {
        called = true;
        return new Response(pngBytes(), { status: 200 });
      },
    });
    for (const path of unsafe) {
      await expect(client.downloadImage(path), path).rejects.toBeInstanceOf(Supra2ImagePathError);
    }
    expect(called).toBe(false);
  });

  it("rejects a download whose bytes are not a PNG", async () => {
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () =>
        new Response(new TextEncoder().encode("definitely not a png"), { status: 200, headers: { "content-type": "image/png" } })).fetchImpl,
    });
    await expect(client.downloadImage("/images/a.png")).rejects.toBeInstanceOf(Supra2ImageProtocolError);
  });

  it("rejects a download whose content type is not a PNG", async () => {
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () =>
        new Response(pngBytes(), { status: 200, headers: { "content-type": "image/jpeg" } })).fetchImpl,
    });
    await expect(client.downloadImage("/images/a.png")).rejects.toBeInstanceOf(Supra2ImageProtocolError);
  });

  it("enforces the byte budget for declared and streamed sizes", async () => {
    const declared = createSupra2ImageClient({
      config: config({ maxBytes: 1_024 }),
      fetch: recordingFetch(async () =>
        new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png", "content-length": "4096" } })).fetchImpl,
    });
    await expect(declared.downloadImage("/images/a.png")).rejects.toBeInstanceOf(Supra2ImagePayloadTooLargeError);
    const streamed = createSupra2ImageClient({
      config: config({ maxBytes: 8 }),
      fetch: recordingFetch(async () =>
        new Response(pngBytes("longer than eight bytes"), { status: 200, headers: { "content-type": "image/png" } })).fetchImpl,
    });
    await expect(streamed.downloadImage("/images/a.png")).rejects.toBeInstanceOf(Supra2ImagePayloadTooLargeError);
  });

  it("classifies download HTTP failures", async () => {
    const client = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => new Response("missing", { status: 404 })).fetchImpl,
    });
    await expect(client.downloadImage("/images/a.png"))
      .rejects.toMatchObject({ name: "Supra2ImageHttpError", status: 404 });
  });
});

describe("Supra2 health", () => {
  it("parses liveness responses and rejects an unhealthy service", async () => {
    const healthy = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json({ ok: true, release: "2026.09.1" })).fetchImpl,
    });
    await expect(healthy.health()).resolves.toEqual({ ok: true, release: "2026.09.1" });

    const unhealthy = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json({ ok: false, release: "2026.09.1" })).fetchImpl,
    });
    await expect(unhealthy.health()).rejects.toBeInstanceOf(Supra2ImageHealthError);

    const malformed = createSupra2ImageClient({
      config: config(),
      fetch: recordingFetch(async () => Response.json({ release: "2026.09.1" })).fetchImpl,
    });
    await expect(malformed.health()).rejects.toBeInstanceOf(Supra2ImageProtocolError);
  });
});

describe("Supra2 cancelAll", () => {
  it("uses the service-wide cancel endpoint with no per-request identifier", async () => {
    const { calls, fetchImpl } = recordingFetch(async () => new Response(null, { status: 204 }));
    const client = createSupra2ImageClient({ config: config(), fetch: fetchImpl });

    await expect(client.cancelAll()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4363/api/cancel");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("origin")).toBe(LOCAL_ORIGIN);
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.init.body).toBe("{}");
  });

  it("retries a rate-limited cancel with bounded backoff", async () => {
    let attempt = 0;
    const { calls, fetchImpl } = recordingFetch(async () => attempt++ === 0
      ? new Response(null, { status: 429 })
      : new Response(null, { status: 204 }));
    const sleeps: number[] = [];
    const client = createSupra2ImageClient({
      config: config(),
      fetch: fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    });

    await expect(client.cancelAll()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it("documents the never-wire warning next to the export", () => {
    const source = readFileSync(new URL("../src/provider/supra2ImageService.ts", import.meta.url), "utf8");
    expect(source).toContain("MUST NEVER be wired to per-request or player cancellation");
  });
});
