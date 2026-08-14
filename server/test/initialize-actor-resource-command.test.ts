import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import * as repoModule from "../src/repo/index.js";
import { createRepository } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const BEFORE = "2030-04-05T06:07:08.009Z";
const AT = "2030-04-05T06:07:09.010Z";
const envelope: CommandEnvelope = {
  commandId: "command-one",
  idempotencyKey: "key-one",
  campaignId: "campaign-one",
  timelineId: "timeline-one",
  actorId: "actor-one",
  expectedRevision: 0,
  sourceTurnId: "turn-one",
  command: { type: "initialize_actor_resource", payload: { name: "hp", current: 5, max: 10 } },
};

function dbPath(): string {
  return path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
}

function markCorruptFixtureAsV46(db: DatabaseDriver.Database): void {
  db.prepare("UPDATE meta SET value = '46' WHERE key = 'schemaVersion'").run();
}

function seed(): void {
  createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }).close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO principals VALUES
    ('gm', 'GM', 0), ('player', 'Player', 0), ('observer', 'Observer', 0),
    ('application-only', 'Application owner only', 0)`).run();
  db.prepare("UPDATE application_owner SET principal_id = 'application-only' WHERE singleton = 1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-one', 'One', 'timeline-one', 'local-owner', ?, ?),
             ('campaign-two', 'Two', 'timeline-two', 'local-owner', ?, ?)`).run(BEFORE, BEFORE, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES
      ('timeline-one', 'campaign-one', ?), ('timeline-old', 'campaign-one', ?),
      ('timeline-two', 'campaign-two', ?)`).run(BEFORE, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_memberships VALUES
      ('campaign-one', 'local-owner', 'owner', ?), ('campaign-one', 'gm', 'gm', ?),
      ('campaign-one', 'player', 'player', ?), ('campaign-one', 'observer', 'observer', ?),
      ('campaign-two', 'local-owner', 'owner', ?)`).run(BEFORE, BEFORE, BEFORE, BEFORE, BEFORE);
  })();
  db.prepare(`INSERT INTO characters VALUES
    ('persona-one', 'One', 30, 'hero', '', 1, 0, ?),
    ('persona-other', 'Other', 30, 'hero', '', 1, 0, ?),
    ('persona-two', 'Two', 30, 'hero', '', 1, 0, ?)`).run(BEFORE, BEFORE, BEFORE);
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
    ["other", "campaign-one", "persona-other"],
    ["two", "campaign-two", "persona-two"],
  ]) {
    db.prepare("INSERT INTO campaign_characters VALUES (?, ?, ?, ?, ?)")
      .run(`cc-${suffix}`, campaign, persona, BEFORE, BEFORE);
    db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      (?, ?, ?, 'core', '1', 'race', 'human', 'core', '1', 'background', 'sage', ?, ?)`)
      .run(`sheet-${suffix}`, campaign, `cc-${suffix}`, BEFORE, BEFORE);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, ?, 0, 'strength', 10)")
      .run(campaign, `sheet-${suffix}`);
    db.prepare(`INSERT INTO campaign_actors
      VALUES (?, ?, ?, ?, 'player-character', 'principal', ?, ?)`)
      .run(`actor-${suffix}`, campaign, `cc-${suffix}`, `sheet-${suffix}`, BEFORE, BEFORE);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES (?, ?, 'local-owner', NULL)")
      .run(`actor-${suffix}`, campaign);
  }
  db.close();
}

function factory(options: { id?: string; at?: string } = {}) {
  return createRepository({
    dataDir: process.env.VELVET_DATA_DIR as string,
    ids: { nextId: vi.fn(() => options.id ?? "event-one") },
    clock: { now: vi.fn(() => new Date(options.at ?? AT)) },
  });
}

function snapshot() {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const result = {
    resources: db.prepare("SELECT * FROM rpg_actor_resources ORDER BY campaign_id, actor_id, name").all(),
    commands: db.prepare("SELECT * FROM campaign_commands ORDER BY campaign_id, command_id").all(),
    events: db.prepare("SELECT * FROM campaign_events ORDER BY event_id").all(),
    receipts: db.prepare("SELECT * FROM command_receipts ORDER BY campaign_id, command_id").all(),
    timeline: db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get(),
    campaignTime: db.prepare("SELECT updated_at FROM campaigns WHERE id = 'campaign-one'").get(),
    characterTime: db.prepare("SELECT updated_at FROM campaign_characters WHERE id = 'cc-one'").get(),
    sheetTime: db.prepare("SELECT updated_at FROM rpg_campaign_sheets WHERE id = 'sheet-one'").get(),
    actorTime: db.prepare("SELECT updated_at FROM campaign_actors WHERE id = 'actor-one'").get(),
  };
  db.close();
  return result;
}

function fiveWrites(commandId = "command-one", key = "key-one", name = "hp") {
  return [
    { sql: `INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, resource_name, resource_current, resource_max) VALUES
      ('campaign-one', ?, ?, 'timeline-one', 'actor-one', 0, 'turn-one',
       'initialize_actor_resource', ?, 5, 10)`, params: [commandId, key, name] },
    { sql: "INSERT INTO rpg_actor_resources VALUES ('campaign-one', 'actor-one', ?, 5, 10)", params: [name] },
    { sql: "UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'" },
    { sql: `INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, resource_name, resource_current, resource_max) VALUES
      ('event-worker', 'campaign-one', ?, 'timeline-one', 'actor-one', 'turn-one',
       'actor_resource_initialized', 1, ?, ?, 5, 10)`, params: [commandId, AT, name] },
    { sql: "INSERT INTO command_receipts VALUES ('campaign-one', ?, 0, 1, 'event-worker')", params: [commandId] },
  ];
}

describe("initialize actor resource command", () => {
  it("rejects every other command variant before dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    for (const command of [
      { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
      { type: "roll_actor_dice", payload: { expression: "1d20" } },
    ] as const) {
      expect(() => repository.executeInitializeActorResource("local-owner", {
        ...envelope,
        command,
      })).toThrow("requires an initialize_actor_resource command");
    }
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("persists one resource and strict receipt without aggregate timestamp changes", () => {
    seed();
    const repository = factory();
    expect(repository.executeInitializeActorResource("local-owner", envelope)).toEqual({
      commandId: "command-one", campaignId: "campaign-one", revisionBefore: 0, revisionAfter: 1,
      events: [{
        eventId: "event-one", commandId: "command-one", campaignId: "campaign-one",
        timelineId: "timeline-one", actorId: "actor-one", sourceTurnId: "turn-one",
        type: "actor_resource_initialized", revision: 1, occurredAt: AT,
        data: { name: "hp", current: 5, max: 10 },
      }],
    });
    repository.close();
    const state = snapshot();
    expect(state.resources).toEqual([{ campaign_id: "campaign-one", actor_id: "actor-one", name: "hp", current: 5, max: 10 }]);
    expect(state.timeline).toEqual({ revision: 1 });
    expect([state.campaignTime, state.characterTime, state.sheetTime, state.actorTime])
      .toEqual(Array(4).fill({ updated_at: BEFORE }));
  });

  it("writes command, resource, timeline, event, and receipt in order", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`
      CREATE TABLE resource_write_order (position INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TRIGGER order_command AFTER INSERT ON campaign_commands BEGIN INSERT INTO resource_write_order(name) VALUES ('command'); END;
      CREATE TRIGGER order_resource AFTER INSERT ON rpg_actor_resources BEGIN INSERT INTO resource_write_order(name) VALUES ('resource'); END;
      CREATE TRIGGER order_timeline AFTER UPDATE ON campaign_timelines BEGIN INSERT INTO resource_write_order(name) VALUES ('timeline'); END;
      CREATE TRIGGER order_event AFTER INSERT ON campaign_events BEGIN INSERT INTO resource_write_order(name) VALUES ('event'); END;
      CREATE TRIGGER order_receipt AFTER INSERT ON command_receipts BEGIN INSERT INTO resource_write_order(name) VALUES ('receipt'); END;
    `);
    db.close();
    const repository = factory();
    repository.executeInitializeActorResource("local-owner", envelope);
    repository.close();
    const verify = new DatabaseDriver(dbPath(), { readonly: true });
    expect((verify.prepare("SELECT name FROM resource_write_order ORDER BY position").all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(["command", "resource", "timeline", "event", "receipt"]);
    verify.close();
  });

  it.each(["local-owner", "gm"])("authorizes %s", (principal) => {
    seed();
    const repository = factory();
    expect(repository.executeInitializeActorResource(principal, envelope).revisionAfter).toBe(1);
    repository.close();
  });

  it.each(["player", "observer", "application-only", "missing"])("denies %s without disclosure or dependencies", (principal) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeInitializeActorResource(principal, envelope)).toThrow("command unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it.each([
    ["missing principal", "DELETE FROM principals WHERE id = 'local-owner'", "campaign_memberships"],
    ["missing campaign", "DELETE FROM campaigns WHERE id = 'campaign-one'", "campaign_timelines"],
    ["owner disagreement", "UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'", "campaigns"],
  ])("rejects corrupt authorization at startup: %s", (_label, mutation, table) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    if(mutation.startsWith("DELETE FROM campaigns"))deleteCampaignForCorruptionTest(db,"campaign-one");db.prepare(mutation).run();
    markCorruptFixtureAsV46(db);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } }))
      .toThrow(`schema marker 46 contains foreign-key violation in ${table}`);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("rejects owner disagreement at startup before GM authorization", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'").run();
    markCorruptFixtureAsV46(db);
    db.close();
    expect(() => factory()).toThrow("schema marker 46 contains foreign-key violation in campaigns");
  });

  it("returns an exact historical retry before inactive and existing-resource checks", () => {
    seed();
    const first = factory();
    const receipt = first.executeInitializeActorResource("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE campaigns SET active_timeline_id = 'timeline-old' WHERE id = 'campaign-one'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date("invalid"));
    const retry = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(retry.executeInitializeActorResource("gm", envelope)).toEqual(receipt);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    retry.close();
  });

  it.each([
    ["same ID", { idempotencyKey: "other-key" }],
    ["same key", { commandId: "other-command" }],
    ["timeline", { timelineId: "timeline-old" }],
    ["actor", { actorId: "actor-other" }],
    ["revision", { expectedRevision: 1 }],
    ["source", { sourceTurnId: null }],
    ["name", { command: { type: "initialize_actor_resource", payload: { name: "HP", current: 5, max: 10 } } }],
    ["current", { command: { type: "initialize_actor_resource", payload: { name: "hp", current: 6, max: 10 } } }],
    ["max", { command: { type: "initialize_actor_resource", payload: { name: "hp", current: 5, max: 11 } } }],
  ] as const)("rejects identity collision by %s", (_label, patch) => {
    seed();
    const repository = factory();
    repository.executeInitializeActorResource("local-owner", envelope);
    expect(() => repository.executeInitializeActorResource("local-owner", { ...envelope, ...patch } as CommandEnvelope))
      .toThrow("identity collision");
    repository.close();
  });

  it("shares command identities with the attribute command variant", () => {
    seed();
    const repository = factory();
    repository.executeSetActorAttribute("local-owner", {
      ...envelope,
      command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
    });
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("identity collision");
    repository.close();
  });

  it.each([
    ["same attribute ID", { commandId: "command-one", idempotencyKey: "resource-key" }],
    ["same attribute key", { commandId: "resource-command", idempotencyKey: "key-one" }],
  ])("rejects cross-variant %s", (_label, identities) => {
    seed();
    const repository = factory();
    repository.executeSetActorAttribute("local-owner", {
      ...envelope,
      command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
    });
    expect(() => repository.executeInitializeActorResource("local-owner", { ...envelope, ...identities }))
      .toThrow("identity collision");
    repository.close();
  });

  it("rejects a real split command-ID/key collision", () => {
    seed();
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: vi.fn().mockReturnValueOnce("event-a").mockReturnValueOnce("event-b") },
      clock: { now: () => new Date(AT) },
    });
    repository.executeInitializeActorResource("local-owner", {
      ...envelope, idempotencyKey: "key-a",
      command: { type: "initialize_actor_resource", payload: { name: "mana", current: 1, max: 2 } },
    });
    repository.executeInitializeActorResource("local-owner", {
      ...envelope, commandId: "command-b", expectedRevision: 1,
      command: { type: "initialize_actor_resource", payload: { name: "stamina", current: 1, max: 2 } },
    });
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("identity collision");
    repository.close();
  });

  it("rejects existing exact resources but preserves case-sensitive distinct names", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("INSERT INTO rpg_actor_resources VALUES ('campaign-one', 'actor-one', 'hp', 1, 2)").run();
    db.close();
    const repository = factory();
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("already exists");
    const upper = { ...envelope, command: { type: "initialize_actor_resource" as const, payload: { name: "HP", current: 5, max: 10 } } };
    expect(repository.executeInitializeActorResource("local-owner", upper).events[0].data).toEqual({ name: "HP", current: 5, max: 10 });
    repository.close();
  });

  it("rejects a corrupt resource campaign association at startup before dependencies", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO rpg_actor_resources VALUES ('campaign-two', 'actor-one', 'hp', 1, 2)").run();
    markCorruptFixtureAsV46(db);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } }))
      .toThrow("schema marker 46 contains foreign-key violation in rpg_actor_resources");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive timeline", { timelineId: "timeline-old" }, "inactive"],
    ["stale revision", { expectedRevision: 1 }, "revision"],
    ["missing actor", { actorId: "missing" }, "target unavailable"],
  ] as const)("rejects %s before dependencies", (_label, patch, message) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeInitializeActorResource("local-owner", { ...envelope, ...patch })).toThrow(message);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("supports nullable source turns and retries independently of current state", () => {
    seed();
    const nullable = { ...envelope, sourceTurnId: null };
    const repository = factory();
    const receipt = repository.executeInitializeActorResource("local-owner", nullable);
    const db = new DatabaseDriver(dbPath());
    db.prepare("DELETE FROM rpg_actor_resources WHERE actor_id = 'actor-one' AND name = 'hp'").run();
    db.close();
    expect(repository.executeInitializeActorResource("gm", nullable)).toEqual(receipt);
    repository.close();
  });

  it.each([
    ["missing audit", "DROP TRIGGER command_receipts_prevent_delete; DROP TRIGGER campaign_events_prevent_delete; DELETE FROM command_receipts; DELETE FROM campaign_events;", "incomplete"],
    ["changed event payload", "DROP TRIGGER campaign_events_prevent_update; UPDATE campaign_events SET resource_current = 6;", "invalid"],
  ])("rejects malformed retry: %s", (_label, mutation, message) => {
    seed();
    const first = factory();
    first.executeInitializeActorResource("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.exec(mutation);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const retry = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => retry.executeInitializeActorResource("gm", envelope)).toThrow(message);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    retry.close();
  });

  it.each([
    ["missing timeline parent", "PRAGMA foreign_keys = OFF; DELETE FROM campaign_timelines WHERE id = 'timeline-one';", "campaign_timeline_events"],
    ["missing actor parent", "PRAGMA foreign_keys = OFF; DELETE FROM campaign_actors WHERE id = 'actor-one';", "campaign_events"],
  ])("rejects malformed retry corruption at startup: %s", (_label, mutation, table) => {
    seed();
    const first = factory();
    first.executeInitializeActorResource("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.exec(mutation);
    markCorruptFixtureAsV46(db);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } }))
      .toThrow(`schema marker 46 contains foreign-key violation in ${table}`);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it.each(["one", 1.5, -1, Number.MAX_SAFE_INTEGER + 1])("rejects malformed retry timeline revision %s", (revision) => {
    seed();
    const first = factory();
    first.executeInitializeActorResource("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'").run(revision);
    db.close();
    const retry = factory();
    expect(() => retry.executeInitializeActorResource("gm", envelope)).toThrow();
    retry.close();
  });

  it.each([
    ["missing character", "DELETE FROM campaign_characters WHERE id = 'cc-one'", "rpg_campaign_sheets"],
    ["mismatched sheet", "UPDATE campaign_actors SET sheet_id = 'sheet-other' WHERE id = 'actor-one'", "campaign_actors"],
  ])("rejects malformed ancestry at startup: %s", (_label, mutation, table) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare(mutation).run();
    markCorruptFixtureAsV46(db);
    db.close();
    expect(() => factory()).toThrow(`schema marker 46 contains foreign-key violation in ${table}`);
  });

  it("consumes one valid event ID before exactly one clock reading", () => {
    seed();
    const calls: string[] = [];
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: vi.fn(() => { calls.push("id"); return "event-one"; }) },
      clock: { now: vi.fn(() => { calls.push("clock"); return new Date(AT); }) },
    });
    repository.executeInitializeActorResource("local-owner", envelope);
    expect(calls).toEqual(["id", "clock"]);
    repository.close();
  });

  it.each([
    ["malformed ID", () => "bad id", () => new Date(AT)],
    ["throwing ID", () => { throw new Error("ID failed"); }, () => new Date(AT)],
    ["invalid clock", () => "event-one", () => new Date("invalid")],
    ["throwing clock", () => "event-one", () => { throw new Error("clock failed"); }],
  ])("rejects %s atomically with ordered dependencies", (_label, generate, readClock) => {
    seed();
    const nextId = vi.fn(generate);
    const now = vi.fn(readClock);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow();
    expect(snapshot().resources).toEqual([]);
    expect(nextId).toHaveBeenCalledOnce();
    if (_label.includes("ID")) expect(now).not.toHaveBeenCalled();
    else expect(now).toHaveBeenCalledOnce();
    repository.close();
  });

  it("accepts the final safe revision and rejects expected-revision overflow", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'")
      .run(Number.MAX_SAFE_INTEGER - 1);
    db.close();
    const repository = factory();
    expect(repository.executeInitializeActorResource("local-owner", {
      ...envelope, expectedRevision: Number.MAX_SAFE_INTEGER - 1,
    }).revisionAfter).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => repository.executeInitializeActorResource("local-owner", {
      ...envelope, commandId: "overflow", idempotencyKey: "overflow", expectedRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow();
    repository.close();
  });

  it.each([
    ["campaign_commands", "BEFORE INSERT"],
    ["rpg_actor_resources", "BEFORE INSERT"],
    ["campaign_timelines", "BEFORE UPDATE"],
    ["campaign_events", "BEFORE INSERT"],
    ["command_receipts", "BEFORE INSERT"],
  ])("rolls back all state when %s fails", (table, timing) => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_write ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    db.close();
    const repository = factory();
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("rejected");
    expect(snapshot()).toEqual(before);
    repository.close();
  });

  it.each([
    ["campaign_commands", "AFTER INSERT"],
    ["rpg_actor_resources", "AFTER INSERT"],
    ["campaign_timelines", "AFTER UPDATE"],
    ["campaign_events", "AFTER INSERT"],
    ["command_receipts", "AFTER INSERT"],
  ])("rolls back full state when an %s trigger fails", (table, timing) => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_after ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'after rejected'); END`);
    db.close();
    const repository = factory();
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("after rejected");
    expect(snapshot()).toEqual(before);
    repository.close();
  });

  it("rolls back command and resource when the conditional timeline write loses", () => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(dbPath());
    db.exec("CREATE TRIGGER ignore_timeline BEFORE UPDATE ON campaign_timelines BEGIN SELECT RAISE(IGNORE); END");
    db.close();
    const repository = factory();
    expect(() => repository.executeInitializeActorResource("local-owner", envelope)).toThrow("revision changed");
    expect(snapshot()).toEqual(before);
    repository.close();
  });

  it.each([
    ["exact winner", fiveWrites(), "receipt"],
    ["different winner", fiveWrites("winner", "winner-key", "mana"), "revision"],
    ["same ID", fiveWrites("command-one", "winner-key"), "collision"],
    ["same key", fiveWrites("winner", "key-one"), "collision"],
    ["timeline switch", [{ sql: "UPDATE campaigns SET active_timeline_id = 'timeline-old' WHERE id = 'campaign-one'" }], "inactive"],
  ] as const)("re-resolves a blocked waiter after %s", async (_label, statements, outcome) => {
    seed();
    const writer = await startLockedWrite(dbPath(), [...statements]);
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    if (outcome === "receipt") {
      expect(repository.executeInitializeActorResource("gm", envelope).events[0]?.eventId).toBe("event-worker");
    } else {
      expect(() => repository.executeInitializeActorResource("gm", envelope)).toThrow(outcome);
    }
    await writer.done;
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("survives busy timeout without local state or dependency use", async () => {
    seed();
    const before = snapshot();
    const writer = await startLockedWrite(dbPath(), [{
      sql: "UPDATE campaigns SET name = 'Worker held lock' WHERE id = 'campaign-one'",
    }], 5_250);
    const nextId = vi.fn(() => "event-after-busy");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeInitializeActorResource("local-owner", envelope))
      .toThrow(/database is locked|SQLITE_BUSY/i);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    await writer.done;
    expect(repository.executeInitializeActorResource("local-owner", envelope).events[0]?.eventId)
      .toBe("event-after-busy");
    repository.close();
  }, 10_000);

  it("is factory-only, synchronous, and lifecycle/nesting guarded", () => {
    seed();
    expect(repoModule).not.toHaveProperty("executeInitializeActorResource");
    const repository = factory();
    expect(repository.transaction((unit) => {
      // @ts-expect-error factory-only command must stay excluded from the unit of work contract
      void unit.executeInitializeActorResource;
      return "executeInitializeActorResource" in unit;
    })).toBe(false);
    expect(() => repository.transaction(() => repository.executeInitializeActorResource("bad actor", {} as CommandEnvelope)))
      .toThrow("cannot run inside a repository transaction");
    expect(repository.executeInitializeActorResource("local-owner", envelope)).not.toBeInstanceOf(Promise);
    repository.close();
    expect(() => repository.executeInitializeActorResource("bad actor", {} as CommandEnvelope)).toThrow("repository is closed");
  });
});
