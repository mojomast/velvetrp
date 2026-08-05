import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { startFakeProvider, useTmpDataDir, type FakeProvider } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

let provider: FakeProvider | null = null;
afterEach(async () => {
  if (provider) await provider.close();
  provider = null;
});

const characterInput = (name: string, safeWord: string) => ({
  name, age: 30, archetype: `${name} archetype`, boundaries: "fictional", safeWord, fictionalConfirmed: true,
});

async function addCharacter(app: ReturnType<typeof buildApp>, name: string, safeWord = "anchor") {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name, safeWord) });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; name: string };
}

describe("management and group-session api", () => {
  it("creates and reuses a durable open solo session", async () => {
    const app = buildApp();
    const character = await addCharacter(app, "Private");
    const first = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    const sessionId = first.json().session.id as string;
    await app.inject({ method: "POST", url: `/api/sessions/${sessionId}/messages`, payload: { content: "private hello" } });
    const second = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    expect(second.json()).toMatchObject({ created: false, session: { id: sessionId } });
    expect(second.json().messages).toHaveLength(2);
    expect((await app.inject({ method: "POST", url: "/api/sessions/solo", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: "missing" } })).statusCode).toBe(404);
    await app.close();
  });

  it("lists, overrides, validates, and resets prompt templates", async () => {
    provider = await startFakeProvider("Prompt override reply.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const listed = await app.inject({ method: "GET", url: "/api/prompt-templates" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().templates.length).toBeGreaterThan(10);
    expect((await app.inject({ method: "PUT", url: "/api/prompt-templates/character.final", payload: { template: "CUSTOM FINAL FOR {{target.name}}" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/prompt-templates/character.final", payload: { template: "bad {{unknown.value}}" } })).statusCode).toBe(400);
    const character = await addCharacter(app, "Template");
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: character.id } })).json();
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "hello" } });
    expect(provider.requests.at(-1)?.systemContent).toContain("CUSTOM FINAL FOR Template");
    const reset = await app.inject({ method: "PUT", url: "/api/prompt-templates/character.final", payload: { template: null } });
    expect(reset.json().templates.find((entry: { id: string }) => entry.id === "character.final").overridden).toBe(false);
    await app.close();
  });

  it("gets, patches, and safely deletes characters", async () => {
    const app = buildApp();
    const unused = await addCharacter(app, "Unused");
    expect((await app.inject({ method: "GET", url: `/api/characters/${unused.id}` })).json().name).toBe("Unused");
    const patched = await app.inject({ method: "PATCH", url: `/api/characters/${unused.id}`, payload: { name: "Renamed" } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().name).toBe("Renamed");
    expect((await app.inject({ method: "DELETE", url: `/api/characters/${unused.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/characters/${unused.id}` })).statusCode).toBe(404);

    const used = await addCharacter(app, "Used");
    await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: used.id } });
    expect((await app.inject({ method: "DELETE", url: `/api/characters/${used.id}` })).statusCode).toBe(409);
    await app.close();
  });

  it("supports manual memory editing, soft-forget, and restore", async () => {
    const app = buildApp();
    const character = await addCharacter(app, "Memory");
    const created = await app.inject({
      method: "POST", url: `/api/characters/${character.id}/memories`,
      payload: { content: "keeps a brass key", kind: "fact", userApproved: false },
    });
    expect(created.statusCode).toBe(201);
    const memory = created.json() as { id: string };
    const edited = await app.inject({
      method: "PATCH", url: `/api/memories/${memory.id}`,
      payload: { content: "keeps a silver key", kind: "event", userApproved: true },
    });
    expect(edited.json()).toMatchObject({ content: "keeps a silver key", kind: "event", userApproved: true });
    expect((await app.inject({ method: "PATCH", url: `/api/memories/${memory.id}`, payload: { content: " " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/api/memories/${memory.id}` })).statusCode).toBe(200);
    const forgottenList = (await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` })).json().memories;
    expect(forgottenList).toHaveLength(1);
    expect(forgottenList[0].forgottenAt).not.toBeNull();
    const restored = await app.inject({ method: "POST", url: `/api/memories/${memory.id}/restore` });
    expect(restored.json().forgottenAt).toBeNull();
    const activeList = (await app.inject({ method: "GET", url: `/api/characters/${character.id}/memories` })).json().memories;
    expect(activeList).toHaveLength(1);
    expect(activeList[0].forgottenAt).toBeNull();
    await app.close();
  });

  it("shares lore globally or with selected characters and manages its lifecycle", async () => {
    const app = buildApp();
    const one = await addCharacter(app, "One");
    const two = await addCharacter(app, "Two");
    const three = await addCharacter(app, "Three");
    await app.inject({ method: "POST", url: "/api/lore", payload: { keys: [], content: "Always-on global lore." } });
    const scopedResponse = await app.inject({
      method: "POST", url: "/api/lore",
      payload: { characterIds: [one.id, two.id], keys: ["gate"], content: "Shared gate lore." },
    });
    expect(scopedResponse.statusCode).toBe(201);
    const scoped = scopedResponse.json() as { id: string; characterIds: string[] };
    expect(scoped.characterIds).toEqual([one.id, two.id]);
    const forOne = (await app.inject({ method: "GET", url: `/api/lore?characterId=${one.id}` })).json().lore;
    const forThree = (await app.inject({ method: "GET", url: `/api/lore?characterId=${three.id}` })).json().lore;
    expect(forOne).toHaveLength(2);
    expect(forThree).toHaveLength(1);
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: one.id } })).json();
    const turn = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "unrelated words" } });
    expect(turn.json().loreTriggered).toBe(1);
    const patched = await app.inject({ method: "PATCH", url: `/api/lore/${scoped.id}`, payload: { characterIds: [two.id], enabled: false } });
    expect(patched.json()).toMatchObject({ characterIds: [two.id], enabled: false });
    expect((await app.inject({ method: "DELETE", url: `/api/lore/${scoped.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/lore", payload: { characterId: "missing", keys: [], content: "x" } })).statusCode).toBe(404);
    await app.close();
  });

  it("resumes, filters, attributes, continues, and swipes group sessions", async () => {
    provider = await startFakeProvider("A single attributed reply.");
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const one = await addCharacter(app, "One", "oneword");
    const two = await addCharacter(app, "Two", "twoword");
    const created = await app.inject({
      method: "POST", url: "/api/sessions",
      payload: { characterIds: [one.id, two.id], primaryCharacterId: one.id, title: "Group" },
    });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { id: string; characterId: string; primaryCharacterId: string; participants: unknown[] };
    expect(session).toMatchObject({ characterId: one.id, primaryCharacterId: one.id });
    expect(session.participants).toHaveLength(2);

    const turn = await app.inject({
      method: "POST", url: `/api/sessions/${session.id}/messages`,
      payload: { content: "Two, answer this.", speakerCharacterId: two.id },
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().reply.speakerCharacterId).toBe(two.id);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/continue`, payload: { speakerCharacterId: one.id } })).json().reply.speakerCharacterId).toBe(one.id);
    const swipe = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages/${turn.json().reply.id}/swipe`, payload: {} });
    expect(swipe.json().reply.speakerCharacterId).toBe(two.id);
    const branch = await app.inject({
      method: "POST", url: `/api/sessions/${session.id}/branch`,
      payload: { messageId: turn.json().reply.id, content: "Try another path.", speakerCharacterId: one.id },
    });
    expect(branch.json().reply.speakerCharacterId).toBe(one.id);
    expect(provider.requests).toHaveLength(4);

    const detail = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}` })).json();
    expect(detail.session.participants).toHaveLength(2);
    expect(detail.messages.every((message: { role: string; speakerCharacterId: string | null }) => message.role !== "character" || message.speakerCharacterId)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/sessions?characterId=${two.id}` })).json().sessions).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/sessions?characterId=missing" })).json().sessions).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/continue`, payload: { speakerCharacterId: "missing" } })).statusCode).toBe(400);
    await app.close();
  });

  it("routes a room message to pertinent characters and chains their replies", async () => {
    provider = await startFakeProvider({ replyTexts: [
      '["One", "Two", "One", "missing"]', "[One] [One] One: One answers first.", "[Two] Two: Two reacts to One.",
      '["Two", "One"]', "[One] One continues the exchange.", "[Two] Two answers One directly.",
    ] });
    const app = buildApp();
    await app.inject({ method: "PUT", url: "/api/provider", payload: { baseUrl: provider.baseUrl } });
    const one = await addCharacter(app, "One", "oneword");
    const two = await addCharacter(app, "Two", "twoword");
    const three = await addCharacter(app, "Three", "threeword");
    const session = (await app.inject({
      method: "POST", url: "/api/sessions",
      payload: { characterIds: [one.id, two.id, three.id], primaryCharacterId: one.id },
    })).json() as { id: string };

    const response = await app.inject({
      method: "POST", url: `/api/sessions/${session.id}/room-turn`,
      payload: { content: "Who should inspect the signal?", maxSpeakers: 2 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      routing: string;
      selectedSpeakerIds: string[];
      replies: Array<{ id: string; parentId: string; content: string; speakerCharacterId: string }>;
      messages: Array<{ role: string }>;
    };
    expect(body.routing).toBe("model");
    expect(body.selectedSpeakerIds).toEqual([one.id, two.id]);
    expect(body.replies.map((reply) => reply.speakerCharacterId)).toEqual([one.id, two.id]);
    expect(body.replies.map((reply) => reply.content)).toEqual(["One answers first.", "Two reacts to One."]);
    expect(body.replies[1]?.parentId).toBe(body.replies[0]?.id);
    expect(body.messages.map((message) => message.role)).toEqual(["user", "character", "character"]);
    const context = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/context` })).json().context;
    expect(context.participants).toHaveLength(3);
    expect(context.recentEvents.some((event: string) => event.includes("Two reacts to One"))).toBe(true);
    const sourceUpdate = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context`, payload: { sourceOfTruth: "Everyone is now inside the locked observatory." } });
    expect(sourceUpdate.statusCode).toBe(200);
    expect(sourceUpdate.json().source.sourceOfTruth).toContain("locked observatory");
    const updatedContext = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/context` })).json().context;
    expect(updatedContext.editableSource).toBe("Everyone is now inside the locked observatory.");
    expect(updatedContext.sourceOfTruth).toContain("Everyone is now inside the locked observatory.");
    expect(updatedContext.sourceOfTruth).toContain("SYNTHESIZED CURRENT SCENE FACTS");
    expect(updatedContext.synthesizedSource).toContain("Observatory at night");
    expect(provider.sceneRequests.length).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]?.lastUserContent).toContain("One just replied: One answers first.");
    expect(provider.requests[2]?.lastUserContent).toContain("Respond directly to One");
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/room-turn`, payload: { content: "x", maxSpeakers: 7 } })).statusCode).toBe(400);

    const continuedResponse = await app.inject({
      method: "POST", url: `/api/sessions/${session.id}/room-continue`, payload: { maxSpeakers: 2 },
    });
    expect(continuedResponse.statusCode).toBe(200);
    const continued = continuedResponse.json() as {
      selectedSpeakerIds: string[];
      replies: Array<{ id: string; parentId: string; content: string; speakerCharacterId: string }>;
      messages: Array<{ role: string }>;
    };
    expect(continued.selectedSpeakerIds).toEqual([one.id, two.id]);
    expect(continued.replies.map((entry) => entry.content)).toEqual(["One continues the exchange.", "Two answers One directly."]);
    expect(continued.replies[0]?.parentId).toBe(body.replies[1]?.id);
    expect(continued.replies[1]?.parentId).toBe(continued.replies[0]?.id);
    expect(continued.messages.map((message) => message.role)).toEqual(["user", "character", "character", "character", "character"]);
    expect(provider.requests).toHaveLength(6);
    expect(provider.requests[5]?.lastUserContent).toContain("One just said or did: One continues the exchange.");
    expect(provider.requests[5]?.systemContent).toContain("AUTHORITATIVE CURRENT SCENE");
    expect(provider.requests[5]?.systemContent).toContain("Everyone is now inside the locked observatory.");
    expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/context`, payload: { sourceOfTruth: 4 } })).statusCode).toBe(400);
    const singleSession = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: one.id } })).json() as { id: string };
    expect((await app.inject({ method: "POST", url: `/api/sessions/${singleSession.id}/room-continue`, payload: {} })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: `/api/sessions/${session.id}/stop` });
    expect((await app.inject({ method: "POST", url: `/api/sessions/${session.id}/room-continue`, payload: {} })).statusCode).toBe(409);
    await app.close();
  });

  it("allows up to six pertinent room responders", async () => {
    const app = buildApp();
    const participants = await Promise.all(["Alpha", "Beta", "Gamma", "Delta"].map((name) => addCharacter(app, name, `${name.toLowerCase()}word`)));
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterIds: participants.map((entry) => entry.id) } })).json() as { id: string };
    const turn = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/room-turn`, payload: { content: "Everyone respond and discuss this together.", maxSpeakers: 4 } });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().selectedSpeakerIds).toHaveLength(4);
    expect(turn.json().replies).toHaveLength(4);
    expect(turn.json().replies.slice(1).every((entry: { parentId: string }, index: number) => entry.parentId === turn.json().replies[index].id)).toBe(true);
    await app.close();
  });

  it("closes a group session on any participant custom safe word", async () => {
    const app = buildApp();
    const one = await addCharacter(app, "One", "alpha");
    const two = await addCharacter(app, "Two", "bravo");
    const session = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterIds: [one.id, two.id] } })).json();
    const stopped = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "bravo" } });
    expect(stopped.json().state).toBe("closed");
    await app.close();
  });

  it("deletes sessions before characters without affecting unrelated data", async () => {
    const app = buildApp();
    const removedCharacter = await addCharacter(app, "Removed");
    const keptCharacter = await addCharacter(app, "Kept");
    const removedSession = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: removedCharacter.id } })).json();
    const keptSession = (await app.inject({ method: "POST", url: "/api/sessions", payload: { characterId: keptCharacter.id } })).json();
    await app.inject({ method: "POST", url: `/api/sessions/${removedSession.id}/messages`, payload: { content: "removed history" } });
    await app.inject({ method: "POST", url: `/api/sessions/${keptSession.id}/messages`, payload: { content: "kept history" } });

    expect((await app.inject({ method: "DELETE", url: `/api/characters/${removedCharacter.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${removedSession.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${removedSession.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${removedSession.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/characters/${removedCharacter.id}` })).statusCode).toBe(200);

    const kept = await app.inject({ method: "GET", url: `/api/sessions/${keptSession.id}` });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().messages).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/api/characters/${keptCharacter.id}` })).statusCode).toBe(200);
    await app.close();
  });
});
