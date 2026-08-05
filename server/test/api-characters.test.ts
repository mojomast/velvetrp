import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { systemRuntime } from "../src/runtime.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const characterInput = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
};

describe("character api compatibility", () => {
  it("preserves exact create, list, get, update, export, import, and delete responses", async () => {
    const app = buildApp();

    const empty = await app.inject({ method: "GET", url: "/api/characters" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ characters: [] });

    const createdResponse = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json() as Record<string, unknown>;
    expect(created).toEqual({
      id: expect.any(String),
      ...characterInput,
      isRealPerson: false,
      createdAt: expect.any(String),
    });

    const listed = await app.inject({ method: "GET", url: "/api/characters" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ characters: [created] });

    const detail = await app.inject({ method: "GET", url: `/api/characters/${created.id as string}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(created);

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/characters/${created.id as string}`,
      payload: { name: "Captain Aria", age: 30 },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = { ...created, name: "Captain Aria", age: 30 };
    expect(updatedResponse.json()).toEqual(updated);

    const exported = await app.inject({ method: "GET", url: `/api/characters/${created.id as string}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toEqual({
      formatVersion: "velvet-character@1",
      character: {
        name: "Captain Aria",
        age: 30,
        archetype: characterInput.archetype,
        boundaries: characterInput.boundaries,
        safeWord: characterInput.safeWord,
        fictionalConfirmed: true,
      },
    });

    const importedResponse = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: exported.json(),
    });
    expect(importedResponse.statusCode).toBe(201);
    const imported = importedResponse.json() as Record<string, unknown>;
    expect(imported).toEqual({
      id: expect.any(String),
      name: "Captain Aria",
      age: 30,
      archetype: characterInput.archetype,
      boundaries: characterInput.boundaries,
      safeWord: characterInput.safeWord,
      fictionalConfirmed: true,
      isRealPerson: false,
      createdAt: expect.any(String),
    });
    expect(imported.id).not.toBe(created.id);

    const directImport = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: { ...characterInput, name: "Direct import" },
    });
    expect(directImport.statusCode).toBe(201);
    expect(directImport.json()).toEqual({
      id: expect.any(String),
      ...characterInput,
      name: "Direct import",
      isRealPerson: false,
      createdAt: expect.any(String),
    });

    const deleted = await app.inject({ method: "DELETE", url: `/api/characters/${created.id as string}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    await app.close();
  });

  it.each([
    [{ ...characterInput, name: "" }, "name is required"],
    [{ ...characterInput, age: 29.5 }, "age must be an integer"],
    [{ ...characterInput, archetype: "" }, "archetype is required"],
    [{ ...characterInput, boundaries: "" }, "boundaries are required"],
    [{ ...characterInput, safeWord: "" }, "safeWord is required"],
    [{ ...characterInput, fictionalConfirmed: false }, "fictionalConfirmed must be true"],
  ])("preserves create validation for %#", async (payload, message) => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/characters", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: message });
    await app.close();
  });

  it("preserves patch and import validation responses", async () => {
    const app = buildApp();
    const created = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput })).json() as { id: string };

    const missingPatch = await app.inject({ method: "PATCH", url: `/api/characters/${created.id}` });
    expect(missingPatch.statusCode).toBe(400);
    expect(missingPatch.json()).toEqual({ error: "character patch is required" });

    const invalidPatch = await app.inject({ method: "PATCH", url: `/api/characters/${created.id}`, payload: { age: "29" } });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json()).toEqual({ error: "age must be an integer" });

    const invalidImport = await app.inject({ method: "POST", url: "/api/characters/import", payload: { character: { ...characterInput, safeWord: null } } });
    expect(invalidImport.statusCode).toBe(400);
    expect(invalidImport.json()).toEqual({ error: "safeWord is required" });
    await app.close();
  });

  it("preserves missing-character responses for every ID route", async () => {
    const app = buildApp();
    for (const request of [
      { method: "GET", url: "/api/characters/missing" },
      { method: "PATCH", url: "/api/characters/missing", payload: { name: "No one" } },
      { method: "DELETE", url: "/api/characters/missing" },
      { method: "GET", url: "/api/characters/missing/export" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "character not found" });
    }
    await app.close();
  });

  it("preserves guarded deletion and allows deletion after session removal", async () => {
    const app = buildApp();
    const character = (await app.inject({ method: "POST", url: "/api/characters", payload: characterInput })).json() as { id: string };
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: character.id } })).json() as { id: string };

    const guarded = await app.inject({ method: "DELETE", url: `/api/characters/${character.id}` });
    expect(guarded.statusCode).toBe(409);
    expect(guarded.json()).toEqual({ error: "character is used by a session; delete the session history first" });

    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` })).json()).toEqual({ ok: true });
    const deleted = await app.inject({ method: "DELETE", url: `/api/characters/${character.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    await app.close();
  });

  it("preserves request ID headers without changing legacy character bodies", async () => {
    const app = buildApp({
      runtime: {
        ...systemRuntime,
        ids: { nextId: () => "generated-character-request" },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/characters",
      headers: { "x-request-id": "caller-character-request" },
    });
    expect(response.headers["x-request-id"]).toBe("caller-character-request");
    expect(response.json()).toEqual({ characters: [] });
    expect(response.json()).not.toHaveProperty("requestId");
    await app.close();
  });

  it("uses buildApp runtime only for request IDs, not character provenance", async () => {
    const nextId = vi.fn(() => "factory-request-id");
    const clockNow = vi.fn(() => new Date("2040-01-02T03:04:05.006Z"));
    const integer = vi.fn(() => 7);
    const app = buildApp({
      runtime: {
        ids: { nextId },
        clock: { now: clockNow },
        rng: { integer },
      },
    });

    const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput });
    const created = response.json() as { id: string; createdAt: string };
    expect(response.statusCode).toBe(201);
    expect(response.headers["x-request-id"]).toBe("factory-request-id");
    expect(created.id).not.toBe("factory-request-id");
    expect(created.createdAt).not.toBe("2040-01-02T03:04:05.006Z");
    expect(nextId).toHaveBeenCalledOnce();
    expect(clockNow).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();

    const listed = await app.inject({
      method: "GET",
      url: "/api/characters",
      headers: { "x-request-id": "list-request-id" },
    });
    expect(listed.json()).toEqual({ characters: [created] });
    await app.close();
  });
});
