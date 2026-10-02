import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { addMemoryFacts, addMessage, getSessionContextSource, getSummary, updateSessionContextSource, updateSessionSynthesizedSource, upsertSummary } from "../src/repo/index.js";
import { generationRegistry } from "../src/routes/roleplay/generationRegistry.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";

useTmpDataDir();

let provider: FakeProvider | null = null;

afterEach(async () => {
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

interface MessageShape {
  id: string;
  role: string;
  content: string;
  parentId: string | null;
  swipeGroupId: string | null;
  swipeIndex: number;
  seq: number;
  status: string;
}

async function setupScene(app: ReturnType<typeof buildApp>) {
  const charRes = await app.inject({ method: "POST", url: "/api/characters", payload: validCharacter });
  const character = charRes.json() as { id: string };
  const sessionRes = await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: character.id } });
  const session = sessionRes.json() as { id: string };
  return { character, session };
}

async function postUserMessage(app: ReturnType<typeof buildApp>, sessionId: string, content: string) {
  const res = await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    userMessage: MessageShape;
    reply: MessageShape;
    messages: MessageShape[];
  };
}

describe("branching api", () => {
  it.each(["swipe", "swipe/stream", "branch"])("excludes abandoned derived context and memories from %s generation", async (operation) => {
    provider = await startFakeProvider("A new possibility unfolds.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const { character, session } = await setupScene(app);
    const first = await postUserMessage(app, session.id, "We arrive at the gate.");
    const discarded = await addMessage(session.id, "user", "Remember the discarded emerald crown.");
    await addMemoryFacts(character.id, [{ kind: "event", content: "discarded emerald crown", sourceTurnId: discarded.id, userApproved: true }]);
    await addMemoryFacts(character.id, [{ kind: "fact", content: "manual compass", sourceTurnId: "manual", userApproved: true }]);
    await updateSessionContextSource(session.id, "The captain carries a silver map.");
    await updateSessionSynthesizedSource(session.id, "ABANDONED_SYNTHESIS: the gate was destroyed.");
    await upsertSummary(session.id, { summary: "ABANDONED_SUMMARY: we sailed away.", keyEvents: [], emotionalBeat: "steady" });

    const response = await app.inject({
      method: "POST",
      url: operation === "branch" ? `/api/sessions/${session.id}/branch` : `/api/sessions/${session.id}/messages/${first.reply.id}/${operation}`,
      ...(operation === "branch" ? { payload: { messageId: first.reply.id, content: "We wait outside the gate." } } : {}),
    });
    expect(response.statusCode).toBe(200);
    if (operation.endsWith("stream")) expect(response.body).toContain("event: done");
    const prompt = provider.requests.at(-1)!.systemContent;
    expect(prompt).toContain("silver map");
    expect(prompt).toContain("manual compass");
    expect(prompt).not.toMatch(/ABANDONED_|discarded emerald crown/);
    expect(provider.sceneRequests.at(-1)!.lastUserContent).not.toContain("ABANDONED_SYNTHESIS");
    expect(await getSummary(session.id)).toBeNull();
    const context = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/context` })).json().context;
    expect(context.rememberedFacts).toEqual(["Aria: manual compass"]);
    await app.close();
  });

  it("clears invalid derived state on activation even without a synthesis provider", async () => {
    const app = buildApp();
    const { session } = await setupScene(app);
    const first = await addMessage(session.id, "user", "The original path.");
    await addMessage(session.id, "user", "A discarded future.");
    await updateSessionContextSource(session.id, "Keep manual canon.");
    await updateSessionSynthesizedSource(session.id, "A discarded future.");
    await upsertSummary(session.id, { summary: "A discarded future.", keyEvents: [], emotionalBeat: "steady" });
    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${first.id}/activate` });
    expect(response.statusCode).toBe(200);
    expect(await getSessionContextSource(session.id)).toMatchObject({ sourceOfTruth: "Keep manual canon.", synthesizedSource: "" });
    expect(await getSummary(session.id)).toBeNull();
    await app.close();
  });

  it("can remember the same fact again on a replacement branch without reviving discarded facts", async () => {
    const app = buildApp();
    const { session } = await setupScene(app);
    const first = await postUserMessage(app, session.id, "Remember the compass is silver; the ship is red");
    const branch = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/branch`,
      payload: { messageId: first.reply.id, content: "Remember the compass is silver; the ship is blue" } });
    expect(branch.statusCode).toBe(200);
    const readContext = async () => (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/context` })).json().context.rememberedFacts;
    expect(await readContext()).toEqual(["Aria: the ship is blue", "Aria: the compass is silver"]);
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${first.reply.id}/activate` });
    expect(await readContext()).toEqual(["Aria: the ship is red", "Aria: the compass is silver"]);
    await app.close();
  });

  it("rejects branch activation while another generation owns the session", async () => {
    const app = buildApp();
    const { session } = await setupScene(app);
    const first = await addMessage(session.id, "user", "First path.");
    const latest = await addMessage(session.id, "user", "Current path.");
    const release = generationRegistry.tryAcquire(session.id)!;
    try {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${first.id}/activate` });
      expect(response.statusCode).toBe(409);
      const read = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
      expect(read.json().messages.at(-1).id).toBe(latest.id);
    } finally { release(); }
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${first.id}/activate` })).statusCode).toBe(200);
    await app.close();
  });

  it("swipes a character reply through the full pipeline and tracks siblings", async () => {
    provider = await startFakeProvider("The captain nods slowly, considering the stars.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const { session } = await setupScene(app);

    const first = await postUserMessage(app, session.id, "we meet at the observation deck");
    expect(first.reply.swipeIndex).toBe(0);
    expect(first.reply.parentId).toBe(first.userMessage.id);

    const swipe = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${first.reply.id}/swipe`,
    });
    expect(swipe.statusCode).toBe(200);
    const swiped = swipe.json() as {
      reply: MessageShape;
      swipeIndex: number;
      siblings: MessageShape[];
      messages: MessageShape[];
      providerError: boolean;
    };
    expect(swiped.providerError).toBe(false);
    expect(swiped.swipeIndex).toBe(1);
    expect(swiped.reply.parentId).toBe(first.userMessage.id);
    expect(swiped.reply.swipeGroupId).toBe(first.reply.swipeGroupId);
    expect(swiped.siblings.map((s) => s.id).sort()).toEqual([first.reply.id, swiped.reply.id].sort());
    // active branch ends on the new swipe
    expect(swiped.messages.map((m) => m.content)).toEqual(["we meet at the observation deck", swiped.reply.content]);
    expect(swiped.messages[1]?.id).toBe(swiped.reply.id);
    // regeneration went through the provider with the parent user turn as the prompt
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.lastUserContent).toContain("observation deck");

    const siblings = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${first.reply.id}/siblings`,
    });
    expect(siblings.statusCode).toBe(200);
    const siblingBody = siblings.json() as { siblings: MessageShape[]; activeMessageId: string; activeLeafId: string };
    expect(siblingBody.siblings).toHaveLength(2);
    expect(siblingBody.activeMessageId).toBe(swiped.reply.id);
    expect(siblingBody.activeLeafId).toBe(swiped.reply.id);

    const activate = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${first.reply.id}/activate`,
    });
    expect(activate.statusCode).toBe(200);
    const activated = activate.json() as { activeLeafId: string; messages: MessageShape[] };
    expect(activated.activeLeafId).toBe(first.reply.id);
    expect(activated.messages[1]?.id).toBe(first.reply.id);
    await app.close();
  });

  it("rejects swipes on user messages and unknown messages", async () => {
    provider = await startFakeProvider();
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const { session } = await setupScene(app);
    const first = await postUserMessage(app, session.id, "hello there");

    const onUser = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${first.userMessage.id}/swipe`,
    });
    expect(onUser.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/nope/swipe` });
    expect(missing.statusCode).toBe(404);
    const siblings404 = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages/nope/siblings` });
    expect(siblings404.statusCode).toBe(404);
    await app.close();
  });

  it("branches a user retry/edit from a character reply", async () => {
    provider = await startFakeProvider("The captain adjusts course without a word.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const { session } = await setupScene(app);
    const first = await postUserMessage(app, session.id, "we set course for the nebula");

    const branch = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/branch`,
      payload: { messageId: first.reply.id, content: "actually, we stay in orbit" },
    });
    expect(branch.statusCode).toBe(200);
    const branched = branch.json() as {
      userMessage: MessageShape;
      reply: MessageShape;
      messages: MessageShape[];
      state: string;
    };
    expect(branched.userMessage.content).toBe("actually, we stay in orbit");
    expect(branched.userMessage.parentId).toBe(first.userMessage.parentId);
    expect(branched.userMessage.swipeGroupId).toBe(first.userMessage.swipeGroupId);
    expect(branched.userMessage.swipeIndex).toBe(1);
    expect(branched.reply.parentId).toBe(branched.userMessage.id);
    expect(branched.messages.map((m) => m.content)).toEqual([
      "actually, we stay in orbit",
      branched.reply.content,
    ]);
    expect(provider.requests[1]?.lastUserContent).toContain("stay in orbit");

    // original branch is intact and can be reactivated
    const activate = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages/${first.reply.id}/activate`,
    });
    const activated = activate.json() as { messages: MessageShape[] };
    expect(activated.messages.map((m) => m.id)).toEqual([first.userMessage.id, first.reply.id]);

    // siblings of the user message now show both user turns
    const siblings = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${first.userMessage.id}/siblings`,
    });
    const siblingBody = siblings.json() as { siblings: MessageShape[] };
    expect(siblingBody.siblings.map((s) => s.swipeIndex)).toEqual([0, 1]);
    await app.close();
  });

  it("allows only one in-flight generation per session with 409", async () => {
    provider = await startFakeProvider({ replyText: "Slow reply from the bridge.", delayMs: 400 });
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const { session } = await setupScene(app);

    const firstPromise = app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "first message" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "second message" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/in flight/);

    const first = await firstPromise;
    expect(first.statusCode).toBe(200);

    // lock released after completion
    const third = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: { content: "third message" },
    });
    expect(third.statusCode).toBe(200);
    await app.close();
  });
});
