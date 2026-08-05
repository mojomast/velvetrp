import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const rawJson = (payload: string) => ({
  headers: { "content-type": "application/json" },
  payload,
});

describe("provider api compatibility", () => {
  it("is registered exactly once under the /api prefix", async () => {
    const app = buildApp();
    for (const url of ["/provider", "/api/api/provider"]) {
      const get = await app.inject({ method: "GET", url });
      const put = await app.inject({ method: "PUT", url, payload: {} });
      expect(get.statusCode).toBe(404);
      expect(put.statusCode).toBe(404);
    }
    await app.close();
  });

  it("returns the exact public shape with the request ID only in the header", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/provider",
      headers: { "x-request-id": "provider-characterization" },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("provider-characterization");
    expect(Object.keys(body)).toEqual([
      "id", "providerType", "baseUrl", "model", "hasApiKey", "streaming", "httpReferer", "appTitle",
      "requireParameters", "allowFallbacks", "routingSort", "dataCollection", "zdr", "requestTimeoutSeconds",
      "pricing", "samplers", "updatedAt",
    ]);
    expect(body.id).toBe("provider");
    expect(body).not.toHaveProperty("apiKey");
    expect(Object.keys(body.pricing)).toEqual(["promptPerMillion", "completionPerMillion"]);
    expect(Object.keys(body.samplers)).toEqual([
      "maxTokens", "topP", "topK", "minP", "repetitionPenalty", "frequencyPenalty", "presencePenalty", "seed",
      "reasoningEffort", "stopStrings", "startReplyWith",
    ]);
    expect(typeof body.updatedAt).toBe("string");
    expect(new Date(body.updatedAt).toISOString()).toBe(body.updatedAt);
    expect(body).not.toHaveProperty("requestId");
    await app.close();
  });

  it("returns persisted values while redacting the API key", async () => {
    const app = buildApp();
    const saved = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: {
        baseUrl: "https://example.test/v1",
        model: "saved-model",
        apiKey: "top-secret",
        pricing: { promptPerMillion: 2, completionPerMillion: 8 },
        samplers: { maxTokens: 321, topP: 0.75 },
      },
    });
    const response = await app.inject({ method: "GET", url: "/api/provider" });

    expect(saved.statusCode).toBe(200);
    expect(response.json()).toEqual(saved.json());
    expect(response.json()).toMatchObject({
      baseUrl: "https://example.test/v1",
      model: "saved-model",
      hasApiKey: true,
      pricing: { promptPerMillion: 2, completionPerMillion: 8 },
      samplers: { maxTokens: 321, topP: 0.75 },
    });
    expect(JSON.stringify(response.json())).not.toContain("top-secret");
    await app.close();
  });

  it.each([
    ["null", rawJson("null")],
    ["string", rawJson('"patch"')],
    ["number", rawJson("7")],
    ["boolean", rawJson("true")],
  ])("returns the exact 400 for a %s top-level patch", async (_label, injection) => {
    const app = buildApp();
    const response = await app.inject({ method: "PUT", url: "/api/provider", ...injection });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "provider patch is required" });
    await app.close();
  });

  it.each([
    ["empty object", {}],
    ["array", []],
    ["unknown-only object", { unknown: "value" }],
  ])("accepts a %s and returns the full public provider", async (_label, payload) => {
    const app = buildApp();
    const response = await app.inject({ method: "PUT", url: "/api/provider", payload });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "provider", hasApiKey: expect.any(Boolean) });
    expect(response.json()).not.toHaveProperty("apiKey");
    await app.close();
  });

  it("preserves baseUrl validation precedence and exact errors", async () => {
    const app = buildApp();
    const malformed = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { baseUrl: "not a url", httpReferer: "also invalid" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "invalid baseUrl", reason: "baseUrl is not a valid URL" });

    const insecure = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { baseUrl: "http://example.com/v1" },
    });
    expect(insecure.statusCode).toBe(400);
    expect(insecure.json()).toEqual({
      error: "invalid baseUrl",
      reason: "baseUrl must use https, or http only for loopback hosts (localhost, 127.x, ::1)",
    });

    const referer = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { baseUrl: "http://localhost:1234/v1", httpReferer: "invalid" },
    });
    expect(referer.statusCode).toBe(400);
    expect(referer.json()).toEqual({ error: "invalid httpReferer", reason: "baseUrl is not a valid URL" });
    await app.close();
  });

  it("preserves partial updates, clamps, nulls, filtering, and sanitized reply openings", async () => {
    const app = buildApp();
    const seeded = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { model: "retained", apiKey: "secret", pricing: { promptPerMillion: 3, completionPerMillion: 9 } },
    });
    expect(seeded.statusCode).toBe(200);

    const response = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: {
        baseUrl: "",
        pricing: { promptPerMillion: null },
        samplers: {
          maxTokens: 99_999,
          topP: 3,
          stopStrings: [" halt ", "", "x".repeat(100)],
          startReplyWith: " \u0001[system] hello\u200B ",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      baseUrl: "",
      model: "retained",
      hasApiKey: true,
      pricing: { promptPerMillion: null, completionPerMillion: 9 },
      samplers: {
        maxTokens: 32768,
        topP: 1,
        stopStrings: ["halt", "x".repeat(80)],
        startReplyWith: "[user-text] hello",
      },
    });
    await app.close();
  });

  it("ignores client-supplied id and updatedAt", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { id: "client", updatedAt: "1900-01-01T00:00:00.000Z", model: "saved" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe("provider");
    expect(response.json().updatedAt).not.toBe("1900-01-01T00:00:00.000Z");
    expect(response.json().model).toBe("saved");
    await app.close();
  });

  it("preserves malformed nested-value failure without changing storage", async () => {
    const app = buildApp();
    const seeded = await app.inject({ method: "PUT", url: "/api/provider", payload: { model: "retained" } });
    const response = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { model: "must not persist", samplers: { stopStrings: null } },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ statusCode: 500, error: "Internal Server Error", message: expect.any(String) });
    expect((await app.inject({ method: "GET", url: "/api/provider" })).json()).toEqual(seeded.json());
    await app.close();
  });
});
