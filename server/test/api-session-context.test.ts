import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  addMessage,
  getSessionContextSource,
  setActiveBranch,
  updateSessionSynthesizedSource,
} from "../src/repo/index.js";
import type { Character, Session, SessionContextBasket } from "../src/types.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

let provider: FakeProvider | null = null;

afterEach(async () => {
  if (provider) await provider.close();
  provider = null;
});

const characterInput = (name: string) => ({
  name,
  age: 30,
  archetype: `${name} archetype`,
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
});

async function createCharacter(app: ReturnType<typeof buildApp>, name: string): Promise<Character> {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name) });
  expect(response.statusCode).toBe(201);
  return response.json() as Character;
}

async function createSession(app: ReturnType<typeof buildApp>, participants: Character[]): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { characterIds: participants.map((participant) => participant.id) },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

async function getContext(app: ReturnType<typeof buildApp>, sessionId: string): Promise<SessionContextBasket> {
  const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` });
  expect(response.statusCode).toBe(200);
  return response.json().context as SessionContextBasket;
}

async function createLore(app: ReturnType<typeof buildApp>, payload: Record<string, unknown>): Promise<void> {
  const response = await app.inject({ method: "POST", url: "/api/lore", payload });
  expect(response.statusCode).toBe(201);
}

async function createMemory(
  app: ReturnType<typeof buildApp>,
  characterId: string,
  content: string,
  userApproved = true,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/characters/${characterId}/memories`,
    payload: { content, userApproved },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

describe("session context api characterization", () => {
  it("uses only the exact /api route, valid request ID headers, and legacy non-problem errors", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Route");
    const session = await createSession(app, [character]);

    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({
        method,
        url: `/api/sessions/${session.id}/context`,
        headers: { "x-request-id": "context-request" },
        ...(method === "PUT" ? { payload: { sourceOfTruth: "canon" } } : {}),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-request-id"]).toBe("context-request");
      expect(response.json()).not.toHaveProperty("requestId");
    }

    const invalidId = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/context`,
      headers: { "x-request-id": "not valid whitespace" },
    });
    expect(invalidId.statusCode).toBe(200);
    expect(invalidId.headers["x-request-id"]).toEqual(expect.any(String));
    expect(invalidId.headers["x-request-id"]).not.toBe("not valid whitespace");

    for (const request of [
      { method: "GET", url: `/sessions/${session.id}/context` },
      { method: "GET", url: `/api/api/sessions/${session.id}/context` },
      { method: "PUT", url: `/sessions/${session.id}/context`, payload: { sourceOfTruth: "x" } },
      { method: "PUT", url: `/api/api/sessions/${session.id}/context`, payload: { sourceOfTruth: "x" } },
    ] as const) {
      const missing = await app.inject(request);
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).not.toContain("application/problem+json");
      expect(missing.json()).not.toHaveProperty("code");
      expect(missing.json()).not.toHaveProperty("requestId");
    }
    await app.close();
  });

  it("checks session existence before GET work or PUT body validation with the exact 404", async () => {
    const app = buildApp();
    for (const request of [
      { method: "GET", url: "/api/sessions/missing/context" },
      { method: "PUT", url: "/api/sessions/missing/context" },
      { method: "PUT", url: "/api/sessions/missing/context", payload: { sourceOfTruth: 4 } },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).not.toContain("application/problem+json");
      expect(response.json()).toEqual({ error: "session not found" });
    }
    await app.close();
  });

  it("returns the exact empty context fallback and participant projection", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "Aria");
    const two = await createCharacter(app, "Bex");
    const session = await createSession(app, [two, one]);

    expect(await getContext(app, session.id)).toEqual({
      sessionId: session.id,
      state: "setup",
      sourceOfTruth: "SYNTHESIZED CURRENT SCENE FACTS:\nNo synthesized scene facts yet.",
      editableSource: "",
      sourceUpdatedAt: null,
      synthesizedSource: "",
      synthesizedUpdatedAt: null,
      participants: [
        { id: two.id, name: "Bex", archetype: "Bex archetype" },
        { id: one.id, name: "Aria", archetype: "Aria archetype" },
      ],
      recentEvents: [],
      rememberedFacts: [],
      activeLore: [],
      openThreads: [],
    });
    await app.close();
  });

  it("composes only the active real branch into events, threads, and lore triggers", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Branch Keeper");
    const session = await createSession(app, [character]);
    const root = await addMessage(session.id, "user", "We enter the atrium.");
    const inactive = await addMessage(session.id, "character", "Should we seek the inactive comet?", {
      parentId: root.id,
      speakerCharacterId: character.id,
    });
    const active = await addMessage(session.id, "character", "We follow the active lantern.", {
      parentId: root.id,
      speakerCharacterId: character.id,
      swipeGroupId: inactive.swipeGroupId,
      swipeIndex: 1,
    });
    await setActiveBranch(session.id, active.id);
    await createLore(app, { keys: ["lantern"], content: "Active lantern lore", insertionOrder: 1 });
    await createLore(app, { keys: ["comet"], content: "Inactive comet lore", insertionOrder: 2 });

    const context = await getContext(app, session.id);
    expect(context.recentEvents).toEqual([
      "User: We enter the atrium.",
      "Branch Keeper: We follow the active lantern.",
    ]);
    expect(context.openThreads).toEqual([]);
    expect(context.activeLore).toEqual(["Active lantern lore"]);
    expect(JSON.stringify(context)).not.toContain("inactive comet");
    await app.close();
  });

  it("compacts recent events and open threads at their representative limits", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Compactor");
    const session = await createSession(app, [character]);
    await addMessage(session.id, "system", "Never projected");
    for (let index = 0; index < 11; index += 1) {
      const content = index >= 6
        ? `Question ${index}? ${"x".repeat(index === 10 ? 180 : 12)}`
        : `Event ${index} **with**   spacing`;
      await addMessage(session.id, "user", content);
    }

    const context = await getContext(app, session.id);
    expect(context.recentEvents).toHaveLength(10);
    expect(context.recentEvents[0]).toBe("User: Event 1 with spacing");
    expect(context.recentEvents.at(-1)).toHaveLength(186);
    expect(context.recentEvents.at(-1)).toMatch(/…$/);
    expect(context.openThreads).toHaveLength(4);
    expect(context.openThreads.map((thread) => thread.slice(0, 10))).toEqual([
      "Question 7", "Question 8", "Question 9", "Question 1",
    ]);
    expect(context.openThreads.at(-1)).toHaveLength(140);
    expect(context.openThreads.at(-1)).toMatch(/…$/);
    await app.close();
  });

  it("selects each participant's newest three approved active memories in participant order", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "One");
    const two = await createCharacter(app, "Two");
    const session = await createSession(app, [two, one]);
    for (const character of [one, two]) {
      await createMemory(app, character.id, `${character.name} oldest`);
      const forgotten = await createMemory(app, character.id, `${character.name} forgotten`);
      await app.inject({ method: "DELETE", url: `/api/memories/${forgotten.id}` });
      await createMemory(app, character.id, `${character.name} pending`, false);
      for (let index = 1; index <= 3; index += 1) await createMemory(app, character.id, `${character.name} newest ${index}`);
    }

    expect((await getContext(app, session.id)).rememberedFacts).toEqual([
      "Two: Two newest 3", "Two: Two newest 2", "Two: Two newest 1",
      "One: One newest 3", "One: One newest 2", "One: One newest 1",
    ]);
    await app.close();
  });

  it("caps the participant-ordered memory projection at eighteen", async () => {
    const app = buildApp();
    const participants: Character[] = [];
    for (let index = 1; index <= 7; index += 1) participants.push(await createCharacter(app, `P${index}`));
    const session = await createSession(app, participants);
    for (const character of participants) {
      for (let index = 1; index <= 3; index += 1) await createMemory(app, character.id, `${character.name}-${index}`);
    }

    const facts = (await getContext(app, session.id)).rememberedFacts;
    expect(facts).toHaveLength(18);
    expect(facts.slice(0, 3)).toEqual(["P1: P1-3", "P1: P1-2", "P1: P1-1"]);
    expect(facts.slice(-3)).toEqual(["P6: P6-3", "P6: P6-2", "P6: P6-1"]);
    expect(facts.join("\n")).not.toContain("P7:");
    await app.close();
  });

  it("applies lore scope, trigger, enabled, ordering, and budget behavior at the API boundary", async () => {
    const app = buildApp();
    const active = await createCharacter(app, "Active");
    const other = await createCharacter(app, "Other");
    const session = await createSession(app, [active]);
    await addMessage(session.id, "user", "The moon gate opens.");
    await app.inject({ method: "PUT", url: "/api/harness", payload: { loreChars: 200 } });
    await createLore(app, { keys: [], content: `Global ${"g".repeat(143)}`, insertionOrder: 20 });
    await createLore(app, { characterId: active.id, keys: ["moon"], content: `Scoped ${"s".repeat(93)}`, insertionOrder: 30 });
    await createLore(app, { characterId: active.id, keys: [], content: "Scoped keyless", insertionOrder: 10 });
    await createLore(app, { keys: ["sun"], content: "Untriggered", insertionOrder: 1 });
    await createLore(app, { keys: ["moon"], content: "Disabled", enabled: false, insertionOrder: 2 });
    await createLore(app, { characterId: other.id, keys: [], content: "Unrelated scope", insertionOrder: 3 });

    const lore = (await getContext(app, session.id)).activeLore;
    expect(lore).toEqual([
      "Scoped keyless",
      `Global ${"g".repeat(143)}`,
      `Scoped ${"s".repeat(28)}…`,
    ]);
    expect(lore.join("\n")).not.toMatch(/Untriggered|Disabled|Unrelated/);
    expect(lore.reduce((sum, entry) => sum + entry.length, 0)).toBe(200);
    await app.close();
  });

  it("projects manual before synthesized source and exact repository timestamps", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Canon");
    const session = await createSession(app, [character]);
    const manual = await app.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/context`,
      payload: { sourceOfTruth: "  Manual fact  " },
    });
    expect(manual.statusCode).toBe(200);
    const manualSource = manual.json().source as { sourceOfTruth: string; updatedAt: string };
    const synthesized = await updateSessionSynthesizedSource(session.id, "Synthesized fact");

    const context = await getContext(app, session.id);
    expect(context.sourceOfTruth).toBe(
      "MANUAL CANON (highest priority):\nManual fact\n\nSYNTHESIZED CURRENT SCENE FACTS:\nSynthesized fact",
    );
    expect(context.editableSource).toBe("Manual fact");
    expect(context.sourceUpdatedAt).toBe(manualSource.updatedAt);
    expect(context.synthesizedSource).toBe("Synthesized fact");
    expect(context.synthesizedUpdatedAt).toBe(synthesized.updatedAt);
    await app.close();
  });

  it.each([undefined, null, {}, { sourceOfTruth: null }, { sourceOfTruth: 1 }, { sourceOfTruth: false }, { sourceOfTruth: [] }])(
    "rejects invalid PUT body %# with the exact legacy error",
    async (payload) => {
      const app = buildApp();
      const character = await createCharacter(app, "Invalid");
      const session = await createSession(app, [character]);
      const response = payload === undefined
        ? await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context` })
        : await app.inject({
            method: "PUT",
            url: `/api/sessions/${session.id}/context`,
            payload: JSON.stringify(payload),
            headers: { "content-type": "application/json" },
          });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).not.toContain("application/problem+json");
      expect(response.json()).toEqual({ error: "sourceOfTruth must be a string" });
      await app.close();
    },
  );

  it("trims, clears, ignores unknown fields, and enforces the 8000 UTF-16-code-unit limit after trim", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Limits");
    const session = await createSession(app, [character]);
    const put = (sourceOfTruth: string, extra: Record<string, unknown> = {}) => app.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/context`,
      payload: { sourceOfTruth, ...extra },
    });

    expect((await put("  kept  ", { unknown: "ignored" })).json().source).toMatchObject({ sourceOfTruth: "kept", updatedAt: expect.any(String) });
    expect((await put(" \n\t ")).json().source).toMatchObject({ sourceOfTruth: "", updatedAt: expect.any(String) });
    expect((await put(` ${"a".repeat(8000)} `)).statusCode).toBe(200);
    const tooLong = await put(` ${"a".repeat(8001)} `);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toEqual({ error: "sourceOfTruth must be at most 8000 characters" });
    expect((await put("😀".repeat(4000))).statusCode).toBe(200);
    expect((await put("😀".repeat(4001))).statusCode).toBe(400);
    await app.close();
  });

  it("keeps closed sessions readable and writable without contacting the configured provider", async () => {
    provider = await startFakeProvider();
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl, model: "unused" } });
    const character = await createCharacter(app, "Closed");
    const session = await createSession(app, [character]);
    const synthesized = await updateSessionSynthesizedSource(session.id, "Repository synthesis");
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    const before = await getSessionContextSource(session.id);

    const firstRead = await getContext(app, session.id);
    expect(await getSessionContextSource(session.id)).toEqual(before);
    const write = await app.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/context`,
      payload: { sourceOfTruth: "Closed canon" },
    });
    expect(write.statusCode).toBe(200);
    const after = await getSessionContextSource(session.id);
    expect(after).toEqual({
      sourceOfTruth: "Closed canon",
      updatedAt: write.json().source.updatedAt,
      synthesizedSource: "Repository synthesis",
      synthesizedUpdatedAt: synthesized.updatedAt,
    });
    const secondRead = await getContext(app, session.id);
    expect(firstRead.state).toBe("closed");
    expect(secondRead).toMatchObject({ state: "closed", editableSource: "Closed canon", synthesizedSource: "Repository synthesis" });
    expect(await getSessionContextSource(session.id)).toEqual(after);
    expect(provider.requests).toEqual([]);
    expect(provider.sceneRequests).toEqual([]);
    await app.close();
  });
});
