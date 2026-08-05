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
const base: CommandEnvelope = { commandId: "command-one", idempotencyKey: "key-one",
  campaignId: "campaign-one", timelineId: "timeline-one", actorId: "actor-one",
  expectedRevision: 0, sourceTurnId: "turn-one",
  command: { type: "roll_actor_dice", payload: { expression: "1d20" } } };

const dbPath = () => path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");

function seed(): void {
  createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }).close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO principals VALUES ('gm','GM',0),('player','Player',0),('observer','Observer',0),('app','App',0)").run();
  db.prepare("UPDATE application_owner SET principal_id='app' WHERE singleton=1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns (id,name,active_timeline_id,owner_principal_id,created_at,updated_at)
      VALUES ('campaign-one','One','timeline-one','local-owner',?,?),('campaign-two','Two','timeline-two','local-owner',?,?)`)
      .run(BEFORE,BEFORE,BEFORE,BEFORE);
    db.prepare(`INSERT INTO campaign_timelines (id,campaign_id,created_at) VALUES
      ('timeline-one','campaign-one',?),('timeline-old','campaign-one',?),('timeline-two','campaign-two',?)`)
      .run(BEFORE,BEFORE,BEFORE);
    db.prepare(`INSERT INTO campaign_memberships VALUES
      ('campaign-one','local-owner','owner',?),('campaign-one','gm','gm',?),
      ('campaign-one','player','player',?),('campaign-one','observer','observer',?),
      ('campaign-two','local-owner','owner',?)`).run(BEFORE,BEFORE,BEFORE,BEFORE,BEFORE);
  })();
  db.prepare("INSERT INTO characters VALUES ('persona-one','One',30,'hero','','stop',1,0,?),('persona-other','Other',30,'hero','','stop',1,0,?),('persona-two','Two',30,'hero','','stop',1,0,?)")
    .run(BEFORE,BEFORE,BEFORE);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Description','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core','1','profile','Core','Description','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core','1','race','human','Human','Description','[]')").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('core','1','background','sage','Sage','Description','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1").run();
  for (const campaign of ["campaign-one","campaign-two"]) {
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?,'core','1','profile')").run(campaign);
  }
  for (const [suffix,campaign,persona] of [["one","campaign-one","persona-one"],["other","campaign-one","persona-other"],["two","campaign-two","persona-two"]]) {
    db.prepare("INSERT INTO campaign_characters VALUES (?,?,?,?,?)").run(`cc-${suffix}`,campaign,persona,BEFORE,BEFORE);
    db.prepare(`INSERT INTO rpg_campaign_sheets VALUES
      (?,?,?,'core','1','race','human','core','1','background','sage',?,?)`)
      .run(`sheet-${suffix}`,campaign,`cc-${suffix}`,BEFORE,BEFORE);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?,?,0,'strength',10)")
      .run(campaign,`sheet-${suffix}`);
    db.prepare("INSERT INTO campaign_actors VALUES (?,?,?,?, 'player-character','principal',?,?)")
      .run(`actor-${suffix}`,campaign,`cc-${suffix}`,`sheet-${suffix}`,BEFORE,BEFORE);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES (?,?,'local-owner',NULL)").run(`actor-${suffix}`,campaign);
  }
  db.close();
}

function factory(values: number[] = [10], options: { id?: string; at?: string } = {}) {
  let index = 0;
  return createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
    rng: { integer: vi.fn(() => values[index++]!) },
    ids: { nextId: vi.fn(() => options.id ?? "event-one") },
    clock: { now: vi.fn(() => new Date(options.at ?? AT)) } });
}

function guardedFactory(values: number[] = [10]) {
  let index = 0;
  const rng = vi.fn(() => values[index++]!);
  const id = vi.fn(() => "unused-event");
  const clock = vi.fn(() => new Date(AT));
  const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
    rng: { integer: rng }, ids: { nextId: id }, clock: { now: clock } });
  return { repository, rng, id, clock };
}

function expectNoDependencies(dependencies: ReturnType<typeof guardedFactory>): void {
  expect(dependencies.rng).not.toHaveBeenCalled();
  expect(dependencies.id).not.toHaveBeenCalled();
  expect(dependencies.clock).not.toHaveBeenCalled();
}

/** Disable only database defenses needed to emulate a corrupt persisted retry. */
function corruptRetry(sql: string, params: unknown[] = []): void {
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
    DROP TRIGGER IF EXISTS rpg_dice_terms_prevent_replace;
    DROP TRIGGER IF EXISTS rpg_dice_terms_must_precede_event;
    DROP TRIGGER IF EXISTS campaign_timelines_advance_revision;`);
  if (params.length === 0) db.exec(sql);
  else db.prepare(sql).run(...params);
  db.close();
}

function executeBase(expression = "3d6kh2+2", values = [4,4,1]) {
  const envelope = { ...base, command: { type: "roll_actor_dice" as const, payload: { expression } } };
  const repository = factory(values, { id: "event-one" });
  const receipt = repository.executeRollActorDice("local-owner", envelope);
  repository.close();
  return { envelope, receipt };
}

function snapshot() {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const value = { commands: db.prepare("SELECT * FROM campaign_commands ORDER BY command_id").all(),
    rolls: db.prepare("SELECT * FROM rpg_dice_rolls ORDER BY event_id").all(),
    terms: db.prepare("SELECT * FROM rpg_dice_terms ORDER BY event_id,position").all(),
    events: db.prepare("SELECT * FROM campaign_events ORDER BY event_id").all(),
    receipts: db.prepare("SELECT * FROM command_receipts ORDER BY command_id").all(),
    revision: db.prepare("SELECT revision FROM campaign_timelines WHERE id='timeline-one'").get(),
    times: ["campaigns","campaign_characters","rpg_campaign_sheets","campaign_actors"].map((table) =>
      db.prepare(`SELECT updated_at FROM ${table} WHERE id=?`).get(table === "campaigns" ? "campaign-one"
        : table === "campaign_characters" ? "cc-one" : table === "rpg_campaign_sheets" ? "sheet-one" : "actor-one")) };
  db.close(); return value;
}

function winnerWrites(commandId = "command-one", key = "key-one") {
  return [
    { sql: `INSERT INTO campaign_commands (campaign_id,command_id,idempotency_key,timeline_id,actor_id,
      expected_revision,source_turn_id,type,dice_expression,dice_count,dice_sides,dice_selection_type,
      dice_selection_count,dice_modifier) VALUES
       ('campaign-one',?,?,'timeline-one','actor-one',0,'turn-one','roll_actor_dice','1d20',1,20,'all',NULL,0)`, params:[commandId,key] },
    { sql: "UPDATE campaign_timelines SET revision=1 WHERE id='timeline-one'" },
    { sql: `INSERT INTO rpg_dice_rolls VALUES
      ('event-worker','campaign-one',?,'1d20',1,20,'all',NULL,0,10)`, params:[commandId] },
    { sql: "INSERT INTO rpg_dice_terms VALUES ('event-worker',0,10,1)" },
    { sql: `INSERT INTO campaign_events (event_id,campaign_id,command_id,timeline_id,actor_id,source_turn_id,type,
      revision,occurred_at) VALUES
       ('event-worker','campaign-one',?,'timeline-one','actor-one','turn-one','actor_dice_rolled',1,?)`, params:[commandId,AT] },
    { sql: "INSERT INTO command_receipts VALUES ('campaign-one',?,0,1,'event-worker')", params:[commandId] },
  ];
}

describe("roll actor dice command", () => {
  it.each([
    ["2d6",[1,6],[true,true],7], ["3d6kh2+2",[4,4,1],[true,true,false],10],
    ["3d6kl2-2",[4,4,6],[true,true,false],6], ["1d20adv",[12,12],[true,false],12],
    ["1d20dis",[7,7],[true,false],7], ["100d1000+1000",Array(100).fill(1000),Array(100).fill(true),101000],
  ])("persists %s with stable earlier-index ties and bounds", (expression, values, kept, total) => {
    seed(); const repository = factory(values as number[]);
    const receipt = repository.executeRollActorDice("local-owner", { ...base,
      command: { type: "roll_actor_dice", payload: { expression: expression as string } } });
    expect(receipt.events[0]).toMatchObject({ type: "actor_dice_rolled", occurredAt: AT,
      data: { expression, terms: (values as number[]).map((value,index) => ({ value, kept: (kept as boolean[])[index] })), total } });
    repository.close(); const state = snapshot();
    expect(state.revision).toEqual({ revision: 1 });
    expect(state.times).toEqual(Array(4).fill({ updated_at: BEFORE }));
    expect(state.rolls).toHaveLength(1); expect(state.terms).toHaveLength((values as number[]).length);
  });

  it("uses exactly RNG terms, then one ID, then one clock and validates each without retry", () => {
    seed(); const calls: string[] = []; let die = 0;
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      rng: { integer: vi.fn((min,max) => { calls.push(`rng:${min}:${max}`); return [2,5][die++]!; }) },
      ids: { nextId: vi.fn(() => { calls.push("id"); return "event-one"; }) },
      clock: { now: vi.fn(() => { calls.push("clock"); return new Date(AT); }) } });
    repository.executeRollActorDice("gm", { ...base, command: { type: "roll_actor_dice", payload: { expression: "2d6" } } });
    expect(calls).toEqual(["rng:1:7","rng:1:7","id","clock"]); repository.close();
  });

  it.each([
    ["rng", { rng: { integer: () => 0 }, ids: { nextId: vi.fn(() => "unused") }, clock: { now: vi.fn(() => new Date(AT)) } }],
    ["id", { rng: { integer: () => 1 }, ids: { nextId: () => "bad id" }, clock: { now: vi.fn(() => new Date(AT)) } }],
    ["clock", { rng: { integer: () => 1 }, ids: { nextId: () => "event-one" }, clock: { now: () => new Date("invalid") } }],
  ])("rolls back a %s dependency failure without hidden retry", (_label, dependencies) => {
    seed(); const before = snapshot();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ...dependencies });
    expect(() => repository.executeRollActorDice("local-owner", base)).toThrow();
    repository.close(); expect(snapshot()).toEqual(before);
  });

  it.each([
    ["first RNG invalid",[0,2,3],undefined,undefined,1,0,0],
    ["midstream RNG invalid",[1,7,3],undefined,undefined,2,0,0],
    ["midstream RNG throws",[1,new Error("rng failed"),3],undefined,undefined,2,0,0],
    ["ID invalid",[1,2,3],"bad id",undefined,3,1,0],
    ["ID throws",[1,2,3],new Error("id failed"),undefined,3,1,0],
    ["clock invalid",[1,2,3],"event-one","invalid",3,1,1],
    ["clock throws",[1,2,3],"event-one",new Error("clock failed"),3,1,1],
  ] as const)("short-circuits exactly when %s", (_label,rolls,idResult,clockResult,rngCalls,idCalls,clockCalls) => {
    seed(); const before=snapshot(); let index=0;
    const rng=vi.fn(() => { const value=rolls[index++]; if (value instanceof Error) throw value; return value as number; });
    const id=vi.fn(() => { if (idResult instanceof Error) throw idResult; return idResult ?? "event-one"; });
    const clock=vi.fn(() => { if (clockResult instanceof Error) throw clockResult; return new Date(clockResult ?? AT); });
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:id},clock:{now:clock}});
    expect(() => repository.executeRollActorDice("local-owner",{...base,
      command:{type:"roll_actor_dice",payload:{expression:"3d6"}}})).toThrow();
    expect(rng).toHaveBeenCalledTimes(rngCalls); expect(id).toHaveBeenCalledTimes(idCalls);
    expect(clock).toHaveBeenCalledTimes(clockCalls); expect(snapshot()).toEqual(before); repository.close();
  });

  it.each(["local-owner","gm"])("authorizes %s", (principal) => {
    seed(); const repository=factory(); expect(repository.executeRollActorDice(principal,base).revisionAfter).toBe(1); repository.close();
  });
  it.each(["player","observer","app","missing"])("non-disclosingly denies %s before dependencies", (principal) => {
    seed(); const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice(principal,base)).toThrow("command unavailable");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["missing principal parent","DELETE FROM principals WHERE id='local-owner'","local-owner"],
    ["missing campaign parent","DELETE FROM campaigns WHERE id='campaign-one'","gm"],
    ["missing owner membership","DELETE FROM campaign_memberships WHERE campaign_id='campaign-one' AND principal_id='local-owner'","local-owner"],
    ["missing GM membership","DELETE FROM campaign_memberships WHERE campaign_id='campaign-one' AND principal_id='gm'","gm"],
    ["owner disagreement","UPDATE campaigns SET owner_principal_id='gm' WHERE id='campaign-one'","local-owner"],
  ])("denies corrupt authorization: %s before every dependency", (_label,sql,principal) => {
    seed(); const db=new DatabaseDriver(dbPath()); db.pragma("foreign_keys=OFF"); if(sql.startsWith("DELETE FROM campaigns"))deleteCampaignForCorruptionTest(db,"campaign-one");db.exec(sql); db.close();
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice(principal,base)).toThrow("command unavailable");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("retains valid GM authority despite persisted owner disagreement", () => {
    seed(); const db=new DatabaseDriver(dbPath()); db.pragma("foreign_keys=OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id='gm' WHERE id='campaign-one'").run(); db.close();
    const repository=factory(); expect(repository.executeRollActorDice("gm",base).revisionAfter).toBe(1); repository.close();
  });

  it.each(["player","observer","app","missing"])("does not disclose known versus unknown command identity to %s", (principal) => {
    seed(); const first=factory(); first.executeRollActorDice("local-owner",base); first.close();
    const guarded=guardedFactory();
    for (const commandId of [base.commandId,"unknown-command"]) {
      expect(() => guarded.repository.executeRollActorDice(principal,{...base,commandId})).toThrow("command unavailable");
    }
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("strictly rejects other variants and remains factory-only", () => {
    seed(); const guarded=guardedFactory(); const repository=guarded.repository;
    for (const command of [{ type:"set_actor_attribute",payload:{attributeId:"x",value:1} },
      { type:"initialize_actor_resource",payload:{name:"hp",current:1,max:1} }] as const) {
      expect(() => repository.executeRollActorDice("local-owner",{...base,command})).toThrow("requires a roll_actor_dice command");
    }
    expectNoDependencies(guarded);
    expect(() => repository.transaction((unit) => (unit as unknown as { executeRollActorDice(): void }).executeRollActorDice()))
      .toThrow();
    expectNoDependencies(guarded);
    expect("executeRollActorDice" in repoModule).toBe(false); repository.close();
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow("repository is closed");
    expectNoDependencies(guarded);
  });

  it("returns an exact retry after timeline deactivation with zero dependencies", () => {
    seed(); const first=factory([6]); const receipt=first.executeRollActorDice("local-owner",base); first.close();
    const db=new DatabaseDriver(dbPath()); db.prepare("UPDATE campaigns SET active_timeline_id='timeline-old' WHERE id='campaign-one'").run(); db.close();
    const rng=vi.fn(() => 1), id=vi.fn(() => "unused"), clock=vi.fn(() => new Date("invalid"));
    const retry=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,rng:{integer:rng},ids:{nextId:id},clock:{now:clock}});
    expect(retry.executeRollActorDice("gm",base)).toEqual(receipt);
    expect(rng).not.toHaveBeenCalled(); expect(id).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled(); retry.close();
  });

  it("returns an earlier exact retry after later valid history without replaying dependencies", () => {
    seed();
    const rng=vi.fn().mockReturnValueOnce(6).mockReturnValueOnce(2);
    const ids=vi.fn().mockReturnValueOnce("event-first").mockReturnValueOnce("event-second");
    const clock=vi.fn(() => new Date(AT));
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:ids},clock:{now:clock}});
    const first=repository.executeRollActorDice("local-owner",base);
    repository.executeRollActorDice("gm",{...base,commandId:"command-two",idempotencyKey:"key-two",expectedRevision:1});
    rng.mockClear(); ids.mockClear(); clock.mockClear();
    expect(repository.executeRollActorDice("gm",base)).toEqual(first);
    expectNoDependencies({repository,rng,id:ids,clock}); repository.close();
  });

  it.each(["attribute", "resource"] as const)(
  "returns an earlier dice retry after valid later %s history with zero dependencies", (variant) => {
    seed();
    const ids=vi.fn().mockReturnValueOnce("event-first").mockReturnValueOnce(`event-${variant}`);
    const rng=vi.fn(() => 6); const clock=vi.fn(() => new Date(AT));
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:ids},clock:{now:clock}});
    const first=repository.executeRollActorDice("local-owner",base);
    if (variant === "attribute") repository.executeSetActorAttribute("gm",{
      ...base,commandId:"attribute-command",idempotencyKey:"attribute-key",expectedRevision:1,
      sourceTurnId:null,command:{type:"set_actor_attribute",payload:{attributeId:"strength",value:11}},
    });
    else repository.executeInitializeActorResource("gm",{
      ...base,commandId:"resource-command",idempotencyKey:"resource-key",expectedRevision:1,
      sourceTurnId:null,command:{type:"initialize_actor_resource",payload:{name:"MP",current:3,max:9}},
    });
    rng.mockClear(); ids.mockClear(); clock.mockClear();
    expect(repository.executeRollActorDice("gm",base)).toEqual(first);
    expectNoDependencies({repository,rng,id:ids,clock}); repository.close();
  });

  it.each([
    ["timeline",{timelineId:"timeline-old"}], ["actor",{actorId:"actor-other"}],
    ["revision",{expectedRevision:1}], ["source",{sourceTurnId:null}],
    ["expression",{command:{type:"roll_actor_dice",payload:{expression:"1d6"}}}],
  ])("rejects same-pair envelope disagreement by %s before every dependency", (_label,patch) => {
    seed(); const first=factory(); first.executeRollActorDice("local-owner",base); first.close();
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",{...base,...patch} as CommandEnvelope)).toThrow("identity collision");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["timeline_id","timeline-old"], ["actor_id","actor-other"], ["expected_revision",1],
    ["source_turn_id",null], ["type","initialize_actor_resource"], ["attribute_id","strength"],
    ["value",11], ["resource_name","hp"], ["resource_current",1], ["resource_max",1],
    ["dice_expression","1d6"], ["dice_count",2], ["dice_sides",6],
    ["dice_selection_type","keep_highest"], ["dice_selection_count",1], ["dice_modifier",1],
  ])("rejects a malformed persisted command %s before every dependency", (column,value) => {
    seed(); executeBase("1d20",[10]);
    corruptRetry(`UPDATE campaign_commands SET ${column}=? WHERE command_id='command-one'`,[value]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",base)).toThrow("identity collision");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["event_id","other-event"], ["campaign_id","campaign-two"], ["command_id","other-command"],
    ["timeline_id","timeline-old"], ["actor_id","actor-other"], ["source_turn_id",null],
    ["type","actor_attribute_set"], ["revision",2], ["occurred_at","not-a-time"],
    ["attribute_id","strength"], ["value_before",1], ["value_after",2],
    ["resource_name","hp"], ["resource_current",1], ["resource_max",2],
  ])("rejects a malformed retry event %s before every dependency", (column,value) => {
    seed(); const {envelope}=executeBase();
    corruptRetry(`UPDATE campaign_events SET ${column}=? WHERE event_id='event-one'`,[value]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["campaign_id","campaign-two"], ["command_id","other-command"],
    ["revision_before",1], ["revision_after",2], ["event_id","other-event"],
  ])("rejects a malformed retry receipt %s before every dependency", (column,value) => {
    seed(); const {envelope}=executeBase();
    corruptRetry(`UPDATE command_receipts SET ${column}=? WHERE command_id='command-one'`,[value]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["event_id","other-event"], ["campaign_id","campaign-two"], ["command_id","other-command"],
    ["expression","3d6kh2+3"], ["dice_count",2], ["dice_sides",8],
    ["selection_type","keep_lowest"], ["selection_count",1], ["modifier",3], ["total",11],
  ])("rejects a malformed retry roll %s before every dependency", (column,value) => {
    seed(); const {envelope}=executeBase();
    corruptRetry(`UPDATE rpg_dice_rolls SET ${column}=? WHERE event_id='event-one'`,[value]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["missing","DELETE FROM rpg_dice_terms WHERE position=1"],
    ["gapped","UPDATE rpg_dice_terms SET position=4 WHERE position=1"],
    ["noninteger position","UPDATE rpg_dice_terms SET position=1.5 WHERE position=1"],
    ["text position","UPDATE rpg_dice_terms SET position='one' WHERE position=1"],
    ["extra","INSERT INTO rpg_dice_terms VALUES ('event-one',3,2,0)"],
    ["zero value","UPDATE rpg_dice_terms SET value=0 WHERE position=0"],
    ["fractional value","UPDATE rpg_dice_terms SET value=1.5 WHERE position=0"],
    ["text value","UPDATE rpg_dice_terms SET value='four' WHERE position=0"],
    ["above sides","UPDATE rpg_dice_terms SET value=7 WHERE position=0"],
    ["kept text zero","UPDATE rpg_dice_terms SET kept='false' WHERE position=2"],
    ["kept text one","UPDATE rpg_dice_terms SET kept='true' WHERE position=0"],
    ["kept fraction","UPDATE rpg_dice_terms SET kept=0.5 WHERE position=0"],
    ["kept negative","UPDATE rpg_dice_terms SET kept=-1 WHERE position=0"],
    ["kept two","UPDATE rpg_dice_terms SET kept=2 WHERE position=0"],
    ["wrong selection","UPDATE rpg_dice_terms SET kept=0 WHERE position=0"],
  ])("rejects malformed retry terms: %s with zero dependencies", (_label,sql) => {
    seed(); const {envelope}=executeBase(); corruptRetry(sql);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("rejects a later-index tie selected in persisted terms", () => {
    seed(); const {envelope}=executeBase("3d6kh1",[4,4,1]);
    corruptRetry("UPDATE rpg_dice_terms SET kept=CASE position WHEN 0 THEN 0 WHEN 1 THEN 1 ELSE kept END");
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow("retry is invalid");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["missing timeline parent","DELETE FROM campaign_timelines WHERE id='timeline-one'"],
    ["missing actor parent","DELETE FROM campaign_actors WHERE id='actor-one'"],
    ["timeline behind event","UPDATE campaign_timelines SET revision=0 WHERE id='timeline-one'"],
    ["timeline ahead without history","UPDATE campaign_timelines SET revision=2 WHERE id='timeline-one'"],
    ["gapped history","UPDATE campaign_events SET revision=2; UPDATE campaign_timelines SET revision=2 WHERE id='timeline-one'"],
  ])("rejects malformed retry history: %s before every dependency", (_label,sql) => {
    seed(); const {envelope}=executeBase(); corruptRetry(sql);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow(/retry is (?:incomplete|invalid)|Invalid/);
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["actor deletion", "DELETE FROM campaign_actors WHERE id='actor-one'"],
    ["campaign character deletion", "DELETE FROM campaign_characters WHERE id='cc-one'"],
    ["global character deletion", "DELETE FROM characters WHERE id='persona-one'"],
    ["exact sheet deletion", "DELETE FROM rpg_campaign_sheets WHERE id='sheet-one'"],
    ["actor campaign disagreement", "UPDATE campaign_actors SET campaign_id='campaign-two' WHERE id='actor-one'"],
    ["actor/campaign-character disagreement", "DELETE FROM campaign_actors WHERE id='actor-other'; UPDATE campaign_actors SET campaign_character_id='cc-other' WHERE id='actor-one'"],
    ["actor/sheet disagreement", "UPDATE campaign_actors SET sheet_id='sheet-other' WHERE id='actor-one'"],
    ["sheet/campaign-character disagreement", "DELETE FROM rpg_campaign_sheets WHERE id='sheet-other'; UPDATE rpg_campaign_sheets SET campaign_character_id='cc-other' WHERE id='sheet-one'"],
    ["campaign-character campaign disagreement", "UPDATE campaign_characters SET campaign_id='campaign-two' WHERE id='cc-one'"],
    ["campaign-character/global-character disagreement", "UPDATE campaign_characters SET character_id='ghost' WHERE id='cc-one'"],
    ["sheet campaign disagreement", "UPDATE rpg_campaign_sheets SET campaign_id='campaign-two' WHERE id='sheet-one'"],
  ])("rejects exact retry actor ancestry corruption: %s with zero dependencies", (_label,sql) => {
    seed(); const {envelope}=executeBase(); corruptRetry(sql);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",envelope)).toThrow("retry is incomplete");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["command parent", "DELETE FROM campaign_commands WHERE command_id='command-two'"],
    ["receipt parent", "DELETE FROM command_receipts WHERE command_id='command-two'"],
    ["actor parent", "UPDATE campaign_events SET actor_id='ghost' WHERE command_id='command-two'"],
    ["timeline parent", "UPDATE campaign_events SET timeline_id='timeline-old' WHERE command_id='command-two'"],
    ["complete dice aggregate", "UPDATE rpg_dice_terms SET kept=CASE position WHEN 0 THEN 0 ELSE 1 END WHERE event_id='event-second'"],
  ])("rejects corrupt later timeline history lacking %s with zero dependencies", (_label,sql) => {
    seed();
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:vi.fn().mockReturnValueOnce(6).mockReturnValueOnce(4).mockReturnValueOnce(4)},
      ids:{nextId:vi.fn().mockReturnValueOnce("event-first").mockReturnValueOnce("event-second")},
      clock:{now:vi.fn(() => new Date(AT))}});
    const first=repository.executeRollActorDice("local-owner",base); repository.executeRollActorDice("gm",{
      ...base,commandId:"command-two",idempotencyKey:"key-two",expectedRevision:1,
      command:{type:"roll_actor_dice",payload:{expression:"1d20adv"}},
    }); repository.close();
    corruptRetry(sql); const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",base)).toThrow("retry is invalid");
    expect(first.revisionAfter).toBe(1); expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["attribute payload ID", "attribute", `UPDATE campaign_commands SET attribute_id='bad attribute'
      WHERE command_id='later-command'; UPDATE campaign_events SET attribute_id='bad attribute'
      WHERE command_id='later-command'`],
    ["resource payload name", "resource", `UPDATE campaign_commands SET resource_name='bad resource'
      WHERE command_id='later-command'; UPDATE campaign_events SET resource_name='bad resource'
      WHERE command_id='later-command'`],
    ["common event ID", "attribute", `UPDATE campaign_events SET event_id='bad event'
      WHERE command_id='later-command'; UPDATE command_receipts SET event_id='bad event'
      WHERE command_id='later-command'`],
    ["nullable source-turn ID", "resource", `UPDATE campaign_commands SET source_turn_id='bad source'
      WHERE command_id='later-command'; UPDATE campaign_events SET source_turn_id='bad source'
      WHERE command_id='later-command'`],
  ] as const)("rejects independent later-history %s corruption with zero dependencies", (_label,variant,sql) => {
    seed();
    const ids=vi.fn().mockReturnValueOnce("event-first").mockReturnValueOnce("event-later");
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:vi.fn(() => 6)},ids:{nextId:ids},clock:{now:vi.fn(() => new Date(AT))}});
    repository.executeRollActorDice("local-owner",base);
    const later={...base,commandId:"later-command",idempotencyKey:"later-key",expectedRevision:1,
      sourceTurnId:null};
    if (variant === "attribute") repository.executeSetActorAttribute("gm",{...later,
      command:{type:"set_actor_attribute",payload:{attributeId:"strength",value:11}}});
    else repository.executeInitializeActorResource("gm",{...later,
      command:{type:"initialize_actor_resource",payload:{name:"MP",current:3,max:9}}});
    repository.close(); corruptRetry(sql);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",base)).toThrow("retry is invalid");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["id",{idempotencyKey:"other"}], ["key",{commandId:"other"}], ["actor",{actorId:"actor-two"}],
    ["expression",{command:{type:"roll_actor_dice",payload:{expression:"1d6"}}}],
  ])("detects shared identity collision by %s before RNG", (_label,patch) => {
    seed(); const first=factory(); first.executeRollActorDice("local-owner",base); first.close();
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",{...base,...patch} as CommandEnvelope)).toThrow("identity collision");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("shares command and key identity with older variants", () => {
    seed(); const db=new DatabaseDriver(dbPath());
    db.prepare(`INSERT INTO campaign_commands (campaign_id,command_id,idempotency_key,timeline_id,actor_id,
      expected_revision,source_turn_id,type,resource_name,resource_current,resource_max)
      VALUES ('campaign-one','command-one','other','timeline-one','actor-one',0,NULL,'initialize_actor_resource','hp',1,1)`).run(); db.close();
    const guarded=guardedFactory(); expect(() => guarded.repository.executeRollActorDice("local-owner",base)).toThrow("identity collision");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["attribute same ID","set_actor_attribute","command-one","older-key"],
    ["attribute same key","set_actor_attribute","older-command","key-one"],
    ["resource same ID","initialize_actor_resource","command-one","older-key"],
    ["resource same key","initialize_actor_resource","older-command","key-one"],
  ])("shares the full collision namespace: %s", (_label,type,commandId,key) => {
    seed(); const db=new DatabaseDriver(dbPath());
    if (type === "set_actor_attribute") db.prepare(`INSERT INTO campaign_commands
      (campaign_id,command_id,idempotency_key,timeline_id,actor_id,expected_revision,source_turn_id,type,attribute_id,value)
      VALUES ('campaign-one',?,?,'timeline-one','actor-one',0,NULL,'set_actor_attribute','strength',11)`).run(commandId,key);
    else db.prepare(`INSERT INTO campaign_commands
      (campaign_id,command_id,idempotency_key,timeline_id,actor_id,expected_revision,source_turn_id,type,resource_name,resource_current,resource_max)
      VALUES ('campaign-one',?,?,'timeline-one','actor-one',0,NULL,'initialize_actor_resource','hp',1,1)`).run(commandId,key);
    db.close(); const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",base)).toThrow("identity collision");
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("rejects a real split dice command-ID/idempotency-key collision", () => {
    seed(); const rng=vi.fn(() => 10), ids=vi.fn().mockReturnValueOnce("event-a").mockReturnValueOnce("event-b");
    const clock=vi.fn(() => new Date(AT));
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:ids},clock:{now:clock}});
    repository.executeRollActorDice("local-owner",{...base,idempotencyKey:"key-a"});
    repository.executeRollActorDice("local-owner",{...base,commandId:"command-b",expectedRevision:1});
    rng.mockClear(); ids.mockClear(); clock.mockClear();
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow("identity collision");
    expectNoDependencies({repository,rng,id:ids,clock}); repository.close();
  });

  it.each([
    ["inactive","UPDATE campaigns SET active_timeline_id='timeline-old' WHERE id='campaign-one'"],
    ["stale","UPDATE campaign_timelines SET revision=1 WHERE id='timeline-one'"],
  ])("rejects %s before dependencies", (_label,sql) => {
    seed(); const db=new DatabaseDriver(dbPath()); db.pragma("foreign_keys=OFF"); db.prepare(sql).run(); db.close();
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",base)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["missing actor","DELETE FROM campaign_actors WHERE id='actor-one'"],
    ["missing campaign character","DELETE FROM campaign_characters WHERE id='cc-one'"],
    ["missing exact sheet","DELETE FROM rpg_campaign_sheets WHERE id='sheet-one'"],
    ["missing global persona","DELETE FROM characters WHERE id='persona-one'"],
    ["actor character disagreement","DELETE FROM campaign_actors WHERE id='actor-other'; UPDATE campaign_actors SET campaign_character_id='cc-other' WHERE id='actor-one'"],
    ["actor sheet disagreement","UPDATE campaign_actors SET sheet_id='sheet-other' WHERE id='actor-one'"],
    ["sheet character disagreement","DELETE FROM rpg_campaign_sheets WHERE id='sheet-other'; UPDATE rpg_campaign_sheets SET campaign_character_id='cc-other' WHERE id='sheet-one'"],
    ["character campaign disagreement","UPDATE campaign_characters SET campaign_id='campaign-two' WHERE id='cc-one'"],
    ["sheet campaign disagreement","UPDATE rpg_campaign_sheets SET campaign_id='campaign-two' WHERE id='sheet-one'"],
    ["actor campaign disagreement","UPDATE campaign_actors SET campaign_id='campaign-two' WHERE id='actor-one'"],
  ])("rejects complete actor ancestry corruption: %s", (_label,sql) => {
    seed(); const before=snapshot(); const db=new DatabaseDriver(dbPath()); db.pragma("foreign_keys=OFF"); db.exec(sql); db.close();
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",base)).toThrow("target unavailable");
    expectNoDependencies(guarded);
    expect(snapshot().commands).toEqual(before.commands); guarded.repository.close();
  });

  it("supports the maximum safe expected revision", () => {
    seed(); const db=new DatabaseDriver(dbPath()); db.exec("DROP TRIGGER campaign_timelines_advance_revision");
    db.prepare("UPDATE campaign_timelines SET revision=? WHERE id='timeline-one'")
      .run(Number.MAX_SAFE_INTEGER-1); db.close();
    const repository=factory(); const receipt=repository.executeRollActorDice("local-owner",
      {...base,expectedRevision:Number.MAX_SAFE_INTEGER-1});
    expect(receipt.revisionAfter).toBe(Number.MAX_SAFE_INTEGER); repository.close();
  });

  it.each(["zero",0.5,-1,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])
  ("rejects malformed or overflowing input revision %s before every dependency", (revision) => {
    seed(); const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",{...base,expectedRevision:revision as number})).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each(["zero",0.5,-1,Number.MAX_SAFE_INTEGER+1])
  ("rejects malformed persisted active revision %s before every dependency", (revision) => {
    seed(); corruptRetry("UPDATE campaign_timelines SET revision=? WHERE id='timeline-one'",[revision]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("local-owner",base)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each(["one",1.5,-1,Number.MAX_SAFE_INTEGER+1])
  ("rejects malformed persisted retry revision %s before every dependency", (revision) => {
    seed(); executeBase("1d20",[10]);
    corruptRetry("UPDATE campaign_timelines SET revision=? WHERE id='timeline-one'",[revision]);
    const guarded=guardedFactory();
    expect(() => guarded.repository.executeRollActorDice("gm",base)).toThrow();
    expectNoDependencies(guarded); guarded.repository.close();
  });

  it("rolls back all writes on event identity collision", () => {
    seed(); const db=new DatabaseDriver(dbPath());
    db.prepare(`INSERT INTO campaign_commands (campaign_id,command_id,idempotency_key,timeline_id,actor_id,expected_revision,
      source_turn_id,type,resource_name,resource_current,resource_max) VALUES
      ('campaign-two','other','other','timeline-two','actor-two',0,NULL,'initialize_actor_resource','hp',1,1)`).run();
    db.prepare("UPDATE campaign_timelines SET revision=1 WHERE id='timeline-two'").run();
    db.prepare(`INSERT INTO campaign_events (event_id,campaign_id,command_id,timeline_id,actor_id,source_turn_id,type,
      revision,occurred_at,resource_name,resource_current,resource_max) VALUES
      ('event-one','campaign-two','other','timeline-two','actor-two',NULL,'actor_resource_initialized',1,?,'hp',1,1)`).run(AT);
    db.prepare("INSERT INTO command_receipts VALUES ('campaign-two','other',0,1,'event-one')").run(); db.close();
    const before=snapshot(); const repository=factory(); expect(() => repository.executeRollActorDice("local-owner",base)).toThrow();
    repository.close(); expect(snapshot()).toEqual(before);
  });

  it("persists in command, timeline, roll, ordered terms, event, receipt order", () => {
    seed(); const db=new DatabaseDriver(dbPath()); db.exec(`CREATE TABLE write_order(pos INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT);
      CREATE TRIGGER wo_c AFTER INSERT ON campaign_commands BEGIN INSERT INTO write_order(name) VALUES ('command'); END;
      CREATE TRIGGER wo_t AFTER UPDATE ON campaign_timelines BEGIN INSERT INTO write_order(name) VALUES ('timeline'); END;
      CREATE TRIGGER wo_r AFTER INSERT ON rpg_dice_rolls BEGIN INSERT INTO write_order(name) VALUES ('roll'); END;
      CREATE TRIGGER wo_d AFTER INSERT ON rpg_dice_terms BEGIN INSERT INTO write_order(name) VALUES ('term-'||NEW.position); END;
      CREATE TRIGGER wo_e AFTER INSERT ON campaign_events BEGIN INSERT INTO write_order(name) VALUES ('event'); END;
      CREATE TRIGGER wo_p AFTER INSERT ON command_receipts BEGIN INSERT INTO write_order(name) VALUES ('receipt'); END;`); db.close();
    const repository=factory([2,4,6]); repository.executeRollActorDice("local-owner",{...base,command:{type:"roll_actor_dice",payload:{expression:"3d6"}}}); repository.close();
    const verify=new DatabaseDriver(dbPath(),{readonly:true}); expect((verify.prepare("SELECT name FROM write_order ORDER BY pos").all() as Array<{name:string}>).map(x=>x.name))
      .toEqual(["command","timeline","roll","term-0","term-1","term-2","event","receipt"]); verify.close();
  });

  it.each([
    ["before command","BEFORE INSERT ON campaign_commands", ""], ["after command","AFTER INSERT ON campaign_commands", ""],
    ["before timeline","BEFORE UPDATE ON campaign_timelines", ""], ["after timeline","AFTER UPDATE ON campaign_timelines", ""],
    ["before roll","BEFORE INSERT ON rpg_dice_rolls", ""], ["after roll","AFTER INSERT ON rpg_dice_rolls", ""],
    ["before first term","BEFORE INSERT ON rpg_dice_terms", "WHEN NEW.position=0"],
    ["after first term","AFTER INSERT ON rpg_dice_terms", "WHEN NEW.position=0"],
    ["before middle term","BEFORE INSERT ON rpg_dice_terms", "WHEN NEW.position=1"],
    ["after middle term","AFTER INSERT ON rpg_dice_terms", "WHEN NEW.position=1"],
    ["before last term","BEFORE INSERT ON rpg_dice_terms", "WHEN NEW.position=2"],
    ["after last term","AFTER INSERT ON rpg_dice_terms", "WHEN NEW.position=2"],
    ["before event","BEFORE INSERT ON campaign_events", ""], ["after event","AFTER INSERT ON campaign_events", ""],
    ["before receipt","BEFORE INSERT ON command_receipts", ""], ["after receipt","AFTER INSERT ON command_receipts", ""],
  ])("rolls back at the %s boundary", (_label, timing, when) => {
    seed(); const before=snapshot(); const db=new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER injected_failure ${timing} ${when} BEGIN SELECT RAISE(ABORT,'injected'); END;`); db.close();
    const repository=factory([1,2,3]);
    expect(() => repository.executeRollActorDice("local-owner",{...base,
      command:{type:"roll_actor_dice",payload:{expression:"3d6"}}})).toThrow("injected");
    repository.close(); expect(snapshot()).toEqual(before);
  });

  it("rolls back a conditional revision loss after the command write", () => {
    seed(); const before=snapshot(); const db=new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER steal_revision AFTER INSERT ON campaign_commands
      BEGIN UPDATE campaign_timelines SET revision=revision+1 WHERE id=NEW.timeline_id; END;`); db.close();
    const repository=factory(); expect(() => repository.executeRollActorDice("local-owner",base)).toThrow("revision changed");
    repository.close(); expect(snapshot()).toEqual(before);
  });

  it("rolls back when ignored event and receipt inserts leave the graph unresolved", () => {
    seed(); const before=snapshot(); const db=new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER omit_event BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER omit_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(IGNORE); END;`); db.close();
    const repository=factory();
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow("receipt was not persisted");
    expect(snapshot()).toEqual(before); repository.close();
  });

  it("requires receipt insert changes===1 and exactly rolls back receipt-only RAISE(IGNORE)", () => {
    seed(); const before=snapshot(); const db=new DatabaseDriver(dbPath());
    db.exec("CREATE TRIGGER omit_receipt_only BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(IGNORE); END;");
    db.close(); const repository=factory([10]);
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow("receipt was not persisted");
    repository.close(); expect(snapshot()).toEqual(before);
  });

  it.each([
    ["exact winner",winnerWrites(),"receipt"],
    ["different winner",winnerWrites("winner-command","winner-key"),"revision"],
    ["same command ID",winnerWrites("command-one","winner-key"),"collision"],
    ["same idempotency key",winnerWrites("winner-command","key-one"),"collision"],
    ["active timeline switch",[{sql:"UPDATE campaigns SET active_timeline_id='timeline-old' WHERE id='campaign-one'"}],"inactive"],
  ] as const)("re-resolves all real blocked-writer outcomes: %s", async (_label,writes,outcome) => {
    seed(); const writer=await startLockedWrite(dbPath(),[...writes]); const guarded=guardedFactory();
    if (outcome === "receipt") expect(guarded.repository.executeRollActorDice("gm",base).events[0]?.eventId).toBe("event-worker");
    else expect(() => guarded.repository.executeRollActorDice("gm",base)).toThrow(outcome);
    await writer.done; expectNoDependencies(guarded); guarded.repository.close();
  });

  it.each([
    ["rename", [
      { sql: "UPDATE characters SET name='Renamed' WHERE id='persona-one'" },
    ]],
    ["earlier roster insertion", [
      { sql: "INSERT INTO characters VALUES ('persona-earlier','Earlier',30,'hero','','stop',1,0,'2029-01-01T00:00:00.000Z')" },
      { sql: "INSERT INTO campaign_characters VALUES ('cc-earlier','campaign-one','persona-earlier','2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')" },
      { sql: `INSERT INTO rpg_campaign_sheets VALUES
          ('sheet-earlier','campaign-one','cc-earlier','core','1','race','human','core','1','background','sage',
            '2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')` },
      { sql: `INSERT INTO campaign_actors VALUES
          ('actor-earlier','campaign-one','cc-earlier','sheet-earlier','player-character','principal',
            '2029-01-01T00:00:00.000Z','2029-01-01T00:00:00.000Z')` },
      { sql: "INSERT INTO campaign_actor_private_state VALUES ('actor-earlier','campaign-one','local-owner',NULL)" },
    ]],
  ] as const)("rejects a real post-preflight %s before RNG, identity, clock, or write", async (_label, writes) => {
    seed();
    const preflightRepository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const binding = preflightRepository.transaction((unit) => {
      expect(unit.getCampaign("local-owner", "campaign-one")?.activeTimelineId).toBe(base.timelineId);
      expect(unit.getCampaignTimeline("local-owner", "campaign-one", base.timelineId)?.revision)
        .toBe(base.expectedRevision);
      const roster = unit.getCampaignCharacterRoster("local-owner", "campaign-one");
      const character = roster?.characters[0];
      if (character === undefined) throw new Error("test preflight character is missing");
      return { position: 1, name: character.name, campaignCharacterId: character.id };
    });
    preflightRepository.close();
    const writer = await startLockedWrite(dbPath(), [...writes]);
    const guarded = guardedFactory();
    expect(() => guarded.repository.executeRollActorDiceForVisibleCharacter("local-owner", base, binding))
      .toThrow(repoModule.CampaignDiceCharacterConflict);
    await writer.done;
    expectNoDependencies(guarded);
    expect(snapshot()).toMatchObject({ commands: [], rolls: [], terms: [], events: [], receipts: [], revision: { revision: 0 } });
    guarded.repository.close();
  });

  it("preserves active-revision race handling after locked binding validation", async () => {
    seed();
    const binding = { position: 1, name: "One", campaignCharacterId: "cc-one" };
    const winner = await startLockedWrite(dbPath(), winnerWrites("winner-command", "winner-key"));
    const raced = guardedFactory();
    expect(() => raced.repository.executeRollActorDiceForVisibleCharacter("gm", base, binding)).toThrow("revision");
    await winner.done;
    expectNoDependencies(raced);
    raced.repository.close();
  });

  it("executes one unchanged binding through the locked specialized path", () => {
    seed();
    const binding = { position: 1, name: "One", campaignCharacterId: "cc-one" };
    const unchanged = guardedFactory();
    expect(unchanged.repository.executeRollActorDiceForVisibleCharacter("local-owner", base, binding))
      .toMatchObject({ revisionBefore: 0, revisionAfter: 1 });
    expect(unchanged.rng).toHaveBeenCalledOnce();
    expect(unchanged.id).toHaveBeenCalledOnce();
    expect(unchanged.clock).toHaveBeenCalledOnce();
    unchanged.repository.close();
  });

  it("does not classify malformed persisted roster data as character drift", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE characters SET name='' WHERE id='persona-one'").run();
    db.close();
    const guarded = guardedFactory();
    let failure: unknown;
    try {
      guarded.repository.executeRollActorDiceForVisibleCharacter("local-owner", base, {
        position: 1, name: "One", campaignCharacterId: "cc-one",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(repoModule.CampaignDiceCharacterConflict);
    expectNoDependencies(guarded);
    guarded.repository.close();
  });

  it("times out under a real writer lock with no dependencies or partial state", async () => {
    seed(); const before=snapshot(); const writer=await startLockedWrite(dbPath(),[
      {sql:"UPDATE campaigns SET name='held' WHERE id='campaign-one'"}],5_250);
    const rng=vi.fn(() => 1), ids=vi.fn(() => "unused"), clock=vi.fn(() => new Date(AT));
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:ids},clock:{now:clock}});
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow(/database is locked|SQLITE_BUSY/i);
    expect(rng).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before); await writer.done;
    expect(repository.executeRollActorDice("local-owner",base).events[0]?.eventId).toBe("unused");
    expect(rng).toHaveBeenCalledOnce(); expect(ids).toHaveBeenCalledOnce(); expect(clock).toHaveBeenCalledOnce();
    repository.close();
  },10_000);

  it("reuses one repository after an atomic dependency failure", () => {
    seed(); const before=snapshot(); const rng=vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(10);
    const id=vi.fn(() => "event-reused"), clock=vi.fn(() => new Date(AT));
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,
      rng:{integer:rng},ids:{nextId:id},clock:{now:clock}});
    expect(() => repository.executeRollActorDice("local-owner",base)).toThrow();
    expect(snapshot()).toEqual(before); expect(id).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    expect(repository.executeRollActorDice("local-owner",base).events[0]?.eventId).toBe("event-reused");
    repository.close();
  });

  it("preserves factory-only synchronous lifecycle, nesting, and UoW boundaries", () => {
    seed(); expect(repoModule).not.toHaveProperty("executeRollActorDice");
    const guarded=guardedFactory(); const repository=guarded.repository;
    expect(repository.transaction((unit) => {
      // @ts-expect-error specialized dice execution must remain absent from the UoW contract
      void unit.executeRollActorDice;
      // @ts-expect-error HTTP-bound dice execution must also remain factory-only
      void unit.executeRollActorDiceForVisibleCharacter;
      return "executeRollActorDice" in unit;
    })).toBe(false);
    expect(() => repository.transaction(() => repository.executeRollActorDice("bad actor",{} as CommandEnvelope)))
      .toThrow("cannot run inside a repository transaction");
    expectNoDependencies(guarded);
    expect(repository.executeRollActorDice("local-owner",base)).not.toBeInstanceOf(Promise);
    guarded.rng.mockClear(); guarded.id.mockClear(); guarded.clock.mockClear();
    repository.close();
    expect(() => repository.executeRollActorDice("bad actor",{} as CommandEnvelope)).toThrow("repository is closed");
    expectNoDependencies(guarded);
  });

  it("projects dice events and receipts without changing executor dependencies", () => {
    seed(); const guarded=guardedFactory(); const repository=guarded.repository;
    repository.executeRollActorDice("local-owner",base);
    guarded.rng.mockClear(); guarded.id.mockClear(); guarded.clock.mockClear();
    expect(repository.listCampaignEvents("local-owner","campaign-one","timeline-one"))
      .toEqual([expect.objectContaining({ eventId: "unused-event", type: "actor_dice_rolled" })]);
    expect(repository.getCommandReceipt("local-owner","campaign-one","command-one"))
      .toEqual(expect.objectContaining({ commandId: "command-one", events: [
        expect.objectContaining({ eventId: "unused-event", type: "actor_dice_rolled" }),
      ] }));
    expect(repository.transaction((unit) => {
      expect(unit.listCampaignEvents("gm","campaign-one","timeline-one"))
        .toEqual([expect.objectContaining({ eventId: "unused-event", type: "actor_dice_rolled" })]);
      expect(unit.getCommandReceipt("gm","campaign-one","command-one")?.events[0]?.type)
        .toBe("actor_dice_rolled");
      return true;
    })).toBe(true); expectNoDependencies(guarded); repository.close();
  });
});
