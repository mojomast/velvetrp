import { expect, request as requestFactory, test, type APIRequestContext } from "@playwright/test";
import { startLiveServer, type LiveServer } from "../support/live-server";

test.skip(process.env.VELVET_E2E_LIVE !== "1", "set VELVET_E2E_LIVE=1 to allow paid provider requests");

let server: LiveServer;
let api: APIRequestContext;

test.beforeAll(async () => {
  server = await startLiveServer();
  api = await requestFactory.newContext({ baseURL: server.baseURL });
});

test.afterAll(async () => {
  await api?.dispose();
  await server?.stop();
});

test("configured provider completes bounded buffered and streamed turns", async () => {
  const runId = `e2e-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessions: string[] = [];
  const characters: string[] = [];
  const lore: string[] = [];
  const providerResponse = await api.get("/api/provider");
  const usageBefore = await api.get("/api/usage");
  expect(usageBefore.status()).toBe(200);
  const initialUsage = await usageBefore.json() as { usage: { calls: number; totalTokens: number } };
  expect(providerResponse.status()).toBe(200);
  const provider = await providerResponse.json() as {
    hasApiKey: boolean; model: string; baseUrl: string; samplers: { maxTokens: number | null; reasoningEffort: "none" | "high" | "xhigh" | null };
  };
  expect(provider).not.toHaveProperty("apiKey");
  test.skip(!provider.hasApiKey, "configured provider has no API key");
  expect(provider.model.trim()).not.toBe("");
  expect(provider.baseUrl.trim()).not.toBe("");

  const originalMaxTokens = provider.samplers.maxTokens;
  const originalReasoningEffort = provider.samplers.reasoningEffort;
  const capResponse = await api.put("/api/provider", { data: { samplers: { maxTokens: 96, reasoningEffort: "none" } } });
  expect(capResponse.status()).toBe(200);
  try {
    const characterResponse = await api.post("/api/characters", { data: {
      name: `${runId}-Guide`, age: 35, archetype: "terse test guide", boundaries: "Keep replies fictional and concise",
      safeWord: `${runId}-anchor`, fictionalConfirmed: true,
    } });
    expect(characterResponse.status()).toBe(201);
    const character = await characterResponse.json() as { id: string };
    characters.push(character.id);
    const secondCharacterResponse = await api.post("/api/characters", { data: {
      name: `${runId}-Analyst`, age: 36, archetype: "concise skeptical analyst", boundaries: "Keep replies fictional and concise",
      safeWord: `${runId}-harbor`, fictionalConfirmed: true,
    } });
    expect(secondCharacterResponse.status()).toBe(201);
    const secondCharacter = await secondCharacterResponse.json() as { id: string };
    characters.push(secondCharacter.id);

    const loreResponse = await api.post("/api/lore", { data: {
      characterIds: [character.id], keys: [`${runId}-beacon`], content: "The test beacon is cobalt blue.",
    } });
    expect(loreResponse.status()).toBe(201);
    const loreEntry = await loreResponse.json() as { id: string };
    lore.push(loreEntry.id);

    const sessionResponse = await api.post("/api/sessions", { data: {
      characterIds: [character.id, secondCharacter.id], primaryCharacterId: character.id, title: runId,
    } });
    expect(sessionResponse.status()).toBe(201);
    const session = await sessionResponse.json() as { id: string };
    sessions.push(session.id);

    const bufferedResponse = await api.post(`/api/sessions/${session.id}/messages`, { data: {
      content: `Remember that the ${runId}-beacon is cobalt blue.`, speakerCharacterId: character.id,
    } });
    expect(bufferedResponse.status()).toBe(200);
    const buffered = await bufferedResponse.json() as {
      providerError: boolean; loreTriggered: number; reply: { id: string; content: string; speakerCharacterId: string };
    };
    expect(buffered.providerError).toBe(false);
    expect(buffered.loreTriggered).toBeGreaterThanOrEqual(1);
    expect(buffered.reply.content.trim()).not.toBe("");
    expect(buffered.reply.speakerCharacterId).toBe(character.id);
    const memoryResponse = await api.get(`/api/characters/${character.id}/memories`);
    expect(memoryResponse.status()).toBe(200);
    const liveMemories = await memoryResponse.json() as { memories: Array<{ content: string; userApproved: boolean }> };
    expect(liveMemories.memories.some((memory) => memory.userApproved && memory.content.includes(`${runId}-beacon`))).toBe(true);

    const streamResponse = await api.post(`/api/sessions/${session.id}/stream`, { data: {
      content: "Reply with one short sentence.", speakerCharacterId: character.id, generationId: `${runId}-stream`,
    } });
    expect(streamResponse.status()).toBe(200);
    expect(streamResponse.headers()["content-type"]).toContain("text/event-stream");
    const events = (await streamResponse.body()).toString("utf8").split("\n\n").flatMap((block) => {
      const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
    });
    expect(events.map((entry) => entry.event).slice(0, 2)).toEqual(["user_message", "state"]);
    expect(events.some((entry) => entry.event === "delta")).toBe(true);
    expect(events.at(-1)?.event).toBe("done");
    const done = events.at(-1)!.data;
    expect(done.providerError).toBe(false);
    const streamedReply = done.reply as { id: string; content: string; speakerCharacterId: string };
    expect(streamedReply.content.trim()).not.toBe("");
    expect(streamedReply.speakerCharacterId).toBe(character.id);

    const roomResponse = await api.post(`/api/sessions/${session.id}/room-turn`, { data: {
      content: `${runId}-Guide and ${runId}-Analyst, briefly compare your views.`, maxSpeakers: 2,
    } });
    expect(roomResponse.status()).toBe(200);
    const room = await roomResponse.json() as {
      providerError: boolean;
      selectedSpeakerIds: string[];
      replies: Array<{ id: string; content: string; parentId: string; speakerCharacterId: string }>;
    };
    expect(room.providerError).toBe(false);
    expect([...room.selectedSpeakerIds].sort()).toEqual([character.id, secondCharacter.id].sort());
    expect(room.replies.map((reply) => reply.speakerCharacterId)).toEqual(room.selectedSpeakerIds);
    expect(room.replies.every((reply) => reply.content.trim().length > 0)).toBe(true);
    expect(room.replies[1]?.parentId).toBe(room.replies[0]?.id);
    const participantLabel = new RegExp(`^\\s*\\[(?:${runId}-Guide|${runId}-Analyst)\\]`, "i");
    expect([buffered.reply, streamedReply, ...room.replies].every((reply) => !participantLabel.test(reply.content))).toBe(true);

    const continuationResponse = await api.post(`/api/sessions/${session.id}/room-continue`, {
      headers: { Accept: "text/event-stream" }, data: { maxSpeakers: 2 },
    });
    expect(continuationResponse.status()).toBe(200);
    const continuationEvents = (await continuationResponse.body()).toString("utf8").split("\n\n").flatMap((block) => {
      const event = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
    });
    expect(continuationEvents.map((entry) => entry.event)).toEqual(["state", "room_reply", "room_reply", "room_done"]);
    const continuation = continuationEvents.at(-1)!.data as unknown as {
      providerError: boolean;
      selectedSpeakerIds: string[];
      replies: Array<{ id: string; content: string; parentId: string; speakerCharacterId: string }>;
    };
    expect(continuation.providerError).toBe(false);
    expect(continuation.selectedSpeakerIds[0]).not.toBe(room.replies.at(-1)?.speakerCharacterId);
    expect(continuation.replies.map((reply) => reply.speakerCharacterId)).toEqual(continuation.selectedSpeakerIds);
    expect(continuation.replies.every((reply) => reply.content.trim().length > 0)).toBe(true);
    expect(continuation.replies[0]?.parentId).toBe(room.replies.at(-1)?.id);
    expect(continuation.replies[1]?.parentId).toBe(continuation.replies[0]?.id);

    const contextResponse = await api.get(`/api/sessions/${session.id}/context`);
    expect(contextResponse.status()).toBe(200);
    const sharedContext = await contextResponse.json() as { context: { sourceOfTruth: string; participants: unknown[]; recentEvents: string[]; rememberedFacts: string[] } };
    expect(sharedContext.context.participants).toHaveLength(2);
    expect(sharedContext.context.recentEvents.length).toBeGreaterThan(0);
    expect(sharedContext.context.rememberedFacts.some((fact) => fact.includes(`${runId}-beacon`))).toBe(true);
    expect(sharedContext.context.sourceOfTruth).toContain("SYNTHESIZED CURRENT SCENE FACTS");
    expect(sharedContext.context.sourceOfTruth).not.toContain("briefly compare your views");
    const usageResponse = await api.get("/api/usage");
    expect(usageResponse.status()).toBe(200);
    const tracked = await usageResponse.json() as { usage: { calls: number; totalTokens: number; byKind: Array<{ kind: string }> } };
    expect(tracked.usage.calls).toBeGreaterThan(initialUsage.usage.calls);
    expect(tracked.usage.totalTokens).toBeGreaterThan(initialUsage.usage.totalTokens);
    expect(tracked.usage.byKind.some((entry) => entry.kind === "character_reply")).toBe(true);
    expect(tracked.usage.byKind.some((entry) => entry.kind === "scene_synthesis")).toBe(true);

    const persistedResponse = await api.get(`/api/sessions/${session.id}`);
    expect(persistedResponse.status()).toBe(200);
    const persisted = await persistedResponse.json() as { messages: Array<{ id: string }> };
    expect(persisted.messages.map((message) => message.id)).toEqual(expect.arrayContaining([
      buffered.reply.id, streamedReply.id, ...room.replies.map((reply) => reply.id), ...continuation.replies.map((reply) => reply.id),
    ]));
  } finally {
    for (const id of sessions) await api.delete(`/api/sessions/${id}`).catch(() => undefined);
    for (const id of lore) await api.delete(`/api/lore/${id}`).catch(() => undefined);
    for (const id of characters) await api.delete(`/api/characters/${id}`).catch(() => undefined);
    const restored = await api.put("/api/provider", { data: { samplers: { maxTokens: originalMaxTokens, reasoningEffort: originalReasoningEffort } } });
    expect(restored.status()).toBe(200);
  }
});
