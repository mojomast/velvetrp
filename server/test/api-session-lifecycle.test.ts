import DatabaseDriver from "better-sqlite3";
import Fastify from "fastify";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { roleplaySessionLifecycleRoutes } from "../src/routes/roleplay/sessionLifecycle.js";
import {
  addConsentEvent,
  addMessage,
  closeRepo,
  createCharacter as createCharacterRecord,
  createSession as createSessionRecord,
  getSessionContextSource,
  getSummary,
  listMessages,
  listSessions,
  updateSessionContextSource,
  upsertSummary,
} from "../src/repo/index.js";
import type { Session } from "../src/types.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

let provider: FakeProvider | null = null;

afterEach(async () => {
  if (provider) await provider.close();
  provider = null;
});

const characterInput = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
};

async function createCharacter(app: ReturnType<typeof buildApp>, name = "Aria") {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: { ...characterInput, name } });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string };
}

async function createSession(app: ReturnType<typeof buildApp>, characterIds: string[], title = "Lifecycle scene") {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { characterIds, primaryCharacterId: characterIds[0], title },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Session;
}

async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

class SseReader {
  readonly events: SseEvent[] = [];
  readonly finished: Promise<void>;
  private waiters: Array<{ predicate: (events: SseEvent[]) => boolean; resolve: () => void }> = [];

  constructor(response: Response) {
    if (!response.body) throw new Error("response has no body");
    this.finished = this.pump(response.body.getReader());
  }

  waitFor(predicate: (events: SseEvent[]) => boolean): Promise<void> {
    if (predicate(this.events)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          if (data.length > 0) this.events.push({ event, data: JSON.parse(data.join("\n")) as Record<string, unknown> });
          boundary = buffer.indexOf("\n\n");
        }
        this.resolveWaiters();
      }
    } finally {
      this.waiters.forEach((waiter) => waiter.resolve());
      this.waiters = [];
    }
  }

  private resolveWaiters(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.predicate(this.events)) return true;
      waiter.resolve();
      return false;
    });
  }
}

async function listen(app: ReturnType<typeof buildApp>): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("session lifecycle api", () => {
  it("does not invoke the abort callback for missing session IDs", async () => {
    const abortActiveGeneration = vi.fn<(sessionId: string) => void>();
    const app = Fastify({ logger: false });
    await app.register(roleplaySessionLifecycleRoutes, { prefix: "/api", abortActiveGeneration });

    expect((await app.inject({ method: "DELETE", url: "/api/sessions/missing" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/sessions/missing/stop" })).statusCode).toBe(404);
    expect(abortActiveGeneration).not.toHaveBeenCalled();
    await app.close();
  });

  it("invokes the abort callback while existing sessions are still open", async () => {
    const character = await createCharacterRecord(characterInput);
    const deletedSession = await createSessionRecord({ characterId: character.id });
    const stoppedSession = await createSessionRecord({ characterId: character.id });
    const observed: Array<{ id: string; state: string }> = [];
    const abortActiveGeneration = vi.fn((sessionId: string) => {
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
      const row = db.prepare("SELECT id, state FROM sessions WHERE id = ?").get(sessionId) as { id: string; state: string } | undefined;
      db.close();
      if (row) observed.push(row);
    });
    const app = Fastify({ logger: false });
    await app.register(roleplaySessionLifecycleRoutes, { prefix: "/api", abortActiveGeneration });

    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${deletedSession.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${stoppedSession.id}/stop` })).statusCode).toBe(200);
    expect(abortActiveGeneration.mock.calls).toEqual([[deletedSession.id], [stoppedSession.id]]);
    expect(observed).toEqual([
      { id: deletedSession.id, state: "setup" },
      { id: stoppedSession.id, state: "setup" },
    ]);
    await app.close();
  });

  it("exposes only the exact prefixed lifecycle routes and preserves missing responses and request IDs", async () => {
    const app = buildApp();

    for (const request of [
      { method: "DELETE", url: "/api/sessions/missing" },
      { method: "POST", url: "/api/sessions/missing/stop" },
    ] as const) {
      const response = await app.inject({ ...request, headers: { "x-request-id": "lifecycle-request" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe("lifecycle-request");
      expect(response.json()).toEqual({ error: "session not found" });
      expect(response.json()).not.toHaveProperty("requestId");
    }

    for (const request of [
      { method: "DELETE", url: "/sessions/missing" },
      { method: "DELETE", url: "/api/api/sessions/missing" },
      { method: "DELETE", url: "/api/sessions/missing/stop" },
      { method: "POST", url: "/sessions/missing/stop" },
      { method: "POST", url: "/api/api/sessions/missing/stop" },
      { method: "POST", url: "/api/sessions/missing" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).not.toEqual({ error: "session not found" });
    }

    await app.close();
  });

  it("deletes exactly once, cascades session data, preserves labeled usage, and releases characters", async () => {
    const app = buildApp();
    const first = await createCharacter(app, "First");
    const second = await createCharacter(app, "Second");
    const session = await createSession(app, [first.id, second.id]);
    await addMessage(session.id, "user", "Remember the observatory.");
    await addMessage(session.id, "character", "I remember.", {
      speakerCharacterId: first.id,
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, source: "provider", model: "fixture-model" },
    });
    await updateSessionContextSource(session.id, "The observatory is locked.");
    await upsertSummary(session.id, { summary: "At the observatory.", keyEvents: ["Arrived"], emotionalBeat: "steady" });
    await addConsentEvent(session.id, "check-in", true, "Still comfortable.");

    const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    const repeated = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect(repeated.statusCode).toBe(404);
    expect(repeated.json()).toEqual({ error: "session not found" });
    const detail = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ error: "session not found" });

    expect(await listMessages(session.id)).toEqual([]);
    expect(await listSessions(first.id)).toEqual([]);
    expect(await listSessions(second.id)).toEqual([]);
    expect(await getSummary(session.id)).toBeNull();
    expect(await getSessionContextSource(session.id)).toEqual({
      sourceOfTruth: "",
      updatedAt: null,
      synthesizedSource: "",
      synthesizedUpdatedAt: null,
    });

    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json().usage as {
      calls: number;
      totalTokens: number;
      bySession: Array<{ sessionId: string; title: string; totalTokens: number }>;
    };
    expect(usage.calls).toBe(1);
    expect(usage.totalTokens).toBe(15);
    expect(usage.bySession).toEqual([expect.objectContaining({ sessionId: session.id, title: "Deleted session", totalTokens: 15 })]);

    closeRepo();
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(session.id) as { count: number }).count;
    expect(count("session_characters")).toBe(0);
    expect(count("messages")).toBe(0);
    expect(count("session_context")).toBe(0);
    expect(count("summaries")).toBe(0);
    expect(count("consent_events")).toBe(0);
    expect(count("usage_events")).toBe(1);
    db.close();

    expect((await app.inject({ method: "DELETE", url: `/api/characters/${first.id}` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "DELETE", url: `/api/characters/${second.id}` })).json()).toEqual({ ok: true });
    await app.close();
  });

  it("returns the bare closed session, records exact consent, rejects later writes, and characterizes repeated stop", async () => {
    const app = buildApp();
    const character = await createCharacter(app);
    const created = await createSession(app, [character.id]);

    const stoppedResponse = await app.inject({ method: "POST", url: `/api/sessions/${created.id}/stop` });
    expect(stoppedResponse.statusCode).toBe(200);
    const stopped = stoppedResponse.json() as Session;
    expect(stopped).toEqual({
      ...created,
      state: "closed",
      stoppedAt: expect.any(String),
      stopReason: "user-stop",
      consentLog: [
        created.consentLog[0],
        {
          id: expect.any(String),
          at: expect.any(String),
          scope: "user-stop",
          granted: false,
          note: "User pressed stop; scene closed.",
        },
      ],
    });
    expect(stopped).not.toHaveProperty("session");

    const laterWrite = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/messages`,
      payload: { content: "Continue the scene." },
    });
    expect(laterWrite.statusCode).toBe(409);
    expect(laterWrite.json()).toMatchObject({ error: "session is stopped", stoppedAt: stopped.stoppedAt, stopReason: "user-stop" });

    const repeatedResponse = await app.inject({ method: "POST", url: `/api/sessions/${created.id}/stop` });
    expect(repeatedResponse.statusCode).toBe(200);
    const repeated = repeatedResponse.json() as Session;
    expect(repeated.stoppedAt).toBe(stopped.stoppedAt);
    expect(repeated.stopReason).toBe(stopped.stopReason);
    expect(repeated.consentLog).toHaveLength(stopped.consentLog.length + 1);
    expect(repeated.consentLog.slice(0, -1)).toEqual(stopped.consentLog);
    expect(repeated.consentLog.at(-1)).toEqual({
      id: expect.any(String),
      at: expect.any(String),
      scope: "user-stop",
      granted: false,
      note: "User pressed stop; scene closed.",
    });
    await app.close();
  });

  it("aborts an active regular stream before deleting the session and persists no character reply", async () => {
    provider = await startFakeProvider({ replyText: "A delayed reply that must not persist.", delayMs: 800 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const characterResponse = await fetch(`${base}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(characterInput),
    });
    const character = (await characterResponse.json()) as { id: string };
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: character.id }),
    });
    const session = (await sessionResponse.json()) as { id: string };

    const streamResponse = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Tell me a long story." }),
    });
    expect(streamResponse.status).toBe(200);
    const reader = new SseReader(streamResponse);
    await within(reader.waitFor((events) => events.some((event) => event.event === "user_message")));

    const deleted = await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    await within(reader.finished);
    expect(reader.events.map((event) => event.event)).toContain("aborted");
    expect(reader.events.map((event) => event.event)).not.toContain("done");
    expect(await listMessages(session.id)).toEqual([]);
    expect((await fetch(`${base}/api/sessions/${session.id}`)).status).toBe(404);
    await app.close();
  });
});
