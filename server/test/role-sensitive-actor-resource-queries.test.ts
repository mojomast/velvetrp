import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as repoModule from "../src/repo.js";
import { createRepository } from "../src/repo.js";
import type { RepositoryUnitOfWork } from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const BEFORE = "2030-04-05T06:07:08.009Z";
const AT = "2030-04-05T06:07:09.010Z";

function dbPath(): string {
  return path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
}

function seed() {
  createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }).close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO principals VALUES
    ('gm', 'GM', 0), ('player', 'Player', 0), ('observer', 'Observer', 0),
    ('nonmember', 'Nonmember', 0), ('application-only', 'Application only', 0)`).run();
  db.prepare("UPDATE application_owner SET principal_id = 'application-only' WHERE singleton = 1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at) VALUES
      ('campaign-one', 'One', 'timeline-one', 'local-owner', ?, ?),
      ('campaign-two', 'Two', 'timeline-two', 'local-owner', ?, ?)`).run(BEFORE, BEFORE, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES
      ('timeline-one', 'campaign-one', ?), ('timeline-two', 'campaign-two', ?)`).run(BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_memberships VALUES
      ('campaign-one', 'local-owner', 'owner', ?), ('campaign-one', 'gm', 'gm', ?),
      ('campaign-one', 'player', 'player', ?), ('campaign-one', 'observer', 'observer', ?),
      ('campaign-two', 'local-owner', 'owner', ?)`).run(BEFORE, BEFORE, BEFORE, BEFORE, BEFORE);
  })();
  db.prepare(`INSERT INTO characters VALUES
    ('persona-one', 'One', 30, 'hero', '', 'stop', 1, 0, ?),
    ('persona-empty', 'Empty', 30, 'hero', '', 'stop', 1, 0, ?),
    ('persona-two', 'Two', 30, 'hero', '', 'stop', 1, 0, ?)`).run(BEFORE, BEFORE, BEFORE);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile', 'Profile', 'Description', '[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core', '1', 'profile', 'Core', 'Description', '[]', 0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', 'race', 'human', 'Human', 'Description', '[]')").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', 'background', 'sage', 'Sage', 'Description', '[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  for (const campaign of ["campaign-one", "campaign-two"]) {
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile')").run(campaign);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'core', '1', 'profile')").run(campaign);
  }
  for (const [suffix, campaign, persona] of [
    ["one", "campaign-one", "persona-one"],
    ["empty", "campaign-one", "persona-empty"],
    ["two", "campaign-two", "persona-two"],
  ]) {
    db.prepare("INSERT INTO campaign_characters VALUES (?, ?, ?, ?, ?)")
      .run(`cc-${suffix}`, campaign, persona, BEFORE, BEFORE);
    db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      (?, ?, ?, 'core', '1', 'race', 'human', 'core', '1', 'background', 'sage', ?, ?)`)
      .run(`sheet-${suffix}`, campaign, `cc-${suffix}`, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_actors
      VALUES (?, ?, ?, ?, 'player-character', 'principal', ?, ?)`)
      .run(`actor-${suffix}`, campaign, `cc-${suffix}`, `sheet-${suffix}`, BEFORE, BEFORE);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES (?, ?, 'local-owner', 'secret')")
      .run(`actor-${suffix}`, campaign);
  }
  db.prepare(`INSERT INTO rpg_actor_resources VALUES
    ('campaign-one', 'actor-one', 'hp', 7, 10),
    ('campaign-one', 'actor-one', 'HP', 0, 0),
    ('campaign-one', 'actor-one', 'mana.1', 1000000, 1000000),
    ('campaign-two', 'actor-two', 'hp', 1, 2)`).run();
  db.close();
  return createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
}

describe("role-sensitive actor resource queries", () => {
  it("gives every campaign role identical strict resources in binary name order", () => {
    const repository = seed();
    const expected = [
      { campaignId: "campaign-one", actorId: "actor-one", name: "HP", current: 0, max: 0 },
      { campaignId: "campaign-one", actorId: "actor-one", name: "hp", current: 7, max: 10 },
      { campaignId: "campaign-one", actorId: "actor-one", name: "mana.1", current: 1_000_000, max: 1_000_000 },
    ];
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      expect(repository.listActorResources(principal, "campaign-one", "actor-one")).toEqual(expected);
      expect(repository.getActorResource(principal, "campaign-one", "actor-one", "hp")).toEqual(expected[1]);
    }
    expect(repository.getActorResource("observer", "campaign-one", "actor-one", "HP")).toEqual(expected[0]);
    expect(Object.keys(expected[0]!)).toEqual(["campaignId", "actorId", "name", "current", "max"]);
    expect(JSON.stringify(expected)).not.toMatch(/controller|private|notes|command|event|timestamp/i);
    repository.close();
  });

  it("conflates denied, missing, empty, and cross-campaign state", () => {
    const repository = seed();
    for (const principal of ["nonmember", "application-only"]) {
      expect(repository.listActorResources(principal, "campaign-one", "actor-one")).toEqual([]);
      expect(repository.getActorResource(principal, "campaign-one", "actor-one", "hp")).toBeNull();
    }
    expect(repository.listActorResources("observer", "campaign-one", "actor-empty")).toEqual([]);
    expect(repository.getActorResource("observer", "campaign-one", "actor-empty", "hp")).toBeNull();
    expect(repository.listActorResources("observer", "campaign-one", "missing")).toEqual([]);
    expect(repository.getActorResource("observer", "campaign-one", "actor-one", "missing")).toBeNull();
    expect(repository.listActorResources("observer", "campaign-one", "actor-two")).toEqual([]);
    expect(repository.getActorResource("observer", "campaign-one", "actor-two", "hp")).toBeNull();
    expect(repository.listActorResources("observer", "missing", "actor-one")).toEqual([]);
    repository.close();
  });

  it.each([
    ["membership role", "UPDATE campaign_memberships SET role = 'administrator' WHERE campaign_id = 'campaign-one' AND principal_id = 'observer'"],
    ["principal parent", "DELETE FROM principals WHERE id = 'observer'"],
    ["campaign parent", "DELETE FROM campaigns WHERE id = 'campaign-one'"],
  ])("requires an intact authorization %s", (_label, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(mutation).run();
    db.close();
    expect(repository.listActorResources("observer", "campaign-one", "actor-one")).toEqual([]);
    expect(repository.getActorResource("observer", "campaign-one", "actor-one", "hp")).toBeNull();
    repository.close();
  });

  it("rejects a valid same-campaign sheet belonging to another character", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_actors WHERE id = 'actor-empty'").run();
    db.prepare("UPDATE campaign_actors SET sheet_id = 'sheet-empty' WHERE id = 'actor-one'").run();
    db.close();
    expect(() => repository.listActorResources("observer", "campaign-one", "actor-one"))
      .toThrow("actor resource root is incomplete");
    expect(() => repository.getActorResource("observer", "campaign-one", "actor-one", "hp"))
      .toThrow("actor resource root is incomplete");
    expect(repository.listActorResources("nonmember", "campaign-one", "actor-one")).toEqual([]);
    repository.close();
  });

  it("rejects a corrupt resource campaign association without outsider disclosure", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE rpg_actor_resources SET campaign_id = 'campaign-two' WHERE actor_id = 'actor-one' AND name = 'hp'").run();
    db.close();
    expect(() => repository.listActorResources("observer", "campaign-one", "actor-one"))
      .toThrow("actor resource record is invalid");
    expect(() => repository.getActorResource("observer", "campaign-one", "actor-one", "hp"))
      .toThrow("actor resource record is invalid");
    expect(repository.listActorResources("nonmember", "campaign-one", "actor-one")).toEqual([]);
    expect(repository.getActorResource("nonmember", "campaign-one", "actor-one", "hp")).toBeNull();
    expect(repository.listActorResources("local-owner", "campaign-two", "actor-one")).toEqual([]);
    expect(repository.getActorResource("local-owner", "campaign-two", "actor-one", "hp")).toBeNull();
    repository.close();
  });

  it("requires exact owner identity while preserving GM access", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'").run();
    db.close();
    expect(repository.listActorResources("local-owner", "campaign-one", "actor-one")).toEqual([]);
    expect(repository.listActorResources("gm", "campaign-one", "actor-one")).toHaveLength(3);
    repository.close();
  });

  it.each([
    ["actor", "DELETE FROM campaign_actors WHERE id = 'actor-one'"],
    ["campaign character", "DELETE FROM campaign_characters WHERE id = 'cc-one'"],
    ["sheet", "DELETE FROM rpg_campaign_sheets WHERE id = 'sheet-one'"],
    ["actor character link", "UPDATE campaign_actors SET campaign_character_id = 'missing-cc' WHERE id = 'actor-one'"],
    ["actor sheet link", "UPDATE campaign_actors SET sheet_id = 'missing-sheet' WHERE id = 'actor-one'"],
  ])("fails loudly for authorized broken %s ancestry without outsider disclosure", (_label, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare(mutation).run();
    db.close();
    expect(() => repository.listActorResources("observer", "campaign-one", "actor-one"))
      .toThrow("actor resource root is incomplete");
    expect(() => repository.getActorResource("observer", "campaign-one", "actor-one", "hp"))
      .toThrow("actor resource root is incomplete");
    expect(repository.listActorResources("nonmember", "campaign-one", "actor-one")).toEqual([]);
    expect(repository.getActorResource("nonmember", "campaign-one", "actor-one", "hp")).toBeNull();
    repository.close();
  });

  it.each([
    ["invalid name", "UPDATE rpg_actor_resources SET name = '' WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["embedded-NUL name", "UPDATE rpg_actor_resources SET name = char(104, 112, 0, 120) WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["overlength name", `UPDATE rpg_actor_resources SET name = '${"x".repeat(129)}' WHERE actor_id = 'actor-one' AND name = 'hp'`],
    ["text amount", "UPDATE rpg_actor_resources SET current = 'seven' WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["fractional amount", "UPDATE rpg_actor_resources SET current = 1.5 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["negative current", "UPDATE rpg_actor_resources SET current = -1 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["overflow current", "UPDATE rpg_actor_resources SET current = 1000001 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["text max", "UPDATE rpg_actor_resources SET max = 'ten' WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["fractional max", "UPDATE rpg_actor_resources SET max = 10.5 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["negative max", "UPDATE rpg_actor_resources SET max = -1 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["overflow max", "UPDATE rpg_actor_resources SET max = 1000001 WHERE actor_id = 'actor-one' AND name = 'hp'"],
    ["over maximum", "UPDATE rpg_actor_resources SET current = 11 WHERE actor_id = 'actor-one' AND name = 'hp'"],
  ])("strictly rejects authorized persisted %s", (_label, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.prepare(mutation).run();
    db.close();
    expect(() => repository.listActorResources("observer", "campaign-one", "actor-one")).toThrow();
    if (!_label.includes("name")) {
      expect(() => repository.getActorResource("observer", "campaign-one", "actor-one", "hp")).toThrow();
    }
    expect(repository.listActorResources("nonmember", "campaign-one", "actor-one")).toEqual([]);
    expect(repository.getActorResource("nonmember", "campaign-one", "actor-one", "hp")).toBeNull();
    repository.close();
  });

  it("uses one explicit membership-rooted SELECT without audit data, transactions, writes, or dependencies", () => {
    seed().close();
    const now = vi.fn(() => new Date(AT));
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, clock: { now }, ids: { nextId },
    });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      for (const call of [
        () => repository.listActorResources("observer", "campaign-one", "actor-one"),
        () => repository.getActorResource("observer", "campaign-one", "actor-one", "hp"),
      ]) {
        prepare.mockClear();
        transaction.mockClear();
        call();
        expect(prepare).toHaveBeenCalledOnce();
        const sql = prepare.mock.calls[0]![0] as string;
        expect(sql).toMatch(/^SELECT\s/i);
        expect(sql).not.toMatch(/SELECT\s+\*/i);
        expect(sql).toMatch(/FROM campaign_memberships/);
        expect(sql).toMatch(/JOIN principals/);
        expect(sql).toMatch(/JOIN campaigns/);
        expect(sql).toMatch(/LEFT JOIN campaign_characters/);
        expect(sql).toMatch(/LEFT JOIN rpg_campaign_sheets/);
        expect(sql).not.toMatch(/private_notes|controller_principal_id|campaign_commands|campaign_events|command_receipts/i);
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
        expect(transaction).not.toHaveBeenCalled();
        expect(now).not.toHaveBeenCalled();
        expect(nextId).not.toHaveBeenCalled();
      }
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
    }
    repository.close();
  });

  it("supports active UoWs and checks validation and lifecycle in order", () => {
    const repository = seed();
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.listActorResources("player", "campaign-one", "actor-one"))
        .toEqual(repository.listActorResources("player", "campaign-one", "actor-one"));
      expect(unit.getActorResource("observer", "campaign-one", "actor-one", "hp")?.current).toBe(7);
    });
    expect(() => repository.listActorResources("bad actor", "campaign-one", "actor-one")).toThrow();
    expect(() => repository.getActorResource("observer", "campaign-one", "actor-one", "bad name")).toThrow();
    expect(() => expired!.listActorResources("bad actor", "bad campaign", "bad actor"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getActorResource("bad actor", "bad campaign", "bad actor", "bad name"))
      .toThrow("transaction unit of work is no longer active");
    expect(repoModule).not.toHaveProperty("listActorResources");
    expect(repoModule).not.toHaveProperty("getActorResource");
    repository.close();
    expect(() => repository.listActorResources("bad actor", "bad campaign", "bad actor"))
      .toThrow("repository is closed");
  });

  it("validates every argument before preparing SQL", () => {
    const repository = seed();
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    try {
      for (const call of [
        () => repository.listActorResources("bad actor", "campaign-one", "actor-one"),
        () => repository.listActorResources("observer", "bad campaign", "actor-one"),
        () => repository.listActorResources("observer", "campaign-one", "bad actor"),
        () => repository.getActorResource("bad actor", "campaign-one", "actor-one", "hp"),
        () => repository.getActorResource("observer", "bad campaign", "actor-one", "hp"),
        () => repository.getActorResource("observer", "campaign-one", "bad actor", "hp"),
        () => repository.getActorResource("observer", "campaign-one", "actor-one", "bad name"),
      ]) {
        prepare.mockClear();
        expect(call).toThrow();
        expect(prepare).not.toHaveBeenCalled();
      }
    } finally {
      prepare.mockRestore();
    }
    repository.close();
  });

  it("reads current state independently from immutable initialization history", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("DELETE FROM rpg_actor_resources WHERE actor_id = 'actor-empty'").run();
    db.close();
    repository.executeInitializeActorResource("local-owner", {
      commandId: "resource-command", idempotencyKey: "resource-key", campaignId: "campaign-one",
      timelineId: "timeline-one", actorId: "actor-empty", expectedRevision: 0, sourceTurnId: null,
      command: { type: "initialize_actor_resource", payload: { name: "stamina", current: 3, max: 8 } },
    });
    expect(repository.getActorResource("observer", "campaign-one", "actor-empty", "stamina")?.current).toBe(3);
    expect(repository.getCommandReceipt("observer", "campaign-one", "resource-command")?.events[0]?.data)
      .toEqual({ name: "stamina", current: 3, max: 8 });
    const mutate = new DatabaseDriver(dbPath());
    mutate.prepare("UPDATE rpg_actor_resources SET current = 2 WHERE actor_id = 'actor-empty' AND name = 'stamina'").run();
    mutate.close();
    expect(repository.getActorResource("observer", "campaign-one", "actor-empty", "stamina")?.current).toBe(2);
    expect(repository.getCommandReceipt("observer", "campaign-one", "resource-command")?.events[0]?.data)
      .toEqual({ name: "stamina", current: 3, max: 8 });

    const removeState = new DatabaseDriver(dbPath());
    removeState.prepare("DELETE FROM rpg_actor_resources WHERE actor_id = 'actor-empty' AND name = 'stamina'").run();
    removeState.close();
    expect(repository.getActorResource("observer", "campaign-one", "actor-empty", "stamina")).toBeNull();
    expect(repository.getCommandReceipt("observer", "campaign-one", "resource-command")?.events[0]?.data)
      .toEqual({ name: "stamina", current: 3, max: 8 });

    const removeAudit = new DatabaseDriver(dbPath());
    removeAudit.prepare("INSERT INTO rpg_actor_resources VALUES ('campaign-one', 'actor-empty', 'stamina', 1, 8)").run();
    removeAudit.exec(`
      DROP TRIGGER command_receipts_prevent_delete;
      DROP TRIGGER campaign_events_prevent_delete;
      DROP TRIGGER campaign_commands_prevent_delete;
      DELETE FROM command_receipts WHERE command_id = 'resource-command';
      DELETE FROM campaign_events WHERE command_id = 'resource-command';
      DELETE FROM campaign_commands WHERE command_id = 'resource-command';
    `);
    removeAudit.close();
    expect(repository.getActorResource("observer", "campaign-one", "actor-empty", "stamina"))
      .toEqual({ campaignId: "campaign-one", actorId: "actor-empty", name: "stamina", current: 1, max: 8 });
    repository.close();
  });
});
