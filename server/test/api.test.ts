import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { systemRuntime } from "../src/runtime.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";

useTmpDataDir();

let provider: FakeProvider | null = null;

afterEach(async () => {
  if (provider) {
    await provider.close();
    provider = null;
  }
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  delete process.env.FEATURE_RPG_STUDIO;
  delete process.env.FEATURE_REMOTE_AUTHENTICATION;
});

const validCharacter = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional adults only",
    fictionalConfirmed: true,
};

async function createCharacter(app: ReturnType<typeof buildApp>) {
  const res = await app.inject({ method: "POST", url: "/api/characters", payload: validCharacter });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

describe("api", () => {
  it("keeps caller-controlled values out of production request logs", async () => {
    const requestIdSecret = "slice82-request-id-secret-51ac83";
    const querySecret = "slice82-query-secret-7f41b9";
    const authorizationSecret = "slice82-auth-secret-29da64";
    const customHeaderSecret = "slice82-custom-secret-e093d2";
    let logged = "";
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) {
        logged += chunk.toString();
        callback();
      },
    });
    process.env.NODE_ENV = "production";
    const app = buildApp({ loggerStream });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/health?token=${querySecret}`,
        headers: {
          "x-request-id": requestIdSecret,
          authorization: `Bearer ${authorizationSecret}`,
          "x-private": customHeaderSecret,
        },
      });
      expect(response.headers["x-request-id"]).toBe(requestIdSecret);
    } finally {
      await app.close();
      process.env.NODE_ENV = "test";
    }

    expect(logged).toContain('"method":"GET"');
    expect(logged).not.toContain('"path"');
    expect(logged).not.toContain(requestIdSecret);
    expect(logged).not.toContain(querySecret);
    expect(logged).not.toContain(authorizationSecret);
    expect(logged).not.toContain(customHeaderSecret);
    expect(logged).not.toContain("authorization");
  });

  it("never retains concrete campaign resources in production automatic request logs", async () => {
    process.env.NODE_ENV = "production";
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const markers = {
      valid: "slice85-valid-resource-1b29d0",
      invalid: "slice85-invalid-resource-7c410a",
      malformed: "slice85-malformed-resource-4e620b",
      unsupported: "slice85-unsupported-resource-9a351c",
    };
    let logged = "";
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) { logged += chunk.toString(); callback(); },
    });
    const app = buildApp({ loggerStream });
    try {
      await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${markers.valid}` });
      await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${markers.invalid}%20invalid` });
      await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/%zz-${markers.malformed}` });
      await app.inject({ method: "DELETE", url: `/api/rpg/v1/campaigns/${markers.unsupported}/characters` });
    } finally {
      await app.close();
      process.env.NODE_ENV = "test";
    }
    expect(logged).toContain('"method":"GET"');
    for (const marker of Object.values(markers)) expect(logged).not.toContain(marker);
  });

  it("serves health and features", async () => {
    const app = buildApp();
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json()).toEqual({ ok: true });
    const features = await app.inject({ method: "GET", url: "/api/features" });
    expect(features.json()).toEqual({ voice: false, images: false });
    expect(features.headers["x-request-id"]).toBeTruthy();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/api/health" })).statusCode).toBe(404);
    await app.close();
  });

  it("validates request IDs and keeps them out of legacy response bodies", async () => {
    const generatedIds = ["generated-1", "generated-2"];
    const app = buildApp({
      runtime: {
        ...systemRuntime,
        ids: { nextId: () => generatedIds.shift() ?? "generated-fallback" },
      },
    });
    const accepted = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "caller-1" } });
    expect(accepted.headers["x-request-id"]).toBe("caller-1");
    expect(accepted.json()).toEqual({ ok: true });
    const replaced = await app.inject({ method: "GET", url: "/api/health", headers: { "x-request-id": "unsafe request id" } });
    expect(replaced.headers["x-request-id"]).toBe("generated-1");
    expect(replaced.json()).toEqual({ ok: true });
    await app.close();
  });

  it("exposes opt-in RPG flags and structured problems only under the RPG boundary", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "TRUE";
    const app = buildApp();
    const features = await app.inject({ method: "GET", url: "/api/rpg/v1/features", headers: { "x-request-id": "rpg-request" } });
    expect(features.json()).toEqual({
      campaign: true,
      mechanics: false,
      combat: false,
      studio: false,
      remoteAuthentication: false,
    });
    const missing = await app.inject({ method: "GET", url: "/api/rpg/v1/not-implemented", headers: { "x-request-id": "rpg-request" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
    expect(missing.json()).toMatchObject({
      status: 404,
      code: "RPG_ROUTE_NOT_FOUND",
      requestId: "rpg-request",
      error: "RPG route not found",
    });
    const legacyMissing = await app.inject({ method: "GET", url: "/api/not-implemented" });
    expect(legacyMissing.json()).not.toHaveProperty("code");
    await app.close();
  });

  it("preserves default legacy 404 shape without reflecting query values", async () => {
    const app = buildApp();
    const secret = "default-not-found-secret";
    for (const [method, path] of [
      ["GET", "/not-implemented"],
      ["POST", "/api/not-implemented"],
      ["TRACE", "/unknown/lookalike"],
    ] as const) {
      // light-my-request accepts TRACE although its InjectOptions union omits it.
      const response = await app.inject({ method: method as never, url: `${path}?token=${secret}` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        message: `Route ${method}:${path} not found`,
        error: "Not Found",
        statusCode: 404,
      });
      expect(response.body).not.toContain(secret);
    }
    await app.close();
  });

  it("uses the current deliberately permissive character policy", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/api/characters", payload: { ...validCharacter, age: 16 } });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("rejects non-fictional characters with 422", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/characters",
      payload: { ...validCharacter, fictionalConfirmed: false },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("uses the current deliberately permissive message policy", async () => {
    const app = buildApp();
    const character = await createCharacter(app);
    const sessionRes = await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: character.id } });
    const session = sessionRes.json() as { id: string };
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "imagine a high school setting" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("runs a full scene against a fake provider and stops cleanly", async () => {
    provider = await startFakeProvider("The captain smiles and pours two glasses of sparkling water.");
    const app = buildApp();

    const providerRes = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { baseUrl: provider.baseUrl, model: "fake-model", apiKey: "test-key", pricing: { promptPerMillion: 2, completionPerMillion: 8 } },
    });
    expect(providerRes.statusCode).toBe(200);
    expect(providerRes.json().hasApiKey).toBe(true);
    expect(JSON.stringify(providerRes.json())).not.toContain("test-key");

    const character = await createCharacter(app);
    const sessionRes = await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: character.id } });
    const session = sessionRes.json() as { id: string; state: string };
    expect(session.state).toBe("setup");

    const msgRes = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "remember that I prefer quiet evenings; we meet at the observation deck" },
    });
    expect(msgRes.statusCode).toBe(200);
    const body = msgRes.json() as {
      reply: { content: string };
      state: string;
      providerError: boolean;
      messages: Array<{ role: string }>;
    };
    expect(body.providerError).toBe(false);
    expect(body.reply.content).toContain("sparkling water");
    expect(body.state).toBe("active");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.lastUserContent).toContain("observation deck");
    expect(provider.requests[0]?.systemContent).toContain("I prefer quiet evenings");
    const usageResponse = await app.inject({ method: "GET", url: "/api/usage" });
    expect(usageResponse.statusCode).toBe(200);
    const usage = usageResponse.json().usage as { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; providerMeasuredTokens: number; estimatedTokens: number; estimatedCostUsd: number; byKind: Array<{ kind: string }> };
    expect(usage.calls).toBe(1);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
    expect(usage.providerMeasuredTokens).toBe(usage.totalTokens);
    expect(usage.estimatedTokens).toBe(0);
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(usage.byKind.map((entry) => entry.kind)).toContain("character_reply");

    const memoriesRes = await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` });
    const memories = (memoriesRes.json() as { memories: Array<{ content: string; userApproved: boolean }> }).memories;
    expect(memories.some((m) => m.content.includes("quiet evenings"))).toBe(true);
    expect(memories.find((m) => m.content.includes("quiet evenings"))?.userApproved).toBe(true);

    const stopRes = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    expect(stopRes.statusCode).toBe(200);
    expect(stopRes.json().state).toBe("closed");
    const stoppedSession = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(stopRes.json()).toEqual(stoppedSession.json().session);
    expect(stopRes.json().consentLog.at(-1)).toMatchObject({
      scope: "user-stop",
      granted: false,
      note: "User pressed stop; scene closed.",
    });

    const afterStop = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "are you still there?" },
    });
    expect(afterStop.statusCode).toBe(409);
    await app.close();
  });

});
