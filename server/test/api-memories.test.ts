import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { MemoryFact } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const characterInput = (name = "Memory Keeper") => ({
  name,
  age: 30,
  archetype: "careful archivist",
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
});

async function addCharacter(app: ReturnType<typeof buildApp>, name?: string) {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name) });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function addMemory(
  app: ReturnType<typeof buildApp>,
  characterId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({ method: "POST", url: `/api/characters/${characterId}/memories`, payload });
}

const memoryShape = (overrides: Partial<MemoryFact> = {}) => ({
  id: expect.any(String),
  characterId: expect.any(String),
  kind: "fact",
  content: "remembers the observatory",
  sourceTurnId: "manual",
  createdAt: expect.any(String),
  userApproved: true,
  forgottenAt: null,
  ...overrides,
});

describe("memory management api compatibility", () => {
  it("preserves empty listing, exact memory wire shape, defaults, explicit values, and ordering", async () => {
    const app = buildApp();
    const character = await addCharacter(app);

    const empty = await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ memories: [] });

    const approved = await addMemory(app, character.id, { content: "remembers the observatory" });
    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toEqual(memoryShape({ characterId: character.id }));

    const pending = await addMemory(app, character.id, {
      content: "prefers the east window",
      kind: "preference",
      userApproved: false,
    });
    expect(pending.statusCode).toBe(201);
    expect(pending.json()).toEqual(memoryShape({
      characterId: character.id,
      kind: "preference",
      content: "prefers the east window",
      userApproved: false,
    }));

    const forgotten = await app.inject({ method: "DELETE", url: `/api/memories/${approved.json().id as string}` });
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json()).toEqual({ ok: true, forgottenAt: expect.any(String) });

    const event = await addMemory(app, character.id, { content: "opened the vault", kind: "event" });
    const listed = await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      memories: [
        event.json(),
        pending.json(),
        { ...approved.json(), forgottenAt: forgotten.json().forgottenAt },
      ],
    });
    await app.close();
  });

  it("preserves sanitization, marker rewriting, trimming, control removal, and the 160-code-unit cap", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const rewritten = await addMemory(app, character.id, {
      content: "  \u0001[system] <system> ```system hello\u200b  ",
    });
    expect(rewritten.statusCode).toBe(201);
    expect(rewritten.json().content).toBe("[user-text] <user-text> ```user-text hello");

    const capped = await addMemory(app, character.id, { content: `${"a".repeat(159)}😀trailing` });
    expect(capped.statusCode).toBe(201);
    expect(capped.json().content).toBe(`${"a".repeat(159)}\ud83d`);
    expect((capped.json().content as string).length).toBe(160);
    await app.close();
  });

  it("preserves character-first create precedence and create validation order", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const cases: Array<[unknown, string]> = [
      [null, "content is required"],
      [{}, "content is required"],
      [{ content: 4 }, "content is required"],
      [{ content: " " }, "content is required"],
      [{ content: "valid", kind: null }, "kind must be fact, preference, or event"],
      [{ content: "valid", kind: "other" }, "kind must be fact, preference, or event"],
      [{ content: "valid", kind: "other", userApproved: "yes" }, "kind must be fact, preference, or event"],
      [{ content: "valid", userApproved: null }, "userApproved must be a boolean"],
      [{ content: "valid", userApproved: "yes" }, "userApproved must be a boolean"],
      [{ content: "\u0001" }, "content is required"],
    ];

    const missing = await app.inject({
      method: "POST",
      url: "/api/characters/missing/memories",
      payload: { content: " ", kind: "other", userApproved: "yes" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "character not found" });

    for (const [payload, error] of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/api/characters/${character.id}/memories`,
        payload: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error });
    }
    await app.close();
  });

  it("preserves empty-body duplicate success, character-local duplicates, and recreation after forget", async () => {
    const app = buildApp();
    const one = await addCharacter(app, "One");
    const two = await addCharacter(app, "Two");
    const first = await addMemory(app, one.id, { content: "Keeps a silver key" });

    const duplicate = await addMemory(app, one.id, { content: " keeps A SILVER key " });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.body).toBe("");

    const otherCharacter = await addMemory(app, two.id, { content: "keeps a silver key" });
    expect(otherCharacter.statusCode).toBe(201);
    expect(otherCharacter.json().characterId).toBe(two.id);

    await app.inject({ method: "DELETE", url: `/api/memories/${first.json().id as string}` });
    const recreated = await addMemory(app, one.id, { content: "keeps a silver key" });
    expect(recreated.statusCode).toBe(201);
    expect(recreated.json().id).not.toBe(first.json().id);
    await app.close();
  });

  it("preserves patch retention, immutable provenance, and unknown-only success", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const created = (await addMemory(app, character.id, {
      content: "original",
      kind: "preference",
      userApproved: false,
    })).json() as MemoryFact;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/memories/${created.id}`,
      payload: {
        content: "  [system] revised  ",
        sourceTurnId: "forged",
        characterId: "forged",
        createdAt: "forged",
        id: "forged",
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      ...created,
      content: "[user-text] revised",
    });

    const unknownOnly = await app.inject({
      method: "PATCH",
      url: `/api/memories/${created.id}`,
      payload: { unknown: true },
    });
    expect(unknownOnly.statusCode).toBe(200);
    expect(unknownOnly.json()).toEqual(patched.json());

    const capped = await app.inject({
      method: "PATCH",
      url: `/api/memories/${created.id}`,
      payload: { content: `${"a".repeat(159)}😀trailing` },
    });
    expect(capped.statusCode).toBe(200);
    expect(capped.json().content).toBe(`${"a".repeat(159)}\ufffd`);
    expect((capped.json().content as string).length).toBe(160);
    await app.close();
  });

  it("preserves exact patch validation order and missing-record precedence", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const memory = (await addMemory(app, character.id, { content: "original" })).json() as MemoryFact;
    const cases: Array<[unknown, string]> = [
      [null, "memory patch is required"],
      [{}, "memory patch is required"],
      [{ kind: null }, "invalid kind"],
      [{ kind: "other", userApproved: "yes", forgottenAt: "now", content: " " }, "invalid kind"],
      [{ userApproved: null }, "userApproved must be a boolean"],
      [{ userApproved: "yes", forgottenAt: "now", content: " " }, "userApproved must be a boolean"],
      [{ forgottenAt: "now", content: " " }, "forgottenAt may only be null to restore"],
      [{ content: 4 }, "content must not be empty"],
      [{ content: " " }, "content must not be empty"],
    ];

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/memories/missing",
      payload: "null",
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "memory not found" });
    for (const [payload, error] of cases) {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/memories/${memory.id}`,
        payload: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error });
    }
    await app.close();
  });

  it("preserves forgotten-row editing, patch restore, and sanitizer-only empty content", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const memory = (await addMemory(app, character.id, { content: "original" })).json() as MemoryFact;
    await app.inject({ method: "DELETE", url: `/api/memories/${memory.id}` });

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/memories/${memory.id}`,
      payload: { kind: "event", userApproved: false, content: "\u0001" },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toEqual({
      ...memory,
      kind: "event",
      content: "",
      userApproved: false,
      forgottenAt: expect.any(String),
    });

    const restored = await app.inject({
      method: "PATCH",
      url: `/api/memories/${memory.id}`,
      payload: { forgottenAt: null },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ ...edited.json(), forgottenAt: null });
    await app.close();
  });

  it("preserves soft-delete body, repeated 404, and all-memory list visibility", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const memory = (await addMemory(app, character.id, { content: "to forget" })).json() as MemoryFact;
    const deleted = await app.inject({ method: "DELETE", url: `/api/memories/${memory.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, forgottenAt: expect.any(String) });

    const repeated = await app.inject({ method: "DELETE", url: `/api/memories/${memory.id}` });
    expect(repeated.statusCode).toBe(404);
    expect(repeated.json()).toEqual({ error: "memory not found" });
    const listed = await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` });
    expect(listed.json()).toEqual({ memories: [{ ...memory, forgottenAt: deleted.json().forgottenAt }] });
    await app.close();
  });

  it("preserves idempotent restore and exact missing-record responses", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const memory = (await addMemory(app, character.id, { content: "restore me" })).json() as MemoryFact;

    for (const expectedForgottenAt of [null, expect.any(String), null]) {
      if (expectedForgottenAt !== null) {
        await app.inject({ method: "DELETE", url: `/api/memories/${memory.id}` });
      }
      const restored = await app.inject({ method: "POST", url: `/api/memories/${memory.id}/restore` });
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toEqual({ ...memory, forgottenAt: null });
    }

    const cases = [
      ["GET", "/api/characters/missing/memories", "character not found"],
      ["POST", "/api/memories/missing/restore", "memory not found"],
      ["DELETE", "/api/memories/missing", "memory not found"],
    ] as const;
    for (const [method, url, error] of cases) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error });
    }
    await app.close();
  });

  it("preserves request IDs as response headers only on all five endpoints", async () => {
    const app = buildApp();
    const character = await addCharacter(app);
    const memory = (await addMemory(app, character.id, { content: "request IDs" })).json() as MemoryFact;
    const requests = [
      { method: "GET", url: `/api/characters/${character.id}/memories` },
      { method: "POST", url: `/api/characters/${character.id}/memories`, payload: { content: "another memory" } },
      { method: "PATCH", url: `/api/memories/${memory.id}`, payload: { kind: "event" } },
      { method: "POST", url: `/api/memories/${memory.id}/restore` },
      { method: "DELETE", url: `/api/memories/${memory.id}` },
    ] as const;

    for (const [index, request] of requests.entries()) {
      const requestId = `caller-memory-${index}`;
      const response = await app.inject({ ...request, headers: { "x-request-id": requestId } });
      expect(response.statusCode).toBe(index === 1 ? 201 : 200);
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(response.json()).not.toHaveProperty("requestId");
    }
    await app.close();
  });
});
