import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Character, Message, Session } from "../src/types.js";
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
  fictionalConfirmed: true,
});

async function createCharacter(app: ReturnType<typeof buildApp>, name: string): Promise<Character> {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name) });
  expect(response.statusCode).toBe(201);
  return response.json() as Character;
}

async function createSession(
  app: ReturnType<typeof buildApp>,
  payload: { characterId?: string; characterIds?: string[]; primaryCharacterId?: string; title?: string; presetId?: string },
): Promise<Session> {
  const response = await app.inject({ method: "POST", url: "/api/sessions", payload });
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

describe("session query api characterization", () => {
  it("registers once at the exact /api paths", async () => {
    const app = buildApp();
    await app.ready();

    const exact = await app.inject({ method: "GET", url: "/api/sessions", headers: { "x-request-id": "session-list" } });
    expect(exact.statusCode).toBe(200);
    expect(exact.headers["x-request-id"]).toBe("session-list");
    expect(exact.json()).toEqual({ sessions: [] });
    expect(exact.json()).not.toHaveProperty("requestId");

    for (const url of ["/sessions", "/api/api/sessions"]) {
      const missing = await app.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).not.toContain("application/problem+json");
      expect(missing.json()).not.toHaveProperty("code");
      expect(missing.json()).not.toHaveProperty("requestId");
    }
    await app.close();
  });

  it("lists every open and closed session in insertion order with its full shape", async () => {
    const app = buildApp();
    const primary = await createCharacter(app, "Primary");
    const secondary = await createCharacter(app, "Secondary");
    const open = await createSession(app, { characterId: primary.id, title: "Open", presetId: "cinematic" });
    const group = await createSession(app, {
      characterIds: [primary.id, secondary.id],
      primaryCharacterId: primary.id,
      title: "Closed group",
    });
    const stoppedResponse = await app.inject({ method: "POST", url: `/api/sessions/${group.id}/stop` });
    expect(stoppedResponse.statusCode).toBe(200);
    const stopped = stoppedResponse.json() as Session;

    expect(Object.keys(open)).toEqual([
      "id", "characterId", "primaryCharacterId", "participants", "title", "state", "presetId",
      "consentLog", "activeLeafId", "createdAt", "stoppedAt", "stopReason",
    ]);
    expect(open.participants).toEqual([primary]);
    expect(open.consentLog).toEqual([{
      id: expect.any(String),
      at: expect.any(String),
      scope: "scene-created",
      granted: true,
      note: "Fictional adult character confirmed at creation.",
    }]);
    expect(new Date(open.consentLog[0]!.at).toISOString()).toBe(open.consentLog[0]!.at);
    expect(open).toMatchObject({
      characterId: primary.id,
      primaryCharacterId: primary.id,
      title: "Open",
      state: "setup",
      presetId: "cinematic",
      activeLeafId: null,
      stoppedAt: null,
      stopReason: null,
    });
    expect(stopped.participants).toEqual([primary, secondary]);
    expect(stopped).toMatchObject({ state: "closed", stopReason: "user-stop" });
    expect(stopped.stoppedAt).toEqual(expect.any(String));
    expect(stopped.consentLog).toEqual([
      group.consentLog[0],
      {
        id: expect.any(String),
        at: expect.any(String),
        scope: "user-stop",
        granted: false,
        note: "User pressed stop; scene closed.",
      },
    ]);

    const listed = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(listed.json()).toEqual({ sessions: [open, stopped] });
    await app.close();
  });

  it("filters on primary or secondary participants without excluding closed sessions", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "One");
    const two = await createCharacter(app, "Two");
    const solo = await createSession(app, { characterId: one.id });
    const group = await createSession(app, { characterIds: [one.id, two.id], primaryCharacterId: one.id });
    const stopped = (await app.inject({ method: "POST", url: `/api/sessions/${group.id}/stop` })).json() as Session;

    expect((await app.inject({ method: "GET", url: `/api/sessions?characterId=${two.id}` })).json()).toEqual({ sessions: [stopped] });
    expect((await app.inject({ method: "GET", url: `/api/sessions?characterId=${one.id}` })).json()).toEqual({ sessions: [solo, stopped] });
    expect((await app.inject({ method: "GET", url: "/api/sessions?characterId=unknown" })).json()).toEqual({ sessions: [] });
    expect((await app.inject({ method: "GET", url: "/api/sessions?characterId=" })).json()).toEqual({ sessions: [solo, stopped] });
    await app.close();
  });

  it("returns exact detail and message envelopes, empty state, and legacy misses", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Quiet");
    const session = await createSession(app, { characterId: character.id });

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}`, headers: { "x-request-id": "session-detail" } });
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["x-request-id"]).toBe("session-detail");
    expect(detail.json()).toEqual({ session, messages: [] });

    const messages = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    expect(messages.statusCode).toBe(200);
    expect(messages.headers["x-request-id"]).toEqual(expect.any(String));
    expect(messages.json()).toEqual({ messages: [] });

    for (const url of ["/api/sessions/missing", "/api/sessions/missing/messages", "/api/sessions/solo"]) {
      const missing = await app.inject({ method: "GET", url, headers: { "x-request-id": "legacy-miss" } });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["x-request-id"]).toBe("legacy-miss");
      expect(missing.headers["content-type"]).not.toContain("application/problem+json");
      expect(missing.json()).toEqual({ error: "session not found" });
    }
    await app.close();
  });

  it("exposes equal active messages with speaker, usage, and branch metadata", async () => {
    provider = await startFakeProvider("The navigator confirms the route.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl, model: "query-test-model" } });
    const character = await createCharacter(app, "Navigator");
    const session = await createSession(app, { characterId: character.id });
    const turn = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "Check the route.", speakerCharacterId: character.id },
    });
    expect(turn.statusCode).toBe(200);
    const activeMessages = turn.json().messages as Message[];

    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    const messages = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    expect(detail.json().messages).toEqual(activeMessages);
    expect(messages.json()).toEqual({ messages: activeMessages });
    expect(activeMessages).toHaveLength(2);
    expect(activeMessages[0]).toEqual({
      id: expect.any(String),
      sessionId: session.id,
      role: "user",
      speakerCharacterId: null,
      content: "Check the route.",
      parentId: null,
      swipeGroupId: expect.any(String),
      swipeIndex: 0,
      seq: 0,
      status: "final",
      createdAt: expect.any(String),
      usage: null,
    });
    expect(activeMessages[1]).toEqual({
      id: expect.any(String),
      sessionId: session.id,
      role: "character",
      speakerCharacterId: character.id,
      content: "The navigator confirms the route.",
      parentId: activeMessages[0]?.id,
      swipeGroupId: expect.any(String),
      swipeIndex: 0,
      seq: 1,
      status: "final",
      createdAt: expect.any(String),
      usage: {
        promptTokens: 120,
        completionTokens: 24,
        totalTokens: 144,
        source: "provider",
        model: "fake-model",
      },
    });

    const swiped = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${activeMessages[1]!.id}/swipe`,
      payload: { speakerCharacterId: character.id },
    });
    expect(swiped.statusCode).toBe(200);
    const swipedMessages = swiped.json().messages as Message[];
    expect(swipedMessages).toHaveLength(2);
    expect(swipedMessages.map((message) => message.id)).not.toContain(activeMessages[1]!.id);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json().messages).toEqual(swipedMessages);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` })).json()).toEqual({ messages: swipedMessages });
    await app.close();
  });
});
