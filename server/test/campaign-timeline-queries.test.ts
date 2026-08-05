import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import { createRepository, type RepositoryUnitOfWork } from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const BEFORE = "2032-01-02T03:04:05.006Z";
const LATER = "2032-01-03T03:04:05.006Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");

function seed(): void {
  createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }).close();
  const db = new DatabaseDriver(dbPath());
  // Campaign and active-timeline parents form deferred cycles; this fixture
  // inserts their final valid state directly before reopening normally.
  db.pragma("foreign_keys = OFF");
  db.exec(`
    INSERT INTO principals VALUES
      ('gm','GM',0),('player','Player',0),('observer','Observer',0),
      ('outsider','Outsider',0),('app-owner','App owner',0),('other-owner','Other owner',0);
    UPDATE application_owner SET principal_id='app-owner' WHERE singleton=1;
  `);
  db.prepare(`INSERT INTO campaigns (id,name,active_timeline_id,owner_principal_id,created_at,updated_at)
    VALUES ('campaign','Campaign','timeline-z-history','local-owner',?,?),
      ('other-campaign','Other','other-timeline','other-owner',?,?)`).run(BEFORE, BEFORE, BEFORE, BEFORE);
  db.prepare(`INSERT INTO campaign_timelines (id,campaign_id,created_at) VALUES
    ('timeline-z-history','campaign',?),('other-timeline','other-campaign',?)`).run(BEFORE, BEFORE);
  for (const [principal, role] of [
    ["local-owner", "owner"], ["gm", "gm"], ["player", "player"], ["observer", "observer"],
  ] as const) {
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign',?,?,?)").run(principal, role, BEFORE);
  }
  db.prepare("INSERT INTO campaign_memberships VALUES ('other-campaign','other-owner','owner',?)").run(BEFORE);
  db.prepare("INSERT INTO characters VALUES ('persona','Persona',20,'hero','','stop',1,0,?)").run(BEFORE);
  db.exec(`
    INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Description','[]');
    INSERT INTO rpg_content_packs VALUES ('core','1','profile','Core','Description','[]',0);
    INSERT INTO rpg_definitions VALUES ('core','1','race','human','Human','Description','[]');
    INSERT INTO rpg_definitions VALUES ('core','1','background','sage','Sage','Description','[]');
    UPDATE rpg_content_packs SET sealed=1;
    INSERT INTO campaign_rules_profiles VALUES ('campaign','profile');
    INSERT INTO campaign_content_packs VALUES ('campaign','core','1','profile');
  `);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc','campaign','persona',?,?)").run(BEFORE, BEFORE);
  db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
    ('sheet','campaign','cc','core','1','race','human','core','1','background','sage',?,?)`).run(BEFORE, BEFORE);
  db.exec(`
    INSERT INTO rpg_character_attributes VALUES ('campaign','sheet',0,'strength',10);
    INSERT INTO campaign_actors VALUES
      ('actor','campaign','cc','sheet','player-character','principal','${BEFORE}','${BEFORE}');
    INSERT INTO campaign_actor_private_state VALUES ('actor','campaign','local-owner','private');
  `);
  db.close();

  const eventIds = ["event-attribute", "event-resource", "event-dice"];
  const repository = createRepository({
    dataDir: process.env.VELVET_DATA_DIR as string,
    ids: { nextId: () => eventIds.shift()! },
    clock: { now: () => new Date(LATER) },
    rng: { integer: () => 4 },
  });
  const common = (commandId: string, expectedRevision: number): Omit<CommandEnvelope, "command"> => ({
    commandId, idempotencyKey: `key-${commandId}`, campaignId: "campaign",
    timelineId: "timeline-z-history", actorId: "actor", expectedRevision, sourceTurnId: null,
  });
  repository.executeSetActorAttribute("local-owner", {
    ...common("command-attribute", 0),
    command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
  });
  repository.executeInitializeActorResource("gm", {
    ...common("command-resource", 1),
    command: { type: "initialize_actor_resource", payload: { name: "focus", current: 2, max: 5 } },
  });
  repository.executeRollActorDice("gm", {
    ...common("command-dice", 2),
    command: { type: "roll_actor_dice", payload: { expression: "2d6kh1+2" } },
  });
  repository.close();

  const finish = new DatabaseDriver(dbPath());
  finish.pragma("foreign_keys = ON");
  finish.prepare(`INSERT INTO campaign_timelines (id,campaign_id,created_at) VALUES
    ('timeline-a-empty','campaign',?),('timeline-A-active','campaign',?)`).run(LATER, LATER);
  finish.prepare("UPDATE campaigns SET active_timeline_id='timeline-A-active' WHERE id='campaign'").run();
  finish.close();
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(`
    DROP TRIGGER IF EXISTS campaign_commands_prevent_update;
    DROP TRIGGER IF EXISTS campaign_commands_prevent_delete;
    DROP TRIGGER IF EXISTS campaign_events_prevent_update;
    DROP TRIGGER IF EXISTS campaign_events_prevent_delete;
    DROP TRIGGER IF EXISTS command_receipts_prevent_update;
    DROP TRIGGER IF EXISTS command_receipts_prevent_delete;
    DROP TRIGGER IF EXISTS command_receipts_require_expected_revision;
    DROP TRIGGER IF EXISTS rpg_dice_rolls_prevent_update;
    DROP TRIGGER IF EXISTS rpg_dice_rolls_prevent_delete;
    DROP TRIGGER IF EXISTS rpg_dice_terms_prevent_update;
    DROP TRIGGER IF EXISTS rpg_dice_terms_prevent_delete;
    DROP TRIGGER IF EXISTS campaign_timelines_advance_revision;
    ${sql}
  `);
  db.close();
}

describe("campaign timeline queries", () => {
  it("lists active, historical, and empty timelines for every intact member in deterministic order", () => {
    seed();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const expected = [
      { id: "timeline-z-history", campaignId: "campaign", revision: 3, createdAt: BEFORE },
      { id: "timeline-A-active", campaignId: "campaign", revision: 0, createdAt: LATER },
      { id: "timeline-a-empty", campaignId: "campaign", revision: 0, createdAt: LATER },
    ];
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      expect(repository.listCampaignTimelines(principal, "campaign")).toEqual(expected);
    }
    for (const timeline of expected) {
      expect(Object.keys(timeline)).toEqual(["id", "campaignId", "revision", "createdAt"]);
      expect(timeline).not.toHaveProperty("active");
    }
    repository.close();
  });

  it("gets active, historical, and empty timelines identically for every intact role", () => {
    seed();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const expected = [
      { id: "timeline-z-history", campaignId: "campaign", revision: 3, createdAt: BEFORE },
      { id: "timeline-A-active", campaignId: "campaign", revision: 0, createdAt: LATER },
      { id: "timeline-a-empty", campaignId: "campaign", revision: 0, createdAt: LATER },
    ];
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      for (const timeline of expected) {
        const result = repository.getCampaignTimeline(principal, "campaign", timeline.id);
        expect(result).toEqual(timeline);
        expect(Object.keys(result!)).toEqual(["id", "campaignId", "revision", "createdAt"]);
      }
    }
    repository.close();
  });

  it("masks outsiders, application ownership, missing campaigns, cross-campaign access, and invalid owner agreement", () => {
    seed();
    let repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    for (const principal of ["outsider", "app-owner", "other-owner"]) {
      expect(repository.listCampaignTimelines(principal, "campaign")).toEqual([]);
      expect(repository.getCampaignTimeline(principal, "campaign", "timeline-z-history")).toBeNull();
    }
    expect(repository.listCampaignTimelines("local-owner", "missing-campaign")).toEqual([]);
    expect(repository.listCampaignTimelines("local-owner", "other-campaign")).toEqual([]);
    expect(repository.getCampaignTimeline("local-owner", "missing-campaign", "timeline-z-history")).toBeNull();
    expect(repository.getCampaignTimeline("local-owner", "campaign", "missing-timeline")).toBeNull();
    expect(repository.getCampaignTimeline("local-owner", "campaign", "other-timeline")).toBeNull();
    expect(repository.getCampaignTimeline("local-owner", "other-campaign", "other-timeline")).toBeNull();
    expect(repository.getCampaignTimeline("other-owner", "other-campaign", "other-timeline")).toEqual({
      id: "other-timeline", campaignId: "other-campaign", revision: 0, createdAt: BEFORE,
    });
    repository.close();
    corrupt("UPDATE campaigns SET owner_principal_id='gm' WHERE id='campaign';");
    repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.listCampaignTimelines("local-owner", "campaign")).toEqual([]);
    expect(repository.listCampaignTimelines("gm", "campaign")).toHaveLength(3);
    expect(repository.getCampaignTimeline("local-owner", "campaign", "timeline-z-history")).toBeNull();
    expect(repository.getCampaignTimeline("gm", "campaign", "timeline-z-history")).not.toBeNull();
    repository.close();
  });

  it.each([
    ["active pointer parent", "UPDATE campaigns SET active_timeline_id='missing' WHERE id='campaign'", "timeline-z-history"],
    ["timeline projection", "UPDATE campaign_timelines SET created_at='invalid' WHERE id='timeline-a-empty'", "timeline-a-empty"],
    ["non-contiguous history", "UPDATE campaign_events SET revision=5 WHERE command_id='command-resource'", "timeline-z-history"],
    ["history after revision reset", "UPDATE campaign_timelines SET revision=0 WHERE id='timeline-z-history'", "timeline-z-history"],
    ["command timeline parent", "UPDATE campaign_commands SET timeline_id='missing' WHERE command_id='command-attribute'", "timeline-z-history"],
    ["event actor parent", "UPDATE campaign_events SET actor_id='missing' WHERE command_id='command-resource'", "timeline-z-history"],
    ["receipt identity", "UPDATE command_receipts SET event_id='missing' WHERE command_id='command-dice'", "timeline-z-history"],
    ["attribute aggregate", "UPDATE campaign_events SET value_before=value_after WHERE command_id='command-attribute'", "timeline-z-history"],
    ["resource aggregate", "UPDATE campaign_commands SET resource_current=6 WHERE command_id='command-resource'", "timeline-z-history"],
    ["dice normalization", "UPDATE rpg_dice_rolls SET expression='2d6kh1+02'", "timeline-z-history"],
    ["dice stable tie", "UPDATE rpg_dice_terms SET kept=CASE position WHEN 0 THEN 0 ELSE 1 END", "timeline-z-history"],
    ["dice total", "UPDATE rpg_dice_rolls SET total=99", "timeline-z-history"],
    ["orphan command", "DELETE FROM campaign_events WHERE command_id='command-attribute'", "timeline-z-history"],
    ["orphan event", "DELETE FROM campaign_commands WHERE command_id='command-attribute'", "timeline-z-history"],
    ["orphan receipt", "DELETE FROM campaign_commands WHERE command_id='command-resource'; DELETE FROM campaign_events WHERE command_id='command-resource'; UPDATE campaign_timelines SET revision=2 WHERE id='timeline-z-history'", "timeline-z-history"],
    ["orphan roll", "DELETE FROM campaign_commands WHERE command_id='command-dice'; DELETE FROM campaign_events WHERE command_id='command-dice'; DELETE FROM command_receipts WHERE command_id='command-dice'; UPDATE campaign_timelines SET revision=2 WHERE id='timeline-z-history'", "timeline-z-history"],
    ["attributable orphan terms", "DELETE FROM rpg_dice_rolls", "timeline-z-history"],
  ])("fails loudly for authorized %s corruption while masking outsiders", (_label, sql, timelineId) => {
    seed();
    corrupt(sql);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(() => repository.listCampaignTimelines("observer", "campaign"))
      .toThrow("campaign timeline aggregate is malformed");
    expect(() => repository.getCampaignTimeline("observer", "campaign", timelineId))
      .toThrow("campaign timeline aggregate is malformed");
    if (_label === "orphan command") {
      expect(() => repository.getCampaignTimeline("observer", "campaign", "missing-timeline"))
        .toThrow("campaign timeline aggregate is malformed");
    }
    expect(repository.listCampaignTimelines("outsider", "campaign")).toEqual([]);
    expect(repository.getCampaignTimeline("outsider", "campaign", timelineId)).toBeNull();
    repository.close();
  });

  it("does not attribute completely free dice terms", () => {
    seed();
    corrupt("INSERT INTO rpg_dice_terms VALUES ('free-event',0,6,1)");
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.listCampaignTimelines("observer", "campaign")).toHaveLength(3);
    expect(repository.getCampaignTimeline("observer", "campaign", "timeline-z-history")).not.toBeNull();
    repository.close();
  });

  it("isolates cross-campaign corruption and preserves outsider masking", () => {
    seed();
    corrupt(`INSERT INTO command_receipts VALUES ('other-campaign','orphan',0,1,'orphan-event')`);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.listCampaignTimelines("observer", "campaign")).toHaveLength(3);
    expect(repository.getCampaignTimeline("observer", "campaign", "timeline-z-history")).not.toBeNull();
    expect(() => repository.listCampaignTimelines("other-owner", "other-campaign"))
      .toThrow("campaign timeline aggregate is malformed");
    expect(() => repository.getCampaignTimeline("other-owner", "other-campaign", "other-timeline"))
      .toThrow("campaign timeline aggregate is malformed");
    expect(repository.listCampaignTimelines("outsider", "other-campaign")).toEqual([]);
    expect(repository.getCampaignTimeline("outsider", "other-campaign", "other-timeline")).toBeNull();
    repository.close();
  });

  it("scopes colliding dice-roll event IDs to their own campaign", () => {
    seed();
    // event-attribute is a valid non-dice event in campaign A. A corrupt roll
    // in campaign B may collide with that globally-intended identity only when
    // constraints are bypassed; it must not poison A's roll-exclusion check.
    corrupt(`DROP TRIGGER rpg_dice_rolls_must_precede_event;
      DROP TRIGGER rpg_dice_terms_must_precede_event;
      INSERT INTO rpg_dice_rolls
      (event_id,campaign_id,command_id,expression,dice_count,dice_sides,
        selection_type,selection_count,modifier,total)
      VALUES ('event-attribute','other-campaign','orphan-roll','1d6',1,6,'all',NULL,0,4);
      INSERT INTO rpg_dice_terms VALUES ('event-attribute',0,4,1)`);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.listCampaignTimelines("observer", "campaign")).toHaveLength(3);
    expect(repository.getCampaignTimeline("observer", "campaign", "timeline-z-history"))
      .toMatchObject({ revision: 3 });
    expect(() => repository.listCampaignTimelines("other-owner", "other-campaign"))
      .toThrow("campaign timeline aggregate is malformed");
    expect(() => repository.getCampaignTimeline("other-owner", "other-campaign", "other-timeline"))
      .toThrow("campaign timeline aggregate is malformed");
    expect(repository.listCampaignTimelines("outsider", "other-campaign")).toEqual([]);
    expect(repository.getCampaignTimeline("outsider", "other-campaign", "other-timeline")).toBeNull();
    repository.close();
  });

  it("still attributes local orphan terms when their owning local roll is missing", () => {
    seed();
    corrupt("DELETE FROM rpg_dice_rolls WHERE campaign_id='campaign' AND event_id='event-dice'");
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      expect(() => repository.listCampaignTimelines(principal, "campaign"))
        .toThrow("campaign timeline aggregate is malformed");
      expect(() => repository.getCampaignTimeline(principal, "campaign", "timeline-z-history"))
        .toThrow("campaign timeline aggregate is malformed");
    }
    expect(repository.listCampaignTimelines("outsider", "campaign")).toEqual([]);
    expect(repository.getCampaignTimeline("outsider", "campaign", "timeline-z-history")).toBeNull();
    repository.close();
  });

  it("uses one explicit-column membership-rooted read without writes, transactions, private columns, or dependencies", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 1);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      clock: { now }, ids: { nextId }, rng: { integer } });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.listCampaignTimelines("player", "campaign")).toHaveLength(3);
      expect(prepare).toHaveBeenCalledOnce();
      const sql = prepare.mock.calls[0]![0] as string;
      expect(sql).toMatch(/^SELECT\s/i);
      expect(sql).toContain("FROM campaign_memberships membership");
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/idempotency_key|private_notes|controller_principal_id/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      expect(transaction).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(nextId).not.toHaveBeenCalled();
      expect(integer).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("gets with one explicit-column membership-rooted read and no side effects", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 1);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      clock: { now }, ids: { nextId }, rng: { integer } });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.getCampaignTimeline("player", "campaign", "timeline-z-history"))
        .toMatchObject({ id: "timeline-z-history", revision: 3 });
      expect(prepare).toHaveBeenCalledOnce();
      const sql = prepare.mock.calls[0]![0] as string;
      expect(sql).toMatch(/^SELECT\s/i);
      expect(sql).toContain("FROM campaign_memberships membership");
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/idempotency_key|private_notes|controller_principal_id/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      expect(transaction).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(nextId).not.toHaveBeenCalled();
      expect(integer).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("validates before SQL and supports factory/UoW lifecycle guard precedence", () => {
    seed();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    expect(() => repository.listCampaignTimelines("bad actor", "campaign")).toThrow();
    expect(() => repository.listCampaignTimelines("observer", "bad campaign")).toThrow();
    expect(() => repository.getCampaignTimeline("observer", "campaign", "bad timeline")).toThrow();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.listCampaignTimelines("observer", "campaign")).toHaveLength(3);
      expect(unit.getCampaignTimeline("observer", "campaign", "timeline-A-active"))
        .toMatchObject({ id: "timeline-A-active", revision: 0 });
    });
    expect(() => expired!.listCampaignTimelines("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignTimeline("bad actor", "bad campaign", "bad timeline"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.listCampaignTimelines("bad actor", "bad campaign"))
      .toThrow("repository is closed");
    expect(() => repository.getCampaignTimeline("bad actor", "bad campaign", "bad timeline"))
      .toThrow("repository is closed");
  });
});
