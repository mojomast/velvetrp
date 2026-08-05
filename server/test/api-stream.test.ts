import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";

useTmpDataDir();

let provider: FakeProvider | null = null;

afterEach(async () => {
  delete process.env.VELVET_SSE_HEARTBEAT_MS;
  if (provider) {
    await provider.close();
    provider = null;
  }
});

const validCharacter = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional adults only",
    fictionalConfirmed: true,
};

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

class SseReader {
  events: SseEvent[] = [];
  raw = "";
  finished: Promise<void>;
  private waiters: Array<{ pred: (events: SseEvent[]) => boolean; resolve: () => void }> = [];

  constructor(res: Response) {
    if (!res.body) throw new Error("response has no body");
    this.finished = this.pump(res.body.getReader());
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.raw += text;
        buffer += text;
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
          let event = "message";
          const dataLines: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) event = line.slice("event:".length).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
          }
          if (dataLines.length > 0) {
            this.events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
          }
        }
        this.waiters = this.waiters.filter((waiter) => {
          if (waiter.pred(this.events)) {
            waiter.resolve();
            return false;
          }
          return true;
        });
      }
    } catch {
      // aborted streams end here
    } finally {
      this.waiters.forEach((waiter) => waiter.resolve());
      this.waiters = [];
    }
  }

  waitFor(pred: (events: SseEvent[]) => boolean): Promise<void> {
    if (pred(this.events)) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push({ pred, resolve });
    });
  }

  eventNames(): string[] {
    return this.events.map((entry) => entry.event);
  }
}

async function listen(app: ReturnType<typeof buildApp>): Promise<string> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

async function setupScene(base: string) {
  const charRes = await fetch(`${base}/api/characters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validCharacter),
  });
  const character = (await charRes.json()) as { id: string };
  const sessionRes = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId: character.id }),
  });
  const session = (await sessionRes.json()) as { id: string };
  return { character, session };
}

async function getMessages(base: string, sessionId: string) {
  const res = await fetch(`${base}/api/sessions/${sessionId}/messages`);
  return ((await res.json()) as { messages: Array<{ id: string; role: string; content: string }> }).messages;
}

describe("streaming api", () => {
  it("streams a turn in event order and persists the final reply", async () => {
    provider = await startFakeProvider("The captain smiles and pours two glasses of sparkling water.");
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { character, session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "we meet at the observation deck", generationId: "gen-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = new SseReader(res);
    await reader.finished;

    const names = reader.eventNames();
    expect(names[0]).toBe("user_message");
    expect(names[1]).toBe("state");
    expect(names[names.length - 1]).toBe("done");
    const deltas = reader.events.filter((entry) => entry.event === "delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((entry) => entry.data.seq)).toEqual(deltas.map((_, index) => index));
    const streamed = deltas.map((entry) => entry.data.text).join("");

    const done = reader.events[reader.events.length - 1]!;
    expect(done.data.providerError).toBe(false);
    const replyMessage = done.data.reply as { content: string; role: string; speakerCharacterId: string };
    expect(replyMessage.content).toContain("sparkling water");
    expect(replyMessage.content).toBe(streamed);
    expect(replyMessage.speakerCharacterId).toBe(character.id);
    const userEvent = reader.events[0]!;
    expect((userEvent.data.message as { content: string }).content).toBe("we meet at the observation deck");
    expect(userEvent.data.generationId).toBe("gen-1");
    expect(done.data.state).toBe("active");

    const persisted = await getMessages(base, session.id);
    expect(persisted.map((m) => m.role)).toEqual(["user", "character"]);
    expect(persisted[1]?.content).toBe(replyMessage.content);
    await app.close();
  });

  it("streams output under the deliberately permissive policy", async () => {
    provider = await startFakeProvider("the kid waved back from across the promenade");
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const reader = new SseReader(res);
    await reader.finished;

    const streamed = reader.events
      .filter((entry) => entry.event === "delta")
      .map((entry) => entry.data.text)
      .join("");
    expect(streamed).toContain("kid");

    const boundary = reader.events[reader.events.length - 1]!;
    expect(boundary.event).toBe("done");
    const replyMessage = boundary.data.reply as { content: string };
    expect(replyMessage.content).toContain("kid");
    const persisted = await getMessages(base, session.id);
    expect(persisted.map((m) => m.role)).toEqual(["user", "character"]);
    expect(persisted[1]?.content).toBe(replyMessage.content);
    await app.close();
  });

  it("streams swipe output under the deliberately permissive policy", async () => {
    provider = await startFakeProvider("the kid waved back from across the promenade");
    const app = buildApp();
    const base = await listen(app);
    const { session } = await setupScene(base);

    // seed a turn against the stub provider so a swipe target exists
    const turn = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "we meet at the observation deck" }),
    });
    const turnBody = (await turn.json()) as { reply: { id: string } };

    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const res = await fetch(`${base}/api/sessions/${session.id}/messages/${turnBody.reply.id}/swipe/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const reader = new SseReader(res);
    await reader.finished;

    const streamed = reader.events
      .filter((entry) => entry.event === "delta")
      .map((entry) => entry.data.text)
      .join("");
    expect(streamed).toContain("kid");
    const boundary = reader.events[reader.events.length - 1]!;
    expect(boundary.event).toBe("done");
    expect((boundary.data.reply as { content: string }).content).toContain("kid");
    expect(boundary.data.swipeIndex).toBe(1);
    const persisted = await getMessages(base, session.id);
    expect(persisted[persisted.length - 1]?.content).toContain("kid");
    await app.close();
  });

  it("aborts an in-flight stream when the session is stopped", async () => {
    provider = await startFakeProvider({ replyText: "A slow reply that never lands.", delayMs: 800 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tell me a long story" }),
    });
    const reader = new SseReader(res);
    await reader.waitFor((events) => events.some((entry) => entry.event === "user_message"));

    const stop = await fetch(`${base}/api/sessions/${session.id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { state: string }).state).toBe("closed");

    await reader.finished;
    expect(reader.eventNames()).toContain("aborted");
    expect(reader.eventNames()).not.toContain("done");

    const persisted = await getMessages(base, session.id);
    expect(persisted.map((m) => m.role)).toEqual(["user"]);
    await app.close();
  });

  it("persists the safe fallback with providerError and releases the lock when the provider is unreachable", async () => {
    provider = await startFakeProvider("unused");
    const deadBaseUrl = provider.baseUrl;
    await provider.close();
    provider = null;

    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: deadBaseUrl }),
    });
    const { session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const reader = new SseReader(res);
    await reader.finished;
    const done = reader.events[reader.events.length - 1]!;
    expect(done.event).toBe("done");
    expect(done.data.providerError).toBe(true);
    expect((done.data.reply as { content: string }).content).toContain("holding the scene right here");

    const persisted = await getMessages(base, session.id);
    expect(persisted[1]?.content).toContain("holding the scene right here");

    // lock was released after the provider failure
    const second = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "again" }),
    });
    const reader2 = new SseReader(second);
    await reader2.finished;
    expect(reader2.eventNames()).toContain("done");
    await app.close();
  });

  it("cancels a generation via the cancel endpoint and persists no reply", async () => {
    provider = await startFakeProvider({ replyText: "A slow reply that never lands.", delayMs: 800 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tell me a long story", generationId: "gen-cancel" }),
    });
    const reader = new SseReader(res);
    await reader.waitFor((events) => events.some((entry) => entry.event === "user_message"));

    const cancel = await fetch(`${base}/api/sessions/${session.id}/generation/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: "gen-cancel" }),
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as { aborted: string }).toEqual({ ok: true, aborted: "gen-cancel" });

    await reader.finished;
    expect(reader.eventNames()).toContain("aborted");
    expect(reader.eventNames()).not.toContain("done");

    const persisted = await getMessages(base, session.id);
    expect(persisted.map((m) => m.role)).toEqual(["user"]);

    const cancelAgain = await fetch(`${base}/api/sessions/${session.id}/generation/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: "gen-cancel" }),
    });
    expect(cancelAgain.status).toBe(404);
    await app.close();
  });

  it("aborts the provider and persists no reply when the client disconnects", async () => {
    provider = await startFakeProvider({ replyText: "A slow reply that never lands.", delayMs: 800 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const controller = new AbortController();
    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tell me a long story" }),
      signal: controller.signal,
    });
    const reader = new SseReader(res);
    await reader.waitFor((events) => events.some((entry) => entry.event === "user_message"));
    controller.abort();
    await reader.finished.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const persisted = await getMessages(base, session.id);
    expect(persisted.map((m) => m.role)).toEqual(["user"]);

    // generation lock was released after abort
    const res2 = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "another try" }),
    });
    const reader2 = new SseReader(res2);
    await reader2.finished;
    expect(reader2.eventNames()).toContain("done");
    await app.close();
  });

  it("emits heartbeat comments while the provider is slow", async () => {
    process.env.VELVET_SSE_HEARTBEAT_MS = "50";
    provider = await startFakeProvider({ replyText: "A warm reply after a pause.", delayMs: 300 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const res = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const reader = new SseReader(res);
    await reader.finished;
    expect(reader.raw).toContain(": heartbeat");
    expect(reader.eventNames()).toContain("done");
    await app.close();
  });

  it("keeps the 404/409 gates with permissive policy", async () => {
    provider = await startFakeProvider({ replyText: "Slow.", delayMs: 500 });
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });

    const missing = await fetch(`${base}/api/sessions/nope/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(missing.status).toBe(404);

    const { session } = await setupScene(base);

    const violation = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "imagine a high school setting" }),
    });
    expect(violation.status).toBe(200);
    const violationReader = new SseReader(violation);
    await violationReader.finished;
    expect(violationReader.eventNames()).toContain("done");

    const first = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "start a slow one" }),
    });
    const firstReader = new SseReader(first);
    await firstReader.waitFor((events) => events.some((entry) => entry.event === "user_message"));
    const second = await fetch(`${base}/api/sessions/${session.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "concurrent attempt" }),
    });
    expect(second.status).toBe(409);
    await firstReader.finished;
    expect(firstReader.eventNames()).toContain("done");
    await app.close();
  });

  it("streams a swipe regeneration and tracks siblings", async () => {
    provider = await startFakeProvider("The captain nods slowly, considering the stars.");
    const app = buildApp();
    const base = await listen(app);
    await fetch(`${base}/api/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: provider.baseUrl }),
    });
    const { session } = await setupScene(base);

    const turn = await fetch(`${base}/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "we meet at the observation deck" }),
    });
    const turnBody = (await turn.json()) as { reply: { id: string } };

    const res = await fetch(`${base}/api/sessions/${session.id}/messages/${turnBody.reply.id}/swipe/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: "gen-swipe" }),
    });
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    await reader.finished;

    const names = reader.eventNames();
    expect(names[0]).toBe("state");
    expect(names[names.length - 1]).toBe("done");
    expect(names).toContain("delta");
    const done = reader.events[reader.events.length - 1]!;
    expect(done.data.swipeIndex).toBe(1);
    expect((done.data.siblings as unknown[]).length).toBe(2);
    const messages = done.data.messages as Array<{ role: string; content: string }>;
    expect(messages.map((m) => m.content)).toEqual([
      "we meet at the observation deck",
      (done.data.reply as { content: string }).content,
    ]);
    await app.close();
  });
});
