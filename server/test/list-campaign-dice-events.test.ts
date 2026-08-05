import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import { createRepository } from "../src/repo/index.js";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const BEFORE = "2030-04-05T06:07:08.009Z";
const AT = "2030-04-05T06:07:09.010Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");

function seed(): void {
  createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }).close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO principals VALUES
    ('gm','GM',0),('player','Player',0),('observer','Observer',0),
    ('outsider','Outsider',0),('app-owner','App owner',0)`).run();
  db.prepare("UPDATE application_owner SET principal_id='app-owner' WHERE singleton=1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns (id,name,active_timeline_id,owner_principal_id,created_at,updated_at)
      VALUES ('campaign','Campaign','timeline-old','local-owner',?,?),
        ('campaign-other','Other','timeline-other','local-owner',?,?)`).run(BEFORE, BEFORE, BEFORE, BEFORE);
    db.prepare(`INSERT INTO campaign_timelines (id,campaign_id,created_at) VALUES
      ('timeline-old','campaign',?),('timeline-new','campaign',?),
      ('timeline-other','campaign-other',?)`).run(BEFORE, BEFORE, BEFORE);
    for (const [principal, role] of [
      ["local-owner", "owner"], ["gm", "gm"], ["player", "player"], ["observer", "observer"],
    ] as const) {
      db.prepare("INSERT INTO campaign_memberships VALUES ('campaign',?,?,?)").run(principal, role, BEFORE);
    }
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-other','local-owner','owner',?)").run(BEFORE);
  })();
  db.prepare("INSERT INTO characters VALUES ('persona','Persona',20,'hero','','stop',1,0,?)").run(BEFORE);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Description','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core','1','profile','Core','Description','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core','1','race','human','Human','Description','[]')").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core','1','background','sage','Sage','Description','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign','profile')").run();
  db.prepare("INSERT INTO campaign_content_packs VALUES ('campaign','core','1','profile')").run();
  db.prepare("INSERT INTO campaign_characters VALUES ('cc','campaign','persona',?,?)").run(BEFORE, BEFORE);
  db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
    ('sheet','campaign','cc','core','1','race','human','core','1','background','sage',?,?)`).run(BEFORE, BEFORE);
  db.prepare("INSERT INTO rpg_character_attributes VALUES ('campaign','sheet',0,'strength',10)").run();
  db.prepare(`INSERT INTO campaign_actors VALUES
    ('actor','campaign','cc','sheet','player-character','principal',?,?)`).run(BEFORE, BEFORE);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor','campaign','local-owner','secret')").run();
  db.close();
}

function envelope(expression: string, revision = 0, commandId = `command-${revision}`): CommandEnvelope {
  return {
    commandId,
    idempotencyKey: `key-${commandId}`,
    campaignId: "campaign",
    timelineId: "timeline-old",
    actorId: "actor",
    expectedRevision: revision,
    sourceTurnId: revision === 0 ? "turn" : null,
    command: { type: "roll_actor_dice", payload: { expression } },
  };
}

function execute(expression = "1d20adv", values = [10, 10]): void {
  let index = 0;
  const repository = createRepository({
    dataDir: process.env.VELVET_DATA_DIR as string,
    rng: { integer: () => values[index++]! },
    ids: { nextId: () => "event-dice" },
    clock: { now: () => new Date(AT) },
  });
  repository.executeRollActorDice("local-owner", envelope(expression));
  repository.close();
}

function corrupt(sql: string, parameters: unknown[] = []): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(`DROP TRIGGER IF EXISTS campaign_commands_prevent_update;
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
    DROP TRIGGER IF EXISTS campaign_timelines_advance_revision;`);
  if (parameters.length === 0) db.exec(sql);
  else db.prepare(sql).run(...parameters);
  db.close();
}

describe("listCampaignEvents dice projection", () => {
  it("bounds recent dice identities before terms and returns the latest twenty newest first", () => {
    seed();
    let event = 0;
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: () => 6 },
      ids: { nextId: () => `recent-event-${String(event++).padStart(2, "0")}` },
      clock: { now: () => new Date(AT) },
    });
    for (let revision = 0; revision < 21; revision += 1) {
      repository.executeRollActorDice("local-owner", envelope(
        revision === 0 ? "100d6" : "1d6", revision, `recent-command-${revision}`,
      ));
    }
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    try {
      const recent = repository.listRecentCampaignDiceEvents("observer", "campaign", "timeline-old");
      expect(recent).toHaveLength(20);
      expect(recent.map((item) => item.revision)).toEqual(Array.from({ length: 20 }, (_, index) => 21 - index));
      expect(prepare).toHaveBeenCalledTimes(2);
      const sql = prepare.mock.calls[1]![0] as string;
      expect(sql).toMatch(/type = 'actor_dice_rolled'[\s\S]*ORDER BY revision DESC[\s\S]*LIMIT 20[\s\S]*LEFT JOIN rpg_dice_terms/);
    } finally {
      prepare.mockRestore();
      repository.close();
    }
  });

  it("validates full history corruption outside the recent window", () => {
    seed();
    let event = 0;
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: () => 4 },
      ids: { nextId: () => `window-event-${event++}` },
    });
    for (let revision = 0; revision < 21; revision += 1) {
      repository.executeRollActorDice("gm", envelope("1d6", revision, `window-command-${revision}`));
    }
    repository.close();
    corrupt("UPDATE campaign_commands SET dice_count=2 WHERE command_id='window-command-0'");
    const guarded = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(() => guarded.listRecentCampaignDiceEvents("local-owner", "campaign", "timeline-old"))
      .toThrow("audit record is incomplete");
    expect(guarded.listRecentCampaignDiceEvents("outsider", "campaign", "timeline-old")).toEqual([]);
    guarded.close();
  });

  it.each([
    ["all", "3d6", [1, 6, 3], [true, true, true], 10],
    ["keep highest", "4d6kh2+2", [4, 4, 2, 1], [true, true, false, false], 10],
    ["keep lowest", "4d8kl2-3", [7, 2, 2, 8], [false, true, true, false], 1],
    ["advantage tie", "1d20adv", [12, 12], [true, false], 12],
    ["disadvantage tie", "1d20dis+2", [9, 9], [true, false], 11],
  ] as const)("reconstructs strict normalized %s rolls", (_label, expression, values, kept, total) => {
    seed();
    execute(expression, [...values]);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const event = repository.listCampaignEvents("observer", "campaign", "timeline-old")[0]!;
    expect(event).toMatchObject({
      eventId: "event-dice",
      commandId: "command-0",
      campaignId: "campaign",
      timelineId: "timeline-old",
      actorId: "actor",
      sourceTurnId: "turn",
      type: "actor_dice_rolled",
      revision: 1,
      occurredAt: AT,
      data: {
        expression,
        terms: values.map((value, index) => ({ value, kept: kept[index] })),
        modifier: expression.endsWith("+2") ? 2 : expression.endsWith("-3") ? -3 : 0,
        total,
      },
    });
    expect(Object.keys(event)).toEqual([
      "eventId", "commandId", "campaignId", "timelineId", "actorId", "sourceTurnId",
      "type", "revision", "occurredAt", "data",
    ]);
    expect(JSON.stringify(event)).not.toMatch(/idempotency|controller|private|notes|payload/i);
    repository.close();
  });

  it("returns one event rather than one per each of 100 ordered terms", () => {
    seed();
    execute("100d1000kh1+1000", Array.from({ length: 100 }, (_, index) => index + 1));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const events = repository.listCampaignEvents("player", "campaign", "timeline-old");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("actor_dice_rolled");
    if (events[0]?.type === "actor_dice_rolled") {
      expect(events[0].data.terms).toHaveLength(100);
      expect(events[0].data.terms[0]).toEqual({ value: 1, kept: false });
      expect(events[0].data.terms[99]).toEqual({ value: 100, kept: true });
    }
    repository.close();
  });

  it("preserves mixed-event revision order and historical access for every current role", () => {
    seed();
    const ids = ["event-z", "event-a"];
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: () => 6 },
      ids: { nextId: () => ids.shift()! },
      clock: { now: () => new Date(AT) },
    });
    repository.executeRollActorDice("gm", envelope("1d6", 0, "dice-command"));
    repository.executeSetActorAttribute("local-owner", {
      commandId: "attribute-command", idempotencyKey: "attribute-key", campaignId: "campaign",
      timelineId: "timeline-old", actorId: "actor", expectedRevision: 1, sourceTurnId: null,
      command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } },
    });
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE campaigns SET active_timeline_id='timeline-new' WHERE id='campaign'").run();
    db.close();
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      expect(repository.listCampaignEvents(principal, "campaign", "timeline-old").map((event) => [
        event.eventId, event.type, event.revision,
      ])).toEqual([
        ["event-z", "actor_dice_rolled", 1],
        ["event-a", "actor_attribute_set", 2],
      ]);
    }
    repository.close();
  });

  it("masks missing, outsider, application-owner-only, and cross-campaign lookups", () => {
    seed();
    execute();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    for (const principal of ["outsider", "app-owner"]) {
      expect(repository.listCampaignEvents(principal, "campaign", "timeline-old")).toEqual([]);
    }
    expect(repository.listCampaignEvents("local-owner", "campaign", "missing-timeline")).toEqual([]);
    expect(repository.listCampaignEvents("local-owner", "campaign-other", "timeline-old")).toEqual([]);
    expect(repository.listCampaignEvents("local-owner", "campaign", "timeline-other")).toEqual([]);
    repository.close();
  });

  it("denies a stale owner identity while retaining GM access and outsider masking", () => {
    seed(); execute(); corrupt("UPDATE campaigns SET owner_principal_id='gm' WHERE id='campaign'");
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string});
    expect(repository.listCampaignEvents("local-owner","campaign","timeline-old")).toEqual([]);
    expect(repository.listCampaignEvents("gm","campaign","timeline-old")).toHaveLength(1);
    expect(repository.listCampaignEvents("outsider","campaign","timeline-old")).toEqual([]);
    repository.close();
  });

  it.each([
    ["orphan receipt", `INSERT INTO command_receipts VALUES
      ('campaign-other','command-0',0,1,'event-dice')`],
    ["orphan roll", `INSERT INTO rpg_dice_rolls VALUES
      ('orphan-roll','campaign-other','orphan-command','1d6',1,6,'all',NULL,0,4)`],
    ["receipt-attributable orphan term", `INSERT INTO command_receipts VALUES
      ('campaign-other','term-command',0,1,'orphan-term');
      INSERT INTO rpg_dice_terms VALUES ('orphan-term',0,4,1)`],
  ])("isolates cross-campaign %s corruption", (_label,mutation) => {
    seed(); execute(); corrupt(mutation);
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string});
    expect(repository.listCampaignEvents("local-owner","campaign","timeline-old"))
      .toHaveLength(1);
    expect(() => repository.listCampaignEvents("local-owner","campaign-other","timeline-other"))
      .toThrow("audit record is incomplete");
    for (const principal of ["outsider","app-owner"]) {
      expect(repository.listCampaignEvents(principal,"campaign-other","timeline-other")).toEqual([]);
    }
    repository.close();
  });

  it("uses one explicit membership-rooted read with no transaction, writes, private projection, or dependencies", () => {
    seed();
    execute();
    const rng = vi.fn(() => 1);
    const id = vi.fn(() => "unused");
    const clock = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: rng }, ids: { nextId: id }, clock: { now: clock } });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      const events = repository.listCampaignEvents("observer", "campaign", "timeline-old");
      expect(events).toHaveLength(1);
      expect(prepare).toHaveBeenCalledTimes(2);
      const sql = prepare.mock.calls[1]![0] as string;
      expect(sql).toMatch(/^SELECT\s/i);
      expect(sql).toMatch(/FROM campaign_memberships membership/);
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/(?:SELECT|,)\s*command\.idempotency_key\s*(?:,|AS|FROM)/i);
      expect(sql).not.toMatch(/private_notes|controller_principal_id/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      expect(transaction).not.toHaveBeenCalled();
      expect(rng).not.toHaveBeenCalled();
      expect(id).not.toHaveBeenCalled();
      expect(clock).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("supports active units of work with both dice projections", () => {
    seed();
    execute();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.listCampaignEvents("player", "campaign", "timeline-old")).toHaveLength(1);
      expect(unit.getCommandReceipt("player", "campaign", "command-0")?.events[0]?.type)
        .toBe("actor_dice_rolled");
    });
    expect(() => expired!.listCampaignEvents("bad actor", "bad campaign", "bad timeline"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
  });

  it.each([
    ["command normalized identity", "UPDATE campaign_commands SET dice_count=2"],
    ["event actor identity", "UPDATE campaign_events SET actor_id='ghost'"],
    ["receipt event identity", "UPDATE command_receipts SET event_id='ghost-event'"],
    ["roll campaign identity", "UPDATE rpg_dice_rolls SET campaign_id='ghost'"],
    ["roll command identity", "UPDATE rpg_dice_rolls SET command_id='ghost-command'"],
    ["roll event identity", "UPDATE rpg_dice_rolls SET event_id='ghost-event'"],
    ["term gap", "UPDATE rpg_dice_terms SET position=2 WHERE position=1"],
    ["missing term", "DELETE FROM rpg_dice_terms WHERE position=1"],
    ["noninteger kept", "UPDATE rpg_dice_terms SET kept=1.5 WHERE position=1"],
    ["raw text kept", "UPDATE rpg_dice_terms SET kept='true' WHERE position=1"],
    ["wrong tied term", "UPDATE rpg_dice_terms SET kept=CASE position WHEN 0 THEN 0 ELSE 1 END"],
    ["missing timeline parent", "DELETE FROM campaign_timelines WHERE id='timeline-old'"],
    ["missing actor parent", "DELETE FROM campaign_actors WHERE id='actor'"],
    ["incomplete timeline history", "UPDATE campaign_timelines SET revision=2 WHERE id='timeline-old'"],
    ["attributable roll without event", `DELETE FROM command_receipts;
      DELETE FROM campaign_events;
      UPDATE campaign_timelines SET revision=0 WHERE id='timeline-old'`],
    ["fully orphaned receipt at reset revision", `DELETE FROM rpg_dice_terms; DELETE FROM rpg_dice_rolls;
      DELETE FROM campaign_events; DELETE FROM campaign_commands;
      UPDATE campaign_timelines SET revision=0 WHERE id='timeline-old'`],
    ["fully orphaned roll at reset revision", `DELETE FROM command_receipts; DELETE FROM campaign_events;
      DELETE FROM campaign_commands; UPDATE campaign_timelines SET revision=0 WHERE id='timeline-old'`],
    ["safely attributable orphan term", "DELETE FROM rpg_dice_rolls"],
  ])("fails loudly for authorized %s corruption while masking outsiders", (_label, mutation) => {
    seed();
    execute();
    corrupt(mutation);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(() => repository.listCampaignEvents("observer", "campaign", "timeline-old"))
      .toThrow("audit record is incomplete");
    expect(repository.listCampaignEvents("outsider", "campaign", "timeline-old")).toEqual([]);
    repository.close();
  });
});
