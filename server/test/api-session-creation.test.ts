import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { addMessage } from "../src/repo.js";
import type { Character, Message, Session } from "../src/types.js";
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

async function createCharacter(app: ReturnType<typeof buildApp>, name: string): Promise<Character> {
  const response = await app.inject({ method: "POST", url: "/api/characters", payload: characterInput(name) });
  expect(response.statusCode).toBe(201);
  return response.json() as Character;
}

async function postSession(app: ReturnType<typeof buildApp>, payload: unknown) {
  return app.inject({ method: "POST", url: "/api/sessions", payload: payload as object });
}

function expectError(response: { statusCode: number; json: () => unknown }, statusCode: number, error: string) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.json()).toEqual({ error });
}

describe("session creation api characterization", () => {
  it("preserves the exact route boundary and request ID header without changing bodies", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Route");
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/solo",
      headers: { "x-request-id": "session-create" },
      payload: { characterId: character.id },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("session-create");
    expect(response.json()).not.toHaveProperty("requestId");
    expect(response.json()).toMatchObject({ created: true, session: { characterId: character.id }, messages: [] });
    for (const url of ["/sessions", "/api/api/sessions"]) {
      const missing = await app.inject({ method: "POST", url, payload: { characterId: character.id } });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers["content-type"]).not.toContain("application/problem+json");
      expect(missing.json()).not.toHaveProperty("requestId");
    }
    await app.close();
  });

  it("validates missing, null, and non-object general inputs first with exact errors", async () => {
    const app = buildApp();
    const missing = await app.inject({ method: "POST", url: "/api/sessions" });
    expectError(missing, 400, "session input is required");
    expectError(await postSession(app, null), 400, "session input is required");
    for (const payload of ["character", 12, false]) {
      expectError(await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      }), 400, "session input is required");
    }
    await app.close();
  });

  it("checks characterId before characterIds and preserves exact plural validation", async () => {
    const app = buildApp();
    expectError(await postSession(app, { characterId: 1, characterIds: "bad" }), 400, "characterId must be a string");
    for (const characterIds of ["bad", ["valid", 2], null]) {
      expectError(
        await postSession(app, { characterIds }),
        400,
        "characterIds must be an array of strings",
      );
    }
    await app.close();
  });

  it("requires an ID and gives an explicit empty plural list precedence over a valid singular ID", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Present");
    for (const payload of [{}, { characterIds: [] }, { characterId: "" }, { characterId: character.id, characterIds: [] }]) {
      expectError(await postSession(app, payload), 400, "characterId or characterIds is required");
    }
    await app.close();
  });

  it("allows exactly 12 unique participants and rejects 13 after first-occurrence dedupe", async () => {
    const app = buildApp();
    const characters: Character[] = [];
    for (let index = 1; index <= 13; index += 1) characters.push(await createCharacter(app, `Limit ${index}`));
    const twelveIds = characters.slice(0, 12).map((character) => character.id);
    const accepted = await postSession(app, { characterIds: [twelveIds[0], ...twelveIds, twelveIds[1]] });
    expect(accepted.statusCode).toBe(201);
    expect((accepted.json() as Session).participants.map((participant) => participant.id)).toEqual(twelveIds);

    expectError(
      await postSession(app, { characterIds: characters.map((character) => character.id) }),
      400,
      "at most 12 participants are allowed",
    );
    await app.close();
  });

  it("preserves primary fallback, singular/plural interaction, and membership validation", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "One");
    const two = await createCharacter(app, "Two");
    const three = await createCharacter(app, "Three");

    const pluralFallback = await postSession(app, { characterIds: [one.id, two.id] });
    expect(pluralFallback.statusCode).toBe(201);
    expect(pluralFallback.json()).toMatchObject({ characterId: one.id, primaryCharacterId: one.id });

    const singularFallback = await postSession(app, { characterId: two.id, characterIds: [one.id, two.id] });
    expect(singularFallback.statusCode).toBe(201);
    expect(singularFallback.json()).toMatchObject({ characterId: two.id, primaryCharacterId: two.id });
    expect((singularFallback.json() as Session).participants.map((participant) => participant.id)).toEqual([one.id, two.id]);

    expectError(
      await postSession(app, { characterId: three.id, characterIds: [one.id, two.id] }),
      400,
      "primaryCharacterId must be a participant",
    );
    expectError(
      await postSession(app, { characterIds: [one.id, two.id], primaryCharacterId: three.id }),
      400,
      "primaryCharacterId must be a participant",
    );
    await app.close();
  });

  it("validates presetId then title before character lookup with exact errors", async () => {
    const app = buildApp();
    expectError(
      await postSession(app, { characterId: "missing", presetId: 1, title: 2 }),
      400,
      "presetId must be a string",
    );
    expectError(
      await postSession(app, { characterId: "missing", presetId: "default", title: 2 }),
      400,
      "title must be a string",
    );
    await app.close();
  });

  it("reports the first missing character in deduped participant order", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Known");
    expectError(
      await postSession(app, { characterIds: [character.id, "missing-first", "missing-second", "missing-first"] }),
      404,
      "character not found: missing-first",
    );
    await app.close();
  });

  it("dedupes IDs by first occurrence and preserves participant order", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "One");
    const two = await createCharacter(app, "Two");
    const three = await createCharacter(app, "Three");
    const response = await postSession(app, {
      characterIds: [two.id, one.id, two.id, three.id, one.id],
      primaryCharacterId: three.id,
    });

    expect(response.statusCode).toBe(201);
    const session = response.json() as Session;
    expect(session.primaryCharacterId).toBe(three.id);
    expect(session.characterId).toBe(three.id);
    expect(session.participants).toEqual([two, one, three]);
    await app.close();
  });

  it("returns the exact bare default Session with 201", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Bare");
    const response = await postSession(app, { characterId: character.id });

    expect(response.statusCode).toBe(201);
    const session = response.json() as Session;
    expect(session).toEqual({
      id: expect.any(String),
      characterId: character.id,
      primaryCharacterId: character.id,
      participants: [character],
      title: "",
      state: "setup",
      presetId: "default",
      consentLog: [{
        id: expect.any(String),
        at: expect.any(String),
        scope: "scene-created",
        granted: true,
        note: "Fictional adult character confirmed at creation.",
      }],
      activeLeafId: null,
      createdAt: expect.any(String),
      stoppedAt: null,
      stopReason: null,
    });
    expect(response.json()).not.toHaveProperty("session");
    await app.close();
  });

  it("preserves explicit untrimmed and empty title and preset values", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Explicit");
    const padded = await postSession(app, { characterId: character.id, title: "  Untouched  ", presetId: "  custom  " });
    expect(padded.statusCode).toBe(201);
    expect(padded.json()).toMatchObject({ title: "  Untouched  ", presetId: "  custom  " });
    const empty = await postSession(app, { characterId: character.id, title: "", presetId: "" });
    expect(empty.statusCode).toBe(201);
    expect(empty.json()).toMatchObject({ title: "", presetId: "" });
    await app.close();
  });
});

describe("solo session creation api characterization", () => {
  it("rejects missing, null, non-string, empty, and whitespace IDs with the same exact 400", async () => {
    const app = buildApp();
    const payloads = [undefined, null, {}, { characterId: null }, { characterId: 3 }, { characterId: "" }, { characterId: "   " }];
    for (const payload of payloads) {
      const response = payload === undefined
        ? await app.inject({ method: "POST", url: "/api/sessions/solo" })
        : await app.inject({ method: "POST", url: "/api/sessions/solo", payload: payload as object });
      expectError(response, 400, "characterId is required");
    }
    await app.close();
  });

  it("does not trim lookup IDs and returns exact unknown-character errors", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Lookup");
    for (const characterId of [` ${character.id} `, "missing"]) {
      expectError(
        await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId } }),
        404,
        "character not found",
      );
    }
    await app.close();
  });

  it("creates a new default solo with the exact 200 envelope", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "New Solo");
    const response = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { session: Session; messages: Message[]; created: boolean };
    expect(body).toEqual({
      session: {
        id: expect.any(String),
        characterId: character.id,
        primaryCharacterId: character.id,
        participants: [character],
        title: "",
        state: "setup",
        presetId: "default",
        consentLog: [{
          id: expect.any(String),
          at: expect.any(String),
          scope: "scene-created",
          granted: true,
          note: "Fictional adult character confirmed at creation.",
        }],
        activeLeafId: null,
        createdAt: expect.any(String),
        stoppedAt: null,
        stopReason: null,
      },
      messages: [],
      created: true,
    });
    await app.close();
  });

  it("reopens the exact open solo and returns its current active messages", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Reopen");
    const first = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    const original = (first.json() as { session: Session }).session;
    const userMessage = await addMessage(original.id, "user", "Existing turn");
    const characterMessage = await addMessage(original.id, "character", "Existing reply", {
      parentId: userMessage.id,
      speakerCharacterId: character.id,
    });

    const reopened = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toEqual({
      session: { ...original, activeLeafId: characterMessage.id },
      messages: [userMessage, characterMessage],
      created: false,
    });
    await app.close();
  });

  it("does not reuse group sessions or solo sessions for another character", async () => {
    const app = buildApp();
    const one = await createCharacter(app, "One");
    const two = await createCharacter(app, "Two");
    const group = (await postSession(app, { characterIds: [one.id, two.id] })).json() as Session;
    const otherSolo = (await postSession(app, { characterId: two.id })).json() as Session;

    const response = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: one.id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: true, session: { characterId: one.id, participants: [{ id: one.id }] }, messages: [] });
    expect(response.json().session.id).not.toBe(group.id);
    expect(response.json().session.id).not.toBe(otherSolo.id);
    await app.close();
  });

  it("does not reuse an exact solo after it is closed and stopped", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Stopped");
    const original = (await postSession(app, { characterId: character.id })).json() as Session;
    const stoppedResponse = await app.inject({ method: "POST", url: `/api/sessions/${original.id}/stop` });
    expect(stoppedResponse.statusCode).toBe(200);
    expect(stoppedResponse.json()).toMatchObject({ id: original.id, state: "closed", stoppedAt: expect.any(String), stopReason: "user-stop" });

    const response = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: true, session: { state: "setup", stoppedAt: null, stopReason: null }, messages: [] });
    expect(response.json().session.id).not.toBe(original.id);
    await app.close();
  });

  it("selects the newest eligible exact solo session", async () => {
    const app = buildApp();
    const character = await createCharacter(app, "Newest");
    const older = (await postSession(app, { characterId: character.id })).json() as Session;
    const newer = (await postSession(app, { characterId: character.id })).json() as Session;
    const olderCreatedAt = "2030-01-01T00:00:00.000Z";
    const newerCreatedAt = "2030-01-02T00:00:00.000Z";
    const raw = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    raw.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(olderCreatedAt, older.id);
    raw.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(newerCreatedAt, newer.id);
    raw.close();
    const marker = await addMessage(newer.id, "user", "Newest history");

    const response = await app.inject({ method: "POST", url: "/api/sessions/solo", payload: { characterId: character.id } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: { ...newer, createdAt: newerCreatedAt, activeLeafId: marker.id },
      messages: [marker],
      created: false,
    });
    await app.close();
  });
});
