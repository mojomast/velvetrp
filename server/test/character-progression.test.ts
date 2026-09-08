import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS, type PublishContentCatalogInput } from "@velvet/contracts";
import { calculateCatalogDigest, createRepository, MECHANICS_STARTER_CATALOG, MECHANICS_STARTER_PRIOR_CATALOG } from "../src/repo/index.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const scores=Object.fromEntries(["might","agility","resolve","insight","presence","craft"].map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;
const srdScores=Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;
function replaceIdentity(value:unknown,packId:string,packVersion:string):void{if(Array.isArray(value)){value.forEach((child)=>replaceIdentity(child,packId,packVersion));return;}if(!value||typeof value!=="object")return;const record=value as Record<string,unknown>;if("packId" in record)record.packId=packId;if("packVersion" in record)record.packVersion=packVersion;Object.values(record).forEach((child)=>replaceIdentity(child,packId,packVersion));}
function catalogFixture(packId:string,mutator?:(catalog:PublishContentCatalogInput)=>void):PublishContentCatalogInput{const catalog=structuredClone(MECHANICS_STARTER_CATALOG) as PublishContentCatalogInput;catalog.idempotencyKey=`${packId}:publish`;replaceIdentity(catalog,packId,"1.2.0+000000000000");catalog.manifest.digest="0".repeat(64);mutator?.(catalog);const digest=calculateCatalogDigest(catalog);replaceIdentity(catalog,packId,`1.2.0+${digest.slice(0,12)}`);catalog.manifest.digest=digest;return catalog;}
function finalized(mode:"xp"|"milestone"="xp",catalog:PublishContentCatalogInput=MECHANICS_STARTER_CATALOG as PublishContentCatalogInput,className?:string,raceName?:string){
  const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date("2032-01-01T00:00:00.000Z")}});
  const persona=repo.createCharacter({name:"Progression persona",age:28,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
  const campaign=repo.createCampaign("local-owner",{name:"Progression"});repo.publishContentCatalog("local-owner",catalog);
  repo.configureCampaignCatalog("local-owner",campaign.id,{rulesProfileId:catalog.manifest.compatibility.rulesProfileId,contentPacks:[{packId:catalog.manifest.packId,packVersion:catalog.manifest.packVersion}],expectedRevision:0,idempotencyKey:"progression-pins"});
  const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",allocation:{method:"standard-array",scores:catalog.manifest.compatibility.rulesProfileId==="srd-5.1:rules:starter-v1"?srdScores:scores},idempotencyKey:"progression-draft"});
  const definitions=catalog.definitions;
  const selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"progression-select",selections:{
   race:{...definitions.find((value)=>value.reference.kind==="race"&&(!raceName||value.name===raceName))!.reference,kind:"race"},background:{...definitions.find((value)=>value.reference.kind==="background")!.reference,kind:"background"},
     class:{...definitions.find((value)=>value.reference.kind==="class"&&(!className||value.name===className))!.reference,kind:"class"},starterGrant:"kit",
      preparedSpells: className === "Cleric" ? definitions.filter((value)=>["srd-5.1:spell:bless","srd-5.1:spell:cure-wounds","srd-5.1:spell:healing-word"].includes(value.reference.definitionId)).map((value)=>value.reference) : undefined}} as any);
  const result=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:"progression-finalize",progressionMode:mode});
  return {repo,campaign,id:result.receipt.campaignCharacterId,actorId:result.receipt.actorId};
}

describe("character progression",()=>{
  it("keeps the prior exact clean-room publication valid and immutable beside the new progression version",()=>{const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!});
    expect(repo.validateContentCatalog(MECHANICS_STARTER_PRIOR_CATALOG).valid).toBe(true);expect(MECHANICS_STARTER_PRIOR_CATALOG.manifest.packVersion).not.toBe(MECHANICS_STARTER_CATALOG.manifest.packVersion);
    repo.publishContentCatalog("local-owner",MECHANICS_STARTER_PRIOR_CATALOG);repo.installMechanicsStarterCatalog("local-owner");expect(repo.listContentCatalogPublications("local-owner")).toHaveLength(2);repo.close();});
  it("previews and atomically applies every crossed level with exact choices, health, resources, and known powers",()=>{
    const {repo,id,actorId}=finalized();const initial=repo.getCharacterProgression("local-owner",id)!;expect(initial.level).toBe(1);
    const grant=repo.grantCharacterXp("local-owner",id,{amount:900,reason:"Two completed journeys",expectedRevision:0,idempotencyKey:"xp-900"});
    expect(repo.grantCharacterXp("local-owner",id,{amount:900,reason:"Two completed journeys",expectedRevision:0,idempotencyKey:"xp-900"})).toEqual(grant);
    const preview=repo.previewCharacterProgression("local-owner",id)!;expect(preview.levels.map((level)=>level.level)).toEqual([2,3]);expect(preview.pendingChoices).toHaveLength(1);
    expect(preview.levels[0]!.fixedAbilities).toEqual([]);
    const damageDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));damageDb.prepare("UPDATE rpg_actor_resources SET current=max-3 WHERE actor_id=? AND name='health'").run(actorId);damageDb.close();
    const damagedPreview=repo.previewCharacterProgression("local-owner",id)!;
    const selection={choiceId:preview.pendingChoices[0]!.choiceId,ability:preview.pendingChoices[0]!.options[0]!};
    const applied=repo.applyCharacterProgression("local-owner",id,{previewRevision:damagedPreview.revision,previewToken:damagedPreview.token,selections:[selection],idempotencyKey:"apply-2-3"});
    expect(applied.progression.level).toBe(3);expect(applied.receipt.appliedLevels).toHaveLength(2);
    expect(applied.progression.knownAbilities.map((value)=>value.definitionId)).toContain(selection.ability.definitionId);
    expect(applied.progression.knownSpells.map((value)=>value.definitionId)).toContain("velvet:mechanics:spell:guiding-ember");
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(db.prepare("SELECT COUNT(*) count FROM character_level_advancements_v23 WHERE campaign_character_id=?").get(id)).toEqual({count:2});
    expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='focus'").get(actorId)).toEqual({current:2,max:2});db.close();repo.close();
  });
  it("returns an atomic public sheet with authoritative progression only to owner, GM, or controller",()=>{
    const {repo,id,campaign,actorId}=finalized();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    for(const [principal,role] of [["sheet-gm","gm"],["sheet-controller","player"],["sheet-other","player"],["sheet-observer","observer"]] as const){
      db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal,principal);
      db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,'2032-01-01T00:00:00.000Z')").run(campaign.id,principal,role);
    }
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id=? WHERE campaign_id=? AND actor_id=?")
      .run("sheet-controller",campaign.id,actorId);
    db.close();

    const expectedProgression=repo.getCharacterProgression("local-owner",id)!;
    for(const principal of ["local-owner","sheet-gm","sheet-controller"]){
      const snapshot=repo.getCampaignCharacterSheetSnapshot(principal,campaign.id,id)!;
      expect(snapshot).toMatchObject({campaignId:campaign.id,campaignCharacterId:id,progression:expectedProgression});
      expect(snapshot.sheet.resources.length).toBeGreaterThan(0);
      expect(JSON.stringify(snapshot)).not.toMatch(/controllerPrincipalId|privateNotes|boundaries|personaId/);
    }
    expect(repo.getCampaignCharacterSheetSnapshot("sheet-other",campaign.id,id)).toBeNull();
    expect(repo.getCampaignCharacterSheetSnapshot("sheet-observer",campaign.id,id)).toBeNull();
    expect(repo.getCampaignCharacterSheetSnapshot("local-owner","other-campaign",id)).toBeNull();
    repo.close();
  });
  it("rejects unresolved choices and stale tokens without partial writes, then correction compensates without deleveling",()=>{
    const {repo,id}=finalized();repo.grantCharacterXp("local-owner",id,{amount:900,reason:"Journey award",expectedRevision:0,idempotencyKey:"award"});const preview=repo.previewCharacterProgression("local-owner",id)!;
    expect(()=>repo.applyCharacterProgression("local-owner",id,{previewRevision:1,previewToken:preview.token,selections:[],idempotencyKey:"missing-choice"})).toThrow("required");expect(repo.getCharacterProgression("local-owner",id)?.level).toBe(1);
    const choice=preview.pendingChoices[0]!;repo.applyCharacterProgression("local-owner",id,{previewRevision:1,previewToken:preview.token,selections:[{choiceId:choice.choiceId,ability:choice.options[0]!}],idempotencyKey:"apply"});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});const entry=(db.prepare("SELECT entry_id FROM character_progression_ledger_v23 WHERE kind='xp'").get() as {entry_id:string}).entry_id;db.close();
    const corrected=repo.correctCharacterProgressionEntry("local-owner",id,{entryId:entry,reason:"Duplicate session award",expectedRevision:2,idempotencyKey:"correct"});expect(corrected.progression.totalXp).toBe(0);expect(corrected.progression.level).toBe(3);
    const correction=repo.listCharacterProgressionEvents("local-owner",id).at(-1)!;expect(correction).toMatchObject({type:"progress_corrected",publicData:{kind:"correction",reason:"Duplicate session award"}});expect(JSON.stringify(correction)).not.toMatch(/private|boundaries/);repo.close();
  });
  it("preview performs no writes and public results omit controller/private persona fields",()=>{
    const {repo,id,campaign}=finalized();repo.grantCharacterXp("local-owner",id,{amount:300,reason:"Crossed threshold",expectedRevision:0,idempotencyKey:"award-small"});
    const file=path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),read=()=>{const db=new DatabaseDriver(file,{readonly:true});const value={root:db.prepare("SELECT * FROM character_progression_v23 WHERE campaign_character_id=?").get(id),commands:db.prepare("SELECT count(*) count FROM character_progression_commands_v23").get(),advancements:db.prepare("SELECT count(*) count FROM character_level_advancements_v23").get()};db.close();return value;};const before=read();
    const preview=repo.previewCharacterProgression("local-owner",id);expect(read()).toEqual(before);
    expect(JSON.stringify({preview,state:repo.getCharacterProgression("local-owner",id)})).not.toMatch(/controllerPrincipalId|privateNotes|personaId|boundaries/);repo.close();
    const roles=new DatabaseDriver(file);for(const [principal,role] of [["progression-gm","gm"],["progression-other","player"],["progression-observer","observer"]] as const){roles.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal,principal);roles.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,'2032-01-01T00:00:00.000Z')").run(campaign.id,principal,role);}roles.close();
    const reopened=createRepository({dataDir:process.env.VELVET_DATA_DIR!});expect(reopened.getCharacterProgression("progression-gm",id)?.level).toBe(1);expect(reopened.getCharacterProgression("progression-other",id)).toBeNull();expect(reopened.getCharacterProgression("progression-observer",id)).toBeNull();reopened.close();
  });
  it("advances in milestone mode without accepting XP grants",()=>{const {repo,id}=finalized("milestone");expect(()=>repo.grantCharacterXp("local-owner",id,{amount:300,reason:"Wrong mode",expectedRevision:0,idempotencyKey:"wrong-mode"})).toThrow("mode");
     repo.grantCharacterMilestone("local-owner",id,{reason:"First story milestone",expectedRevision:0,idempotencyKey:"milestone-one"});
     const preview=repo.previewCharacterProgression("local-owner",id)!;expect(preview.mode).toBe("milestone");expect(preview.levels.map((level)=>level.level)).toEqual([2]);repo.close();});
  it("exposes closed canonical level-one profiles for the broader SRD class set",()=>{
    const definitions=SRD_5_1_STARTER_CATALOG.definitions;
    const expected={
      Barbarian:{hitDie:12,hpGain:12,abilities:["barbarian-rage"],resource:["rage"]},
      Rogue:{hitDie:8,hpGain:8,abilities:["rogue-sneak-attack"],resource:[]},
      Wizard:{hitDie:6,hpGain:6,abilities:["wizard-spellbook"],resource:["spell-slot-1"]},
      Paladin:{hitDie:10,hpGain:10,abilities:["paladin-divine-sense","paladin-lay-on-hands"],resource:["lay-on-hands"]},
      Ranger:{hitDie:10,hpGain:10,abilities:["ranger-favored-enemy","ranger-natural-explorer"],resource:[]},
    } as const;
    for(const [name,profile] of Object.entries(expected)){
      const klass=definitions.find((definition)=>definition.reference.kind==="class"&&definition.name===name) as any;
      expect(klass.mechanics.hitDie).toBe(profile.hitDie);
      const level=definitions.find((definition)=>definition.reference.kind==="class-level"&&definition.name===`${name} Level 1`) as any;
      expect(level.mechanics.classRef.definitionId).toBe(klass.reference.definitionId);
      expect(level.mechanics.hpGain).toBe(profile.hpGain);
      expect(level.mechanics.abilityRefs.map((reference:any)=>reference.definitionId)).toEqual(profile.abilities.map((id)=>`srd-5.1:ability:${id}`));
      expect((level.mechanics.resourceGrants??[]).map((grant:any)=>grant.resourceId)).toEqual(profile.resource);
      expect(level.mechanics.progressionChoices).toBeUndefined();
    }
    const wizardLevel=definitions.find((definition)=>definition.name==="Wizard Level 1") as any;
    expect(wizardLevel.mechanics.spellRefs.map((reference:any)=>reference.definitionId)).toEqual(["srd-5.1:spell:fire-bolt","srd-5.1:spell:ray-of-frost"]);
  });
  it("finalizes every bounded SRD class from level metadata with durable spell preparation",()=>{
    const expected={Barbarian:"hit-dice-d12",Rogue:"hit-dice-d8",Wizard:"hit-dice-d6",Paladin:"hit-dice-d10",Ranger:"hit-dice-d10",Cleric:"hit-dice-d8"} as const;
    for(const [className,hitDie] of Object.entries(expected)){
      const {repo,id,actorId}=finalized("xp",SRD_5_1_STARTER_CATALOG,className);
      const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
      expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name=?").get(actorId,hitDie)).toEqual({current:1,max:1});
      if(className==="Cleric"){
        expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='slot-1'").get(actorId)).toEqual({current:2,max:2});
       expect(db.prepare("SELECT COUNT(*) count FROM character_known_powers_v23 WHERE campaign_character_id=? AND kind='spell'").get(id)).toEqual({count:3});
      }
      db.close();repo.close();
    }
  });
  it.each([
    ["Human",30,"strength",1], ["Dwarf",25,"constitution",2], ["Elf",30,"dexterity",2],
    ["Halfling",25,"dexterity",2], ["Dragonborn",30,"strength",2], ["Gnome",25,"intelligence",2], ["Half-Orc",30,"strength",2],
  ] as const)("hydrates the %s race projection and preserves it across replay",(name,speed,bonusAttribute,bonus)=>{
    const {repo,id}=finalized("xp",SRD_5_1_STARTER_CATALOG,"Fighter",name);
    const initial=repo.getCharacterProgression("local-owner",id)!;
    expect(initial.race).toMatchObject({name,reference:{kind:"race",packId:SRD_5_1_STARTER_CATALOG.manifest.packId},mechanics:{speed}});
    expect(initial.race.mechanics.attributeBonuses[bonusAttribute]).toBe(bonus);
    expect(initial.race.mechanics.languages).toBeDefined();
    expect(initial.race.mechanics.senses).toBeDefined();
    expect(initial.race.mechanics.damageResistances).toBeDefined();
    repo.close();
    const reopened=createRepository({dataDir:process.env.VELVET_DATA_DIR!});
    expect(reopened.getCharacterProgression("local-owner",id)?.race).toEqual(initial.race);
    reopened.close();
  });
  it("fails closed when the persisted race definition is missing or bound to another ruleset",()=>{
     const {repo,id}=finalized("xp",SRD_5_1_STARTER_CATALOG,"Fighter","Elf");repo.close();
     const file=path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),db=new DatabaseDriver(file);
     const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='rpg_catalog_definitions_immutable_update'").get() as {sql:string};
     db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
     db.prepare("UPDATE rpg_catalog_definitions SET definition_json='{}' WHERE pack_id=? AND kind='race' AND definition_id=?").run(SRD_5_1_STARTER_CATALOG.manifest.packId,"srd-5.1:race:elf");
     db.exec(trigger.sql);db.close();
     const missing=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date("2032-01-01T00:00:00.000Z")}});expect(()=>missing.getCharacterProgression("local-owner",id)).toThrow();missing.close();
   });
   it("does not hydrate an ancestry from a different ruleset",()=>{
     const {repo,id}=finalized("xp",SRD_5_1_STARTER_CATALOG,"Fighter","Dwarf");repo.close();
     const file=path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),db=new DatabaseDriver(file);
     const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='rpg_catalog_definitions_immutable_update'").get() as {sql:string};
     db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
     db.prepare("UPDATE rpg_catalog_definitions SET definition_json=json_set(definition_json,'$.reference.packId','velvet:mechanics-starter') WHERE pack_id=? AND kind='race' AND definition_id=?").run(SRD_5_1_STARTER_CATALOG.manifest.packId,"srd-5.1:race:dwarf");
     db.exec(trigger.sql);db.close();
     const reopened=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date("2032-01-01T00:00:00.000Z")}});expect(()=>reopened.getCharacterProgression("local-owner",id)).toThrow();reopened.close();
   });
  it("leaves the preserved level-one-only publication progression-unavailable",()=>{const {repo,id}=finalized("xp",MECHANICS_STARTER_PRIOR_CATALOG as PublishContentCatalogInput);
    expect(repo.getCharacterProgression("local-owner",id)).toBeNull();expect(repo.previewCharacterProgression("local-owner",id)).toBeNull();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});expect(db.prepare("SELECT count(*) count FROM character_progression_v23 WHERE campaign_character_id=?").get(id)).toEqual({count:0});db.close();repo.close();});
   it("advances the pinned SRD Human Acolyte Fighter to level 2 only, with fixed d10 advancement and durable power provenance",()=>{const {repo,id,actorId}=finalized("xp",SRD_5_1_STARTER_CATALOG);
     const initial=repo.getCharacterProgression("local-owner",id)!;expect(initial.knownAbilities.map(value=>value.definitionId)).toContain("srd-5.1:ability:fighter-second-wind");
    repo.grantCharacterXp("local-owner",id,{amount:900,reason:"SRD award",expectedRevision:0,idempotencyKey:"srd-award"});const preview=repo.previewCharacterProgression("local-owner",id)!;
    expect(preview.eligibleLevel).toBe(2);expect(preview.levels).toHaveLength(1);expect(preview.levels[0]).toMatchObject({level:2,hp:{gain:6},proficiency:{before:2,after:2}});
    const applied=repo.applyCharacterProgression("local-owner",id,{previewRevision:1,previewToken:preview.token,selections:[],idempotencyKey:"srd-apply"});expect(repo.applyCharacterProgression("local-owner",id,{previewRevision:1,previewToken:preview.token,selections:[],idempotencyKey:"srd-apply"})).toEqual(applied);expect(applied.progression.level).toBe(2);expect(applied.progression.knownAbilities.map(value=>value.definitionId)).toContain("srd-5.1:ability:fighter-action-surge");
    const capped=repo.previewCharacterProgression("local-owner",id)!;expect(capped.eligibleLevel).toBe(2);expect(capped.levels).toEqual([]);expect(()=>repo.applyCharacterProgression("local-owner",id,{previewRevision:capped.revision,previewToken:capped.token,selections:[],idempotencyKey:"srd-level-three"})).toThrow("no eligible levels");
      const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='hit-dice-d10'").get(actorId)).toEqual({current:2,max:2});db.close();repo.close();const reopened=createRepository({dataDir:process.env.VELVET_DATA_DIR!});expect(reopened.getCharacterProgression("local-owner",id)?.level).toBe(2);reopened.close();});
  it("retains the persisted Human ancestry ability bonus after level advancement",()=>{const {repo,id}=finalized("xp",SRD_5_1_STARTER_CATALOG);
    const initial=repo.getCharacterProgression("local-owner",id)!;expect(initial.derived.abilityModifiers?.strength).toBe(3);
    repo.grantCharacterXp("local-owner",id,{amount:300,reason:"Human progression regression",expectedRevision:0,idempotencyKey:"human-xp"});const preview=repo.previewCharacterProgression("local-owner",id)!;
    const applied=repo.applyCharacterProgression("local-owner",id,{previewRevision:preview.revision,previewToken:preview.token,selections:[],idempotencyKey:"human-level-two"});
    expect(applied.progression.derived.abilityModifiers?.strength).toBe(3);expect(applied.progression.derived.carryingLimit).toBe(240);repo.close();});
  it("advances every authored SRD class through levels 2-3 while retaining the Fighter archetype cap",()=>{
    const expected={Fighter:2,Cleric:3,Barbarian:3,Rogue:3,Wizard:3,Paladin:3,Ranger:3} as const;
    for(const [className,maximum] of Object.entries(expected)){
      const {repo,id}=finalized("xp",SRD_5_1_STARTER_CATALOG,className);
      repo.grantCharacterXp("local-owner",id,{amount:900,reason:"Authored class progression",expectedRevision:0,idempotencyKey:`${className}-xp`});
      const preview=repo.previewCharacterProgression("local-owner",id)!;
      expect(preview.eligibleLevel).toBe(maximum);
      expect(preview.levels.map((level)=>level.level)).toEqual(maximum===2?[2]:[2,3]);
      const applied=repo.applyCharacterProgression("local-owner",id,{previewRevision:preview.revision,previewToken:preview.token,selections:[],idempotencyKey:`${className}-apply`});
      expect(applied.progression.level).toBe(maximum);
      expect(applied.receipt.appliedLevels.map((level)=>level.level)).toEqual(maximum===2?[2]:[2,3]);
      repo.close();
    }
  });
  it("uses only exact levels referenced by the selected class in a multi-class pack",()=>{const catalog=catalogFixture("velvet:multi-class",value=>{const klass=structuredClone(value.definitions.find((definition)=>definition.reference.kind==="class")!) as any;klass.reference.definitionId="velvet:multi-class:class:other";klass.name="Other Class";klass.mechanics.levelRefs=[];
    const sourceLevels=value.definitions.filter((definition)=>definition.reference.kind==="class-level") as any[];for(const source of sourceLevels){const level=structuredClone(source);level.reference.definitionId=`velvet:multi-class:level:other-${source.mechanics.level}`;level.name=`Other ${source.mechanics.level}`;level.mechanics.classRef=structuredClone(klass.reference);if(source.mechanics.level===1)level.mechanics.abilityRefs=[structuredClone(value.definitions.find((definition)=>definition.reference.kind==="ability"&&definition.reference.definitionId.endsWith("beacon-step"))!.reference)];klass.mechanics.levelRefs.push(level.reference);value.definitions.push(level);}value.definitions.push(klass);});
    const {repo,id}=finalized("xp",catalog);const known=repo.getCharacterProgression("local-owner",id)!.knownAbilities.map((reference)=>reference.definitionId);expect(known).not.toContain("velvet:mechanics:ability:beacon-step");repo.close();});
  it("derives initial race powers from the sheet's exact separately pinned race",()=>{const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date("2032-01-01T00:00:00.000Z")}}),raceCatalog=catalogFixture("velvet:race-pack"),persona=repo.createCharacter({name:"Exact race",age:28,archetype:"Warden",boundaries:"",fictionalConfirmed:true}),campaign=repo.createCampaign("local-owner",{name:"Multi pack"});repo.publishContentCatalog("local-owner",MECHANICS_STARTER_CATALOG);repo.publishContentCatalog("local-owner",raceCatalog);repo.configureCampaignCatalog("local-owner",campaign.id,{rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,contentPacks:[{packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion},{packId:raceCatalog.manifest.packId,packVersion:raceCatalog.manifest.packVersion}],expectedRevision:0,idempotencyKey:"multi-pins"});
    const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:"multi-draft"}),race=raceCatalog.definitions.find((definition)=>definition.reference.kind==="race")!.reference,background=MECHANICS_STARTER_CATALOG.definitions.find((definition)=>definition.reference.kind==="background")!.reference,klass=MECHANICS_STARTER_CATALOG.definitions.find((definition)=>definition.reference.kind==="class")!.reference;repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"multi-select",selections:{race,background,class:klass,starterGrant:"kit"}} as any);const final=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:1,idempotencyKey:"multi-final"}),known=repo.getCharacterProgression("local-owner",final.receipt.campaignCharacterId)!.knownAbilities;expect(known.some((reference)=>reference.packId===raceCatalog.manifest.packId&&reference.definitionId.endsWith("mending-light"))).toBe(true);expect(known.some((reference)=>reference.packId===MECHANICS_STARTER_CATALOG.manifest.packId&&reference.definitionId.endsWith("mending-light"))).toBe(false);repo.close();});
  it.each(["profile","power","pending"] as const)("rejects forged %s provenance on authoritative read",kind=>{const {repo,id}=finalized();repo.grantCharacterXp("local-owner",id,{amount:300,reason:"Threshold",expectedRevision:0,idempotencyKey:"forge-award"});repo.close();const file=path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),db=new DatabaseDriver(file);
    if(kind==="profile"){const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='rpg_progression_profiles_v23_immutable_update'").get() as {sql:string};db.exec("DROP TRIGGER rpg_progression_profiles_v23_immutable_update");db.prepare("UPDATE rpg_progression_profiles_v23 SET thresholds_json='[{\"level\":1,\"xp\":0},{\"level\":2,\"xp\":1},{\"level\":3,\"xp\":2}]',profile_digest=? WHERE mode='xp'").run("0".repeat(64));db.exec(trigger.sql);}
    if(kind==="power")db.prepare(`INSERT INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at)
      VALUES(?,'ability',?,?,?,1,NULL,NULL,'2032-01-01T00:00:00.000Z')`).run(id,MECHANICS_STARTER_CATALOG.manifest.packId,MECHANICS_STARTER_CATALOG.manifest.packVersion,"velvet:mechanics:ability:beacon-step");
    if(kind==="pending"){const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE name='character_progression_pending_snapshots_v24_immutable_update'").get() as {sql:string};db.exec("DROP TRIGGER character_progression_pending_snapshots_v24_immutable_update");db.prepare("UPDATE character_progression_pending_snapshots_v24 SET pending_json='[]',pending_digest=? WHERE campaign_character_id=? AND revision=1").run("0".repeat(64),id);db.exec(trigger.sql);}db.close();const corrupted=createCorruptionTestRepository({dataDir:process.env.VELVET_DATA_DIR!});expect(()=>corrupted.getCharacterProgression("local-owner",id)).toThrow(/profile canonical|known power|pending choice/);corrupted.close();});
});
