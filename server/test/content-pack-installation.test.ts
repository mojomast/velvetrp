import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InstallContentPackInput } from "@velvet/contracts";
import { createRepository } from "../src/repo/index.js";
import { createCorruptionTestRepository, makeTmpDataDir, useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const ownerId = "application-owner";
const metadata = {
  name: "Wayfinder",
  description: "A compact original rules entry.",
  tags: ["core", "ordered", "ordered"],
};
const input: InstallContentPackInput = {
  packId: "velvet-starter",
  packVersion: "1.0.0",
  rulesProfileId: "velvet-core",
  rulesProfile: {
    name: "Velvet Core",
    description: "Core profile metadata.",
    tags: ["profile", "ordered"],
  },
  name: "Velvet Starter",
  description: "Starter pack metadata.",
  tags: ["pack", "ordered", "ordered"],
  classes: [
    { definitionId: "fighter", kind: "class", ...metadata },
    { definitionId: "wizard", kind: "class", ...metadata, name: "Wizard" },
  ],
  races: [{ definitionId: "human", kind: "race", ...metadata }],
  backgrounds: [{ definitionId: "sage", kind: "background", ...metadata }],
  items: [{ definitionId: "rope", kind: "item", ...metadata }],
  spells: [{ definitionId: "bolt", kind: "spell", ...metadata }],
  abilities: [{ definitionId: "action", kind: "ability", ...metadata }],
  enemies: [{ definitionId: "dragon", kind: "enemy", ...metadata }],
};

function dbPath(dir = process.env.VELVET_DATA_DIR as string): string {
  return path.join(dir, "velvet.sqlite");
}

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function initializeOwner(dir = process.env.VELVET_DATA_DIR as string): void {
  const initial = createRepository({ dataDir: dir });
  initial.close();
  const db = new DatabaseDriver(dbPath(dir));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, 'Application owner', 0)").run(ownerId);
  db.prepare("UPDATE application_owner SET principal_id = ? WHERE singleton = 1").run(ownerId);
  db.close();
}

function contentSnapshot(dir = process.env.VELVET_DATA_DIR as string): Record<string, unknown> {
  const db = new DatabaseDriver(dbPath(dir), { readonly: true });
  const result = {
    profiles: db.prepare("SELECT * FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
    packs: db.prepare("SELECT * FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
    definitions: db.prepare("SELECT * FROM rpg_definitions ORDER BY rowid").all(),
    selections: db.prepare("SELECT * FROM campaign_rules_profiles").all(),
    pins: db.prepare("SELECT * FROM campaign_content_packs").all(),
  };
  db.close();
  return result;
}

function changedDefinition(
  patch: Partial<InstallContentPackInput["classes"][number]>,
): InstallContentPackInput {
  return { ...input, classes: [{ ...input.classes[0]!, ...patch }, input.classes[1]!] };
}

function installationStatements(
  pack: InstallContentPackInput,
  options: { includeProfile: boolean; persistedName?: string },
): Array<{ sql: string; params: unknown[] }> {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  if (options.includeProfile) {
    statements.push({
      sql: `INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags) VALUES (?, ?, ?, ?)`,
      params: [pack.rulesProfileId, pack.rulesProfile.name, pack.rulesProfile.description, JSON.stringify(pack.rulesProfile.tags)],
    });
  }
  statements.push({
    sql: `INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    params: [
      pack.packId, pack.packVersion, pack.rulesProfileId, options.persistedName ?? pack.name,
      pack.description, JSON.stringify(pack.tags),
    ],
  });
  for (const definition of [
    ...pack.classes, ...pack.races, ...pack.backgrounds, ...pack.items,
    ...pack.spells, ...pack.abilities, ...pack.enemies,
  ]) {
    statements.push({
      sql: `INSERT INTO rpg_definitions
        (pack_id, pack_version, kind, definition_id, name, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        pack.packId, pack.packVersion, definition.kind, definition.definitionId,
        definition.name, definition.description, JSON.stringify(definition.tags),
      ],
    });
  }
  statements.push({
    sql: "UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = ? AND pack_version = ? AND sealed = 0",
    params: [pack.packId, pack.packVersion],
  });
  return statements;
}

describe("content-pack installation", () => {
  it("installs a complete pack in contract-kind and supplied order without dependencies or campaign pins", () => {
    initializeOwner();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: dataDir(),
      clock: { now },
      ids: { nextId },
    });

    expect(repository.installContentPack(ownerId, input)).toEqual({
      packId: input.packId,
      packVersion: input.packVersion,
      rulesProfileId: input.rulesProfileId,
      name: input.name,
      description: input.description,
      tags: input.tags,
    });
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const snapshot = contentSnapshot();
    expect(snapshot.profiles).toEqual([{
      rules_profile_id: input.rulesProfileId,
      name: input.rulesProfile.name,
      description: input.rulesProfile.description,
      tags: JSON.stringify(input.rulesProfile.tags),
    }]);
    expect((snapshot.definitions as Array<{ kind: string; definition_id: string }>).map(
      ({ kind, definition_id }) => `${kind}:${definition_id}`,
    )).toEqual([
      "class:fighter", "class:wizard", "race:human", "background:sage", "item:rope",
      "spell:bolt", "ability:action", "enemy:dragon",
    ]);
    expect(snapshot.selections).toEqual([]);
    expect(snapshot.pins).toEqual([]);
  });

  it("allows only the exact current application owner and discloses no collision state to denied roles", () => {
    initializeOwner();
    const db = new DatabaseDriver(dbPath());
    for (const id of ["campaign-owner", "campaign-gm", "campaign-player", "campaign-observer", "next-owner"]) {
      db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, id);
    }
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    repository.installContentPack(ownerId, input);

    for (const denied of ["local-owner", "campaign-owner", "campaign-gm", "campaign-player", "campaign-observer", "missing-principal"]) {
      expect(() => repository.installContentPack(denied, input))
        .toThrow("content pack installation requires the application owner");
      expect(() => repository.installContentPack(denied, { ...input, packId: "not-installed" }))
        .toThrow("content pack installation requires the application owner");
    }

    const transfer = new DatabaseDriver(dbPath());
    transfer.prepare("UPDATE application_owner SET principal_id = 'next-owner' WHERE singleton = 1").run();
    transfer.close();
    expect(() => repository.installContentPack(ownerId, input))
      .toThrow("content pack installation requires the application owner");
    expect(repository.installContentPack("next-owner", input).packId).toBe(input.packId);
    repository.close();
  });

  it("returns an existing pack only for an exactly equivalent complete retry regardless of definition order", () => {
    initializeOwner();
    const repository = createRepository({ dataDir: dataDir() });
    const installed = repository.installContentPack(ownerId, input);
    const reordered = {
      ...input,
      classes: [...input.classes].reverse(),
      races: [...input.races].reverse(),
    };
    expect(repository.installContentPack(ownerId, reordered)).toEqual(installed);
    expect((contentSnapshot().definitions as unknown[])).toHaveLength(8);

    const mutations: InstallContentPackInput[] = [
      { ...input, rulesProfile: { ...input.rulesProfile, name: "Changed profile" } },
      { ...input, rulesProfile: { ...input.rulesProfile, tags: [...input.rulesProfile.tags].reverse() } },
      { ...input, name: "Changed pack" },
      { ...input, rulesProfileId: "other-profile", rulesProfile: { ...input.rulesProfile, name: "Other" } },
      { ...input, tags: [...input.tags].reverse() },
      changedDefinition({ name: "Changed definition" }),
      changedDefinition({ tags: [...input.classes[0]!.tags].reverse() }),
      { ...input, classes: [input.classes[0]!] },
      { ...input, classes: [...input.classes, { ...input.classes[0]!, definitionId: "rogue" }] },
    ];
    for (const mutation of mutations) {
      expect(() => repository.installContentPack(ownerId, mutation)).toThrow(/conflict.*installed/);
    }
    expect(contentSnapshot().definitions).toHaveLength(8);
    repository.close();
  });

  it("accepts the same definition ID in different kinds but rejects same-kind duplicates before SQL", () => {
    initializeOwner();
    const repository = createRepository({ dataDir: dataDir() });
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const duplicate: InstallContentPackInput = {
      ...input,
      classes: [input.classes[0]!, { ...input.classes[0]!, name: "Duplicate" }],
    };
    try {
      expect(() => repository.installContentPack(ownerId, duplicate)).toThrow("duplicate class definitionId");
      expect(transaction).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
      prepare.mockRestore();
    }

    const crossKind = {
      ...input,
      races: [{ ...input.races[0]!, definitionId: input.classes[0]!.definitionId }],
    };
    expect(repository.installContentPack(ownerId, crossKind).packId).toBe(input.packId);
    expect(contentSnapshot().definitions).toHaveLength(8);
    repository.close();
  });

  it("requires exact existing profile metadata and leaves an unreferenced matching profile reusable", () => {
    initializeOwner();
    const db = new DatabaseDriver(dbPath());
    db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
      VALUES (?, ?, ?, ?)`).run(
        input.rulesProfileId,
        input.rulesProfile.name,
        input.rulesProfile.description,
        JSON.stringify(input.rulesProfile.tags),
      );
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.installContentPack(ownerId, input).rulesProfileId).toBe(input.rulesProfileId);
    repository.close();

    const otherDir = makeTmpDataDir();
    initializeOwner(otherDir);
    const conflictDb = new DatabaseDriver(dbPath(otherDir));
    conflictDb.prepare(`INSERT INTO rpg_rules_profiles VALUES (?, 'Different', 'Core profile metadata.', ?)`)
      .run(input.rulesProfileId, JSON.stringify(input.rulesProfile.tags));
    conflictDb.close();
    const conflict = createRepository({ dataDir: otherDir });
    expect(() => conflict.installContentPack(ownerId, input))
      .toThrow("rules profile metadata conflicts with the installed profile");
    expect(contentSnapshot(otherDir).packs).toEqual([]);
    conflict.close();
  });

  it("rolls back profile, pack, and every definition on profile, pack, or mid-definition SQL failure", () => {
    for (const [stage, trigger] of [
      ["profile", `CREATE TRIGGER fail_install BEFORE INSERT ON rpg_rules_profiles
        BEGIN SELECT RAISE(ABORT, 'injected profile failure'); END`],
      ["pack", `CREATE TRIGGER fail_install BEFORE INSERT ON rpg_content_packs
        BEGIN SELECT RAISE(ABORT, 'injected pack failure'); END`],
      ["definition", `CREATE TRIGGER fail_install BEFORE INSERT ON rpg_definitions WHEN NEW.kind = 'ability'
        BEGIN SELECT RAISE(ABORT, 'injected definition failure'); END`],
    ] as const) {
      const dir = makeTmpDataDir();
      initializeOwner(dir);
      const db = new DatabaseDriver(dbPath(dir));
      db.exec(trigger);
      db.close();
      const repository = createCorruptionTestRepository({ dataDir: dir });
      expect(() => repository.installContentPack(ownerId, input)).toThrow(`injected ${stage} failure`);
      expect(contentSnapshot(dir)).toEqual({ profiles: [], packs: [], definitions: [], selections: [], pins: [] });
      repository.close();
    }
  });

  it("waits on a competing writer, then converges or reports the committed conflict without retry", async () => {
    initializeOwner();
    const repository = createRepository({ dataDir: dataDir() });
    const exactWriter = await startLockedWrite(dbPath(), installationStatements(input, { includeProfile: true }));
    const exactStarted = Date.now();
    expect(repository.installContentPack(ownerId, input).packId).toBe(input.packId);
    expect(Date.now() - exactStarted).toBeGreaterThanOrEqual(75);
    await exactWriter.done;
    expect(contentSnapshot().packs).toHaveLength(1);

    const other = { ...input, packId: "other-pack" };
    const conflictWriter = await startLockedWrite(
      dbPath(),
      installationStatements(other, { includeProfile: false, persistedName: "Competing metadata" }),
    );
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const conflictStarted = Date.now();
    expect(() => repository.installContentPack(ownerId, other))
      .toThrow("content pack metadata conflicts with the installed pack");
    expect(Date.now() - conflictStarted).toBeGreaterThanOrEqual(75);
    expect(transaction).toHaveBeenCalledOnce();
    await conflictWriter.done;
    transaction.mockRestore();
    repository.close();
  });

  it("checks lifecycle, actor, input, and nested-transaction guards in dependency-safe order and excludes UoW", () => {
    initializeOwner();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: dataDir(),
      clock: { now },
      ids: { nextId },
    });
    const poisonInput = { get packId(): string { throw new Error("input was read"); } } as InstallContentPackInput;
    expect(() => repository.installContentPack("bad actor", poisonInput)).not.toThrow("input was read");
    expect(() => repository.installContentPack(ownerId, { ...input, path: "pack.json" } as never)).toThrow();
    expect(() => repository.transaction(() => repository.installContentPack(ownerId, input)))
      .toThrow("content pack installation cannot run inside a repository transaction");
    repository.transaction((unitOfWork) => {
      expect("installContentPack" in unitOfWork).toBe(false);
      // @ts-expect-error Installation intentionally is not a unit-of-work operation.
      expect(unitOfWork.installContentPack).toBeUndefined();
    });
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
    expect(() => repository.installContentPack("bad actor", poisonInput)).toThrow("repository is closed");
  });

  it("rejects direct SQL append after sealing and leaves an exact repository retry unchanged", () => {
    initializeOwner();
    const repository = createRepository({ dataDir: dataDir() });
    repository.installContentPack(ownerId, input);
    expect("appendContentPackDefinition" in repository).toBe(false);

    const db = new DatabaseDriver(dbPath());
    expect(() => db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES (?, ?, 'class', 'sql-appended', 'SQL append', 'Unsupported direct SQL', '[]')`)
      .run(input.packId, input.packVersion)).toThrow("sealed RPG content packs cannot accept definitions");
    db.close();
    expect(repository.installContentPack(ownerId, input).packId).toBe(input.packId);
    expect(contentSnapshot().definitions).toHaveLength(8);
    repository.close();
  });
});
