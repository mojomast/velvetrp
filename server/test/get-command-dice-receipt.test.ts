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

function diceEnvelope(expression: string, revision = 0, commandId = "dice-command"): CommandEnvelope {
  return {
    commandId, idempotencyKey: `key-${commandId}`, campaignId: "campaign", timelineId: "timeline-old",
    actorId: "actor", expectedRevision: revision, sourceTurnId: revision === 0 ? "turn" : null,
    command: { type: "roll_actor_dice", payload: { expression } },
  };
}

function executeDice(expression = "1d20adv", values = [10, 10]): void {
  let index = 0;
  const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
    rng: { integer: () => values[index++]! }, ids: { nextId: () => "dice-event" },
    clock: { now: () => new Date(AT) } });
  repository.executeRollActorDice("local-owner", diceEnvelope(expression));
  repository.close();
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(`DROP TRIGGER IF EXISTS campaign_commands_prevent_update;
    DROP TRIGGER IF EXISTS campaign_commands_prevent_delete;
    DROP TRIGGER IF EXISTS campaign_events_prevent_update;
    DROP TRIGGER IF EXISTS campaign_events_prevent_delete;
    DROP TRIGGER IF EXISTS command_receipts_prevent_update;
    DROP TRIGGER IF EXISTS command_receipts_prevent_delete;
    DROP TRIGGER IF EXISTS rpg_dice_rolls_prevent_update;
    DROP TRIGGER IF EXISTS rpg_dice_rolls_prevent_delete;
    DROP TRIGGER IF EXISTS rpg_dice_terms_prevent_update;
    DROP TRIGGER IF EXISTS rpg_dice_terms_prevent_delete;
    DROP TRIGGER IF EXISTS campaign_timelines_advance_revision;
    ${sql}`);
  db.close();
}

describe("getCommandReceipt dice projection", () => {
  it.each([
    ["all", "3d6", [1, 6, 3], [true, true, true], 10],
    ["keep highest tie", "4d6kh2+2", [4, 4, 2, 1], [true, true, false, false], 10],
    ["keep lowest tie", "4d8kl2-3", [7, 2, 2, 8], [false, true, true, false], 1],
    ["advantage tie", "1d20adv", [12, 12], [true, false], 12],
    ["disadvantage tie", "1d20dis+2", [9, 9], [true, false], 11],
  ] as const)("reconstructs a strict %s receipt", (_label, expression, values, kept, total) => {
    seed();
    executeDice(expression, [...values]);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const receipt = repository.getCommandReceipt("observer", "campaign", "dice-command")!;
    expect(receipt).toMatchObject({ commandId: "dice-command", campaignId: "campaign",
      revisionBefore: 0, revisionAfter: 1, events: [{ eventId: "dice-event", commandId: "dice-command",
        campaignId: "campaign", timelineId: "timeline-old", actorId: "actor", sourceTurnId: "turn",
        type: "actor_dice_rolled", revision: 1, occurredAt: AT,
        data: { expression, terms: values.map((value, index) => ({ value, kept: kept[index] })), total } }] });
    expect(Object.keys(receipt)).toEqual(["commandId", "campaignId", "revisionBefore", "revisionAfter", "events"]);
    expect(JSON.stringify(receipt)).not.toMatch(/idempotency|controller|private|notes|payload|key-dice/i);
    repository.close();
  });

  it("groups and returns all 100 physical terms in order", () => {
    seed();
    executeDice("100d1000kh1+1000", Array.from({ length: 100 }, (_, index) => index + 1));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const event = repository.getCommandReceipt("player", "campaign", "dice-command")!.events[0]!;
    expect(event.type).toBe("actor_dice_rolled");
    if (event.type === "actor_dice_rolled") {
      expect(event.data.terms).toHaveLength(100);
      expect(event.data.terms[0]).toEqual({ value: 1, kept: false });
      expect(event.data.terms[99]).toEqual({ value: 100, kept: true });
    }
    repository.close();
  });

  it("provides role parity for historical receipts and preserves old variants", () => {
    seed();
    const ids = ["dice-event", "attribute-event"];
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: () => 6 }, ids: { nextId: () => ids.shift()! }, clock: { now: () => new Date(AT) } });
    repository.executeRollActorDice("gm", diceEnvelope("1d6"));
    repository.executeSetActorAttribute("local-owner", { commandId: "attribute-command", idempotencyKey: "attribute-key",
      campaignId: "campaign", timelineId: "timeline-old", actorId: "actor", expectedRevision: 1,
      sourceTurnId: null, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 11 } } });
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE campaigns SET active_timeline_id='timeline-new' WHERE id='campaign'").run();
    db.close();
    for (const principal of ["local-owner", "gm", "player", "observer"]) {
      expect(repository.getCommandReceipt(principal, "campaign", "dice-command")?.events[0]?.type)
        .toBe("actor_dice_rolled");
      expect(repository.getCommandReceipt(principal, "campaign", "attribute-command")?.events[0]?.type)
        .toBe("actor_attribute_set");
    }
    repository.close();
  });

  it("masks missing, outsider, application-owner-only, and cross-campaign requests", () => {
    seed(); executeDice();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.getCommandReceipt("outsider", "campaign", "dice-command")).toBeNull();
    expect(repository.getCommandReceipt("app-owner", "campaign", "dice-command")).toBeNull();
    expect(repository.getCommandReceipt("local-owner", "campaign", "missing-command")).toBeNull();
    expect(repository.getCommandReceipt("local-owner", "campaign-other", "dice-command")).toBeNull();
    repository.close();
  });

  it("denies a stale owner identity while retaining GM access and outsider masking", () => {
    seed(); executeDice(); corrupt("UPDATE campaigns SET owner_principal_id='gm' WHERE id='campaign'");
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string});
    expect(repository.getCommandReceipt("local-owner","campaign","dice-command")).toBeNull();
    expect(repository.getCommandReceipt("gm","campaign","dice-command")?.events).toHaveLength(1);
    expect(repository.getCommandReceipt("outsider","campaign","dice-command")).toBeNull();
    repository.close();
  });

  it("uses one explicit membership-rooted all query without writes, transactions, dependencies, or private projection", () => {
    seed(); executeDice();
    const rng = vi.fn(() => 1); const nextId = vi.fn(() => "unused"); const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: rng }, ids: { nextId }, clock: { now } });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.getCommandReceipt("observer", "campaign", "dice-command")?.events).toHaveLength(1);
      expect(prepare).toHaveBeenCalledOnce();
      const sql = prepare.mock.calls[0]![0] as string;
      expect(sql).toMatch(/^SELECT\s/i); expect(sql).toMatch(/FROM campaign_memberships membership/);
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(sql).not.toMatch(/(?:SELECT|,)\s*command\.idempotency_key\s*(?:,|AS|FROM)/i);
      expect(sql).not.toMatch(/private_notes|controller_principal_id|command\.dice_expression\s+AS/i);
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      expect(transaction).not.toHaveBeenCalled(); expect(rng).not.toHaveBeenCalled();
      expect(nextId).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); transaction.mockRestore(); repository.close(); }
  });

  it("supports units of work and enforces unit/repository lifecycle before argument validation", () => {
    seed(); executeDice();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => { expired = unit;
      expect(unit.getCommandReceipt("player", "campaign", "dice-command")?.events[0]?.type).toBe("actor_dice_rolled"); });
    expect(() => expired!.getCommandReceipt("bad actor", "bad campaign", "bad command"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.getCommandReceipt("bad actor", "bad campaign", "bad command"))
      .toThrow("repository is closed");
  });

  it.each([
    ["missing command", "DELETE FROM campaign_commands"],
    ["command timeline", "UPDATE campaign_commands SET timeline_id='timeline-new'"],
    ["command actor", "UPDATE campaign_commands SET actor_id='ghost'"],
    ["command source", "UPDATE campaign_commands SET source_turn_id=NULL"],
    ["command revision", "UPDATE campaign_commands SET expected_revision=1"],
    ["command type", "UPDATE campaign_commands SET type='set_actor_attribute'"],
    ["command key", "UPDATE campaign_commands SET idempotency_key='bad key'"],
    ["command expression", "UPDATE campaign_commands SET dice_expression='1d20dis'"],
    ["command count", "UPDATE campaign_commands SET dice_count=2"],
    ["command sides", "UPDATE campaign_commands SET dice_sides=19"],
    ["command selection", "UPDATE campaign_commands SET dice_selection_type='disadvantage'"],
    ["command modifier", "UPDATE campaign_commands SET dice_modifier=1"],
    ["missing event", "DELETE FROM campaign_events; UPDATE campaign_timelines SET revision=0"],
    ["event command", "UPDATE campaign_events SET command_id='ghost-command'"],
    ["event actor", "UPDATE campaign_events SET actor_id='ghost'"],
    ["event timeline", "UPDATE campaign_events SET timeline_id='timeline-new'"],
    ["event revision", "UPDATE campaign_events SET revision=2"],
    ["event data", "UPDATE campaign_events SET resource_name='hp'"],
    ["missing receipt", "DELETE FROM command_receipts"],
    ["receipt command", "UPDATE command_receipts SET command_id='ghost-command'"],
    ["receipt event", "UPDATE command_receipts SET event_id='ghost-event'"],
    ["receipt revisions", "UPDATE command_receipts SET revision_before=1"],
    ["missing roll", "DELETE FROM rpg_dice_terms; DELETE FROM rpg_dice_rolls"],
    ["roll event", "UPDATE rpg_dice_rolls SET event_id='ghost-event'"],
    ["roll campaign", "UPDATE rpg_dice_rolls SET campaign_id='campaign-other'"],
    ["roll command", "UPDATE rpg_dice_rolls SET command_id='ghost-command'"],
    ["roll expression", "UPDATE rpg_dice_rolls SET expression='1d20dis'"],
    ["roll normalized", "UPDATE rpg_dice_rolls SET dice_sides=19"],
    ["roll total", "UPDATE rpg_dice_rolls SET total=11"],
    ["term gap", "UPDATE rpg_dice_terms SET position=2 WHERE position=1"],
    ["missing term", "DELETE FROM rpg_dice_terms WHERE position=1"],
    ["term value", "UPDATE rpg_dice_terms SET value=21 WHERE position=1"],
    ["term text kept", "UPDATE rpg_dice_terms SET kept='true' WHERE position=1"],
    ["term fractional kept", "UPDATE rpg_dice_terms SET kept=0.5 WHERE position=1"],
    ["unstable tie", "UPDATE rpg_dice_terms SET kept=CASE position WHEN 0 THEN 0 ELSE 1 END"],
    ["missing timeline parent", "DELETE FROM campaign_timelines WHERE id='timeline-old'"],
    ["missing actor parent", "DELETE FROM campaign_actors WHERE id='actor'"],
    ["trailing history gap", "UPDATE campaign_timelines SET revision=2 WHERE id='timeline-old'"],
    ["leading history gap", "UPDATE campaign_events SET revision=2; UPDATE command_receipts SET revision_before=1,revision_after=2; UPDATE campaign_commands SET expected_revision=1; UPDATE campaign_timelines SET revision=2"],
    ["roll-only identity", "DELETE FROM command_receipts; DELETE FROM campaign_events; DELETE FROM campaign_commands; UPDATE campaign_timelines SET revision=0"],
  ])("fails loudly for authorized %s corruption while masking outsiders", (_label, mutation) => {
    seed(); executeDice(); corrupt(mutation);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(() => repository.getCommandReceipt("observer", "campaign", "dice-command")).toThrow();
    expect(repository.getCommandReceipt("outsider", "campaign", "dice-command")).toBeNull();
    repository.close();
  });
});
