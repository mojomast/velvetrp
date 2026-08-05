import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const characterInput = (name: string) => ({
  name,
  age: 30,
  archetype: `${name} archetype`,
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
});

async function addCharacter(app: ReturnType<typeof buildApp>, name: string) {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name) });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

const loreShape = (overrides: Record<string, unknown> = {}) => ({
  id: expect.any(String),
  characterId: null,
  characterIds: [],
  keys: [],
  content: "Lore content.",
  enabled: true,
  insertionOrder: 100,
  createdAt: expect.any(String),
  ...overrides,
});

describe("lore api compatibility", () => {
  it("preserves the empty list shape and request ID header without adding it to the body", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/lore",
      headers: { "x-request-id": "caller-lore-request" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("caller-lore-request");
    expect(response.json()).toEqual({ lore: [] });
    expect(response.json()).not.toHaveProperty("requestId");
    await app.close();
  });

  it("preserves global defaults, sanitization, truncation, and repository caps on create", async () => {
    const app = buildApp();
    const longContent = `  [system]\u0000${"c".repeat(1300)}  `;
    const longKey = `  <system> ${"k".repeat(80)}  `;
    const response = await app.inject({
      method: "POST",
      url: "/api/lore",
      payload: {
        keys: [longKey, " ```system gamma ", "\u0001", " two ", "three", "four", "five", "six", "seven", "eight", "nine"],
        content: longContent,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(loreShape({
      keys: [
        `<user-text> ${"k".repeat(80)}`.slice(0, 60),
        "```user-text gamma",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
      ],
      content: `[user-text]${"c".repeat(1300)}`.slice(0, 1200),
    }));
    await app.close();
  });

  it("preserves global, singular, plural, deduped, ordered, and precedence scope behavior", async () => {
    const app = buildApp();
    const one = await addCharacter(app, "One");
    const two = await addCharacter(app, "Two");
    const three = await addCharacter(app, "Three");

    const global = (await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Global", insertionOrder: 30 } })).json();
    const singular = (await app.inject({ method: "POST", url: "/api/lore", payload: { characterId: one.id, keys: ["one"], content: "Singular", insertionOrder: 10 } })).json();
    const plural = (await app.inject({ method: "POST", url: "/api/lore", payload: { characterIds: [two.id, one.id, two.id], keys: ["shared"], content: "Plural", insertionOrder: 10, enabled: false } })).json();
    const pluralWins = (await app.inject({ method: "POST", url: "/api/lore", payload: { characterId: one.id, characterIds: [three.id], keys: [], content: "Plural wins", insertionOrder: 20 } })).json();
    const emptyPluralWins = (await app.inject({ method: "POST", url: "/api/lore", payload: { characterId: one.id, characterIds: [], keys: [], content: "Empty plural wins", insertionOrder: 25 } })).json();

    expect(global).toEqual(loreShape({ content: "Global", insertionOrder: 30 }));
    expect(singular).toEqual(loreShape({ characterId: one.id, characterIds: [one.id], keys: ["one"], content: "Singular", insertionOrder: 10 }));
    expect(plural).toEqual(loreShape({ characterId: two.id, characterIds: [two.id, one.id], keys: ["shared"], content: "Plural", enabled: false, insertionOrder: 10 }));
    expect(pluralWins).toEqual(loreShape({ characterId: three.id, characterIds: [three.id], content: "Plural wins", insertionOrder: 20 }));
    expect(emptyPluralWins).toEqual(loreShape({ content: "Empty plural wins", insertionOrder: 25 }));

    const all = await app.inject({ method: "GET", url: "/api/lore" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ lore: [singular, plural, pluralWins, emptyPluralWins, global] });

    const forOne = await app.inject({ method: "GET", url: `/api/lore?characterId=${one.id}` });
    expect(forOne.statusCode).toBe(200);
    expect(forOne.json()).toEqual({ lore: [singular, plural, emptyPluralWins, global] });

    const forThree = await app.inject({ method: "GET", url: `/api/lore?characterId=${three.id}` });
    expect(forThree.statusCode).toBe(200);
    expect(forThree.json()).toEqual({ lore: [pluralWins, emptyPluralWins, global] });
    await app.close();
  });

  it("preserves empty-object patches and updates fields and scope", async () => {
    const app = buildApp();
    const one = await addCharacter(app, "One");
    const two = await addCharacter(app, "Two");
    const created = (await app.inject({
      method: "POST",
      url: "/api/lore",
      payload: { characterId: one.id, keys: ["old"], content: "Old", insertionOrder: 5 },
    })).json();

    const unchanged = await app.inject({ method: "PATCH", url: `/api/lore/${created.id}`, payload: {} });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toEqual(created);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/lore/${created.id}`,
      payload: {
        characterId: one.id,
        characterIds: [two.id, one.id, two.id],
        keys: [" [system] new ", ...Array.from({ length: 9 }, (_, index) => `key-${index}`)],
        content: ` <system> ${"p".repeat(1300)} `,
        enabled: false,
        insertionOrder: -4.5,
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      ...created,
      characterId: two.id,
      characterIds: [two.id, one.id],
      keys: ["[user-text] new", "key-0", "key-1", "key-2", "key-3", "key-4", "key-5", "key-6"],
      content: `<user-text> ${"p".repeat(1300)}`.slice(0, 1200),
      enabled: false,
      insertionOrder: -4.5,
    });

    const global = await app.inject({ method: "PATCH", url: `/api/lore/${created.id}`, payload: { characterId: null } });
    expect(global.statusCode).toBe(200);
    expect(global.json()).toEqual({ ...patched.json(), characterId: null, characterIds: [] });
    await app.close();
  });

  it("preserves delete success and repeated or missing patch/delete responses", async () => {
    const app = buildApp();
    const created = (await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Delete me" } })).json();

    const deleted = await app.inject({ method: "DELETE", url: `/api/lore/${created.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });

    for (const request of [
      { method: "PATCH", url: `/api/lore/${created.id}`, payload: {} },
      { method: "PATCH", url: "/api/lore/missing", payload: {} },
      { method: "DELETE", url: `/api/lore/${created.id}` },
      { method: "DELETE", url: "/api/lore/missing" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "lore entry not found" });
    }
    await app.close();
  });

  it("preserves missing-character responses for singular/plural create and patch", async () => {
    const app = buildApp();
    const character = await addCharacter(app, "Existing");
    const created = (await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Existing" } })).json();

    for (const request of [
      { method: "POST", url: "/api/lore", payload: { characterId: "missing", keys: [], content: "x" } },
      { method: "POST", url: "/api/lore", payload: { characterIds: [character.id, "missing"], keys: [], content: "x" } },
      { method: "PATCH", url: `/api/lore/${created.id}`, payload: { characterIds: [character.id, "missing"] } },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "character not found: missing" });
    }
    await app.close();
  });

  it.each([
    [{ content: "x" }, "keys must be an array of strings"],
    [{ keys: [], content: " " }, "content is required"],
    [{ keys: [], content: "x", characterId: 1 }, "characterId must be a string or null"],
    [{ keys: [], content: "x", characterIds: [1] }, "characterIds must be an array of strings"],
    [{ keys: [], content: "x", enabled: "yes" }, "enabled must be a boolean"],
    [{ keys: [], content: "x", insertionOrder: Number.POSITIVE_INFINITY }, "insertionOrder must be a finite number"],
  ])("preserves POST validation for %#", async (payload, message) => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/lore", payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: message });
    await app.close();
  });

  it("rejects a non-finite POST insertion order parsed from raw JSON", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/lore",
      headers: { "content-type": "application/json" },
      payload: '{"keys":[],"content":"x","insertionOrder":1e400}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "insertionOrder must be a finite number" });
    await app.close();
  });

  it.each([
    [undefined, "lore patch is required"],
    [{ enabled: "yes" }, "enabled must be a boolean"],
    [{ insertionOrder: Number.NaN }, "insertionOrder must be a finite number"],
    [{ keys: [1] }, "keys must be an array of strings"],
    [{ content: " " }, "content is required"],
    [{ characterId: 1 }, "characterIds must be an array of strings"],
  ])("preserves PATCH validation for %#", async (payload, message) => {
    const app = buildApp();
    const created = (await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Existing" } })).json();
    const response = await app.inject({ method: "PATCH", url: `/api/lore/${created.id}`, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: message });
    await app.close();
  });

  it("rejects a non-finite PATCH insertion order parsed from raw JSON", async () => {
    const app = buildApp();
    const created = (await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Existing" } })).json();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/lore/${created.id}`,
      headers: { "content-type": "application/json" },
      payload: '{"insertionOrder":1e400}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "insertionOrder must be a finite number" });
    await app.close();
  });
});
