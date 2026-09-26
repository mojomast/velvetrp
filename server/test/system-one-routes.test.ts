import DatabaseDriver from "better-sqlite3";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { defaultSystemOneLaneModes } from "../src/defaults.js";
import { SYSTEM_ONE_LANES, type SystemOneLane, type SystemOneLaneMode } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

function laneMap(mode: SystemOneLaneMode): Record<SystemOneLane, SystemOneLaneMode> {
  return Object.fromEntries(SYSTEM_ONE_LANES.map((lane) => [lane, mode])) as Record<SystemOneLane, SystemOneLaneMode>;
}

process.env.NODE_ENV = "test";
useTmpDataDir();

let server: Server | null = null;
const savedBaseUrl = process.env.TYPESAFE_BASE_URL;
const savedApiKey = process.env.TYPESAFE_API_KEY;

async function startServer(body: unknown): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "x-typesafe-request-id": "req_route" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

beforeEach(() => {
  delete process.env.TYPESAFE_BASE_URL;
  delete process.env.TYPESAFE_API_KEY;
});

afterEach(async () => {
  if (savedBaseUrl === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = savedBaseUrl;
  if (savedApiKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = savedApiKey;
  if (server) { await new Promise<void>((resolve) => server?.close(() => resolve())); server = null; }
});

describe("System One provider api", () => {
  it("is registered exactly once under the /api prefix", async () => {
    const app = buildApp();
    for (const url of ["/provider/system-one", "/api/api/provider/system-one"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
      expect((await app.inject({ method: "PUT", url, payload: {} })).statusCode).toBe(404);
    }
    await app.close();
  });

  it("returns the public shape with the key redacted and lane modes defaulting to shadow", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/provider/system-one" });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(Object.keys(body)).toEqual([
      "id", "providerType", "enabled", "laneModes", "shadowAdventurePayload", "baseUrl", "model", "hasApiKey", "requestTimeoutSeconds",
      "pricing", "budget", "confidencePolicy", "confidenceCalibration", "updatedAt",
    ]);
    expect(body.id).toBe("system-one");
    expect(body.enabled).toBe(false);
    expect(Object.keys(body.laneModes)).toEqual([...SYSTEM_ONE_LANES]);
    expect(Object.values(body.laneModes)).toEqual(SYSTEM_ONE_LANES.map(() => "shadow"));
    expect(body.laneModes).toEqual(defaultSystemOneLaneModes());
    expect(body.hasApiKey).toBe(false);
    expect(body.baseUrl).toBe("https://api.typesafe.ai/v1");
    expect(body.model).toBe("jev-latest");
    expect(body.pricing).toEqual({ promptPerMillion: 0.042, completionPerMillion: 0 });
    expect(Object.keys(body.confidencePolicy)).toEqual([...SYSTEM_ONE_LANES]);
    expect(Object.keys(body.confidenceCalibration)).toEqual(Object.keys(body.confidencePolicy));
    expect(body.confidenceCalibration["director-selection"]).toEqual({ a: 1, b: 0 });
    expect(body).not.toHaveProperty("apiKey");
    await app.close();
  });

  it("migrates a legacy global shadow boolean into per-lane modes", async () => {
    const app = buildApp();
    const dbPath = path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
    const writeLegacyRow = (payload: unknown) => {
      const db = new DatabaseDriver(dbPath);
      db.prepare(
        "INSERT INTO provider (id, payload) VALUES ('system-one', ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
      ).run(JSON.stringify(payload));
      db.close();
    };

    // No persisted row: a fresh install records every lane.
    const fresh = (await app.inject({ method: "GET", url: "/api/provider/system-one" })).json();
    expect(fresh.laneModes).toEqual(defaultSystemOneLaneModes());
    expect(fresh.laneModes).toEqual(laneMap("shadow"));

    // Legacy `shadow: false` meant "may act"; every lane migrates to active.
    writeLegacyRow({ enabled: true, shadow: false });
    const acting = (await app.inject({ method: "GET", url: "/api/provider/system-one" })).json();
    expect(acting.laneModes).toEqual(laneMap("active"));

    // Legacy `shadow: true` meant "record only"; every lane migrates to shadow.
    writeLegacyRow({ enabled: true, shadow: true });
    const recording = (await app.inject({ method: "GET", url: "/api/provider/system-one" })).json();
    expect(recording.laneModes).toEqual(laneMap("shadow"));

    await app.close();
  });

  it("persists and clamps settings while keeping the key private", async () => {
    const app = buildApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/provider/system-one",
      payload: {
        enabled: true,
        model: "jev-1.13.0",
        apiKey: "top-secret",
        requestTimeoutSeconds: 999,
        pricing: { promptPerMillion: 1 },
        budget: { maxTotalTokens: 5, rateWindowMs: 10 },
        confidencePolicy: { guardrails: { actionThreshold: 0.9, reviewThreshold: 0.95 } },
        confidenceCalibration: { "director-selection": { a: 2.5, b: 3.3 } },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      enabled: true,
      model: "jev-1.13.0",
      hasApiKey: true,
      requestTimeoutSeconds: 120,
      budget: { maxTotalTokens: 5, rateWindowMs: 1_000 },
      confidencePolicy: { guardrails: { actionThreshold: 0.9, reviewThreshold: 0.9 } },
      confidenceCalibration: { "director-selection": { a: 2.5, b: 3.3 } },
    });
    expect(JSON.stringify(put.json())).not.toMatch(/top-secret/);
    await app.close();
  });

  it("rejects invalid patches", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "PUT", url: "/api/provider/system-one", payload: [] })).statusCode).toBe(400);
    const badUrl = await app.inject({ method: "PUT", url: "/api/provider/system-one", payload: { baseUrl: "http://api.typesafe.ai/v1" } });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json()).toMatchObject({ error: "invalid baseUrl" });
    await app.close();
  });

  it("runs a live capability probe only on explicit empty no-store POST", async () => {
    process.env.TYPESAFE_BASE_URL = await startServer({
      model: "jev-1.13.0",
      answers: { reachable: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    process.env.TYPESAFE_API_KEY = "route-secret";
    const app = buildApp();

    expect((await app.inject({ method: "GET", url: "/api/provider/system-one/preflight" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/provider/system-one/preflight", payload: {}, headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/provider/system-one/preflight?probe=1", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/provider/system-one/preflight", headers: { "content-type": "application/json" }, payload: { extra: true } })).statusCode).toBe(400);

    const response = await app.inject({ method: "POST", url: "/api/provider/system-one/preflight", headers: { "content-type": "application/json" }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ enabled: false, configured: true, ok: true, model: "jev-1.13.0", requestId: "req_route" });
    expect(JSON.stringify(response.json())).not.toMatch(/route-secret|authorization|bearer/i);
    await app.close();
  });

  it("reports a classified failure without leaking when the endpoint is unreachable", async () => {
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:1";
    process.env.TYPESAFE_API_KEY = "route-secret";
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/provider/system-one/preflight", headers: { "content-type": "application/json" }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, failure: { kind: "transport" } });
    await app.close();
  });
});
