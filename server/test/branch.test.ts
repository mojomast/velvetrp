import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";
import {
  addMessage,
  closeRepo,
  createCharacter,
  createSession,
  getActiveLeaf,
  getSession,
  listBranchChildren,
  listBranchMessages,
  listMessages,
  nextSwipeIndex,
  setActiveBranch,
} from "../src/repo/index.js";

useTmpDataDir();

const characterInput = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional only",
    fictionalConfirmed: true,
};

async function seedSession() {
  const character = await createCharacter(characterInput);
  const session = await createSession({ characterId: character.id });
  return { character, session };
}

describe("branch tree", () => {
  it("chains linear messages and reads the active branch in seq order", async () => {
    const { session } = await seedSession();
    const u1 = await addMessage(session.id, "user", "u1");
    const c1 = await addMessage(session.id, "character", "c1");
    const u2 = await addMessage(session.id, "user", "u2");

    expect(u1.parentId).toBeNull();
    expect(c1.parentId).toBe(u1.id);
    expect(u2.parentId).toBe(c1.id);
    expect([u1.seq, c1.seq, u2.seq]).toEqual([0, 1, 2]);
    expect(u1.status).toBe("final");
    expect(u1.swipeGroupId).toBe(u1.id);
    expect(u1.swipeIndex).toBe(0);

    const leaf = await getActiveLeaf(session.id);
    expect(leaf?.id).toBe(u2.id);
    const stored = await getSession(session.id);
    expect(stored?.activeLeafId).toBe(u2.id);

    const messages = await listMessages(session.id);
    expect(messages.map((m) => m.content)).toEqual(["u1", "c1", "u2"]);
  });

  it("reads only the active branch after forking and switching", async () => {
    const { session } = await seedSession();
    const u1 = await addMessage(session.id, "user", "u1");
    const c1 = await addMessage(session.id, "character", "c1");

    const u1Alt = await addMessage(session.id, "user", "u1-alt", {
      parentId: u1.parentId,
      swipeGroupId: u1.swipeGroupId ?? u1.id,
      swipeIndex: 1,
    });
    const c2 = await addMessage(session.id, "character", "c2", { parentId: u1Alt.id });

    expect((await listMessages(session.id)).map((m) => m.content)).toEqual(["u1-alt", "c2"]);
    expect((await getActiveLeaf(session.id))?.id).toBe(c2.id);

    const switched = await setActiveBranch(session.id, c1.id);
    expect(switched?.activeLeafId).toBe(c1.id);
    expect((await listMessages(session.id)).map((m) => m.content)).toEqual(["u1", "c1"]);

    expect(await setActiveBranch(session.id, "missing")).toBeNull();
  });

  it("tracks swipe indexes and siblings within a swipe group", async () => {
    const { session } = await seedSession();
    const u1 = await addMessage(session.id, "user", "u1");
    const c1 = await addMessage(session.id, "character", "c1", { parentId: u1.id });
    const group = c1.swipeGroupId ?? c1.id;

    expect(await nextSwipeIndex(session.id, group)).toBe(1);
    const c1b = await addMessage(session.id, "character", "c1-alt", {
      parentId: u1.id,
      swipeGroupId: group,
      swipeIndex: await nextSwipeIndex(session.id, group),
    });
    expect(c1b.swipeIndex).toBe(1);
    expect(await nextSwipeIndex(session.id, group)).toBe(2);

    const children = await listBranchChildren(session.id, u1.id);
    expect(children.map((m) => [m.content, m.swipeIndex])).toEqual([
      ["c1", 0],
      ["c1-alt", 1],
    ]);
    const roots = await listBranchChildren(session.id, null);
    expect(roots.map((m) => m.content)).toEqual(["u1"]);

    expect((await listBranchMessages(session.id, c1b.id)).map((m) => m.content)).toEqual(["u1", "c1-alt"]);
  });

  it("does not advance the active leaf for aborted messages", async () => {
    const { session } = await seedSession();
    const u1 = await addMessage(session.id, "user", "u1");
    const aborted = await addMessage(session.id, "character", "partial", { status: "aborted" });
    expect(aborted.status).toBe("aborted");
    expect((await getActiveLeaf(session.id))?.id).toBe(u1.id);
    const stored = await getSession(session.id);
    expect(stored?.activeLeafId).toBe(u1.id);
  });
});

describe("branching foreign keys", () => {
  it("cascades session deletion across a branched message tree", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const { character, session } = await seedSession();
    const u1 = await addMessage(session.id, "user", "u1");
    await addMessage(session.id, "character", "c1", { parentId: u1.id });
    await addMessage(session.id, "character", "c1-alt", { parentId: u1.id, swipeIndex: 1 });

    closeRepo();
    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    raw.pragma("foreign_keys = ON");
    const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("messages")).toBe(3);
    raw.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    expect(count("messages")).toBe(0);
    raw.prepare("DELETE FROM characters WHERE id = ?").run(character.id);
    expect(count("sessions")).toBe(0);
    raw.close();
  });
});

describe("schema v2 to v3 migration", () => {
  it("backfills linear parents, seq, and the active leaf", async () => {
    const dir = makeTmpDataDir();
    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE characters (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, archetype TEXT NOT NULL,
        boundaries TEXT NOT NULL, fictional_confirmed INTEGER NOT NULL,
        is_real_person INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        title TEXT NOT NULL, state TEXT NOT NULL, preset_id TEXT NOT NULL,
        created_at TEXT NOT NULL, stopped_at TEXT, stop_reason TEXT
      );
      CREATE TABLE consent_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, at TEXT NOT NULL, scope TEXT NOT NULL, granted INTEGER NOT NULL, note TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schemaVersion', '2');
      INSERT INTO characters VALUES ('c1', 'Aria', 29, 'captain', 'fictional only', 1, 0, '2025-01-01T00:00:00.000Z');
      INSERT INTO sessions VALUES ('s1', 'c1', '', 'active', 'default', '2025-01-01T00:01:00.000Z', NULL, NULL);
      INSERT INTO messages VALUES ('m1', 's1', 'user', 'hello', '2025-01-01T00:02:00.000Z');
      INSERT INTO messages VALUES ('m2', 's1', 'character', 'greetings', '2025-01-01T00:03:00.000Z');
      INSERT INTO messages VALUES ('m3', 's1', 'user', 'how are you', '2025-01-01T00:04:00.000Z');
    `);
    raw.close();
    closeRepo();

    const messages = await listMessages("s1");
    expect(messages.map((m) => m.content)).toEqual(["hello", "greetings", "how are you"]);
    expect(messages.map((m) => m.seq)).toEqual([0, 1, 2]);
    expect(messages[0]?.parentId).toBeNull();
    expect(messages[1]?.parentId).toBe("m1");
    expect(messages[2]?.parentId).toBe("m2");
    expect(messages.every((m) => m.status === "final" && m.swipeIndex === 0)).toBe(true);
    expect(messages[1]?.swipeGroupId).toBe("m2");

    expect((await getActiveLeaf("s1"))?.id).toBe("m3");
    expect((await getSession("s1"))?.activeLeafId).toBe("m3");

    const next = await addMessage("s1", "character", "doing well");
    expect(next.parentId).toBe("m3");
    expect(next.seq).toBe(3);
    expect((await listMessages("s1")).map((m) => m.content)).toEqual([
      "hello",
      "greetings",
      "how are you",
      "doing well",
    ]);

    closeRepo();
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const version = verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string };
    expect(version.value).toBe("33");
    verify.close();
  });
});
