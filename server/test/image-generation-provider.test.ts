import { describe, expect, it } from "vitest";
import {
  base64DecodedByteEstimate,
  createImageGenerationClient,
  ImageGenerationConfigurationError,
  ImageGenerationPayloadTooLargeError,
  ImageGenerationProtocolError,
  ImageGenerationTimeoutError,
  readImageGenerationConfig,
  validateImageGenerationBaseUrl,
  type ImageGenerationConfig,
} from "../src/provider/imageGeneration.js";
import { createFakeImageGenerationClient } from "../src/provider/imageGenerationFake.js";

const baseConfig: ImageGenerationConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8788",
  token: "test-token",
  model: "supra2-img",
  timeoutMs: 5_000,
  maxBytes: 1024 * 1024,
};

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

describe("image generation base URL policy", () => {
  it("allows https anywhere and http only on private or tailnet hosts", () => {
    for (const allowed of [
      "https://images.example.com/api",
      "https://gpu-host.example.com:8443",
      "http://127.0.0.1:8123",
      "http://localhost:8123",
      "http://10.1.2.3:8123",
      "http://172.20.0.4:8123",
      "http://192.168.1.20:8123",
      "http://100.101.102.103:8123",
      "http://gpu-host.tailnet.ts.net:8123",
    ]) {
      expect(validateImageGenerationBaseUrl(allowed), allowed).toEqual({ ok: true });
    }
    for (const rejected of [
      "http://images.example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://172.15.0.1",
      "http://100.128.0.1",
      "http://100.63.0.1",
      "ftp://images.example.com",
      "not a url",
    ]) {
      expect(validateImageGenerationBaseUrl(rejected).ok, rejected).toBe(false);
    }
  });
});

describe("image generation configuration", () => {
  it("stays disabled unless the flag is exact-true and the base URL is valid", () => {
    expect(readImageGenerationConfig({}).enabled).toBe(false);
    expect(readImageGenerationConfig({ VELVET_IMAGES_BASE_URL: "https://images.example.com" }).enabled).toBe(false);
    expect(readImageGenerationConfig({ VELVET_IMAGES_ENABLED: "TRUE", VELVET_IMAGES_BASE_URL: "https://images.example.com" }).enabled).toBe(false);
    expect(readImageGenerationConfig({ VELVET_IMAGES_ENABLED: "true", VELVET_IMAGES_BASE_URL: "http://images.example.com" }).enabled).toBe(false);
    expect(readImageGenerationConfig({ VELVET_IMAGES_ENABLED: "true" }).enabled).toBe(false);
    const config = readImageGenerationConfig({
      VELVET_IMAGES_ENABLED: "true",
      VELVET_IMAGES_BASE_URL: "https://images.example.com/",
      VELVET_IMAGES_TOKEN: " token ",
      VELVET_IMAGES_MODEL: "supra2-img",
    });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "https://images.example.com",
      token: "token",
      model: "supra2-img",
      timeoutMs: 120_000,
      maxBytes: 8_388_608,
    });
  });

  it("rejects malformed deadlines and byte budgets even while disabled", () => {
    for (const value of ["0", "-1", "999", "600001", "abc", "1.5"]) {
      expect(() => readImageGenerationConfig({ VELVET_IMAGES_TIMEOUT_MS: value }), value).toThrow();
    }
    for (const value of ["0", "1023", "67108865", "abc", "1.5"]) {
      expect(() => readImageGenerationConfig({ VELVET_IMAGES_MAX_BYTES: value }), value).toThrow();
    }
    expect(readImageGenerationConfig({ VELVET_IMAGES_TIMEOUT_MS: "1000", VELVET_IMAGES_MAX_BYTES: "1024" }))
      .toMatchObject({ enabled: false, timeoutMs: 1_000, maxBytes: 1_024 });
  });
});

describe("image generation client", () => {
  it("posts the parsed request with a bearer token and returns the parsed result", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ images: [{ format: "png", base64: "aGVsbG8=" }], seed: 7, seconds: 0.25 }));
    const client = createImageGenerationClient({ config: baseConfig, fetch: fetchImpl });
    const result = await client.generate({ prompt: "  a moonlit castle  ", seed: 7 });
    expect(result).toEqual({ images: [{ format: "png", base64: "aGVsbG8=" }], seed: 7, seconds: 0.25 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8788/generate");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      prompt: "a moonlit castle", seed: 7, steps: 50, guidanceScale: 3, count: 1,
    });
  });

  it("probes health through the same policy and omits an absent credential", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      Response.json({ status: "ok", model: "supra2-img", commit: null, device: "cuda:0" }));
    const client = createImageGenerationClient({ config: { ...baseConfig, token: "" }, fetch: fetchImpl });
    await expect(client.health()).resolves.toEqual({ status: "ok", model: "supra2-img", commit: null, device: "cuda:0" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8788/health");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBeNull();
  });

  it("classifies non-200 responses once, without retrying, and redacts the token", async () => {
    const { calls, fetchImpl } = recordingFetch(async () =>
      new Response(JSON.stringify({ error: "model not loaded for test-token" }), { status: 503 }));
    const client = createImageGenerationClient({ config: baseConfig, fetch: fetchImpl });
    await expect(client.generate({ prompt: "a lighthouse" })).rejects.toMatchObject({
      name: "ImageGenerationHttpError",
      status: 503,
      message: "Image generation HTTP 503: model not loaded for [REDACTED]",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects malformed and non-JSON bodies as protocol failures", async () => {
    const malformed = createImageGenerationClient({
      config: baseConfig,
      fetch: recordingFetch(async () => Response.json({ images: [{ format: "gif", base64: "x" }], seed: 1, seconds: 0 })).fetchImpl,
    });
    await expect(malformed.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationProtocolError);
    const nonJson = createImageGenerationClient({
      config: baseConfig,
      fetch: recordingFetch(async () => new Response("nope", { status: 200 })).fetchImpl,
    });
    await expect(nonJson.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationProtocolError);
  });

  it("aborts at the configured deadline and reports a typed timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const client = createImageGenerationClient({ config: { ...baseConfig, timeoutMs: 25 }, fetch: hanging });
    await expect(client.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects images whose decoded bytes exceed the configured budget", async () => {
    const oversized = "A".repeat(2_048);
    expect(base64DecodedByteEstimate(oversized)).toBeGreaterThan(1_024);
    const client = createImageGenerationClient({
      config: { ...baseConfig, maxBytes: 1_024 },
      fetch: recordingFetch(async () => Response.json({ images: [{ format: "png", base64: oversized }], seed: 1, seconds: 0 })).fetchImpl,
    });
    await expect(client.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationPayloadTooLargeError);
    const declared = createImageGenerationClient({
      config: { ...baseConfig, maxBytes: 1_024 },
      fetch: recordingFetch(async () =>
        new Response("{}", { headers: { "content-length": String(8 * 1024 * 1024) } })).fetchImpl,
    });
    await expect(declared.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationPayloadTooLargeError);
  });

  it("refuses to call out while disabled or with an invalid request", async () => {
    let called = false;
    const disabled = createImageGenerationClient({
      config: { ...baseConfig, enabled: false },
      fetch: async () => { called = true; return Response.json({}); },
    });
    await expect(disabled.health()).rejects.toBeInstanceOf(ImageGenerationConfigurationError);
    await expect(disabled.generate({ prompt: "a lighthouse" })).rejects.toBeInstanceOf(ImageGenerationConfigurationError);
    const client = createImageGenerationClient({ config: baseConfig, fetch: async () => { called = true; return Response.json({}); } });
    await expect(client.generate({ prompt: "   " })).rejects.toBeInstanceOf(ImageGenerationConfigurationError);
    expect(called).toBe(false);
  });
});

describe("fake image generation client", () => {
  it("is deterministic, records parsed calls, and honors its failure modes", async () => {
    const fake = createFakeImageGenerationClient({ seconds: 0.1 });
    const first = await fake.generate({ prompt: "portrait", seed: 3, count: 2 });
    const second = await fake.generate({ prompt: "portrait", seed: 3, count: 2 });
    expect(first).toEqual(second);
    expect(first.seed).toBe(3);
    expect(first.images).toHaveLength(2);
    expect(first.seconds).toBe(0.1);
    expect(fake.calls).toEqual([
      { prompt: "portrait", seed: 3, steps: 50, guidanceScale: 3, count: 2 },
      { prompt: "portrait", seed: 3, steps: 50, guidanceScale: 3, count: 2 },
    ]);
    expect(Buffer.from(first.images[0]!.base64, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");
    await expect(fake.health()).resolves.toMatchObject({ status: "ok", commit: null, device: "cpu" });
    expect(fake.healthCalls).toBe(1);

    const failing = createFakeImageGenerationClient({ failWith: new Error("offline"), healthFailWith: new Error("down") });
    await expect(failing.generate({ prompt: "portrait" })).rejects.toThrow("offline");
    expect(failing.calls).toHaveLength(1);
    await expect(failing.health()).rejects.toThrow("down");
    expect(failing.healthCalls).toBe(1);
  });
});
