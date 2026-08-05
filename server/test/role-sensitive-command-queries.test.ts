import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import * as repoModule from "../src/repo/index.js";
import { createRepository } from "../src/repo/index.js";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const BEFORE = "2030-04-05T06:07:08.009Z";
const AT = "2030-04-05T06:07:09.010Z";
const campaignId = "campaign-audit";

function dbPath(): string {
  return path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
}

function command(
  commandId: string,
  timelineId: string,
  expectedRevision: number,
  value: number,
  sourceTurnId: string | null,
): CommandEnvelope {
  return {
    commandId,
    idempotencyKey: `key-${commandId}`,
    campaignId,
    timelineId,
    actorId: "actor-audit",
    expectedRevision,
    sourceTurnId,
    command: { type: "set_actor_attribute", payload: { attributeId: "strength", value } },
  };
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
      (?, 'Audit', 'timeline-old', 'local-owner', ?, ?),
      ('campaign-other', 'Other', 'timeline-other', 'local-owner', ?, ?)`).run(campaignId, BEFORE, BEFORE, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES
      ('timeline-old', ?, ?), ('timeline-new', ?, ?),
      ('timeline-other', 'campaign-other', ?)`).run(campaignId, BEFORE, campaignId, BEFORE, BEFORE);
    for (const [principal, role] of [
      ["local-owner", "owner"], ["gm", "gm"], ["player", "player"], ["observer", "observer"],
    ] as const) {
      db.prepare("INSERT INTO campaign_memberships VALUES (?, ?, ?, ?)").run(campaignId, principal, role, BEFORE);
    }
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-other', 'local-owner', 'owner', ?)").run(BEFORE);
  })();
  db.prepare("INSERT INTO characters VALUES ('persona-audit', 'Audit', 20, 'hero', '', 'stop', 1, 0, ?)").run(BEFORE);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile', 'Profile', 'Description', '[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core', '1', 'profile', 'Core', 'Description', '[]', 0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', 'race', 'human', 'Human', 'Description', '[]')").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', 'background', 'sage', 'Sage', 'Description', '[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile')").run(campaignId);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'core', '1', 'profile')").run(campaignId);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc-audit', ?, 'persona-audit', ?, ?)").run(campaignId, BEFORE, BEFORE);
  db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
    ('sheet-audit', ?, 'cc-audit', 'core', '1', 'race', 'human',
     'core', '1', 'background', 'sage', ?, ?)`).run(campaignId, BEFORE, BEFORE);
  db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-audit', 0, 'strength', 10)").run(campaignId);
  db.prepare(`INSERT INTO campaign_actors VALUES
    ('actor-audit', ?, 'cc-audit', 'sheet-audit', 'player-character', 'principal', ?, ?)`).run(campaignId, BEFORE, BEFORE);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-audit', ?, 'local-owner', 'secret notes')").run(campaignId);
  db.close();

  const ids = ["event-b", "event-a", "event-new"];
  const repository = createRepository({
    dataDir: process.env.VELVET_DATA_DIR as string,
    ids: { nextId: () => ids.shift()! },
    clock: { now: () => new Date(AT) },
  });
  repository.executeSetActorAttribute("local-owner", command("command-b", "timeline-old", 0, 11, "turn-a"));
  repository.executeSetActorAttribute("gm", command("command-a", "timeline-old", 1, 12, null));
  const switchDb = new DatabaseDriver(dbPath());
  switchDb.prepare("UPDATE campaigns SET active_timeline_id = 'timeline-new' WHERE id = ?").run(campaignId);
  switchDb.close();
  repository.executeSetActorAttribute("local-owner", command("command-new", "timeline-new", 0, 13, "turn-new"));
  return repository;
}

describe("role-sensitive command event and receipt queries", () => {
  it("gives every campaign role identical safe historical reads in revision order", () => {
    const repository = seed();
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      const events = repository.listCampaignEvents(principal, campaignId, "timeline-old");
      expect(events.map(({ eventId, revision }) => [eventId, revision])).toEqual([["event-b", 1], ["event-a", 2]]);
      expect(repository.listCampaignEvents(principal, campaignId, "timeline-new").map((event) => event.eventId))
        .toEqual(["event-new"]);
      expect(repository.getCommandReceipt(principal, campaignId, "command-a")?.events[0]?.sourceTurnId).toBeNull();
    }

    const event = repository.listCampaignEvents("observer", campaignId, "timeline-old")[0]!;
    expect(Object.keys(event)).toEqual([
      "eventId", "commandId", "campaignId", "timelineId", "actorId", "sourceTurnId",
      "type", "revision", "occurredAt", "data",
    ]);
    expect(Object.keys(event.data)).toEqual(["attributeId", "valueBefore", "valueAfter"]);
    const receipt = repository.getCommandReceipt("player", campaignId, "command-b")!;
    expect(Object.keys(receipt)).toEqual(["commandId", "campaignId", "revisionBefore", "revisionAfter", "events"]);
    expect(JSON.stringify({ event, receipt })).not.toMatch(/idempotency|controller|notes|payload/i);
    repository.close();
  });

  it("does not disclose missing, unauthorized, application-owner-only, or cross-campaign records", () => {
    const repository = seed();
    for (const principal of ["nonmember", "application-only"]) {
      expect(repository.listCampaignEvents(principal, campaignId, "timeline-old")).toEqual([]);
      expect(repository.getCommandReceipt(principal, campaignId, "command-b")).toBeNull();
    }
    expect(repository.listCampaignEvents("local-owner", campaignId, "missing-timeline")).toEqual([]);
    expect(repository.listCampaignEvents("local-owner", "campaign-other", "timeline-old")).toEqual([]);
    expect(repository.getCommandReceipt("local-owner", campaignId, "missing-command")).toBeNull();
    expect(repository.getCommandReceipt("local-owner", "campaign-other", "command-b")).toBeNull();
    repository.close();
  });

  it("uses one membership-rooted explicit SELECT and no transaction, dependency, or write", () => {
    seed().close();
    const now = vi.fn(() => new Date(AT));
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string, clock: { now }, ids: { nextId },
    });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      for (const [call, statementIndex] of [
        [() => repository.listCampaignEvents("observer", campaignId, "timeline-old"), 1],
        [() => repository.getCommandReceipt("player", campaignId, "command-b"), 0],
      ] as const) {
        prepare.mockClear();
        transaction.mockClear();
        call();
        expect(prepare).toHaveBeenCalledTimes(statementIndex + 1);
        const sql = prepare.mock.calls[statementIndex]![0] as string;
        expect(sql).toMatch(/^SELECT\s/i);
        expect(sql).not.toMatch(/SELECT\s+\*/i);
        expect(sql).toMatch(/FROM campaign_memberships/);
        expect(sql).toMatch(/LEFT JOIN campaign_commands/);
        expect(sql).toMatch(/LEFT JOIN command_receipts/);
        // The private key may be checked in place to reject corrupt commands,
        // but its value must never be projected out of SQLite.
        expect(sql).not.toMatch(/(?:SELECT|,)\s*command\.idempotency_key\s*(?:,|AS|FROM)/i);
        expect(sql).not.toMatch(/private_notes|controller_principal_id/i);
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

  it("supports active units of work and checks expired/closed lifecycle before validation", () => {
    const repository = seed();
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.listCampaignEvents("observer", campaignId, "timeline-old")).toHaveLength(2);
      expect(unit.getCommandReceipt("observer", campaignId, "command-b")?.commandId).toBe("command-b");
    });
    expect(() => expired!.listCampaignEvents("bad actor", "bad campaign", "bad timeline"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCommandReceipt("bad actor", "bad campaign", "bad command"))
      .toThrow("transaction unit of work is no longer active");
    expect(repoModule).not.toHaveProperty("listCampaignEvents");
    expect(repoModule).not.toHaveProperty("getCommandReceipt");
    repository.close();
    expect(() => repository.listCampaignEvents("bad actor", "bad campaign", "bad timeline"))
      .toThrow("repository is closed");
    expect(() => repository.getCommandReceipt("bad actor", "bad campaign", "bad command"))
      .toThrow("repository is closed");
  });

  it("fails loudly for authorized incomplete or malformed audit rows but discloses nothing to outsiders", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TRIGGER command_receipts_prevent_delete");
    db.prepare("DELETE FROM command_receipts WHERE campaign_id = ? AND command_id = 'command-b'").run(campaignId);
    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-old")).toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("player", campaignId, "command-b")).toThrow("audit record is incomplete");
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-old")).toEqual([]);
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-b")).toBeNull();

    db.exec("DROP TRIGGER campaign_events_prevent_update");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_events SET value_before = value_after WHERE event_id = 'event-a'").run();
    db.close();
    expect(() => repository.getCommandReceipt("observer", campaignId, "command-a")).toThrow();
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-a")).toBeNull();
    repository.close();
  });

  it.each([
    ["command only", "DELETE FROM command_receipts WHERE command_id = 'command-new'; DELETE FROM campaign_events WHERE command_id = 'command-new'", true],
    ["event only", "DELETE FROM command_receipts WHERE command_id = 'command-new'; DELETE FROM campaign_commands WHERE command_id = 'command-new'", true],
    ["receipt only", "DELETE FROM campaign_events WHERE command_id = 'command-new'; DELETE FROM campaign_commands WHERE command_id = 'command-new'", false],
    ["command and event", "DELETE FROM command_receipts WHERE command_id = 'command-new'", true],
    ["command and receipt", "DELETE FROM campaign_events WHERE command_id = 'command-new'", true],
    ["event and receipt", "DELETE FROM campaign_commands WHERE command_id = 'command-new'", true],
  ] as const)("treats orphan audit permutation %s as corruption", (_label, mutation, listHasIdentity) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TRIGGER campaign_commands_prevent_delete;
      DROP TRIGGER campaign_events_prevent_delete;
      DROP TRIGGER command_receipts_prevent_delete;
      ${mutation}
    `);
    db.close();

    expect(() => repository.getCommandReceipt("observer", campaignId, "command-new"))
      .toThrow("audit record is incomplete");
    if (listHasIdentity) {
      expect(() => repository.listCampaignEvents("player", campaignId, "timeline-new"))
        .toThrow("audit record is incomplete");
    } else {
      // The receipt has no timeline identity, but the existing timeline's
      // revision proves that its now-empty event history is corrupt.
      expect(() => repository.listCampaignEvents("player", campaignId, "timeline-new"))
        .toThrow("audit record is incomplete");
    }
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-new")).toEqual([]);
    repository.close();
  });

  it("requires a recognized membership role and intact principal/campaign authorization parents", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_memberships SET role = 'administrator' WHERE campaign_id = ? AND principal_id = 'observer'")
      .run(campaignId);
    db.close();
    expect(repository.listCampaignEvents("observer", campaignId, "timeline-old")).toEqual([]);
    expect(repository.getCommandReceipt("observer", campaignId, "command-b")).toBeNull();
    repository.close();
  });

  it.each([
    ["principal", "DELETE FROM principals WHERE id = 'observer'"],
    ["campaign", "DELETE FROM campaigns WHERE id = 'campaign-audit'"],
  ])("does not authorize an orphan membership missing its %s parent", (_parent, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    if(mutation.startsWith("DELETE FROM campaigns"))deleteCampaignForCorruptionTest(db,"campaign-audit");db.prepare(mutation).run();
    db.close();
    expect(repository.listCampaignEvents("observer", campaignId, "timeline-old")).toEqual([]);
    expect(repository.getCommandReceipt("observer", campaignId, "command-b")).toBeNull();
    repository.close();
  });

  it.each(["timeline", "actor"] as const)(
    "fails loudly for a missing event %s parent while preserving outsider nondisclosure",
    (parent) => {
      const repository = seed();
      const db = new DatabaseDriver(dbPath());
      db.pragma("foreign_keys = OFF");
      if (parent === "timeline") {
        db.prepare("DELETE FROM campaign_timelines WHERE campaign_id = ? AND id = 'timeline-new'").run(campaignId);
      } else {
        db.prepare("DELETE FROM campaign_actors WHERE campaign_id = ? AND id = 'actor-audit'").run(campaignId);
      }
      db.close();
      expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new"))
        .toThrow("audit record is incomplete");
      expect(() => repository.getCommandReceipt("observer", campaignId, "command-new"))
        .toThrow("audit record is incomplete");
      expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-new")).toEqual([]);
      expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
      repository.close();
    },
  );

  it("strictly parses malformed event rows for list reads", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_events_prevent_update");
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_events SET value_before = value_after WHERE event_id = 'event-new'").run();
    db.close();
    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new")).toThrow();
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-new")).toEqual([]);
    repository.close();
  });

  it.each([
    ["event id", "event_id = 'bad id'"],
    ["event type", "type = 'unknown'"],
    ["event revision", "revision = 0"],
    ["event timestamp", "occurred_at = 'invalid'"],
    ["event attribute", "attribute_id = 'bad id'"],
    ["event values", "value_before = value_after"],
  ])("rejects malformed representative %s fields for authorized reads", (_field, assignment) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_events_prevent_update");
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE campaign_events SET ${assignment} WHERE command_id = 'command-new'`).run();
    db.close();
    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new")).toThrow();
    expect(() => repository.getCommandReceipt("player", campaignId, "command-new")).toThrow();
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
    repository.close();
  });

  it.each([
    ["revision before", "revision_before = 1"],
    ["revision after", "revision_after = 2"],
    ["event identity", "event_id = 'missing-event'"],
  ])("rejects malformed representative receipt %s without outsider disclosure", (_field, assignment) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER command_receipts_prevent_update");
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE command_receipts SET ${assignment} WHERE command_id = 'command-new'`).run();
    db.close();
    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new"))
      .toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("player", campaignId, "command-new"))
      .toThrow("audit record is incomplete");
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
    repository.close();
  });

  it.each([
    ["private command idempotency", "UPDATE campaign_commands SET idempotency_key = 'bad key' WHERE command_id = 'command-new'"],
    ["event revision ahead of its timeline", "UPDATE campaign_timelines SET revision = 0 WHERE id = 'timeline-new'"],
  ])("treats malformed %s as incomplete without outsider disclosure", (_label, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_commands_prevent_update; DROP TRIGGER campaign_timelines_advance_revision");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(mutation).run();
    db.close();

    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new"))
      .toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("player", campaignId, "command-new"))
      .toThrow("audit record is incomplete");
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-new")).toEqual([]);
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
    repository.close();
  });

  it.each([
    ["text", "one"],
    ["fraction", 1.5],
    ["negative", -1],
    ["out of range", Number.MAX_SAFE_INTEGER + 1],
  ])("strictly rejects a malformed %s timeline revision for authorized audit reads", (_label, revision) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-new'").run(revision);
    db.close();

    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-new")).toThrow();
    expect(() => repository.getCommandReceipt("player", campaignId, "command-new")).toThrow();
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-new")).toEqual([]);
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-new")).toBeNull();
    repository.close();
  });

  it("rejects a trailing revision gap for authorized historical reads", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.prepare("UPDATE campaign_timelines SET revision = ? WHERE id = 'timeline-old'")
      .run(Number.MAX_SAFE_INTEGER);
    db.close();
    expect(() => repository.listCampaignEvents("observer", campaignId, "timeline-old"))
      .toThrow("audit record is incomplete");
    expect(() => repository.getCommandReceipt("player", campaignId, "command-b"))
      .toThrow("audit record is incomplete");
    expect(repository.listCampaignEvents("nonmember", campaignId, "timeline-old")).toEqual([]);
    expect(repository.getCommandReceipt("nonmember", campaignId, "command-b")).toBeNull();
    repository.close();
  });

  it("isolates the same command ID by campaign and explicit timeline", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO campaign_actors VALUES
      ('actor-other', 'campaign-other', 'cc-missing', 'sheet-missing', 'player-character', 'principal', ?, ?)`).run(BEFORE, BEFORE);
    db.prepare("UPDATE campaign_timelines SET revision = 1 WHERE campaign_id = 'campaign-other' AND id = 'timeline-other'").run();
    db.prepare(`INSERT INTO campaign_commands
      (campaign_id, command_id, idempotency_key, timeline_id, actor_id, expected_revision,
       source_turn_id, type, attribute_id, value) VALUES
      ('campaign-other', 'command-b', 'other-key', 'timeline-other', 'actor-other', 0,
       NULL, 'set_actor_attribute', 'strength', 99)`).run();
    db.prepare(`INSERT INTO campaign_events
      (event_id, campaign_id, command_id, timeline_id, actor_id, source_turn_id, type,
       revision, occurred_at, attribute_id, value_before, value_after) VALUES
      ('event-other', 'campaign-other', 'command-b', 'timeline-other', 'actor-other', NULL,
       'actor_attribute_set', 1, ?, 'strength', 10, 99)`).run(AT);
    db.prepare("INSERT INTO command_receipts VALUES ('campaign-other', 'command-b', 0, 1, 'event-other')").run();
    db.close();

    expect(repository.getCommandReceipt("local-owner", campaignId, "command-b")?.events[0]?.eventId).toBe("event-b");
    expect(repository.getCommandReceipt("local-owner", "campaign-other", "command-b")?.events[0]?.eventId)
      .toBe("event-other");
    expect(repository.listCampaignEvents("local-owner", campaignId, "timeline-other")).toEqual([]);
    expect(repository.listCampaignEvents("local-owner", "campaign-other", "timeline-old")).toEqual([]);
    expect(repository.listCampaignEvents("local-owner", "campaign-other", "timeline-other").map((event) => event.eventId))
      .toEqual(["event-other"]);
    repository.close();
  });

  it("validates all arguments before preparing SQL", () => {
    const repository = seed();
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    try {
      for (const call of [
        () => repository.listCampaignEvents("bad actor", campaignId, "timeline-old"),
        () => repository.listCampaignEvents("observer", "bad campaign", "timeline-old"),
        () => repository.listCampaignEvents("observer", campaignId, "bad timeline"),
        () => repository.getCommandReceipt("bad actor", campaignId, "command-b"),
        () => repository.getCommandReceipt("observer", "bad campaign", "command-b"),
        () => repository.getCommandReceipt("observer", campaignId, "bad command"),
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
});
