import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { buildCombatPowerLegalActions } from "../src/repo/encounter/combatPowerRuntime.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";

useTmpDataDir();
describe("persisted D&D turn economy",()=>{
  it("spends once, advances explicitly, restarts without rerolling, and settles GP",async()=>{
    let sequence=0,rolls=0,powerDamage=false;
    const options={clock:{now:()=>new Date("2036-01-01T00:00:00.000Z")},ids:{nextId:()=>`economy-${++sequence}`},
      rng:{integer:(min:number,max:number)=>{rolls++;return max===21?20:powerDamage?max-1:min;}}};
    let repo=createRepository(options);
    const campaign=repo.createCampaign("local-owner",{name:"Turn economy"});
    repo.installSrdStarterCatalog("local-owner");repo.configureSrdStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const persona=repo.createCharacter({name:"Hero",age:30,archetype:"Fighter",boundaries:"",fictionalConfirmed:true});
    const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",
      allocation:{method:"standard-array",scores:Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key,i)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as any},idempotencyKey:"draft"});
    const definitions=SRD_5_1_STARTER_CATALOG.definitions;
    const selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"select",selections:{
      race:definitions.find(d=>d.reference.kind==="race")!.reference,background:definitions.find(d=>d.reference.kind==="background")!.reference,
      class:definitions.find(d=>d.reference.kind==="class")!.reference,starterGrant:"kit"}} as any);
    const actor=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:"final"}).receipt.actorId;
    repo.mutateInventoryForActor("local-owner",campaign.id,actor,{kind:"equip",entryId:grantSrdEquipment(campaign.id,actor),slot:"hand",expectedRevision:0,idempotencyKey:"equip"});
    const session=await createSession({characterId:persona.id,title:"Combat"});repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const template=definitions.find(d=>d.reference.definitionId==="srd-5.1:enemy-template:goblin")!.reference as any;
    const prepared=repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Fight",combatants:[{kind:"actor",actorId:actor,team:"allies"},{kind:"enemy",template,team:"enemies"}],idempotencyKey:"prepare"});
     let combat=repo.startEncounter("local-owner",prepared.encounter.encounterId,{expectedRevision:1,idempotencyKey:"start"}).combat;
     const first=combat.turnEconomy!;expect(first).toMatchObject({action:{available:true,used:false},bonusAction:{available:true},reaction:{available:true},movement:{allowanceFeet:30,usedFeet:0,remainingFeet:30}});
     const legal=repo.getLegalCombatActionAllowlist("local-owner",campaign.id,combat.combatId)!;
     expect(legal.actions).toEqual(expect.arrayContaining([{kind:"dash"},{kind:"disengage"},{kind:"hide"},{kind:"flee"},{kind:"end-turn"}]));
     expect(legal.actions.filter(action=>action.kind==="end-turn")).toHaveLength(1);
     const target=combat.combatants.find(c=>c.kind==="enemy")!;
    const request={legalActionId:combat.legalActions.find(a=>a.kind==="attack")!.legalActionId,targetIds:[target.combatantId],choices:[] as [],expectedRevision:combat.revision,idempotencyKey:"attack"};
    const result=repo.resolveCombatAction("local-owner",combat.combatId,request);combat=result.combat;
    expect(result.resolution.outcomes[0]).toMatchObject({damageType:"slashing",critical:true,damageRolls:[1,1],requested:5,attackTotal:25});
    expect(combat.currentCombatant).toBe(first.combatantId);expect(combat.turnEconomy).toMatchObject({turnId:first.turnId,action:{available:false,used:true}});
    expect(combat.legalActions.some(a=>a.kind==="attack")).toBe(false);
    const runtimeDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    // Reviewed setup pins the Fighter's abilities, so Second Wind is now an available bonus action.
    expect(buildCombatPowerLegalActions(runtimeDb,"local-owner",combat.combatId).map(action=>action.definition.name)).toContain("Second Wind");runtimeDb.close();
    expect(()=>repo.resolveCombatAction("local-owner",combat.combatId,{...request,expectedRevision:combat.revision,idempotencyKey:"twice"})).toThrow();
    const usedRolls=rolls;repo.close();repo=createRepository(options);
    expect(repo.resolveCombatAction("local-owner",combat.combatId,request)).toEqual(result);expect(rolls).toBe(usedRolls);
    expect(repo.getCombatState("local-owner",combat.combatId)?.turnEconomy).toEqual(combat.turnEconomy);
    process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";
    const app=buildApp({campaignRepositoryFactory:()=>repo});
    const response=await app.inject({method:"GET",url:`/api/rpg/v1/combats/${combat.combatId}`});expect(response.statusCode,response.body).toBe(200);expect(response.json().turnEconomy).toEqual(combat.turnEconomy);
    const end={legalActionId:"end-turn",targetIds:[],choices:[] as [],expectedRevision:combat.revision,idempotencyKey:"end-turn"};
    const advanced=repo.resolveCombatAction("local-owner",combat.combatId,end);combat=advanced.combat;
    expect(combat.currentCombatant).toBe(target.combatantId);expect(combat.turnEconomy?.turnId).not.toBe(first.turnId);
    expect(repo.resolveCombatAction("local-owner",combat.combatId,end)).toEqual(advanced);
    const enemyRequest={expectedRevision:combat.revision,idempotencyKey:"enemy-turn"};
    expect(()=>repo.resolveCombatAction("local-owner",combat.combatId,{legalActionId:"end-turn",targetIds:[],choices:[] as [],...enemyRequest})).toThrow();
    const authDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    authDb.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('enemy-player','Enemy player',0)").run();
    authDb.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(campaign.id,"enemy-player","player",options.clock.now().toISOString());authDb.close();
    expect(()=>repo.executeCombatEnemyTurn("enemy-player",combat.combatId,enemyRequest)).toThrow();
    const enemyResult=repo.executeCombatEnemyTurn("local-owner",combat.combatId,enemyRequest),enemyRolls=rolls;
    expect(()=>repo.executeCombatEnemyTurn("local-owner",combat.combatId,{expectedRevision:enemyRequest.expectedRevision,idempotencyKey:"enemy-stale"})).toThrow();
    repo.close();repo=createRepository(options);
    expect(repo.executeCombatEnemyTurn("local-owner",combat.combatId,enemyRequest)).toEqual(enemyResult);expect(rolls).toBe(enemyRolls);
    combat=enemyResult.combat;
    expect(combat.round).toBe(2);expect(combat.turnEconomy?.action.available).toBe(true);
    const powerDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const ability=definitions.find(d=>d.reference.kind==="ability")!.reference;
    powerDb.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,?)").run(campaign.id,ability.packId,ability.packVersion,ability.kind,ability.definitionId);
    // Reviewed setup already pins abilities; a forged legal action id is still never listed.
    expect(buildCombatPowerLegalActions(powerDb,"local-owner",combat.combatId).some(action=>action.legalActionId==="combat-power:forged")).toBe(false);
    powerDb.close();
    const beforeBypass=rolls;
    expect(()=>repo.useCombatPower("local-owner",{legalActionId:"combat-power:forged",powerRef:ability as any,targetCombatantId:target.combatantId,
      expectedCombatRevision:combat.revision,expectedSourceM15Revision:1,expectedSourceM16Revision:0,expectedTargetM15Revision:null,
      expectedTargetM16Revision:null,idempotencyKey:"bypass"})).toThrow();
    expect(rolls).toBe(beforeBypass);
    powerDamage=true;
    const finishRequest={type:"attack" as const,campaignId:campaign.id,encounterId:combat.combatId,combatantId:first.combatantId,
      actionId:"finish-action",submittedAt:options.clock.now().toISOString(),
      targetCombatantId:target.combatantId,attackId:"basic_attack",expectedRevision:combat.revision,idempotencyKey:"finish"};
    const finishResult=repo.executeEncounterCommand("local-owner",finishRequest),finishRolls=rolls;
    repo.mutateInventoryForActor("local-owner",campaign.id,actor,{kind:"unequip",slot:"hand",expectedRevision:2,idempotencyKey:"finish-unequip"});
    expect(repo.executeEncounterCommand("local-owner",finishRequest)).toEqual(finishResult);expect(rolls).toBe(finishRolls);
    combat=repo.getCombatState("local-owner",combat.combatId)!;
    expect(combat.currentCombatant).toBeNull();expect(combat.turnEconomy).toBeNull();
    const ended=repo.endCombat("local-owner",combat.combatId,{expectedRevision:combat.revision,idempotencyKey:"end"});
    const reward=ended.rewards[0]!;expect(reward.rewards[0]).toMatchObject({kind:"currency"});
    repo.claimCombatReward("local-owner",combat.combatId,reward.rewardBundleId,{rewardClaimId:"claim",expectedRevision:ended.encounter.revision,idempotencyKey:"claim"});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    expect(db.prepare("SELECT balance_minor FROM rpg_wallets_v25 WHERE campaign_id=? AND actor_id=? AND currency_code='GP'").get(campaign.id,actor)).toMatchObject({balance_minor:1});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();
    await app.close();repo.close();
    delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;
  });

  it("executes a projected D&D utility action through the legacy command API", async () => {
    let sequence = 0;
    const options = { clock: { now: () => new Date("2036-01-01T00:00:00.000Z") }, ids: { nextId: () => `utility-${++sequence}` }, rng: { integer: () => 20 } };
    const repo = createRepository(options);
    const campaign = repo.createCampaign("local-owner", { name: "Utility action" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const persona = repo.createCharacter({ name: "Utility Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as any }, idempotencyKey: "draft" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
      race: definitions.find(d => d.reference.kind === "race")!.reference, background: definitions.find(d => d.reference.kind === "background")!.reference,
      class: definitions.find(d => d.reference.kind === "class")!.reference, starterGrant: "kit" } } as any);
    const actor = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "final" }).receipt.actorId;
    const session = await createSession({ characterId: persona.id, title: "Utility combat" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const prepared = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Utility fight", combatants: [{ kind: "actor", actorId: actor, team: "allies" }], idempotencyKey: "prepare" });
    const combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
    const combatantId = combat.combatants.find(value => value.kind === "actor")!.combatantId;
    expect(repo.getLegalCombatActionAllowlist("local-owner", campaign.id, combat.combatId)?.actions).toContainEqual({ kind: "dash" });
    const result = repo.executeEncounterCommand("local-owner", { type: "dash", campaignId: campaign.id, encounterId: combat.combatId, combatantId,
      actionId: "dash-action", submittedAt: options.clock.now().toISOString(), expectedRevision: combat.revision, idempotencyKey: "dash" });
    expect(result.receipt.revisionBefore).toBe(combat.revision);
    expect(result.status).toBe("active");
    repo.close();
  });

  it("halves the turn-start movement allowance for an exhausted actor", async () => {
    let sequence = 0;
    const options = { clock: { now: () => new Date("2036-03-01T00:00:00.000Z") }, ids: { nextId: () => `exhaustion-${++sequence}` }, rng: { integer: () => 20 } };
    const repo = createRepository(options);
    const campaign = repo.createCampaign("local-owner", { name: "Exhaustion" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const persona = repo.createCharacter({ name: "Tired Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as any }, idempotencyKey: "draft" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
      race: definitions.find(d => d.reference.kind === "race")!.reference, background: definitions.find(d => d.reference.kind === "background")!.reference,
      class: definitions.find(d => d.reference.kind === "class")!.reference, starterGrant: "kit" } } as any);
    const actor = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "final" }).receipt.actorId;
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("UPDATE rpg_actor_resources SET current=2 WHERE campaign_id=? AND actor_id=? AND name='exhaustion'").run(campaign.id, actor);
    db.close();
    const session = await createSession({ characterId: persona.id, title: "Exhausted combat" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const prepared = repo.createEncounter("local-owner", campaign.id, { sessionId: session.id, name: "Tired fight", combatants: [{ kind: "actor", actorId: actor, team: "allies" }], idempotencyKey: "prepare" });
    const combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
    expect(combat.turnEconomy!.movement.allowanceFeet).toBe(15);
    repo.close();
  });

  it("rejects an unavailable exact pin and ends a pinned enemy turn with no actor target",async()=>{
    let sequence=0;const options={clock:{now:()=>new Date("2036-01-01T00:00:00.000Z")},ids:{nextId:()=>`enemy-profile-${++sequence}`},rng:{integer:()=>20}};
    const repo=createRepository(options),campaign=repo.createCampaign("local-owner",{name:"Enemy pins"});
    repo.installSrdStarterCatalog("local-owner");repo.configureSrdStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const persona=repo.createCharacter({name:"Enemy Pin Witness",age:30,archetype:"Witness",boundaries:"",fictionalConfirmed:true});
    const session=await createSession({characterId:persona.id,title:"No target"});repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const goblin=SRD_5_1_STARTER_CATALOG.definitions.find(entry=>entry.reference.definitionId==="srd-5.1:enemy-template:goblin")!.reference as any;
    expect(()=>repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Wrong pin",combatants:[{kind:"enemy",template:{...goblin,packVersion:"1.0.2+76bb2c61d7ef"},team:"enemies"}],idempotencyKey:"wrong-pin"})).toThrow(/unavailable/);
    const tampered=repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Tampered pin",combatants:[{kind:"enemy",template:goblin,team:"enemies"}],idempotencyKey:"tampered"});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const original=(db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='enemy-template' AND definition_id=?")
      .get(goblin.packId,goblin.packVersion,goblin.definitionId) as {definition_json:string}).definition_json;
    const altered=JSON.parse(original);delete altered.mechanics.combatProfile;
    expect(()=>db.prepare("UPDATE rpg_catalog_definitions SET definition_json=? WHERE pack_id=? AND pack_version=? AND kind='enemy-template' AND definition_id=?")
      .run(JSON.stringify(altered),goblin.packId,goblin.packVersion,goblin.definitionId)).toThrow(/immutable/);db.close();
    const tamperedCombat=repo.startEncounter("local-owner",tampered.encounter.encounterId,{expectedRevision:1,idempotencyKey:"tampered-start"}).combat;
    expect(repo.executeCombatEnemyTurn("local-owner",tamperedCombat.combatId,{expectedRevision:tamperedCombat.revision,idempotencyKey:"no-target-turn"}).resolution)
      .toMatchObject({kind:"end-turn",targetIds:[],outcomes:[]});
    repo.close();
  });
});
