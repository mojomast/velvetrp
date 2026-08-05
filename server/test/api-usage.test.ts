import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { addMessage, createCharacter, createSession, recordUsageEvent } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const characterInput = {
  name: "Usage Character",
  age: 29,
  archetype: "archivist",
  boundaries: "fictional only",
    fictionalConfirmed: true,
};

describe("usage api compatibility", () => {
  it("is registered exactly once under the /api prefix", async () => {
    const app = buildApp();
    for (const url of ["/usage", "/api/api/usage"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it("returns the exact empty ledger with request ID only in the header", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/usage",
      headers: { "x-request-id": "usage-characterization" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("usage-characterization");
    expect(response.json()).toEqual({
      usage: {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        providerMeasuredTokens: 0,
        estimatedTokens: 0,
        estimatedCostUsd: null,
        pricing: { promptPerMillion: null, completionPerMillion: null },
        byKind: [],
        byModel: [],
        bySession: [],
      },
    });
    expect(response.json()).not.toHaveProperty("requestId");
    await app.close();
  });

  it("uses current pricing and preserves exact grouping and descending token order", async () => {
    const app = buildApp();
    const firstCharacter = await createCharacter({ ...characterInput, name: "First" });
    const secondCharacter = await createCharacter({ ...characterInput, name: "Second" });
    const first = await createSession({ characterId: firstCharacter.id, title: "First session" });
    const second = await createSession({ characterId: secondCharacter.id, title: "Second session" });
    await addMessage(first.id, "character", "Measured", {
      speakerCharacterId: firstCharacter.id,
      usage: { promptTokens: 16, completionTokens: 4, totalTokens: 20, source: "provider", model: "model-b" },
    });
    await recordUsageEvent(first.id, "scene_synthesis", {
      promptTokens: 4, completionTokens: 1, totalTokens: 5, source: "estimated", model: "model-a",
    });
    await recordUsageEvent(second.id, "room_routing", {
      promptTokens: 24, completionTokens: 6, totalTokens: 30, source: "estimated", model: "model-a",
    });

    const unpriced = await app.inject({ method: "GET", url: "/api/usage" });
    expect(unpriced.json().usage.estimatedCostUsd).toBeNull();
    const provider = await app.inject({
      method: "PUT",
      url: "/api/provider",
      payload: { pricing: { promptPerMillion: 2, completionPerMillion: 8 } },
    });
    expect(provider.statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/api/usage" });
    const usage = response.json().usage;

    expect(response.statusCode).toBe(200);
    expect(usage).toMatchObject({
      calls: 3,
      promptTokens: 44,
      completionTokens: 11,
      totalTokens: 55,
      providerMeasuredTokens: 20,
      estimatedTokens: 35,
      estimatedCostUsd: 0.000176,
      pricing: { promptPerMillion: 2, completionPerMillion: 8 },
    });
    expect(usage.byKind).toEqual([
      { kind: "room_routing", calls: 1, promptTokens: 24, completionTokens: 6, totalTokens: 30, estimatedCostUsd: 0.000096 },
      { kind: "character_reply", calls: 1, promptTokens: 16, completionTokens: 4, totalTokens: 20, estimatedCostUsd: 0.000064 },
      { kind: "scene_synthesis", calls: 1, promptTokens: 4, completionTokens: 1, totalTokens: 5, estimatedCostUsd: 0.000016 },
    ]);
    expect(usage.byModel).toEqual([
      { model: "model-a", calls: 2, promptTokens: 28, completionTokens: 7, totalTokens: 35, estimatedCostUsd: 0.000112 },
      { model: "model-b", calls: 1, promptTokens: 16, completionTokens: 4, totalTokens: 20, estimatedCostUsd: 0.000064 },
    ]);
    expect(usage.bySession).toEqual([
      { sessionId: second.id, title: "Second session", calls: 1, promptTokens: 24, completionTokens: 6, totalTokens: 30, estimatedCostUsd: 0.000096 },
      { sessionId: first.id, title: "First session", calls: 2, promptTokens: 20, completionTokens: 5, totalTokens: 25, estimatedCostUsd: 0.00008 },
    ]);
    await app.close();
  });
});
