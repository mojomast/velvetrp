import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { ActorResourceConflictError, ActorResourceStaleError, EncounterConflictError, MECHANICS_STARTER_CATALOG,
  M16StaleError, PowerUnavailableError, createRepository, createSession } from "../src/repo/index.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "../src/repo/encounter/combatCompositionPlan.js";
import { executeCombatCompositionPlan, type CombatCompositionBoundary } from "../src/repo/encounter/combatCompositionExecutor.js";
import { executeUseConsumable, type UseConsumableBoundary } from "../src/repo/encounter/useConsumableRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const scores: CharacterBuilderAttributeScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) =>
    [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;

async function fixture(effectRounds = 2, autoStart = true) {
  let sequence = 0;
  const ids = { nextId: () => `m53-${++sequence}` };
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) }, ids,
    rng: { integer: (minimum) => minimum } });
  const campaign = repo.createCampaign("local-owner", { name: "Combat composition" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const persona = repo.createCharacter({ name: "Aster", age: 31, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id,
    controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores },
    idempotencyKey: "draft" });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0,
    idempotencyKey: "select", selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
      starterGrant: "kit",
    } } as any);
  const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
    expectedRevision: selected.draft.revision, idempotencyKey: "final",
  }).receipt.actorId;
  const effect = repo.mutateActorEffect("local-owner", actorId, { kind: "apply", effect: { source: null,
    modifiers: [{ kind: "flat", appliesToId: "defense", amount: 1 }], duration: { kind: "rounds", remaining: effectRounds },
    recovery: "none", stacking: { kind: "concentration", concentrationId: "focus" } },
    expectedRevision: 0, idempotencyKey: "effect" }).effects[0]!;
  const session = await createSession({ characterId: persona.id, title: "Composition room" });
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
  const enemy = { kind: "enemy-template" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId,
    packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
    definitionId: "velvet:mechanics:enemy-template:gloam-mite" };
  const created = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Mite",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: enemy, team: "enemies" }],
    idempotencyKey: "prepare" });
  const filename = path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
  const start = () => repo.startEncounter("local-owner", created.encounter.encounterId,
    { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const combat = (autoStart ? start() : undefined) as ReturnType<typeof start>;
  const ability = definitions.find((definition) => definition.reference.kind === "ability")!.reference as any;
  return { repo, ids, filename, campaignId: campaign.id, actorId, personaId: persona.id, effectId: effect.effectId,
    combat, prepared: created.encounter, start, enemy, ability, timelineId: campaign.activeTimelineId, definitions };
}

function durableState(db: DatabaseDriver.Database, campaignId: string, actorId: string, encounterId: string, effectId: string) {
  return {
    combatant: db.prepare("SELECT combatant_id,hit_points,status,state_revision FROM combatant WHERE encounter_id=? ORDER BY combatant_id").all(encounterId),
    health: db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'").get(campaignId, actorId),
    m15Root: db.prepare("SELECT revision,updated_at FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaignId, actorId) ?? null,
    m15Commands: db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?").get(campaignId, actorId),
    effect: db.prepare("SELECT remaining_rounds,status,state_revision,concentration_key,updated_at,ended_at FROM rpg_active_effects_v26 WHERE effect_id=?").get(effectId),
    m16Root: db.prepare("SELECT revision,updated_at FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaignId, actorId),
    combatRoot: db.prepare("SELECT revision,updated_at FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId),
  };
}

function consumableRollbackState(db: DatabaseDriver.Database, campaignId: string, actorId: string, encounterId: string) {
  return {
    inventory: db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE entry_id='rollback-tonic' ORDER BY entry_id").all(),
    resources: db.prepare("SELECT * FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name")
      .all(campaignId, actorId),
    m15Roots: db.prepare("SELECT * FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
      .all(campaignId, actorId),
    m15Commands: db.prepare("SELECT * FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=? ORDER BY command_id")
      .all(campaignId, actorId),
    m15Receipts: db.prepare("SELECT * FROM rpg_m15_receipts_v25 WHERE campaign_id=? AND actor_id=? ORDER BY command_id")
      .all(campaignId, actorId),
    m15ChangedKeys: db.prepare(`SELECT * FROM rpg_m15_receipt_changed_keys_v25
      WHERE campaign_id=? AND actor_id=? ORDER BY command_id,changed_key`).all(campaignId, actorId),
    effects: db.prepare("SELECT * FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=? ORDER BY effect_id")
      .all(campaignId, actorId),
    m16Roots: db.prepare("SELECT * FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
      .all(campaignId, actorId),
    m16Commands: db.prepare("SELECT * FROM rpg_m16_commands_v26 WHERE campaign_id=? AND actor_id=? ORDER BY command_id")
      .all(campaignId, actorId),
    m16Receipts: db.prepare("SELECT * FROM rpg_m16_receipts_v26 WHERE campaign_id=? AND actor_id=? ORDER BY command_id")
      .all(campaignId, actorId),
    m16Events: db.prepare("SELECT * FROM rpg_m16_events_v26 WHERE campaign_id=? AND actor_id=? ORDER BY event_id")
      .all(campaignId, actorId),
    effectLifecycle: db.prepare(`SELECT * FROM rpg_effect_lifecycle_events_v26
      WHERE campaign_id=? AND actor_id=? ORDER BY lifecycle_event_id`).all(campaignId, actorId),
    combatants: db.prepare("SELECT * FROM combatant WHERE encounter_id=? ORDER BY combatant_id").all(encounterId),
    encounter: db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(encounterId),
    combatRoot: db.prepare("SELECT * FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId),
    combatLogs: db.prepare("SELECT * FROM combat_log WHERE encounter_id=? ORDER BY log_id").all(encounterId),
    combatEvents: db.prepare("SELECT * FROM combat_events_v27 WHERE encounter_id=? ORDER BY event_id").all(encounterId),
    combatCommands: db.prepare("SELECT * FROM combat_commands_v27 WHERE encounter_id=? ORDER BY command_id").all(encounterId),
    combatReceipts: db.prepare("SELECT * FROM combat_receipts_v27 WHERE encounter_id=? ORDER BY command_id").all(encounterId),
  };
}

async function consumableRollbackFixture() {
  const f = await fixture(2);
  const actor = f.combat.combatants.find((value) => value.kind === "actor")!;
  let combat = f.repo.resolveCombatAction("local-owner", f.combat.combatId, { legalActionId: "end-turn", targetIds: [],
    choices: [], expectedRevision: f.combat.revision, idempotencyKey: "rollback-actor-end" }).combat;
  combat = f.repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "attack:basic",
    targetIds: [actor.combatantId], choices: [], expectedRevision: combat.revision,
    idempotencyKey: "rollback-enemy-attack" }).combat;
  const db = new DatabaseDriver(f.filename);
  const enemy = combat.combatants.find((value) => value.kind === "enemy")!;
  db.exec("DROP TRIGGER combatant_state_guard_v27");
  db.prepare("UPDATE combatant SET initiative=0 WHERE combatant_id=?").run(actor.combatantId);
  db.prepare("UPDATE combatant SET initiative=1 WHERE combatant_id=?").run(enemy.combatantId);
  db.exec(`CREATE TRIGGER combatant_state_guard_v27 BEFORE UPDATE ON combatant WHEN NEW.combatant_id<>OLD.combatant_id OR NEW.encounter_id<>OLD.encounter_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.combatant_kind<>OLD.combatant_kind OR NEW.team<>OLD.team OR NOT (NEW.actor_id IS OLD.actor_id) OR NOT (NEW.enemy_pack_id IS OLD.enemy_pack_id) OR NOT (NEW.enemy_pack_version IS OLD.enemy_pack_version) OR NOT (NEW.enemy_kind IS OLD.enemy_kind) OR NOT (NEW.enemy_definition_id IS OLD.enemy_definition_id) OR NEW.enemy_tactic<>OLD.enemy_tactic OR NEW.initiative<>OLD.initiative OR NEW.initiative_tiebreaker<>OLD.initiative_tiebreaker OR NEW.maximum_hit_points<>OLD.maximum_hit_points OR NEW.state_revision<>OLD.state_revision+1 OR NEW.updated_at<OLD.updated_at OR NOT EXISTS(SELECT 1 FROM combat_log l JOIN combat_events_v27 e ON e.event_id=l.event_id WHERE l.encounter_id=OLD.encounter_id AND l.combatant_id=OLD.combatant_id AND e.event_type='combatant_state_changed' AND e.occurred_at=NEW.updated_at) BEGIN SELECT RAISE(ABORT,'combatant state requires immutable combat event'); END`);
  const item = f.definitions.find((value) => value.reference.kind === "item")!.reference;
  db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25
    (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'item',?)`)
    .run(f.campaignId, item.packId, item.packVersion, item.definitionId);
  db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,
    item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
    VALUES('rollback-tonic',?,?,?,?,'item',?,'stackable',2,NULL,NULL,0,?)`)
    .run(f.campaignId, f.actorId, item.packId, item.packVersion, item.definitionId, at);
  const definition = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions
    WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?`)
    .get(item.packId, item.packVersion, item.definitionId) as { definition_json: string };
  const tonic = JSON.parse(definition.definition_json);
  tonic.mechanics = { ...tonic.mechanics, category: "consumable", stackable: true, slot: null,
    effects: [{ type: "healing", dice: { count: 1, sides: 4, modifier: 0 } }] };
  db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
  db.prepare(`UPDATE rpg_catalog_definitions SET definition_json=?,public_definition_json=?
    WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?`)
    .run(JSON.stringify(tonic), JSON.stringify(tonic), item.packId, item.packVersion, item.definitionId);
  db.close();
  const action = f.repo.getUseConsumableLegalActions("local-owner", combat.combatId)
    .find((value) => value.inventoryEntryId === "rollback-tonic" && value.target.relation === "self")!;
  const command = { legalActionId: action.legalActionId, inventoryEntryId: action.inventoryEntryId, item: action.item,
    quantity: 1 as const, targetCombatantId: action.target.combatantId, targetActorBacked: true,
    expectedCombatRevision: combat.revision, expectedActingM15Revision: 1, expectedTargetM15Revision: 1,
    idempotencyKey: "rollback-tonic-command" };
  const publicState = { combat: f.repo.getCombatState("local-owner", combat.combatId),
    effects: f.repo.listActiveEffects("local-owner", f.campaignId, f.actorId),
    resources: f.repo.getActorResourceSnapshot("local-owner", f.campaignId, f.actorId) };
  f.repo.close();
  return { ...f, command, publicState, deps: { clock: { now: () => new Date(at) }, ids: f.ids,
    rng: { integer: (minimum: number) => minimum } } };
}

describe("M5.3 Slice 0 combat composition", () => {
  it("uses an exact server-derived consumable atomically and replays without rerolling", async () => {
    let rolls=0,sequence=0,duplicateIds=false;
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) },
      ids:{nextId:()=>duplicateIds?"duplicate-fresh-id":`consume-${++sequence}`},rng:{integer:(minimum)=>{rolls++;return minimum;}} });
    const campaign=repo.createCampaign("local-owner",{name:"Consumables"});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const persona=repo.createCharacter({name:"Tonic Bearer",age:30,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
    const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",
      durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:"draft"});
    const definitions=MECHANICS_STARTER_CATALOG.definitions;
    const selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"select",selections:{
      race:definitions.find((value)=>value.reference.kind==="race")!.reference,
      background:definitions.find((value)=>value.reference.kind==="background")!.reference,
      class:definitions.find((value)=>value.reference.kind==="class")!.reference,starterGrant:"kit"}} as any);
    const actorId=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:"final"}).receipt.actorId;
    const session=await createSession({characterId:persona.id,title:"Consumable combat"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const enemy={kind:"enemy-template" as const,packId:MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion,definitionId:"velvet:mechanics:enemy-template:gloam-mite"};
    const created=repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Tonic test",
      combatants:[{kind:"actor",actorId,team:"allies"},{kind:"enemy",template:enemy,team:"enemies"}],idempotencyKey:"prepare"});
    const combat=repo.startEncounter("local-owner",created.encounter.encounterId,{expectedRevision:1,idempotencyKey:"start"}).combat;
    const acting=combat.combatants.find((value)=>value.combatantId===combat.currentCombatant)!;
    expect(acting.kind).toBe("actor");
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const itemRef=definitions.find((value)=>value.reference.kind==="item")!.reference;
    db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25
      (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'item',?)`)
      .run(campaign.id,itemRef.packId,itemRef.packVersion,itemRef.definitionId);
    db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,
      item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
      VALUES('tonic-entry',?,?,?,?,'item',?,'stackable',1,NULL,NULL,0,?)`)
      .run(campaign.id,actorId,itemRef.packId,itemRef.packVersion,itemRef.definitionId,at);
    const entry={entry_id:"tonic-entry",item_pack_id:itemRef.packId,item_pack_version:itemRef.packVersion,item_definition_id:itemRef.definitionId};
    const definitionRow=db.prepare(`SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=?
      AND kind='item' AND definition_id=?`).get(entry.item_pack_id,entry.item_pack_version,entry.item_definition_id) as {definition_json:string};
    const tonic=JSON.parse(definitionRow.definition_json);
    db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
    const updateDefinition=db.prepare(`UPDATE rpg_catalog_definitions SET definition_json=?,public_definition_json=? WHERE pack_id=? AND pack_version=?
      AND kind='item' AND definition_id=?`);
    const statistics=["check","attack","defense","damage","healing","speed","max-hp","save-dc"] as const;
    for(const statistic of statistics)for(const effects of [
      [{type:"modifier",statistic,amount:1,duration:"instant"}],
      [{type:"healing",dice:{count:1,sides:4,modifier:0}},{type:"modifier",statistic,amount:1,duration:"instant"}],
      [{type:"modifier",statistic,amount:0,duration:"instant"}],
    ]){
      const modifierConsumable=structuredClone(tonic);
      modifierConsumable.mechanics={...modifierConsumable.mechanics,category:"consumable",stackable:true,slot:null,effects};
      updateDefinition.run(JSON.stringify(modifierConsumable),JSON.stringify(modifierConsumable),entry.item_pack_id,entry.item_pack_version,entry.item_definition_id);
      const before={rolls,inventory:db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(entry.entry_id),
        combatCommands:(db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
        m15Commands:(db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id,actorId) as {count:number}).count};
      expect(repo.getUseConsumableLegalActions("local-owner",combat.combatId)).toEqual([]);
      expect({rolls,inventory:db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(entry.entry_id),
        combatCommands:(db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
        m15Commands:(db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id,actorId) as {count:number}).count}).toEqual(before);
    }
    tonic.mechanics={...tonic.mechanics,category:"consumable",stackable:true,slot:null,
      effects:[{type:"healing",dice:{count:1,sides:4,modifier:0}}]};
    updateDefinition.run(JSON.stringify(tonic),JSON.stringify(tonic),entry.item_pack_id,entry.item_pack_version,entry.item_definition_id);
    const action=repo.getUseConsumableLegalActions("local-owner",combat.combatId).find((value)=>value.inventoryEntryId===entry.entry_id&&value.target.relation==="self")!;
    expect(action).toMatchObject({kind:"use-consumable",inventoryEntryId:entry.entry_id,target:{actorBacked:true,relation:"self"}});
    const beforeRolls=rolls;
    const command={legalActionId:action.legalActionId,inventoryEntryId:action.inventoryEntryId,item:action.item,quantity:1 as const,
      targetCombatantId:action.target.combatantId,targetActorBacked:true,expectedCombatRevision:combat.revision,
      expectedActingM15Revision:0,expectedTargetM15Revision:0,idempotencyKey:"use-tonic"};
    const beforeDuplicate={rolls,inventory:db.prepare("SELECT quantity FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(entry.entry_id),
      combatCommands:(db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
      m15Commands:(db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id,actorId) as {count:number}).count};
    duplicateIds=true;
    expect(()=>repo.useConsumable("local-owner",command)).toThrow("generated consumable identities are not unique");
    duplicateIds=false;
    expect({rolls,inventory:db.prepare("SELECT quantity FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(entry.entry_id),
      combatCommands:(db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
      m15Commands:(db.prepare("SELECT count(*) count FROM rpg_m15_commands_v25 WHERE campaign_id=? AND actor_id=?").get(campaign.id,actorId) as {count:number}).count})
      .toEqual(beforeDuplicate);
    const result=repo.useConsumable("local-owner",command);
    expect(result.resolution).toMatchObject({effectPlan:action.effectPlan,actingM15Revision:{before:0,after:1},targetM15Revision:null});
    expect(result.resolution.outcome.settlements.map((value)=>value.kind)).toEqual(["combat-hp-healing"]);
    expect(rolls).toBe(beforeRolls+1);
    expect(repo.useConsumable("local-owner",command)).toEqual(result);
    expect(rolls).toBe(beforeRolls+1);
    expect(db.prepare("SELECT 1 FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(entry.entry_id)).toBeUndefined();
    expect((db.prepare("SELECT count(*) count FROM rpg_m16_commands_v26 WHERE campaign_id=? AND actor_id=?")
      .get(campaign.id,actorId) as {count:number}).count).toBe(0);
    const stored=db.prepare(`SELECT command_id,canonical_request_json,request_digest,canonical_result_json,result_digest
      FROM combat_commands_v27 JOIN combat_receipts_v27 USING(encounter_id,command_id) WHERE encounter_id=? AND idempotency_key=?`)
      .get(combat.combatId,command.idempotencyKey) as {command_id:string;canonical_request_json:string;request_digest:string;canonical_result_json:string;result_digest:string};
    db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,current_turn_combatant_id,
      state_revision,created_at,updated_at) VALUES('collision-combat',?,?,'prepared','completed',1,NULL,1,?,?)`).run(campaign.id,session.id,at,at);
    db.prepare("INSERT INTO combat_mutation_revisions_v27 VALUES('collision-combat',3,?)").run(at);
    db.prepare("INSERT INTO combat_commands_v27 VALUES('collision-combat',?,?, 'resolve_action',?,?,?,?,3,?)")
      .run(stored.command_id,actorId,command.idempotencyKey,stored.canonical_request_json,stored.request_digest,2,at);
    db.prepare("INSERT INTO combat_receipts_v27 VALUES('collision-combat',?,3,?,?,?)")
      .run(stored.command_id,stored.canonical_result_json,stored.result_digest,at);
    expect(repo.getUseConsumableCommandResultByKey("local-owner",combat.combatId,command.idempotencyKey)).toEqual(result);
    expect(repo.getUseConsumableCommandResultByKey("local-owner","collision-combat",command.idempotencyKey)).toEqual(result);
    for(const [principal,role] of [["result-gm","gm"],["result-player","player"],["result-observer","observer"],["result-controller","player"]] as const){
      db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal,principal);
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(campaign.id,principal,role,at);
    }
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='result-controller' WHERE campaign_id=? AND actor_id=?")
      .run(campaign.id,actorId);
    expect(repo.getUseConsumableCommandResultByKey("local-owner",combat.combatId,command.idempotencyKey)).toEqual(result);
    expect(repo.getUseConsumableCommandResultByKey("result-gm",combat.combatId,command.idempotencyKey)).toEqual(result);
    expect(repo.getUseConsumableCommandResultByKey("result-controller",combat.combatId,command.idempotencyKey)).toEqual(result);
    for(const principal of ["result-player","result-observer","result-outsider"])
      expect(repo.getUseConsumableCommandResultByKey(principal,combat.combatId,command.idempotencyKey)).toBeNull();
    expect(repo.getUseConsumableCommandResultByKey("result-gm","missing-combat",command.idempotencyKey)).toBeNull();
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='local-owner' WHERE campaign_id=? AND actor_id=?")
      .run(campaign.id,actorId);
    db.exec("DROP TRIGGER combat_receipts_v27_immutable_delete; DROP TRIGGER combat_commands_v27_immutable_delete; DROP TRIGGER combat_mutation_revisions_v27_retain");
    db.prepare("DELETE FROM combat_receipts_v27 WHERE encounter_id='collision-combat'").run();
    db.prepare("DELETE FROM combat_commands_v27 WHERE encounter_id='collision-combat'").run();
    db.prepare("DELETE FROM combat_mutation_revisions_v27 WHERE encounter_id='collision-combat'").run();
    db.prepare("DELETE FROM encounter WHERE encounter_id='collision-combat'").run();
    db.exec(`CREATE TRIGGER combat_commands_v27_immutable_delete BEFORE DELETE ON combat_commands_v27 BEGIN SELECT RAISE(ABORT,'combat commands are immutable'); END;
      CREATE TRIGGER combat_receipts_v27_immutable_delete BEFORE DELETE ON combat_receipts_v27 BEGIN SELECT RAISE(ABORT,'combat receipts are immutable'); END;
      CREATE TRIGGER combat_mutation_revisions_v27_retain BEFORE DELETE ON combat_mutation_revisions_v27 BEGIN SELECT RAISE(ABORT,'combat mutation revisions are retained'); END;`);
    db.close();repo.close();
    const reopened=createRepository({dataDir:process.env.VELVET_DATA_DIR!});
    expect(reopened.getCombatState("local-owner",combat.combatId)?.revision).toBe(result.receipt.revisionAfter);
    const verifyDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    const commandId=(verifyDb.prepare("SELECT command_id FROM combat_commands_v27 WHERE encounter_id=? AND idempotency_key=?")
      .get(combat.combatId,command.idempotencyKey) as {command_id:string}).command_id;
    verifyDb.close();
    expect(reopened.getUseConsumableCommandResult("local-owner",commandId)).toEqual(result);
    expect(reopened.getUseConsumableCommandResultByKey("local-owner",combat.combatId,command.idempotencyKey)).toEqual(result);
    reopened.close();
  });

  it.each<UseConsumableBoundary>(["inventory", "m15", "effects", "combatant", "combat", "log", "receipt"])(
    "rolls back every durable consumable write after the %s boundary",
    async (boundary) => {
      const f = await consumableRollbackFixture();
      const db = new DatabaseDriver(f.filename);
      const before = consumableRollbackState(db, f.campaignId, f.actorId, f.combat.combatId);
      expect(() => executeUseConsumable(db, f.deps, "local-owner", f.command, (value) => {
        if (value === boundary) throw new Error(`failpoint:${boundary}`);
      })).toThrow(`failpoint:${boundary}`);
      expect(consumableRollbackState(db, f.campaignId, f.actorId, f.combat.combatId)).toEqual(before);
      db.close();

      const reopened = createRepository({ dataDir: path.dirname(f.filename) });
      expect({ combat: reopened.getCombatState("local-owner", f.combat.combatId),
        effects: reopened.listActiveEffects("local-owner", f.campaignId, f.actorId),
        resources: reopened.getActorResourceSnapshot("local-owner", f.campaignId, f.actorId) }).toEqual(f.publicState);
      reopened.close();
      const verify = new DatabaseDriver(f.filename, { readonly: true });
      expect(consumableRollbackState(verify, f.campaignId, f.actorId, f.combat.combatId)).toEqual(before);
      verify.close();
    },
  );

  it("requires transaction-owned sealed plans and rolls back representative composition boundaries", async () => {
    const f = await fixture();
    const db = new DatabaseDriver(f.filename);
    const actor = f.combat.combatants.find((combatant) => combatant.kind === "actor")!;
    const row = db.prepare("SELECT hit_points,status,state_revision FROM combatant WHERE combatant_id=?")
      .get(actor.combatantId) as { hit_points: number; status: string; state_revision: number };
    const change: CombatantStateChange = { combatantId: actor.combatantId, hitPointsBefore: row.hit_points,
      hitPointsAfter: row.hit_points - 1, statusBefore: row.status, statusAfter: "active",
      stateRevisionBefore: row.state_revision };
    expect(() => buildCombatCompositionPlan(db, f.ids, { encounterId: f.combat.combatId,
      campaignId: f.campaignId, roundBefore: 1, roundAfter: 2, occurredAt: at, combatantChanges: [change] }))
      .toThrow("planning requires a caller-owned transaction");
    const plan = db.transaction(() => buildCombatCompositionPlan(db, f.ids, { encounterId: f.combat.combatId,
      campaignId: f.campaignId, roundBefore: 1, roundAfter: 2, occurredAt: at, combatantChanges: [change] })).deferred();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.combatantChanges[0]!)).toBe(true);
    expect(Object.isFrozen(plan.healthMirrors[0]!)).toBe(true);
    expect(plan.occurredAt).toBe(at);
    expect(() => executeCombatCompositionPlan(db, plan)).toThrow("caller-owned transaction");
    const before = durableState(db, f.campaignId, f.actorId, f.combat.combatId, f.effectId);
    for (const boundary of ["preflight", "health", "effects", "combatant"] as CombatCompositionBoundary[]) {
      expect(() => db.transaction(() => executeCombatCompositionPlan(db, plan, (value) => {
        if (value === boundary) throw new Error(`failpoint:${boundary}`);
      })).immediate()).toThrow(`failpoint:${boundary}`);
      expect(durableState(db, f.campaignId, f.actorId, f.combat.combatId, f.effectId)).toEqual(before);
    }
    expect(() => db.transaction(() => executeCombatCompositionPlan(db, plan)).immediate())
      .toThrow("combatant state requires immutable combat event");
    expect(durableState(db, f.campaignId, f.actorId, f.combat.combatId, f.effectId)).toEqual(before);
    expect(() => db.transaction(() => buildCombatCompositionPlan(db, f.ids, { encounterId: f.combat.combatId,
      campaignId: f.campaignId, roundBefore: 1, roundAfter: 2, occurredAt: at,
      combatantChanges: [{ ...change, hitPointsBefore: change.hitPointsBefore + 1 }] })).immediate())
      .toThrow(EncounterConflictError);
    const escaped = db.transaction(() => buildCombatCompositionPlan(db, f.ids, { encounterId: f.combat.combatId,
      campaignId: f.campaignId, roundBefore: 1, roundAfter: 1, occurredAt: at, combatantChanges: [] })).deferred();
    f.repo.resolveCombatAction("local-owner", f.combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [],
      expectedRevision: f.combat.revision, idempotencyKey: "unrelated-advance" });
    expect(() => db.transaction(() => executeCombatCompositionPlan(db, escaped)).immediate())
      .toThrow("sealed encounter state changed");
    db.close(); f.repo.close();
  });

  it("atomically mirrors modern combat HP through M15 and preserves exact replay and concentration", async () => {
    const f = await fixture();
    let combat = f.combat;
    const actor = combat.combatants.find((combatant) => combatant.kind === "actor")!;
    const enemy = combat.combatants.find((combatant) => combatant.kind === "enemy")!;
    combat = f.repo.resolveCombatAction("local-owner", combat.combatId, { legalActionId: "end-turn", targetIds: [],
      choices: [], expectedRevision: combat.revision, idempotencyKey: "actor-end" }).combat;
    const db = new DatabaseDriver(f.filename);
    const before = durableState(db, f.campaignId, f.actorId, combat.combatId, f.effectId);
    db.exec(`CREATE TRIGGER m53_fail_effect_tick BEFORE UPDATE ON rpg_active_effects_v26
      WHEN OLD.effect_id='${f.effectId.replaceAll("'", "''")}' BEGIN SELECT RAISE(ABORT,'forced composition failure'); END`);
    const command = { legalActionId: "attack:basic", targetIds: [actor.combatantId], choices: [] as [],
      expectedRevision: combat.revision, idempotencyKey: "enemy-attack" };
    expect(() => f.repo.resolveCombatAction("local-owner", combat.combatId, command)).toThrow("forced composition failure");
    expect(durableState(db, f.campaignId, f.actorId, combat.combatId, f.effectId)).toEqual(before);
    db.exec("DROP TRIGGER m53_fail_effect_tick");

    const result = f.repo.resolveCombatAction("local-owner", combat.combatId, command);
    const after = durableState(db, f.campaignId, f.actorId, combat.combatId, f.effectId) as any;
    expect(result.combat).toMatchObject({ round: 2, currentCombatant: actor.combatantId });
    expect(result.combat.combatants.find((value) => value.combatantId === actor.combatantId)?.hitPoints)
      .toBe((before.health as any).current - 1);
    expect(after.health.current).toBe((before.health as any).current - 1);
    expect(after.m15Root).toEqual({ revision: 1, updated_at: at });
    const provenance = db.prepare(`SELECT command.command_family,command.command_type,command.expected_revision,
      command.resulting_revision,command.created_at,receipt.occurred_at,receipt.changed_keys_json,key.changed_key
      FROM rpg_m15_commands_v25 command JOIN rpg_m15_receipts_v25 receipt USING(campaign_id,actor_id,command_id)
      JOIN rpg_m15_receipt_changed_keys_v25 key USING(campaign_id,actor_id,command_id)
      WHERE command.campaign_id=? AND command.actor_id=?`).get(f.campaignId, f.actorId);
    expect(provenance).toEqual({ command_family: "resource", command_type: "encounter_health_mirror",
      expected_revision: 0, resulting_revision: 1, created_at: at, occurred_at: at,
      changed_keys_json: '["resource:health"]', changed_key: "resource:health" });
    expect(after.effect).toMatchObject({ remaining_rounds: 1, status: "active", concentration_key: "focus", updated_at: at });
    const effectProvenance = db.prepare(`SELECT command.created_at,receipt.occurred_at receipt_at,
      lifecycle.occurred_at lifecycle_at,event.occurred_at event_at,
      json_extract(command.canonical_request_json,'$.kind') request_kind
      FROM rpg_m16_commands_v26 command JOIN rpg_m16_receipts_v26 receipt USING(campaign_id,actor_id,command_id)
      JOIN rpg_m16_events_v26 event USING(campaign_id,actor_id,command_id)
      JOIN rpg_effect_lifecycle_events_v26 lifecycle USING(campaign_id,actor_id,command_id)
      WHERE command.campaign_id=? AND command.actor_id=? AND command.command_type='advance_effect_duration'`)
      .get(f.campaignId, f.actorId);
    expect(effectProvenance).toEqual({ created_at: at, receipt_at: at, lifecycle_at: at, event_at: at,
      request_kind: "encounter-round-wrap" });
    const effectResult = JSON.parse((db.prepare(`SELECT receipt.canonical_result_json FROM rpg_m16_commands_v26 command
      JOIN rpg_m16_receipts_v26 receipt USING(campaign_id,actor_id,command_id)
      WHERE command.campaign_id=? AND command.actor_id=? AND command.command_type='advance_effect_duration'`)
      .get(f.campaignId, f.actorId) as { canonical_result_json: string }).canonical_result_json);
    expect(effectResult.effects).toEqual(f.repo.listActiveEffects("local-owner", f.campaignId, f.actorId));
    expect(f.repo.resolveCombatAction("local-owner", combat.combatId, command)).toEqual(result);
    expect(durableState(db, f.campaignId, f.actorId, combat.combatId, f.effectId)).toEqual(after);
    expect(result.combat.currentCombatant).not.toBe(enemy.combatantId);
    db.close(); f.repo.close();
    const reopened = createRepository({ dataDir: path.dirname(f.filename) });
    reopened.close();
  });

  it("composes legacy enemy damage, expires round effects, and rejects stale or fresh outside health writes", async () => {
    const f = await fixture(1);
    let combat = f.repo.resolveCombatAction("local-owner", f.combat.combatId, { legalActionId: "end-turn", targetIds: [],
      choices: [], expectedRevision: f.combat.revision, idempotencyKey: "actor-end" }).combat;
    f.repo.executeEncounterCommand("local-owner", { type: "advance_turn", campaignId: f.campaignId,
      encounterId: combat.combatId, expectedRevision: combat.revision, idempotencyKey: "legacy-enemy",
      advancedAt: at } as any);
    combat = f.repo.getCombatState("local-owner", combat.combatId)!;
    const db = new DatabaseDriver(f.filename);
    const actor = combat.combatants.find((value) => value.kind === "actor")!;
    const health = (db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .get(f.campaignId, f.actorId) as { current: number }).current;
    expect(actor.hitPoints).toBe(health);
    expect(db.prepare("SELECT remaining_rounds,status,concentration_key,updated_at,ended_at FROM rpg_active_effects_v26 WHERE effect_id=?")
      .get(f.effectId)).toEqual({ remaining_rounds: 0, status: "expired", concentration_key: "focus", updated_at: at, ended_at: at });
    const expiredResult = JSON.parse((db.prepare(`SELECT receipt.canonical_result_json FROM rpg_m16_commands_v26 command
      JOIN rpg_m16_receipts_v26 receipt USING(campaign_id,actor_id,command_id)
      WHERE command.campaign_id=? AND command.actor_id=? AND command.command_type='advance_effect_duration'`)
      .get(f.campaignId, f.actorId) as { canonical_result_json: string }).canonical_result_json);
    expect(expiredResult.effects).toEqual([]);
    expect(() => f.repo.mutateActorResource("local-owner", { type: "change_actor_resource", campaignId: f.campaignId,
      actorId: f.actorId, resourceId: "health", amount: 1, expectedRevision: 0, idempotencyKey: "stale-health" }))
      .toThrow(ActorResourceStaleError);
    expect(() => f.repo.mutateActorResource("local-owner", { type: "change_actor_resource", campaignId: f.campaignId,
      actorId: f.actorId, resourceId: "health", amount: 1, expectedRevision: 1, idempotencyKey: "fresh-health" }))
      .toThrow(ActorResourceConflictError);
    const healthPower = { type: "use_power" as const, campaignId: f.campaignId, actorId: f.actorId,
      power: f.ability, targetActorId: null, costs: [{ kind: "resource", resourceId: "health", amount: 1 }],
      expectedRevision: 1, idempotencyKey: "stale-health-cost", usedAt: at };
    expect(() => f.repo.usePower("local-owner", healthPower as any)).toThrow(M16StaleError);
    expect(() => f.repo.usePower("local-owner", { ...healthPower, expectedRevision: 2,
      idempotencyKey: "health-cost" } as any)).toThrow(PowerUnavailableError);
    expect((db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .get(f.campaignId, f.actorId) as { current: number }).current).toBe(health);
    expect((db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaignId, f.actorId) as { revision: number }).revision).toBe(2);
    expect((db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaignId, f.actorId) as { revision: number }).revision).toBe(1);
    db.close(); f.repo.close();
  });

  it("prevents one actor from entering active encounters in different sessions", async () => {
    const f = await fixture();
    const session = await createSession({ characterId: f.personaId, title: "Second combat" });
    f.repo.attachCampaignSession("local-owner", { campaignId: f.campaignId, sessionId: session.id } as any);
    const second = f.repo.createEncounter("local-owner", f.campaignId, { sessionId: session.id, name: "Second mite",
      combatants: [{ kind: "actor", actorId: f.actorId, team: "allies" },
        { kind: "enemy", template: f.enemy, team: "enemies" }], idempotencyKey: "second-prepare" });
    expect(() => f.repo.startEncounter("local-owner", second.encounter.encounterId,
      { expectedRevision: 1, idempotencyKey: "second-start" })).toThrow(EncounterConflictError);
    expect(f.repo.listEncounters("local-owner", f.campaignId)?.find((value) => value.encounterId === second.encounter.encounterId))
      .toMatchObject({ status: "preparing", revision: 1 });
    f.repo.close();
  });

  it("rejects activation when authoritative health changed after preparation", async () => {
    const f = await fixture(2, false);
    const before = f.repo.listEncounters("local-owner", f.campaignId)!.find((value) => value.encounterId === f.prepared.encounterId)!;
    f.repo.mutateActorResource("local-owner", { type: "change_actor_resource", campaignId: f.campaignId,
      actorId: f.actorId, resourceId: "health", amount: -1, expectedRevision: 0, idempotencyKey: "between-health" });
    expect(() => f.start()).toThrow("prepared actor health changed before encounter activation");
    expect(f.repo.listEncounters("local-owner", f.campaignId)!.find((value) => value.encounterId === f.prepared.encounterId))
      .toEqual(before);
    f.repo.close();
  });

  it("rejects activation when a prepared actor has no persisted health", async () => {
    const f = await fixture(2, false);
    const db = new DatabaseDriver(f.filename);
    db.prepare("DELETE FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .run(f.campaignId, f.actorId);
    db.close();
    expect(() => f.start()).toThrow("prepared actor health changed before encounter activation");
    expect(f.repo.listEncounters("local-owner", f.campaignId)!.find((value) => value.encounterId === f.prepared.encounterId))
      .toMatchObject({ status: "preparing", revision: 1 });
    f.repo.close();
  });

  it("rejects activation when persisted actor health is zero", async () => {
    const f = await fixture(2, false);
    f.repo.mutateActorResource("local-owner", { type: "set_actor_resource", campaignId: f.campaignId,
      actorId: f.actorId, resourceId: "health", current: 0, expectedRevision: 0, idempotencyKey: "zero-health" });
    expect(() => f.start()).toThrow("prepared actor health changed before encounter activation");
    expect(f.repo.listEncounters("local-owner", f.campaignId)!.find((value) => value.encounterId === f.prepared.encounterId))
      .toMatchObject({ status: "preparing", revision: 1 });
    f.repo.close();
  });

  it("rejects legacy health initialization while the actor is in active combat", async () => {
    const f = await fixture();
    const db = new DatabaseDriver(f.filename);
    const revision = (db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?")
      .get(f.campaignId, f.timelineId) as { revision: number }).revision;
    db.close();
    expect(() => f.repo.executeInitializeActorResource("local-owner", { campaignId: f.campaignId,
      timelineId: f.timelineId, actorId: f.actorId, commandId: "active-health-init",
      idempotencyKey: "active-health-init", expectedRevision: revision, sourceTurnId: null,
      command: { type: "initialize_actor_resource", payload: { name: "health", current: 10, max: 10 } } }))
      .toThrow("active encounter health is authoritative");
    const verify = new DatabaseDriver(f.filename, { readonly: true });
    expect((verify.prepare(`SELECT count(*) count FROM campaign_commands
      WHERE campaign_id=? AND command_id='active-health-init'`).get(f.campaignId) as { count: number }).count).toBe(0);
    verify.close();
    f.repo.close();
  });

  it("requires persisted health for legacy actor joins and preserves exact replay", async () => {
    const f = await fixture();
    const makeActor = (name: string, key: string) => {
      const persona = f.repo.createCharacter({ name, age: 29, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
      const draft = f.repo.createCharacterDraft("local-owner", f.campaignId, { personaId: persona.id,
        controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores },
        idempotencyKey: `${key}-draft` });
      const selected = f.repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0,
        idempotencyKey: `${key}-select`, selections: {
          race: f.definitions.find((definition) => definition.reference.kind === "race")!.reference,
          background: f.definitions.find((definition) => definition.reference.kind === "background")!.reference,
          class: f.definitions.find((definition) => definition.reference.kind === "class")!.reference,
          starterGrant: "kit",
        } } as any);
      return f.repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision,
        idempotencyKey: `${key}-final` }).receipt.actorId;
    };
    const missing = makeActor("Missing Health", "missing-join"), zero = makeActor("Zero Health", "zero-join"),
      normal = makeActor("Healthy Join", "normal-join");
    const db = new DatabaseDriver(f.filename);
    db.prepare("DELETE FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .run(f.campaignId, missing);
    const normalHealth = db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
      .get(f.campaignId, normal);
    db.close();
    const missingCommand = { type: "join_combatant", campaignId: f.campaignId, encounterId: f.combat.combatId,
      combatantId: "missing-health-combatant", combatant: { kind: "actor", actorId: missing }, team: "allies",
      expectedRevision: f.combat.revision, idempotencyKey: "missing-health-join", joinedAt: at } as any;
    expect(() => f.repo.executeEncounterCommand("local-owner", missingCommand)).toThrow("actor health is unavailable");
    f.repo.mutateActorResource("local-owner", { type: "set_actor_resource", campaignId: f.campaignId,
      actorId: zero, resourceId: "health", current: 0, expectedRevision: 0, idempotencyKey: "zero-join-health" });
    const zeroCommand = { ...missingCommand, combatantId: "zero-health-combatant",
      combatant: { kind: "actor", actorId: zero }, idempotencyKey: "zero-health-join" };
    expect(() => f.repo.executeEncounterCommand("local-owner", zeroCommand))
      .toThrow("actor health must be positive to join combat");
    const normalCommand = { ...missingCommand, combatantId: "normal-health-combatant",
      combatant: { kind: "actor", actorId: normal }, idempotencyKey: "normal-health-join" };
    const joined = f.repo.executeEncounterCommand("local-owner", normalCommand);
    expect(f.repo.executeEncounterCommand("local-owner", normalCommand)).toEqual(joined);
    const verify = new DatabaseDriver(f.filename, { readonly: true });
    expect(verify.prepare("SELECT 1 FROM combatant WHERE combatant_id='missing-health-combatant'").get()).toBeUndefined();
    expect(verify.prepare("SELECT 1 FROM combatant WHERE combatant_id='zero-health-combatant'").get()).toBeUndefined();
    expect(verify.prepare("SELECT hit_points current,maximum_hit_points max FROM combatant WHERE combatant_id='normal-health-combatant'").get())
      .toEqual(normalHealth);
    verify.close(); f.repo.close();
  });

  it("rejects checkpoint resource restoration while checkpoint actors are in active combat", async () => {
    const f = await fixture();
    const db = new DatabaseDriver(f.filename);
    const revision = (db.prepare("SELECT administration_revision FROM campaigns WHERE id=?")
      .get(f.campaignId) as { administration_revision: number }).administration_revision;
    db.close();
    const checkpoint = f.repo.createCampaignCheckpoint("local-owner", f.campaignId, { timelineId: f.timelineId,
      timelineRevision: 0, label: "Active health", expectedRevision: revision, idempotencyKey: "active-checkpoint" });
    const beforeHealth = f.repo.getActorResourceSnapshot("local-owner", f.campaignId, f.actorId)!;
    expect(() => f.repo.forkCampaignTimeline("local-owner", f.campaignId, { checkpointId: checkpoint.value.id,
      expectedRevision: revision + 1, idempotencyKey: "blocked-fork" })).toThrow("active encounter health is authoritative");
    expect(f.repo.getActorResourceSnapshot("local-owner", f.campaignId, f.actorId)).toEqual(beforeHealth);
    expect(f.repo.getCampaign("local-owner", f.campaignId)?.activeTimelineId).toBe(f.timelineId);
    f.repo.close();
  });
});
