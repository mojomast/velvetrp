import DatabaseDriver from "better-sqlite3";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";
import {
  addConsentEvent,
  addMemoryFacts,
  addMessage,
  closeRepo,
  createCharacter,
  createLoreEntry,
  createRepository,
  createSession,
  deleteSession,
  forgetMemory,
  getSessionContextSource,
  getHarnessSettings,
  getProviderSettings,
  getPublicProviderSettings,
  getSummary,
  listAllMemories,
  listApprovedMemories,
  listCharacters,
  listLoreEntries,
  listMessages,
  setMemoryApproval,
  stopSession,
  transitionSession,
  updateHarnessSettings,
  updateProviderSettings,
  updateSessionContextSource,
  updateSessionSynthesizedSource,
  upsertSummary,
} from "../src/repo/index.js";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { systemRuntime } from "../src/runtime.js";
import type { Database, UpdateHarnessInput } from "../src/types.js";

useTmpDataDir();

const characterInput = {
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "fictional only",
    fictionalConfirmed: true,
};

describe("schema", () => {
  it("records schemaVersion 35 revision 1 and enables WAL", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    await listCharacters();
    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const version = raw.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string };
    expect(version.value).toBe("35");
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    raw.close();
  });
});

describe("characters and sessions", () => {
  it("creates a character with a seed consent event on session creation", async () => {
    const character = await createCharacter(characterInput);
    expect(character.isRealPerson).toBe(false);
    const session = await createSession({ characterId: character.id });
    expect(session.state).toBe("setup");
    expect(session.consentLog).toHaveLength(1);
    expect(session.consentLog[0]?.scope).toBe("scene-created");
  });

  it("transitions and stops sessions exactly once", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    await transitionSession(session.id, "active", "first-user-message");
    const stopped = await stopSession(session.id, "user-stop");
    expect(stopped?.state).toBe("closed");
    expect(stopped?.stoppedAt).not.toBeNull();
    expect(stopped?.stopReason).toBe("user-stop");
    const again = await stopSession(session.id, "other");
    expect(again?.stoppedAt).toBe(stopped?.stoppedAt);
    expect(again?.stopReason).toBe("user-stop");
  });

  it("appends consent events in order", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    await addConsentEvent(session.id, "scene-start", true, "started");
    await addConsentEvent(session.id, "user-stop", false, "stopped");
    const fresh = await transitionSession(session.id, "paused", "check");
    expect(fresh?.consentLog.map((e) => e.scope)).toEqual(["scene-created", "scene-start", "user-stop"]);
    expect(await addConsentEvent("missing", "x", true, "n")).toBeNull();
  });
});

describe("factory session context source", () => {
  it("returns and persists the injected timestamp without consuming an ID", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const clockNow = vi.fn(() => new Date("2030-04-05T06:07:08.009Z"));
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });

    expect(repository.updateSessionContextSource(session.id, "The observatory is locked.")).toEqual({
      sourceOfTruth: "The observatory is locked.",
      updatedAt: "2030-04-05T06:07:08.009Z",
    });
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT source_of_truth, updated_at FROM session_context WHERE session_id = ?").get(session.id)).toEqual({
      source_of_truth: "The observatory is locked.",
      updated_at: "2030-04-05T06:07:08.009Z",
    });
    raw.close();
  });

  it("overwrites only manual source fields and preserves synthesized fields", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const synthesized = await updateSessionSynthesizedSource(session.id, "A brass key is present.");
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const clockNow = vi.fn()
      .mockReturnValueOnce(new Date("2030-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:00.000Z"));
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow } });

    repository.updateSessionContextSource(session.id, "First manual source.");
    expect(repository.updateSessionContextSource(session.id, "Replacement manual source.")).toEqual({
      sourceOfTruth: "Replacement manual source.",
      updatedAt: "2031-01-01T00:00:00.000Z",
    });
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT source_of_truth, updated_at, synthesized_source, synthesized_updated_at FROM session_context WHERE session_id = ?").get(session.id)).toEqual({
      source_of_truth: "Replacement manual source.",
      updated_at: "2031-01-01T00:00:00.000Z",
      synthesized_source: "A brass key is present.",
      synthesized_updated_at: synthesized.updatedAt,
    });
    expect(clockNow).toHaveBeenCalledTimes(2);
    raw.close();
  });

  it("leaves the prior row unchanged when the clock throws", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const prior = await updateSessionContextSource(session.id, "Prior source.");
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const clockNow = vi.fn(() => { throw new Error("clock unavailable"); });
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow } });

    expect(() => repository.updateSessionContextSource(session.id, "Must not persist.")).toThrow("clock unavailable");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT source_of_truth, updated_at FROM session_context WHERE session_id = ?").get(session.id)).toEqual({
      source_of_truth: "Prior source.",
      updated_at: prior.updatedAt,
    });
    raw.close();
  });

  it("consumes the clock before a missing-session foreign-key failure", async () => {
    const character = await createCharacter(characterInput);
    await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const clockNow = vi.fn(() => new Date("2030-01-01T00:00:00.000Z"));
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow } });

    expect(() => repository.updateSessionContextSource("missing", "No session.")).toThrow();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM session_context").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it("rejects updates after close without consuming dependencies", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });
    repository.close();

    expect(() => repository.updateSessionContextSource(session.id, "No update.")).toThrow("repository is closed");
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
  });

  it("keeps the named wrapper asynchronous and on the system clock", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const clockNow = vi.spyOn(systemRuntime.clock, "now").mockReturnValue(new Date("2032-03-04T05:06:07.008Z"));
    try {
      const pending = updateSessionContextSource(session.id, "Named source.");
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toEqual({
        sourceOfTruth: "Named source.",
        updatedAt: "2032-03-04T05:06:07.008Z",
      });
      expect(clockNow).toHaveBeenCalledOnce();
      expect(await getSessionContextSource(session.id)).toMatchObject({
        sourceOfTruth: "Named source.",
        updatedAt: "2032-03-04T05:06:07.008Z",
      });
    } finally {
      clockNow.mockRestore();
    }
  });
});

describe("repository transactions", () => {
  it("creates an exact deterministic character and durably inserts its row", () => {
    const dir = makeTmpDataDir();
    const calls: string[] = [];
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId: () => { calls.push("id"); return "character-fixed"; } },
      clock: { now: () => { calls.push("clock"); return new Date("2030-04-05T06:07:08.009Z"); } },
    });

    const character = repository.createCharacter(characterInput);

    expect(character).toEqual({
      id: "character-fixed",
      ...characterInput,
      isRealPerson: false,
      createdAt: "2030-04-05T06:07:08.009Z",
    });
    expect(calls).toEqual(["id", "clock"]);
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT * FROM characters WHERE id = ?").get("character-fixed")).toEqual({
      id: "character-fixed",
      name: characterInput.name,
      age: characterInput.age,
      archetype: characterInput.archetype,
      boundaries: characterInput.boundaries,
      fictional_confirmed: 1,
      is_real_person: 0,
      created_at: "2030-04-05T06:07:08.009Z",
    });
    raw.close();
  });

  it("does not call the clock or insert when character ID generation fails", () => {
    const dir = makeTmpDataDir();
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId: vi.fn(() => { throw new Error("ID generator unavailable"); }) },
      clock: { now: clockNow },
    });

    expect(() => repository.createCharacter(characterInput)).toThrow("ID generator unavailable");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM characters").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it("consumes the ID but inserts no character when the clock fails", () => {
    const dir = makeTmpDataDir();
    const nextId = vi.fn(() => "character-fixed");
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId },
      clock: { now: vi.fn(() => { throw new Error("clock unavailable"); }) },
    });

    expect(() => repository.createCharacter(characterInput)).toThrow("clock unavailable");
    expect(nextId).toHaveBeenCalledOnce();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM characters").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it("preserves the first row and consumes dependencies on duplicate character IDs", () => {
    const dir = makeTmpDataDir();
    const nextId = vi.fn(() => "duplicate-character");
    const clockNow = vi.fn()
      .mockReturnValueOnce(new Date("2030-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:00.000Z"));
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });

    const first = repository.createCharacter(characterInput);
    expect(() => repository.createCharacter({ ...characterInput, name: "Replacement" })).toThrow();
    expect(nextId).toHaveBeenCalledTimes(2);
    expect(clockNow).toHaveBeenCalledTimes(2);
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT name, created_at FROM characters").all()).toEqual([
      { name: first.name, created_at: first.createdAt },
    ]);
    raw.close();
  });

  it("rejects character creation after close without consuming dependencies", () => {
    const dir = makeTmpDataDir();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });
    repository.close();

    expect(() => repository.createCharacter(characterInput)).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });

  it("keeps character creation out of transaction units of work", () => {
    const repository = createRepository({ dataDir: makeTmpDataDir() });
    repository.transaction((unitOfWork) => {
      if (false) {
        // @ts-expect-error Character creation is factory-owned, not transactional.
        unitOfWork.createCharacter(characterInput);
        // @ts-expect-error Session context source updates are factory-owned, not transactional.
        unitOfWork.updateSessionContextSource("session", "source");
        // @ts-expect-error Lore creation is factory-owned, not transactional.
        unitOfWork.createLoreEntry({ characterIds: [], keys: [], content: "", enabled: true, insertionOrder: 0 });
        // @ts-expect-error Harness updates are factory-owned, not transactional.
        unitOfWork.updateHarnessSettings({});
        // @ts-expect-error Campaign creation is factory-owned, not transactional.
        unitOfWork.createCampaign("local-owner", { name: "Campaign" });
        // @ts-expect-error Campaign rename is factory-owned, not transactional.
        unitOfWork.renameCampaign("local-owner", "campaign", { name: "Renamed" });
        // @ts-expect-error Campaign membership addition is factory-owned, not transactional.
        unitOfWork.addCampaignMembership("local-owner", "campaign", { principalId: "principal", role: "player" });
        // @ts-expect-error Campaign-session attachment is factory-owned, not transactional.
        unitOfWork.attachCampaignSession("local-owner", { campaignId: "campaign", sessionId: "session" });
        // @ts-expect-error Campaign-session detachment is factory-owned, not transactional.
        unitOfWork.detachCampaignSession("local-owner", { campaignId: "campaign", sessionId: "session" });
      }
    });
    repository.close();
  });

  it("commits all writes in a synchronous unit of work", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const repository = createRepository({ dataDir: dir });

    const committed = repository.transaction((unitOfWork) => {
      unitOfWork.addConsentEvent(session.id, "command", true, "committed");
      return unitOfWork.transitionSession(session.id, "active", "command");
    });

    expect(committed?.state).toBe("active");
    expect(committed?.consentLog.map((event) => event.scope)).toEqual(["scene-created", "command"]);
    repository.close();
  });

  it("rolls back consent and session transition after a forced failure", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const repository = createRepository({ dataDir: dir });

    expect(() => repository.transaction((unitOfWork) => {
      unitOfWork.addConsentEvent(session.id, "user-stop", false, "rolled back");
      unitOfWork.transitionSession(session.id, "closed", "user-stop");
      throw new Error("forced failure");
    })).toThrow("forced failure");

    const unchanged = repository.getSession(session.id);
    expect(unchanged?.state).toBe("setup");
    expect(unchanged?.stoppedAt).toBeNull();
    expect(unchanged?.stopReason).toBeNull();
    expect(unchanged?.consentLog.map((event) => event.scope)).toEqual(["scene-created"]);
    repository.close();
  });

  it("rejects async callbacks and rolls back their synchronous writes", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const repository = createRepository({ dataDir: dir });

    if (false) {
      // @ts-expect-error Transaction callbacks cannot return promises.
      repository.transaction(async () => undefined);
    }
    const unsafeTransaction = repository.transaction as unknown as (
      callback: (unitOfWork: RepositoryUnitOfWork) => unknown,
    ) => unknown;
    expect(() => unsafeTransaction(async (unitOfWork) => {
      unitOfWork.addConsentEvent(session.id, "async-stop", false, "must roll back");
      unitOfWork.transitionSession(session.id, "closed", "async-stop");
      await Promise.resolve();
      unitOfWork.addConsentEvent(session.id, "late-write", false, "must be inactive");
    })).toThrow("repository transaction callbacks must be synchronous");

    const unchanged = repository.getSession(session.id);
    expect(unchanged?.state).toBe("setup");
    expect(unchanged?.stoppedAt).toBeNull();
    expect(unchanged?.consentLog.map((event) => event.scope)).toEqual(["scene-created"]);
    repository.close();
  });

  it("accepts non-callable then properties, rejects inherited callable thenables, and expires failed units of work", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const repository = createRepository({ dataDir: dir });
    const unsafeTransaction = repository.transaction as unknown as (
      callback: (unitOfWork: RepositoryUnitOfWork) => unknown,
    ) => unknown;

    const ownNonCallable = { then: 42, value: "own" };
    expect(unsafeTransaction(() => ownNonCallable)).toBe(ownNonCallable);
    const inheritedNonCallable = Object.create({ then: "not callable" }) as { then: string; value: string };
    inheritedNonCallable.value = "inherited";
    expect(unsafeTransaction(() => inheritedNonCallable)).toBe(inheritedNonCallable);

    const inheritedCallable = Object.create({ then: (resolve: (value: string) => void) => resolve("late") });
    expect(() => unsafeTransaction((unitOfWork) => {
      unitOfWork.addConsentEvent(session.id, "thenable", false, "must roll back");
      return inheritedCallable;
    })).toThrow("repository transaction callbacks must be synchronous");
    expect(repository.getSession(session.id)?.consentLog.map((event) => event.scope)).toEqual(["scene-created"]);

    let captured: RepositoryUnitOfWork | undefined;
    expect(() => repository.transaction((unitOfWork) => {
      captured = unitOfWork;
      throw new Error("callback failed");
    })).toThrow("callback failed");
    expect(() => captured!.getSession(session.id)).toThrow("transaction unit of work is no longer active");
    repository.close();
  });

  it("uses injected clock and IDs for deterministic stop records", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const ids = ["consent-fixed-1", "consent-fixed-2"];
    const repository = createRepository({
      dataDir: dir,
      clock: { now: () => new Date("2030-04-05T06:07:08.000Z") },
      ids: { nextId: () => ids.shift() ?? "consent-fallback" },
    });

    const stopped = repository.stopSession(session.id, "user-stop");
    expect(stopped?.stoppedAt).toBe("2030-04-05T06:07:08.000Z");
    expect(stopped?.stopReason).toBe("user-stop");
    expect(stopped?.consentLog.at(-1)).toEqual({
      id: "consent-fixed-1",
      at: "2030-04-05T06:07:08.000Z",
      scope: "user-stop",
      granted: false,
      note: "User pressed stop; scene closed.",
    });

    const repeated = repository.stopSession(session.id, "other");
    expect(repeated?.stoppedAt).toBe(stopped?.stoppedAt);
    expect(repeated?.stopReason).toBe("user-stop");
    expect(repeated?.consentLog.at(-1)?.id).toBe("consent-fixed-2");
    repository.close();
  });

  it("does not rewrite representative v8 records when opened", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id, title: "preserved" });
    await addMessage(session.id, "user", "preserved message");
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const dbPath = path.join(dir, "velvet.sqlite");
    const readRecords = () => {
      const raw = new DatabaseDriver(dbPath, { readonly: true });
      const records = {
        meta: raw.prepare("SELECT * FROM meta ORDER BY key").all(),
        characters: raw.prepare("SELECT * FROM characters ORDER BY rowid").all(),
        sessions: raw.prepare("SELECT * FROM sessions ORDER BY rowid").all(),
        participants: raw.prepare("SELECT * FROM session_characters ORDER BY rowid").all(),
        consent: raw.prepare("SELECT * FROM consent_events ORDER BY rowid").all(),
        messages: raw.prepare("SELECT * FROM messages ORDER BY rowid").all(),
      };
      raw.close();
      return records;
    };
    const before = readRecords();

    const repository = createRepository({ dataDir: dir });
    repository.close();

    expect(readRecords()).toEqual(before);
  });
});

describe("named character creation", () => {
  it("remains promise-based and persists a character", async () => {
    const pending = createCharacter(characterInput);
    expect(pending).toBeInstanceOf(Promise);

    const character = await pending;
    expect(character).toEqual({
      id: expect.any(String),
      ...characterInput,
      isRealPerson: false,
      createdAt: expect.any(String),
    });
    expect(await listCharacters()).toEqual([character]);
  });
});

describe("factory lore creation", () => {
  it("returns the exact normalized entry and persists ordered character associations", async () => {
    const first = await createCharacter({ ...characterInput, name: "First" });
    const second = await createCharacter({ ...characterInput, name: "Second" });
    const ignored = await createCharacter({ ...characterInput, name: "Ignored" });
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const calls: string[] = [];
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId: () => { calls.push("id"); return "lore-fixed"; } },
      clock: { now: () => { calls.push("clock"); return new Date("2030-04-05T06:07:08.009Z"); } },
    });

    const entry = repository.createLoreEntry({
      characterId: ignored.id,
      characterIds: [second.id, first.id],
      keys: [" alpha ", "", " beta ", "c", "d", "e", "f", "g", "h", "ignored"],
      content: `  ${"x".repeat(1_201)}  `,
      enabled: false,
      insertionOrder: Number.NaN,
    });

    expect(entry).toEqual({
      id: "lore-fixed",
      characterId: second.id,
      characterIds: [second.id, first.id],
      keys: ["alpha", "beta", "c", "d", "e", "f", "g", "h"],
      content: "x".repeat(1_200),
      enabled: false,
      insertionOrder: 100,
      createdAt: "2030-04-05T06:07:08.009Z",
    });
    expect(calls).toEqual(["id", "clock"]);
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT * FROM lore WHERE id = ?").get("lore-fixed")).toEqual({
      id: "lore-fixed",
      character_id: second.id,
      keys: JSON.stringify(entry.keys),
      content: entry.content,
      enabled: 0,
      insertion_order: 100,
      created_at: "2030-04-05T06:07:08.009Z",
    });
    expect(raw.prepare("SELECT character_id FROM lore_characters WHERE lore_id = ? ORDER BY rowid").all("lore-fixed")).toEqual([
      { character_id: second.id },
      { character_id: first.id },
    ]);
    raw.close();
  });

  it("lets explicit characterIds: [] override singular scope with no associations", async () => {
    const character = await createCharacter(characterInput);
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId: () => "global-fixed" },
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    });

    const entry = repository.createLoreEntry({
      characterId: character.id,
      characterIds: [],
      keys: ["global"],
      content: "Everywhere",
      enabled: true,
      insertionOrder: 1,
    });
    expect(entry.characterId).toBeNull();
    expect(entry.characterIds).toEqual([]);
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT character_id FROM lore WHERE id = ?").get(entry.id)).toEqual({ character_id: null });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore_characters WHERE lore_id = ?").get(entry.id) as { count: number }).count).toBe(0);
    raw.close();
  });

  it("does not consume the clock or insert rows when ID generation fails", () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => { throw new Error("ID generator unavailable"); });
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.createLoreEntry({ characterIds: [], keys: [], content: "none", enabled: true, insertionOrder: 0 }))
      .toThrow("ID generator unavailable");
    expect(nextId).toHaveBeenCalledOnce();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore").get() as { count: number }).count).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore_characters").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it("consumes the ID but inserts no rows when the clock fails", () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const nextId = vi.fn(() => "lore-fixed");
    const clockNow = vi.fn(() => { throw new Error("clock unavailable"); });
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.createLoreEntry({ characterIds: [], keys: [], content: "none", enabled: true, insertionOrder: 0 }))
      .toThrow("clock unavailable");
    expect(nextId).toHaveBeenCalledOnce();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore").get() as { count: number }).count).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore_characters").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it.each([
    ["a missing later association", (id: string) => [id, "missing-character"]],
    ["a duplicate direct scope", (id: string) => [id, id]],
  ])("rolls back parent and all associations after %s", async (_label, scope) => {
    const character = await createCharacter(characterInput);
    const dir = process.env.VELVET_DATA_DIR as string;
    closeRepo();
    const nextId = vi.fn(() => "rolled-back-lore");
    const clockNow = vi.fn(() => new Date("2030-01-01T00:00:00.000Z"));
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.createLoreEntry({
      characterIds: scope(character.id),
      keys: ["rollback"],
      content: "Must roll back",
      enabled: true,
      insertionOrder: 1,
    })).toThrow();
    expect(nextId).toHaveBeenCalledOnce();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore").get() as { count: number }).count).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS count FROM lore_characters").get() as { count: number }).count).toBe(0);
    raw.close();
  });

  it("rejects creation after close without consuming dependencies", () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dir, ids: { nextId }, clock: { now: clockNow } });
    repository.close();

    expect(() => repository.createLoreEntry({ characterIds: [], keys: [], content: "none", enabled: true, insertionOrder: 0 }))
      .toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });

  it("preserves insertion-order then rowid listing behavior", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const ids = ["same-first", "lower", "same-second"];
    const repository = createRepository({
      dataDir: dir,
      ids: { nextId: () => ids.shift() ?? "unused" },
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    });
    repository.createLoreEntry({ characterIds: [], keys: ["first"], content: "first", enabled: true, insertionOrder: 5 });
    repository.createLoreEntry({ characterIds: [], keys: ["lower"], content: "lower", enabled: true, insertionOrder: 1 });
    repository.createLoreEntry({ characterIds: [], keys: ["second"], content: "second", enabled: true, insertionOrder: 5 });
    repository.close();

    expect((await listLoreEntries()).map((entry) => entry.id)).toEqual(["lower", "same-first", "same-second"]);
  });

  it("keeps the named wrapper promise-based", () => {
    const pending = createLoreEntry({ characterIds: [], keys: ["named"], content: "Named", enabled: true, insertionOrder: 1 });
    expect(pending).toBeInstanceOf(Promise);
    return expect(pending).resolves.toMatchObject({ characterIds: [], characterId: null, keys: ["named"] });
  });
});

describe("messages", () => {
  it("stores and lists messages in order", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    await addMessage(session.id, "user", "hello");
    await addMessage(session.id, "character", "hi there", {
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, source: "provider", model: "test-model" },
    });
    const messages = await listMessages(session.id);
    expect(messages.map((m) => m.role)).toEqual(["user", "character"]);
    expect(messages[0]?.usage).toBeNull();
    expect(messages[1]?.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120, source: "provider", model: "test-model" });
  });
});

describe("memories", () => {
  it("supports add, approve, list, and forget lifecycle", async () => {
    const character = await createCharacter(characterInput);
    const created = await addMemoryFacts(character.id, [
      { kind: "preference", content: "likes slow pacing", sourceTurnId: "t1", userApproved: false },
      { kind: "fact", content: "has a silver compass", sourceTurnId: "t2", userApproved: true },
    ]);
    expect(created).toHaveLength(2);
    expect(await listApprovedMemories(character.id)).toHaveLength(1);

    const approved = await setMemoryApproval(created[0]!.id, true);
    expect(approved?.userApproved).toBe(true);
    expect(await listApprovedMemories(character.id)).toHaveLength(2);

    const forgotten = await forgetMemory(created[0]!.id);
    expect(forgotten?.forgottenAt).not.toBeNull();
    const all = await listAllMemories(character.id);
    expect(all).toHaveLength(2);
    expect(all.find((memory) => memory.id === created[0]!.id)?.forgottenAt).not.toBeNull();
    expect(await listApprovedMemories(character.id)).toHaveLength(1);
    expect(await forgetMemory(created[0]!.id)).toBeNull();
  });

  it("respects the approved memory limit", async () => {
    const character = await createCharacter(characterInput);
    await addMemoryFacts(
      character.id,
      Array.from({ length: 5 }, (_, i) => ({
        kind: "fact" as const,
        content: `fact ${i}`,
        sourceTurnId: `t${i}`,
        userApproved: true,
      })),
    );
    expect(await listApprovedMemories(character.id, 3)).toHaveLength(3);
  });

  it("does not duplicate an active memory for the same character", async () => {
    const character = await createCharacter(characterInput);
    const fact = { kind: "fact" as const, content: "Keeps a silver key", sourceTurnId: "t1", userApproved: true };
    expect(await addMemoryFacts(character.id, [fact, { ...fact, sourceTurnId: "t2" }])).toHaveLength(1);
    expect(await addMemoryFacts(character.id, [{ ...fact, content: " keeps A SILVER key ", sourceTurnId: "t3" }])).toHaveLength(0);
    expect(await listAllMemories(character.id)).toHaveLength(1);
  });
});

describe("summaries", () => {
  it("upserts summaries per session", async () => {
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    expect(await getSummary(session.id)).toBeNull();
    await upsertSummary(session.id, { summary: "first", keyEvents: ["a"], emotionalBeat: "steady" });
    const updated = await upsertSummary(session.id, { summary: "second", keyEvents: ["a", "b"], emotionalBeat: "warm" });
    expect(updated.summary).toBe("second");
    const stored = await getSummary(session.id);
    expect(stored?.summary).toBe("second");
    expect(stored?.keyEvents).toEqual(["a", "b"]);
  });
});

describe("lore", () => {
  it("creates entries with clamps and scoping", async () => {
    const character = await createCharacter(characterInput);
    const global = await createLoreEntry({
      characterId: null,
      keys: [" nebula ", ""],
      content: "  The nebula glows.  ",
      enabled: true,
      insertionOrder: 1,
    });
    expect(global.keys).toEqual(["nebula"]);
    expect(global.content).toBe("The nebula glows.");

    await createLoreEntry({ characterId: character.id, keys: ["compass"], content: "A silver compass.", enabled: true, insertionOrder: 2 });
    const other = await createCharacter({ ...characterInput, name: "Other" });
    await createLoreEntry({ characterId: other.id, keys: ["other"], content: "Not yours.", enabled: true, insertionOrder: 3 });

    const scoped = await listLoreEntries(character.id);
    expect(scoped.map((e) => e.keys[0])).toEqual(["nebula", "compass"]);
    const all = await listLoreEntries();
    expect(all).toHaveLength(3);
  });
});

describe("settings", () => {
  it("round-trips harness settings with clamps", async () => {
    const defaults = await getHarnessSettings();
    expect(defaults.recentTurns).toBe(32);
    const updated = await updateHarnessSettings({
      personaPreamble: " grounded tone ",
      systemPrompt: "x".repeat(70_000),
      recentTurns: 999,
      memoryChars: 1,
      temperature: 42,
    });
    expect(updated.personaPreamble).toBe("grounded tone");
    expect(updated.systemPrompt).toHaveLength(64_000);
    expect(updated.recentTurns).toBe(32);
    expect(updated.memoryChars).toBe(200);
    expect(updated.temperature).toBe(2);
    const reread = await getHarnessSettings();
    expect(reread.recentTurns).toBe(32);
    const cleared = await updateHarnessSettings({ temperature: null });
    expect(cleared.temperature).toBeNull();
  });

  it("round-trips provider settings with clamps and key redaction", async () => {
    const updated = await updateProviderSettings({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: " test-model ",
      apiKey: "sk-secret-value",
      samplers: { maxTokens: 999999, topP: 2, stopStrings: ["halt", "", "x".repeat(200)] },
    });
    expect(updated.hasApiKey).toBe(true);
    expect("apiKey" in updated).toBe(false);
    expect(updated.samplers.maxTokens).toBe(32768);
    expect(updated.samplers.topP).toBe(1);
    expect(updated.samplers.stopStrings).toEqual(["halt", "x".repeat(80)]);

    const internal = await getProviderSettings();
    expect(internal.apiKey).toBe("sk-secret-value");
    const publicView = await getPublicProviderSettings();
    expect(publicView.hasApiKey).toBe(true);
    expect(JSON.stringify(publicView)).not.toContain("sk-secret-value");
  });
});

describe("factory harness settings updates", () => {
  it("returns an exact deterministic result and durably stores its payload without consuming an ID", () => {
    const dir = makeTmpDataDir();
    const clockNow = vi.fn(() => new Date("2030-04-05T06:07:08.009Z"));
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dir, clock: { now: clockNow }, ids: { nextId } });

    const settings = repository.updateHarnessSettings({
      personaPreamble: " grounded tone ",
      recentTurns: 9.8,
      temperature: 0.375,
      promptOverrides: { "character.final": "Final {{target.name}}" },
    });

    expect(settings).toEqual({
      id: "harness",
      systemPrompt: "",
      personaPreamble: "grounded tone",
      styleGuide: "",
      postHistoryInstructions: "",
      recentTurns: 9,
      memoryChars: 2400,
      summaryChars: 1600,
      loreChars: 1600,
      temperature: 0.375,
      promptOverrides: { "character.final": "Final {{target.name}}" },
      updatedAt: "2030-04-05T06:07:08.009Z",
    });
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT id, payload FROM settings WHERE id = 'harness'").get()).toEqual({
      id: "harness",
      payload: JSON.stringify(settings),
    });
    raw.close();
  });

  it("uses successive clock values while preserving omitted fields", () => {
    const clockNow = vi.fn()
      .mockReturnValueOnce(new Date("2030-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:00.000Z"));
    const repository = createRepository({ dataDir: makeTmpDataDir(), clock: { now: clockNow } });

    const first = repository.updateHarnessSettings({ styleGuide: "retained", memoryChars: 345.9 });
    const second = repository.updateHarnessSettings({ recentTurns: 7 });

    expect(first.updatedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(second).toMatchObject({
      styleGuide: "retained",
      memoryChars: 345,
      recentTurns: 7,
      updatedAt: "2031-01-01T00:00:00.000Z",
    });
    expect(clockNow).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it.each([
    ["empty", {}],
    ["array", []],
    ["unknown-only", { unknown: "value" }],
  ])("accepts a %s no-op write and gives it a fresh timestamp", (_label, patch) => {
    const clockNow = vi.fn()
      .mockReturnValueOnce(new Date("2030-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2030-01-02T00:00:00.000Z"));
    const repository = createRepository({ dataDir: makeTmpDataDir(), clock: { now: clockNow } });
    const seeded = repository.updateHarnessSettings({ styleGuide: "retained" });

    const updated = repository.updateHarnessSettings(patch as UpdateHarnessInput);

    expect(updated).toEqual({ ...seeded, updatedAt: "2030-01-02T00:00:00.000Z" });
    expect(clockNow).toHaveBeenCalledTimes(2);
    repository.close();
  });

  it("leaves the prior payload unchanged when the clock fails", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const prior = await updateHarnessSettings({ styleGuide: "prior" });
    closeRepo();
    const repository = createRepository({
      dataDir: dir,
      clock: { now: vi.fn(() => { throw new Error("clock unavailable"); }) },
    });

    expect(() => repository.updateHarnessSettings({ styleGuide: "must not persist" })).toThrow("clock unavailable");
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(raw.prepare("SELECT payload FROM settings WHERE id = 'harness'").get()).toEqual({ payload: JSON.stringify(prior) });
    raw.close();
  });

  it.each([
    ["non-string text", { styleGuide: null }],
    ["null prompt overrides", { promptOverrides: null }],
  ])("fails a malformed %s patch before consuming the clock", (_label, patch) => {
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: makeTmpDataDir(), clock: { now: clockNow } });

    expect(() => repository.updateHarnessSettings(patch as unknown as UpdateHarnessInput)).toThrow();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it("rejects an update after close before consuming dependencies", () => {
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: makeTmpDataDir(),
      clock: { now: clockNow },
      ids: { nextId },
    });
    repository.close();

    expect(() => repository.updateHarnessSettings({ styleGuide: "closed" })).toThrow("repository is closed");
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
  });

  it("keeps the named wrapper asynchronous and on the system clock", async () => {
    await getHarnessSettings();
    const clockNow = vi.spyOn(systemRuntime.clock, "now").mockReturnValue(new Date("2032-03-04T05:06:07.008Z"));
    try {
      const pending = updateHarnessSettings({ postHistoryInstructions: "Named update" });
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toMatchObject({
        postHistoryInstructions: "Named update",
        updatedAt: "2032-03-04T05:06:07.008Z",
      });
      expect(clockNow).toHaveBeenCalledOnce();
      expect(await getHarnessSettings()).toMatchObject({
        postHistoryInstructions: "Named update",
        updatedAt: "2032-03-04T05:06:07.008Z",
      });
    } finally {
      clockNow.mockRestore();
    }
  });
});

describe("foreign key safety", () => {
  it("prevents direct character deletion when session history references it", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const character = await createCharacter(characterInput);
    const session = await createSession({ characterId: character.id });
    await addMessage(session.id, "user", "hello");
    await addMemoryFacts(character.id, [{ kind: "fact", content: "compass", sourceTurnId: "t1", userApproved: true }]);
    await upsertSummary(session.id, { summary: "s", keyEvents: [], emotionalBeat: "steady" });

    closeRepo();
    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    raw.pragma("foreign_keys = ON");
    expect(() => raw.prepare("DELETE FROM characters WHERE id = ?").run(character.id)).toThrow(/FOREIGN KEY/);
    const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("sessions")).toBe(1);
    expect(count("messages")).toBe(1);
    expect(count("memories")).toBe(1);
    expect(count("summaries")).toBe(1);
    expect(count("consent_events")).toBe(1);
    raw.close();
  });

  it("cascades only the deleted session's dependent rows", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    const removedCharacter = await createCharacter({ ...characterInput, name: "Removed" });
    const keptCharacter = await createCharacter({ ...characterInput, name: "Kept" });
    const removed = await createSession({ characterId: removedCharacter.id });
    const kept = await createSession({ characterId: keptCharacter.id });
    await addMessage(removed.id, "user", "removed message");
    await addMessage(kept.id, "user", "kept message");
    await addConsentEvent(removed.id, "extra", true, "removed event");
    await addConsentEvent(kept.id, "extra", true, "kept event");
    await upsertSummary(removed.id, { summary: "removed", keyEvents: [], emotionalBeat: "steady" });
    await upsertSummary(kept.id, { summary: "kept", keyEvents: [], emotionalBeat: "steady" });

    expect(await deleteSession(removed.id)).toBe(true);
    expect(await deleteSession(removed.id)).toBe(false);
    closeRepo();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const count = (table: string, sessionId: string) =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId) as { n: number }).n;
    expect((raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(removed.id) as { n: number }).n).toBe(0);
    expect(count("session_characters", removed.id)).toBe(0);
    expect(count("messages", removed.id)).toBe(0);
    expect(count("summaries", removed.id)).toBe(0);
    expect(count("consent_events", removed.id)).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(kept.id) as { n: number }).n).toBe(1);
    expect(count("session_characters", kept.id)).toBe(1);
    expect(count("messages", kept.id)).toBe(1);
    expect(count("summaries", kept.id)).toBe(1);
    expect(count("consent_events", kept.id)).toBe(2);
    raw.close();
  });
});

describe("legacy migration", () => {
  it("migrates db.json into SQLite and renames it to db.json.migrated", async () => {
    const dir = makeTmpDataDir();
    const legacy = {
      characters: [
        {
          id: "char-1",
          name: "Legacy Aria",
          age: 31,
          archetype: "archivist",
          boundaries: "fictional only",
                    fictionalConfirmed: true,
          isRealPerson: false,
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      sessions: [
        {
          id: "sess-1",
          characterId: "char-1",
          title: "legacy scene",
          state: "closed",
          presetId: "immersive",
          consentLog: [{ id: "ce-1", at: "2025-01-01T00:00:00.000Z", scope: "scene-created", granted: true, note: "seed" }],
          createdAt: "2025-01-01T00:00:00.000Z",
          stoppedAt: "2025-01-02T00:00:00.000Z",
          stopReason: "user-stop",
        },
      ],
      messages: [
        { id: "msg-1", sessionId: "sess-1", role: "user", content: "hello", createdAt: "2025-01-01T00:01:00.000Z" },
        { id: "msg-2", sessionId: "sess-1", role: "character", content: "greetings", createdAt: "2025-01-01T00:02:00.000Z" },
      ],
      memories: [
        {
          id: "mem-1",
          characterId: "char-1",
          kind: "fact",
          content: "collects maps",
          sourceTurnId: "msg-1",
          createdAt: "2025-01-01T00:03:00.000Z",
          userApproved: true,
          forgottenAt: null,
        },
      ],
      summaries: [
        { sessionId: "sess-1", summary: "legacy summary", keyEvents: ["a", "b"], emotionalBeat: "calm", updatedAt: "2025-01-01T00:04:00.000Z" },
      ],
      lore: [
        {
          id: "lore-1",
          characterId: "char-1",
          keys: ["map"],
          content: "The archive holds every map.",
          enabled: true,
          insertionOrder: 5,
          createdAt: "2025-01-01T00:05:00.000Z",
        },
      ],
      settings: {
        id: "harness",
        personaPreamble: "legacy preamble",
        styleGuide: "legacy style",
        postHistoryInstructions: "",
        recentTurns: 9,
        memoryChars: 800,
        summaryChars: 600,
        loreChars: 500,
        temperature: 0.7,
        updatedAt: "2025-01-01T00:06:00.000Z",
      },
      provider: {
        id: "provider",
        providerType: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "legacy-model",
        apiKey: "legacy-key",
        streaming: true,
        samplers: { maxTokens: 256, topP: 0.9, topK: null, minP: null, repetitionPenalty: null, stopStrings: ["halt"], startReplyWith: "" },
        updatedAt: "2025-01-01T00:07:00.000Z",
      },
    } as unknown as Database;
    writeFileSync(path.join(dir, "db.json"), JSON.stringify(legacy, null, 2), "utf8");
    closeRepo();

    const characters = await listCharacters();
    expect(characters).toHaveLength(1);
    expect(characters[0]?.name).toBe("Legacy Aria");
    expect(characters[0]?.createdAt).toBe("2025-01-01T00:00:00.000Z");

    const messages = await listMessages("sess-1");
    expect(messages.map((m) => m.content)).toEqual(["hello", "greetings"]);

    const memories = await listApprovedMemories("char-1");
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toBe("collects maps");

    const summary = await getSummary("sess-1");
    expect(summary?.keyEvents).toEqual(["a", "b"]);

    const lore = await listLoreEntries("char-1");
    expect(lore).toHaveLength(1);
    expect(lore[0]?.insertionOrder).toBe(5);

    const settings = await getHarnessSettings();
    expect(settings.personaPreamble).toBe("legacy preamble");
    expect(settings.recentTurns).toBe(9);
    expect(settings.temperature).toBe(0.7);

    const provider = await getProviderSettings();
    expect(provider.apiKey).toBe("legacy-key");
    expect(provider.samplers.maxTokens).toBe(256);

    expect(existsSync(path.join(dir, "db.json"))).toBe(false);
    const migrated = JSON.parse(readFileSync(path.join(dir, "db.json.migrated"), "utf8")) as Database;
    expect(migrated.characters[0]?.id).toBe("char-1");

    const meta = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const migratedAt = meta.prepare("SELECT value FROM meta WHERE key = 'legacyMigratedAt'").get() as
      | { value: string }
      | undefined;
    expect(migratedAt?.value).toBeTruthy();
    meta.close();

    const session = await transitionSession("sess-1", "closed", "again");
    expect(session?.stoppedAt).toBe("2025-01-02T00:00:00.000Z");
  });

  it("uses injected provenance for sparse legacy sessions and settings", () => {
    const dir = makeTmpDataDir();
    const fixedNow = "2030-04-05T06:07:08.009Z";
    writeFileSync(path.join(dir, "db.json"), JSON.stringify({
      characters: [{
        id: "char-sparse",
        name: "Sparse Aria",
        age: 31,
        archetype: "archivist",
        boundaries: "fictional only",
                fictionalConfirmed: true,
        isRealPerson: false,
        createdAt: "2025-01-01T00:00:00.000Z",
      }],
      sessions: [{ characterId: "char-sparse", title: "sparse scene" }],
      settings: { personaPreamble: "sparse harness" },
      provider: { model: "sparse-model" },
    }), "utf8");
    const nextId = vi.fn(() => "session-generated");

    const repository = createRepository({
      dataDir: dir,
      clock: { now: () => new Date(fixedNow) },
      ids: { nextId },
    });
    expect(repository.getSession("session-generated")?.createdAt).toBe(fixedNow);
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const harness = JSON.parse((raw.prepare("SELECT payload FROM settings WHERE id = 'harness'").get() as { payload: string }).payload) as
      Database["settings"];
    const provider = JSON.parse((raw.prepare("SELECT payload FROM provider WHERE id = 'provider'").get() as { payload: string }).payload) as
      Database["provider"];
    const migratedAt = raw.prepare("SELECT value FROM meta WHERE key = 'legacyMigratedAt'").get() as { value: string };
    expect(harness.personaPreamble).toBe("sparse harness");
    expect(harness.updatedAt).toBe(fixedNow);
    expect(provider.model).toBe("sparse-model");
    expect(provider.updatedAt).toBe(fixedNow);
    expect(migratedAt.value).toBe(fixedNow);
    expect(nextId).toHaveBeenCalledOnce();
    raw.close();
  });

  it("preserves supplied legacy IDs and timestamps without consuming fallback IDs", () => {
    const dir = makeTmpDataDir();
    writeFileSync(path.join(dir, "db.json"), JSON.stringify({
      characters: [{
        id: "char-complete",
        name: "Complete Aria",
        age: 31,
        archetype: "archivist",
        boundaries: "fictional only",
                fictionalConfirmed: true,
        isRealPerson: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      }],
      sessions: [{
        id: "session-supplied",
        characterId: "char-complete",
        createdAt: "2024-02-03T04:05:06.007Z",
      }],
      settings: { updatedAt: "2024-03-04T05:06:07.008Z" },
      provider: { updatedAt: "2024-04-05T06:07:08.009Z" },
    }), "utf8");
    const nextId = vi.fn(() => "must-not-be-used");
    const clockNow = vi.fn(() => new Date("2035-01-01T00:00:00.000Z"));

    const repository = createRepository({
      dataDir: dir,
      clock: { now: clockNow },
      ids: { nextId },
    });
    expect(repository.getSession("session-supplied")?.createdAt).toBe("2024-02-03T04:05:06.007Z");
    repository.close();

    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    const harness = JSON.parse((raw.prepare("SELECT payload FROM settings WHERE id = 'harness'").get() as { payload: string }).payload) as
      Database["settings"];
    const provider = JSON.parse((raw.prepare("SELECT payload FROM provider WHERE id = 'provider'").get() as { payload: string }).payload) as
      Database["provider"];
    expect(harness.updatedAt).toBe("2024-03-04T05:06:07.008Z");
    expect(provider.updatedAt).toBe("2024-04-05T06:07:08.009Z");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).toHaveBeenCalledOnce();
    raw.close();
  });

  it("warns and leaves db.json untouched when migration is skipped", async () => {
    const dir = process.env.VELVET_DATA_DIR as string;
    await createCharacter(characterInput);
    writeFileSync(path.join(dir, "db.json"), JSON.stringify({ characters: [], sessions: [] }), "utf8");
    closeRepo();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const characters = await listCharacters();
      expect(characters).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toMatch(/migration was skipped/);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(path.join(dir, "db.json"))).toBe(true);
  });

  it("quarantines corrupt db.json and starts empty", async () => {
    const dir = makeTmpDataDir();
    writeFileSync(path.join(dir, "db.json"), "{ not json !!!", "utf8");
    closeRepo();
    expect(await listCharacters()).toEqual([]);
    expect(existsSync(path.join(dir, "db.json"))).toBe(false);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith("db.json.corrupt-"))).toBe(true);
  });

  it("uses the injected clock for the exact corrupt quarantine filename", () => {
    const dir = makeTmpDataDir();
    const fixedNow = new Date("2030-04-05T06:07:08.009Z");
    writeFileSync(path.join(dir, "db.json"), "{ not json !!!", "utf8");

    const repository = createRepository({
      dataDir: dir,
      clock: { now: () => fixedNow },
      ids: { nextId: () => "unused" },
    });
    repository.close();

    expect(existsSync(path.join(dir, `db.json.corrupt-${fixedNow.getTime()}`))).toBe(true);
    expect(existsSync(path.join(dir, "db.json"))).toBe(false);
  });

  it("leaves valid legacy JSON retryable when fallback generation fails", () => {
    const dir = makeTmpDataDir();
    const legacyPath = path.join(dir, "db.json");
    writeFileSync(legacyPath, JSON.stringify({ sessions: [{}] }), "utf8");

    expect(() => createRepository({
      dataDir: dir,
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
      ids: { nextId: () => { throw new Error("ID generator unavailable"); } },
    })).toThrow("ID generator unavailable");

    expect(existsSync(legacyPath)).toBe(true);
    const files = readdirSync(dir);
    expect(files.some((file) => file.startsWith("db.json.corrupt-"))).toBe(false);
  });

  it("rolls back a failed legacy import and leaves db.json retryable", () => {
    const dir = makeTmpDataDir();
    const legacyPath = path.join(dir, "db.json");
    const duplicateCharacter = {
      id: "duplicate",
      name: "Duplicate",
      age: 31,
      archetype: "archivist",
      boundaries: "fictional only",
            fictionalConfirmed: true,
      isRealPerson: false,
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    writeFileSync(legacyPath, JSON.stringify({ characters: [duplicateCharacter, duplicateCharacter] }), "utf8");

    expect(() => createRepository({
      dataDir: dir,
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
      ids: { nextId: () => "unused" },
    })).toThrow();

    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(path.join(dir, "db.json.migrated"))).toBe(false);
    const raw = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS count FROM characters").get() as { count: number }).count).toBe(0);
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'legacyMigratedAt'").get()).toBeUndefined();
    raw.close();
  });
});
