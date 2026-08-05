import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  addMessage,
  createCharacter,
  createSession,
  stopSession,
} from "../src/repo.js";
import type { Message } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";

useTmpDataDir();

const characterInput = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional adults only",
  safeWord: "anchor",
  fictionalConfirmed: true,
};

async function seedSession() {
  const character = await createCharacter(characterInput);
  const session = await createSession({ characterId: character.id });
  return { character, session };
}

function expectFullMessageShape(message: Message): void {
  expect(Object.keys(message)).toEqual([
    "id",
    "sessionId",
    "role",
    "speakerCharacterId",
    "content",
    "parentId",
    "swipeGroupId",
    "swipeIndex",
    "seq",
    "status",
    "createdAt",
    "usage",
  ]);
}

describe("branch sibling read api characterization", () => {
  it("serves only the exact /api route and returns the request ID only as a header", async () => {
    const { session } = await seedSession();
    const message = await addMessage(session.id, "user", "root", { parentId: null });
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${message.id}/siblings`,
      headers: { "x-request-id": "branch-siblings-read" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("branch-siblings-read");
    expect(response.json()).toEqual({
      siblings: [message],
      activeMessageId: message.id,
      activeLeafId: message.id,
    });
    expect(response.json()).not.toHaveProperty("requestId");

    for (const url of [
      `/sessions/${session.id}/messages/${message.id}/siblings`,
      `/api/api/sessions/${session.id}/messages/${message.id}/siblings`,
    ]) {
      const missing = await app.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).not.toHaveProperty("requestId");
    }
    await app.close();
  });

  it("preserves exact missing-session precedence and message misses across sessions", async () => {
    const first = await seedSession();
    const second = await seedSession();
    const foreignMessage = await addMessage(second.session.id, "user", "foreign", { parentId: null });
    const app = buildApp();

    const missingSession = await app.inject({
      method: "GET",
      url: "/api/sessions/missing/messages/missing/siblings",
      headers: { "x-request-id": "missing-session" },
    });
    expect(missingSession.statusCode).toBe(404);
    expect(missingSession.headers["x-request-id"]).toBe("missing-session");
    expect(missingSession.json()).toEqual({ error: "session not found" });

    for (const messageId of ["missing", foreignMessage.id]) {
      const missingMessage = await app.inject({
        method: "GET",
        url: `/api/sessions/${first.session.id}/messages/${messageId}/siblings`,
      });
      expect(missingMessage.statusCode).toBe(404);
      expect(missingMessage.json()).toEqual({ error: "message not found" });
    }
    await app.close();
  });

  it("returns full root and non-root sibling shapes ordered by swipe index then sequence", async () => {
    const { character, session } = await seedSession();
    const rootLate = await addMessage(session.id, "user", "root late", { parentId: null, swipeIndex: 2 });
    const rootFirst = await addMessage(session.id, "system", "root first", {
      parentId: null,
      swipeIndex: 0,
      status: "aborted",
    });
    const rootSecond = await addMessage(session.id, "character", "root second", {
      parentId: null,
      swipeIndex: 0,
      speakerCharacterId: character.id,
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6, source: "estimated", model: "fixture" },
    });
    const childLate = await addMessage(session.id, "user", "child late", { parentId: rootLate.id, swipeIndex: 3 });
    const childFirst = await addMessage(session.id, "system", "child first", {
      parentId: rootLate.id,
      swipeIndex: 1,
      status: "aborted",
    });
    const childSecond = await addMessage(session.id, "character", "child second", {
      parentId: rootLate.id,
      swipeIndex: 1,
      speakerCharacterId: character.id,
    });
    const app = buildApp();

    const roots = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${rootLate.id}/siblings`,
    });
    expect(Object.keys(roots.json())).toEqual(["siblings", "activeMessageId", "activeLeafId"]);
    expect(roots.json()).toEqual({
      siblings: [rootFirst, rootSecond, rootLate],
      activeMessageId: rootLate.id,
      activeLeafId: childSecond.id,
    });

    const children = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${childFirst.id}/siblings`,
    });
    expect(children.json()).toEqual({
      siblings: [childFirst, childSecond, childLate],
      activeMessageId: childSecond.id,
      activeLeafId: childSecond.id,
    });
    for (const message of children.json().siblings as Message[]) expectFullMessageShape(message);
    expect((children.json().siblings as Message[]).map(({ role, status }) => [role, status])).toEqual([
      ["system", "aborted"],
      ["character", "final"],
      ["user", "final"],
    ]);
    await app.close();
  });

  it("returns null active IDs when the session has no final active leaf", async () => {
    const { session } = await seedSession();
    const aborted = await addMessage(session.id, "character", "partial", { parentId: null, status: "aborted" });
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${aborted.id}/siblings`,
    });
    expect(response.json()).toEqual({ siblings: [aborted], activeMessageId: null, activeLeafId: null });
    await app.close();
  });

  it("falls back to the latest final message when the stored active leaf is null", async () => {
    const { session } = await seedSession();
    const first = await addMessage(session.id, "user", "first", { parentId: null });
    const latest = await addMessage(session.id, "user", "latest", { parentId: null, swipeIndex: 1 });
    const raw = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    raw.prepare("UPDATE sessions SET active_leaf_id = NULL WHERE id = ?").run(session.id);
    raw.close();
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${first.id}/siblings`,
    });
    expect(response.json()).toEqual({
      siblings: [first, latest],
      activeMessageId: latest.id,
      activeLeafId: latest.id,
    });
    await app.close();
  });

  it("identifies an ancestor sibling for a descendant leaf and null after an earlier divergence", async () => {
    const { session } = await seedSession();
    const rootA = await addMessage(session.id, "user", "root A", { parentId: null });
    const siblingA = await addMessage(session.id, "character", "sibling A", { parentId: rootA.id });
    const siblingB = await addMessage(session.id, "character", "sibling B", { parentId: rootA.id, swipeIndex: 1 });
    const descendant = await addMessage(session.id, "user", "descendant", { parentId: siblingB.id });
    const app = buildApp();

    const ancestor = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${siblingA.id}/siblings`,
    });
    expect(ancestor.json()).toEqual({
      siblings: [siblingA, siblingB],
      activeMessageId: siblingB.id,
      activeLeafId: descendant.id,
    });

    const rootB = await addMessage(session.id, "user", "root B", { parentId: null, swipeIndex: 1 });
    const divergentLeaf = await addMessage(session.id, "character", "divergent leaf", { parentId: rootB.id });
    const divergent = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${siblingA.id}/siblings`,
    });
    expect(divergent.json()).toEqual({
      siblings: [siblingA, siblingB],
      activeMessageId: null,
      activeLeafId: divergentLeaf.id,
    });
    await app.close();
  });

  it("keeps siblings readable after the session is stopped and closed", async () => {
    const { session } = await seedSession();
    const message = await addMessage(session.id, "user", "still readable", { parentId: null });
    const stopped = await stopSession(session.id, "user-stop");
    expect(stopped).toMatchObject({ state: "closed", stopReason: "user-stop" });
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages/${message.id}/siblings`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      siblings: [message],
      activeMessageId: message.id,
      activeLeafId: message.id,
    });
    await app.close();
  });
});
