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
  command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 12 } },
};

function dbPath(): string {
  return path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
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
      ('campaign-two', 'local-owner', 'owner', ?)`)
      .run(BEFORE, BEFORE, BEFORE, BEFORE, BEFORE);
  })();
  db.prepare(`INSERT INTO characters VALUES
    ('persona-one', 'One', 30, 'hero', '', 'stop', 1, 0, ?),
    ('persona-two', 'Two', 30, 'hero', '', 'stop', 1, 0, ?),
    ('persona-other', 'Other', 30, 'hero', '', 'stop', 1, 0, ?)`).run(BEFORE, BEFORE, BEFORE);
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

function counts() {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const result = Object.fromEntries(["campaign_commands", "campaign_events", "command_receipts"].map((table) => [
    table,
    (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count,
  ]));
  db.close();
  return result;
}

function affectedSnapshot() {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const result = {
    commands: db.prepare("SELECT * FROM campaign_commands ORDER BY campaign_id, command_id").all(),
    events: db.prepare("SELECT * FROM campaign_events ORDER BY event_id").all(),
    receipts: db.prepare("SELECT * FROM command_receipts ORDER BY campaign_id, command_id").all(),
    attribute: db.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-one'").get(),
    sheet: db.prepare("SELECT updated_at FROM rpg_campaign_sheets WHERE id = 'sheet-one'").get(),
    timeline: db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get(),
  };
  db.close();
  return result;
}

function sixWrites(commandId = "command-one", key = "key-one", value = 12) {
  return [
    { sql: `INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value) VALUES
      ('campaign-one', ?, ?, 'timeline-one', 'actor-one', 0, 'turn-one',
       'set_actor_attribute', 'strength', ?)`, params: [commandId, key, value] },
    { sql: "UPDATE rpg_character_attributes SET value = ? WHERE campaign_id = 'campaign-one' AND sheet_id = 'sheet-one' AND attribute_id = 'strength'", params: [value] },
    { sql: "UPDATE rpg_campaign_sheets SET updated_at = ? WHERE id = 'sheet-one'", params: [AT] },
    { sql: "UPDATE campaign_timelines SET revision = 1 WHERE id = 'timeline-one'" },
    { sql: `INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after) VALUES
      ('event-worker', 'campaign-one', ?, 'timeline-one', 'actor-one', 'turn-one',
       'actor_attribute_set', 1, ?, 'strength', 10, ?)`, params: [commandId, AT, value] },
    { sql: "INSERT INTO command_receipts VALUES ('campaign-one', ?, 0, 1, 'event-worker')", params: [commandId] },
  ];
}

describe("set actor attribute command", () => {
  it("explicitly rejects every other command union variant without dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    for (const command of [
      { type: "initialize_actor_resource", payload: { name: "hp", current: 5, max: 10 } },
      { type: "roll_actor_dice", payload: { expression: "1d20" } },
    ] as const) {
      expect(() => repository.executeSetActorAttribute("local-owner", {
        ...envelope,
        command,
      })).toThrow("requires a set_actor_attribute command");
    }
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("returns the strict receipt and persists the six writes with sheet-only timestamping", () => {
    seed();
    const repository = factory();
    expect(repository.executeSetActorAttribute("local-owner", envelope)).toEqual({
      commandId: "command-one", campaignId: "campaign-one", revisionBefore: 0, revisionAfter: 1,
      events: [{
        eventId: "event-one", commandId: "command-one", campaignId: "campaign-one",
        timelineId: "timeline-one", actorId: "actor-one", sourceTurnId: "turn-one",
        type: "actor_attribute_set", revision: 1, occurredAt: AT,
        data: { attributeId: "strength", valueBefore: 10, valueAfter: 12 },
      }],
    });
    repository.close();
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-one'").get()).toEqual({ value: 12 });
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 1 });
    expect(db.prepare("SELECT updated_at FROM rpg_campaign_sheets WHERE id = 'sheet-one'").get()).toEqual({ updated_at: AT });
    expect(db.prepare("SELECT updated_at FROM campaign_actors WHERE id = 'actor-one'").get()).toEqual({ updated_at: BEFORE });
    expect(db.prepare("SELECT updated_at FROM campaign_characters WHERE id = 'cc-one'").get()).toEqual({ updated_at: BEFORE });
    expect(db.prepare("SELECT updated_at FROM campaigns WHERE id = 'campaign-one'").get()).toEqual({ updated_at: BEFORE });
    expect(counts()).toEqual({ campaign_commands: 1, campaign_events: 1, command_receipts: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("consumes and validates one event ID before exactly one canonical clock reading", () => {
    seed();
    const calls: string[] = [];
    const nextId = vi.fn(() => { calls.push("id"); return "event-one"; });
    const now = vi.fn(() => { calls.push("clock"); return new Date(AT); });
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    repository.executeSetActorAttribute("local-owner", envelope);
    expect(calls).toEqual(["id", "clock"]);
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    repository.close();
  });

  it("performs persistence in the specified trigger-visible order", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`
      CREATE TABLE command_write_order (position INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      CREATE TRIGGER order_command AFTER INSERT ON campaign_commands
        BEGIN INSERT INTO command_write_order(name) VALUES ('command'); END;
      CREATE TRIGGER order_attribute AFTER UPDATE ON rpg_character_attributes
        BEGIN INSERT INTO command_write_order(name) VALUES ('attribute'); END;
      CREATE TRIGGER order_sheet AFTER UPDATE ON rpg_campaign_sheets
        BEGIN INSERT INTO command_write_order(name) VALUES ('sheet'); END;
      CREATE TRIGGER order_timeline AFTER UPDATE ON campaign_timelines
        BEGIN INSERT INTO command_write_order(name) VALUES ('timeline'); END;
      CREATE TRIGGER order_event AFTER INSERT ON campaign_events
        BEGIN INSERT INTO command_write_order(name) VALUES ('event'); END;
      CREATE TRIGGER order_receipt AFTER INSERT ON command_receipts
        BEGIN INSERT INTO command_write_order(name) VALUES ('receipt'); END;
    `);
    db.close();
    const repository = factory();
    repository.executeSetActorAttribute("local-owner", envelope);
    repository.close();
    const verify = new DatabaseDriver(dbPath(), { readonly: true });
    expect((verify.prepare("SELECT name FROM command_write_order ORDER BY position").all() as Array<{ name: string }>).map(({ name }) => name))
      .toEqual(["command", "attribute", "sheet", "timeline", "event", "receipt"]);
    verify.close();
  });

  it.each(["local-owner", "gm"])("authorizes %s", (principal) => {
    seed();
    const repository = factory();
    expect(repository.executeSetActorAttribute(principal, envelope).revisionAfter).toBe(1);
    repository.close();
  });

  it.each([
    ["missing principal parent", "DELETE FROM principals WHERE id = 'local-owner'", "local-owner"],
    ["missing campaign parent", "DELETE FROM campaigns WHERE id = 'campaign-one'", "gm"],
    ["owner disagreement", "UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'", "local-owner"],
  ])("denies %s before dependencies", (_label, mutation, principal) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    if(mutation.startsWith("DELETE FROM campaigns"))deleteCampaignForCorruptionTest(db,"campaign-one");db.prepare(mutation).run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeSetActorAttribute(principal, envelope)).toThrow("command unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("still authorizes a valid GM when the persisted owner identity disagrees", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'").run();
    db.close();
    const repository = factory();
    expect(repository.executeSetActorAttribute("gm", envelope).revisionAfter).toBe(1);
    repository.close();
  });

  it.each(["player", "observer", "application-only", "missing"])("denies %s before identity disclosure or dependencies", (principal) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.executeSetActorAttribute(principal, envelope)).toThrow("command unavailable");
    expect(() => repository.executeSetActorAttribute(principal, { ...envelope, commandId: "unknown" })).toThrow("command unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("returns an exact retry immediately and with the original timeline inactive", () => {
    seed();
    const first = factory();
    const original = first.executeSetActorAttribute("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE campaigns SET active_timeline_id = 'timeline-old' WHERE id = 'campaign-one'").run();
    db.close();
    const retry = factory({ id: "must-not-run", at: "invalid" });
    expect(retry.executeSetActorAttribute("gm", envelope)).toEqual(original);
    expect(retry.executeSetActorAttribute("gm", envelope)).toEqual(original);
    expect(retry.executeSetActorAttribute("gm", envelope)).toEqual(original);
    expect(counts()).toEqual({ campaign_commands: 1, campaign_events: 1, command_receipts: 1 });
    retry.close();
  });

  it("persists and retries an envelope with a nullable source turn", () => {
    seed();
    const nullable = { ...envelope, sourceTurnId: null };
    const first = factory();
    const receipt = first.executeSetActorAttribute("local-owner", nullable);
    expect(receipt.events[0].sourceTurnId).toBeNull();
    first.close();
    const retry = factory({ id: "must-not-run", at: "invalid" });
    expect(retry.executeSetActorAttribute("gm", nullable)).toEqual(receipt);
    retry.close();
  });

  it.each([
    ["same ID", { idempotencyKey: "other-key" }],
    ["same key", { commandId: "other-command" }],
    ["same pair, timeline", { timelineId: "timeline-old" }],
    ["same pair, actor", { actorId: "other-actor" }],
    ["same pair, revision", { expectedRevision: 1 }],
    ["same pair, source", { sourceTurnId: null }],
    ["same pair, payload ID", { command: { type: "set_actor_attribute", payload: { attributeId: "dexterity", value: 12 } } }],
    ["same pair, payload value", { command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 13 } } }],
  ] as const)("rejects collision: %s", (_label, patch) => {
    seed();
    const nextId = vi.fn(() => "event-one");
    const now = vi.fn(() => new Date(AT));
    const first = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    first.executeSetActorAttribute("local-owner", envelope);
    nextId.mockClear();
    now.mockClear();
    expect(() => first.executeSetActorAttribute("local-owner", { ...envelope, ...patch } as CommandEnvelope)).toThrow("identity collision");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    first.close();
  });

  it("rejects a real two-row command-ID/idempotency-key collision without dependencies", () => {
    seed();
    const nextId = vi.fn().mockReturnValueOnce("event-a").mockReturnValueOnce("event-b");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    repository.executeSetActorAttribute("local-owner", {
      ...envelope,
      idempotencyKey: "key-a",
      command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
    });
    repository.executeSetActorAttribute("local-owner", {
      ...envelope,
      commandId: "command-b",
      expectedRevision: 1,
    });
    nextId.mockClear();
    now.mockClear();

    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("identity collision");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(counts()).toEqual({ campaign_commands: 2, campaign_events: 2, command_receipts: 2 });
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-one'").get()).toEqual({ value: 12 });
    expect(db.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 2 });
    db.close();
    repository.close();
  });

  it("rejects an incomplete retry", () => {
    seed();
    const repository = factory();
    repository.executeSetActorAttribute("local-owner", envelope);
    repository.close();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_commands_prevent_replace; DROP TRIGGER campaign_commands_prevent_delete; DROP TRIGGER command_receipts_prevent_delete; DROP TRIGGER campaign_events_prevent_delete");
    db.prepare("DELETE FROM command_receipts").run();
    db.prepare("DELETE FROM campaign_events").run();
    db.close();
    const retry = factory();
    expect(() => retry.executeSetActorAttribute("local-owner", envelope)).toThrow("retry is incomplete");
    retry.close();
  });

  it("rejects a semantically corrupt retry event before dependencies", () => {
    seed();
    const first = factory();
    first.executeSetActorAttribute("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_events_prevent_update");
    db.prepare("UPDATE campaign_events SET source_turn_id = NULL WHERE event_id = 'event-one'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const retry = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => retry.executeSetActorAttribute("local-owner", envelope)).toThrow("retry is invalid");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    retry.close();
  });

  it.each([
    ["missing timeline parent", "DELETE FROM campaign_timelines WHERE id = 'timeline-one'"],
    ["missing actor parent", "DELETE FROM campaign_actors WHERE id = 'actor-one'"],
    ["timeline behind event", "UPDATE campaign_timelines SET revision = 0 WHERE id = 'timeline-one'"],
  ])("rejects an exact retry with %s before dependencies", (_label, mutation) => {
    seed();
    const first = factory();
    first.executeSetActorAttribute("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.prepare(mutation).run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const retry = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => retry.executeSetActorAttribute("gm", envelope)).toThrow(/retry is (?:incomplete|invalid)/);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    retry.close();
  });

  it.each([
    ["text", "one"],
    ["fraction", 1.5],
    ["negative", -1],
    ["out of range", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects an exact retry with a malformed %s timeline revision", (_label, revision) => {
    seed();
    const first = factory();
    first.executeSetActorAttribute("local-owner", envelope);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'").run(revision);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const retry = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => retry.executeSetActorAttribute("gm", envelope)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    retry.close();
  });

  it("returns a genuine earlier-command receipt after a later command advances the timeline", () => {
    seed();
    const ids = vi.fn().mockReturnValueOnce("event-first").mockReturnValueOnce("event-second");
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId: ids }, clock: { now: () => new Date(AT) },
    });
    const original = repository.executeSetActorAttribute("local-owner", { ...envelope, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } } });
    repository.executeSetActorAttribute("gm", { ...envelope, commandId: "command-two", idempotencyKey: "key-two", expectedRevision: 1 });
    ids.mockClear();
    expect(repository.executeSetActorAttribute("gm", { ...envelope, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } } })).toEqual(original);
    expect(ids).not.toHaveBeenCalled();
    repository.close();
  });

  it("accepts the final safe timeline revision", () => {
    seed();
    const lastExpected = Number.MAX_SAFE_INTEGER - 1;
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'").run(lastExpected);
    db.close();
    const nextId = vi.fn(() => "event-max");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    const boundary = { ...envelope, expectedRevision: lastExpected };
    const receipt = repository.executeSetActorAttribute("local-owner", boundary);
    expect(receipt.revisionAfter).toBe(Number.MAX_SAFE_INTEGER);
    repository.close();
  });

  it("rejects an overflow expected revision before dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const rejected = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => rejected.executeSetActorAttribute("local-owner", {
      ...envelope, expectedRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    rejected.close();
  });

  it.each([
    ["inactive", { timelineId: "timeline-old" }, "inactive"],
    ["stale", { expectedRevision: 1 }, "revision"],
    ["missing actor", { actorId: "missing" }, "target unavailable"],
    ["missing attribute", { command: { type: "set_actor_attribute", payload: { attributeId: "dexterity", value: 12 } } }, "target unavailable"],
    ["no-op", { command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 10 } } }, "no-op"],
  ] as const)("rejects %s without consuming dependencies", (_label, patch, message) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", { ...envelope, ...patch } as CommandEnvelope)).toThrow(message);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    repository.close();
  });

  it.each([
    ["text", "zero"],
    ["fraction", 0.5],
    ["negative", -1],
    ["out of range", Number.MAX_SAFE_INTEGER + 1],
  ])("strictly rejects a malformed %s active timeline revision before dependencies", (_label, revision) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-one'").run(revision);
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    repository.close();
  });

  it("rejects a missing campaign-character parent before mutation or dependencies", () => {
    seed();
    const before = affectedSnapshot();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_characters WHERE id = 'cc-one'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("target unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(affectedSnapshot()).toEqual(before);
    repository.close();
  });

  it("fails closed when an actor points at another same-campaign character's sheet", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(0);
    db.prepare("UPDATE campaign_actors SET sheet_id = 'sheet-other' WHERE id = 'actor-one'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("target unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    const verify = new DatabaseDriver(dbPath(), { readonly: true });
    expect(verify.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-one'").get()).toEqual({ value: 10 });
    expect(verify.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-other'").get()).toEqual({ value: 10 });
    expect(verify.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 0 });
    verify.close();
    repository.close();
  });

  it.each([
    ["malformed event ID", { id: "bad id" }, undefined],
    ["invalid clock", {}, "invalid"],
    ["backward clock", {}, "2030-04-05T06:07:08.008Z"],
  ] as const)("rejects %s atomically", (_label, options, at) => {
    seed();
    const repository = factory({ ...options, ...(at === undefined ? {} : { at }) });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow();
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    repository.close();
  });

  it.each([
    ["malformed", () => "bad id"],
    ["throwing", () => { throw new Error("ID failed"); }],
  ])("a %s generated ID prevents clock consumption", (_label, generate) => {
    seed();
    const nextId = vi.fn(generate);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow();
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("a throwing clock follows exactly one generated ID", () => {
    seed();
    const nextId = vi.fn(() => "event-one");
    const now = vi.fn(() => { throw new Error("clock failed"); });
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("clock failed");
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    repository.close();
  });

  it("rejects a globally colliding event ID and does not retry", () => {
    seed();
    const nextId = vi.fn(() => "global-event");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    repository.executeSetActorAttribute("local-owner", envelope);
    nextId.mockClear();
    now.mockClear();
    expect(() => repository.executeSetActorAttribute("local-owner", {
      ...envelope, commandId: "command-two", idempotencyKey: "key-two", campaignId: "campaign-two",
      timelineId: "timeline-two", actorId: "actor-two",
    })).toThrow();
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(counts()).toEqual({ campaign_commands: 1, campaign_events: 1, command_receipts: 1 });
    repository.close();
  });

  it.each([
    ["campaign_commands", "BEFORE INSERT"],
    ["rpg_character_attributes", "BEFORE UPDATE"],
    ["rpg_campaign_sheets", "BEFORE UPDATE"],
    ["campaign_timelines", "BEFORE UPDATE"],
    ["campaign_events", "BEFORE INSERT"],
    ["command_receipts", "BEFORE INSERT"],
  ])("rolls back every write when %s fails", (table, timing) => {
    seed();
    const before = affectedSnapshot();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_write ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    db.close();
    const nextId = vi.fn(() => "event-one");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("rejected");
    expect(counts()).toEqual({ campaign_commands: 0, campaign_events: 0, command_receipts: 0 });
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(affectedSnapshot()).toEqual(before);
    const verify = new DatabaseDriver(dbPath(), { readonly: true });
    expect(verify.prepare("SELECT value FROM rpg_character_attributes WHERE sheet_id = 'sheet-one'").get()).toEqual({ value: 10 });
    expect(verify.prepare("SELECT revision FROM campaign_timelines WHERE id = 'timeline-one'").get()).toEqual({ revision: 0 });
    expect(verify.prepare("SELECT updated_at FROM rpg_campaign_sheets WHERE id = 'sheet-one'").get()).toEqual({ updated_at: BEFORE });
    verify.close();
    repository.close();
  });

  it.each([
    ["campaign_commands", "AFTER INSERT"],
    ["rpg_character_attributes", "AFTER UPDATE"],
    ["rpg_campaign_sheets", "AFTER UPDATE"],
    ["campaign_timelines", "AFTER UPDATE"],
    ["campaign_events", "AFTER INSERT"],
    ["command_receipts", "AFTER INSERT"],
  ])("rolls back the full affected-row snapshot when an %s trigger fails", (table, timing) => {
    seed();
    const before = affectedSnapshot();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_after ${timing} ON ${table} BEGIN SELECT RAISE(ABORT, 'after rejected'); END`);
    db.close();
    const nextId = vi.fn(() => "event-one");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow("after rejected");
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    expect(affectedSnapshot()).toEqual(before);
    repository.close();
  });

  it.each([
    ["exact winner", sixWrites(), envelope, "receipt"],
    ["different winner", sixWrites("winner-command", "winner-key", 11), envelope, "revision"],
    ["same command ID with another key", sixWrites("command-one", "winner-key", 12), envelope, "collision"],
    ["same key with another command ID", sixWrites("winner-command", "key-one", 12), envelope, "collision"],
    ["active timeline switch", [{ sql: "UPDATE campaigns SET active_timeline_id = 'timeline-old' WHERE id = 'campaign-one'" }], envelope, "inactive"],
  ] as const)("re-resolves a blocked waiter after %s commits", async (_label, statements, waiterEnvelope, outcome) => {
    seed();
    const writer = await startLockedWrite(dbPath(), [...statements]);
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    if (outcome === "receipt") {
      expect(repository.executeSetActorAttribute("gm", waiterEnvelope).events[0]?.eventId).toBe("event-worker");
    } else {
      expect(() => repository.executeSetActorAttribute("gm", waiterEnvelope)).toThrow(outcome);
    }
    await writer.done;
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(counts()).toEqual(outcome === "inactive"
      ? { campaign_commands: 0, campaign_events: 0, command_receipts: 0 }
      : { campaign_commands: 1, campaign_events: 1, command_receipts: 1 });
    repository.close();
  });

  it("survives a lock held beyond busy_timeout without local writes or dependency use", async () => {
    seed();
    const before = affectedSnapshot();
    const writer = await startLockedWrite(dbPath(), [{
      sql: "UPDATE campaigns SET name = 'Worker held lock' WHERE id = 'campaign-one'",
    }], 5_250);
    const nextId = vi.fn(() => "event-after-busy");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now },
    });
    expect(() => repository.executeSetActorAttribute("local-owner", envelope)).toThrow(/database is locked|SQLITE_BUSY/i);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(affectedSnapshot()).toEqual(before);
    await writer.done;
    expect(repository.executeSetActorAttribute("local-owner", envelope).events[0]?.eventId).toBe("event-after-busy");
    expect(nextId).toHaveBeenCalledOnce();
    expect(now).toHaveBeenCalledOnce();
    repository.close();
  }, 10_000);

  it("is factory-only, synchronous, absent from UoW, and checks lifecycle/nesting before validation", () => {
    seed();
    expect(repoModule).not.toHaveProperty("executeSetActorAttribute");
    const repository = factory();
    expect(repository.transaction((unit) => {
      // @ts-expect-error factory-only command must stay excluded from the unit of work contract
      void unit.executeSetActorAttribute;
      return "executeSetActorAttribute" in unit;
    })).toBe(false);
    expect(() => repository.transaction(() => repository.executeSetActorAttribute("bad actor", {} as CommandEnvelope)))
      .toThrow("cannot run inside a repository transaction");
    expect(repository.executeSetActorAttribute("local-owner", envelope)).not.toBeInstanceOf(Promise);
    repository.close();
    expect(() => repository.executeSetActorAttribute("bad actor", {} as CommandEnvelope)).toThrow("repository is closed");
  });
});
