import type DatabaseDriver from "better-sqlite3";
import { progressionProfileSchema, raceCatalogDefinitionSchema, type ProgressionSelection } from "@velvet/contracts";
import { calculateCharacterProgression } from "../characterProgressionCalculator.js";
import { isExecutableClassLevel, progressionReferenceKey, resolveInitialKnownPowers, resolveSelectedClassProgression, type ExactReference } from "../characterProgressionCatalog.js";
import { assertCanonicalProgressionProfile } from "../characterProgressionProfile.js";
import { resolveCampaignRuleset } from "../rulesets/campaignBinding.js";

export interface ProgressionRootRow {
  campaign_character_id:string; campaign_id:string; sheet_id:string; actor_id:string; profile_id:string;
  class_pack_id:string; class_pack_version:string; class_definition_id:string; level:number; total_xp:number;
  milestone_count:number; revision:number; derived_json:string; updated_at:string; created_at:string;
}

export function loadCanonicalProgressionProfile(db:DatabaseDriver.Database,id:string){
  const row=db.prepare("SELECT * FROM rpg_progression_profiles_v23 WHERE profile_id=?").get(id) as any;
  if(!row)throw new Error("progression profile is missing");
  assertCanonicalProgressionProfile(row);
  return progressionProfileSchema.parse({profileId:row.profile_id,rulesProfileId:row.rules_profile_id,mode:row.mode,
    maxLevel:row.max_level,thresholds:JSON.parse(row.thresholds_json)});
}

export function loadExactProgressionCatalog(db:DatabaseDriver.Database,row:ProgressionRootRow){
  const classRow=db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='class' AND definition_id=?")
    .get(row.class_pack_id,row.class_pack_version,row.class_definition_id) as {definition_json:string}|undefined;
  if(!classRow)throw new Error("selected class definition is unavailable");
  const selectedClass=JSON.parse(classRow.definition_json) as any;
  const levelStatement=db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='class-level' AND definition_id=?");
  const referencedLevels=(selectedClass.mechanics?.levelRefs??[]).map((reference:any)=>{
    const found=levelStatement.get(reference.packId,reference.packVersion,reference.definitionId) as {definition_json:string}|undefined;
    if(!found)throw new Error("selected class progression reference is unavailable");
    return JSON.parse(found.definition_json);
  });
  const profile=loadCanonicalProgressionProfile(db,row.profile_id);
  // A class owns its progression cap. The profile is only the global ceiling;
  // explicitly gated catalog levels do not make a class executable at that level.
  const executableLevels = referencedLevels.filter((value: any) => isExecutableClassLevel(value));
  const maximum = profile.rulesProfileId === "srd-5.1:rules:starter-v1"
    ? Math.min(profile.maxLevel, Math.max(...executableLevels.map((value: any) => value.mechanics?.level ?? 0)))
    : profile.maxLevel;
  const levels=resolveSelectedClassProgression({selectedClass,availableDefinitions:referencedLevels,profileMaximum:maximum});
  const raceRow=db.prepare(`SELECT definition.definition_json,definition.pack_id,definition.pack_version,definition.kind,definition.definition_id
    FROM rpg_campaign_sheets sheet
    JOIN rpg_catalog_definitions definition ON definition.pack_id=sheet.race_pack_id AND definition.pack_version=sheet.race_pack_version
      AND definition.kind='race' AND definition.definition_id=sheet.race_definition_id
    JOIN rpg_content_packs pack ON pack.pack_id=definition.pack_id AND pack.pack_version=definition.pack_version
      AND pack.rules_profile_id=? WHERE sheet.id=?`).get(profile.rulesProfileId,row.sheet_id) as {definition_json:string;pack_id:string;pack_version:string;kind:string;definition_id:string}|undefined;
  if(!raceRow)throw new Error("selected race definition is unavailable");
  const selectedRace=raceCatalogDefinitionSchema.parse(JSON.parse(raceRow.definition_json));
  if (selectedRace.reference.packId !== raceRow.pack_id || selectedRace.reference.packVersion !== raceRow.pack_version
    || selectedRace.reference.kind !== raceRow.kind || selectedRace.reference.definitionId !== raceRow.definition_id) {
    throw new Error("selected race definition provenance is inconsistent");
  }
  const bootstrap = db.prepare("SELECT initial_powers_json FROM character_progression_bootstrap_v24 WHERE campaign_character_id=?")
    .get(row.campaign_character_id) as { initial_powers_json: string } | undefined;
  return {selectedClass,selectedRace,raceRef:selectedRace.reference,levels,profile,initialPowers:bootstrap
    ? JSON.parse(bootstrap.initial_powers_json)
    : resolveInitialKnownPowers({selectedRace,levels})};
}

export function readKnownPowerReferences(db:DatabaseDriver.Database,characterId:string){
  return (db.prepare("SELECT kind,pack_id,pack_version,definition_id FROM character_known_powers_v23 WHERE campaign_character_id=? ORDER BY kind,pack_id,pack_version,definition_id")
    .all(characterId) as Array<any>).map((power)=>({kind:power.kind,packId:power.pack_id,packVersion:power.pack_version,definitionId:power.definition_id}));
}

export function calculateAuthoritativeProgressionPreview(db:DatabaseDriver.Database,row:ProgressionRootRow,selections:ProgressionSelection[]=[]){
  const catalog=loadExactProgressionCatalog(db,row),ruleset=resolveCampaignRuleset(db,row.campaign_id);
  if(ruleset.rulesProfileId!==catalog.profile.rulesProfileId)throw new Error("progression profile is not bound to the campaign ruleset");
  const attributes=Object.fromEntries((db.prepare("SELECT attribute_id,value FROM rpg_character_attributes WHERE sheet_id=?").all(row.sheet_id) as Array<{attribute_id:string;value:number}>).map((value)=>[value.attribute_id,value.value]));
  const resources=db.prepare("SELECT name,current,max FROM rpg_actor_resources WHERE actor_id=? ORDER BY name").all(row.actor_id) as Array<{name:string;current:number;max:number}>;
  const health=resources.find((resource)=>resource.name==="health");if(!health)throw new Error("health resource is unavailable");
  const known=readKnownPowerReferences(db,row.campaign_character_id);
  return calculateCharacterProgression({campaignCharacterId:row.campaign_character_id,revision:row.revision,profile:catalog.profile,
     selectedClassRef:(catalog.selectedClass as any).reference,raceRef:catalog.raceRef,
    currentLevel:row.level,totalXp:row.total_xp,milestoneCount:row.milestone_count,currentHp:health.current,
       currentDerived:JSON.parse(row.derived_json),derivedBase:{scores:attributes as any,raceSpeed:catalog.selectedRace.mechanics.speed,
      spellcastingAttribute:(catalog.selectedClass as any).mechanics.primaryAttribute},classLevels:catalog.levels,
    knownAbilities:known.filter((ref)=>ref.kind==="ability") as any,knownSpells:known.filter((ref)=>ref.kind==="spell") as any,
    resources:resources.filter((resource)=>resource.name!=="health").map((resource)=>({resourceId:resource.name,current:resource.current,max:resource.max})),selections},{rulesetId:ruleset.rulesetId,rulesetVersion:ruleset.rulesetVersion});
}

export function assertPowerDefinitionExists(db:DatabaseDriver.Database,reference:Extract<ExactReference,{kind:"ability"|"spell"}>):void{
  if(!db.prepare("SELECT 1 FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind=? AND definition_id=?")
    .get(reference.packId,reference.packVersion,reference.kind,reference.definitionId))throw new Error("known power exact catalog definition is unavailable");
}

export function expectedKnownPowerSources(db:DatabaseDriver.Database,row:ProgressionRootRow,catalog=loadExactProgressionCatalog(db,row)){
  const expected=new Map<string,{reference:any;sourceKind:string;sourceReference:any}>();
  for(const source of catalog.initialPowers){assertPowerDefinitionExists(db,source.reference);expected.set(progressionReferenceKey(source.reference),
    {reference:source.reference,sourceKind:source.source,sourceReference:source.sourceReference});}
  const advancements=db.prepare("SELECT advancement_id,command_id,level,selections_json,changes_json FROM character_level_advancements_v23 WHERE campaign_character_id=? ORDER BY level")
    .all(row.campaign_character_id) as Array<Record<string,any>>;
  for(const advancement of advancements){const changes=JSON.parse(advancement.changes_json),selections=JSON.parse(advancement.selections_json) as Array<any>;
    for(const reference of [...changes.fixedAbilities,...changes.spells]){assertPowerDefinitionExists(db,reference);const key=progressionReferenceKey(reference);if(expected.has(key))throw new Error("known power advancement duplicates an existing power");
      expected.set(key,{reference,sourceKind:"advancement-fixed",sourceReference:{advancementId:advancement.advancement_id,commandId:advancement.command_id,level:advancement.level}});}
    for(const reference of changes.selectedAbilities){assertPowerDefinitionExists(db,reference);const selection=selections.find((value)=>progressionReferenceKey(value.ability)===progressionReferenceKey(reference));
      if(!selection)throw new Error("known choice power has no exact advancement selection");const key=progressionReferenceKey(reference);if(expected.has(key))throw new Error("known choice power duplicates an existing power");
      expected.set(key,{reference,sourceKind:"advancement-choice",sourceReference:{advancementId:advancement.advancement_id,choiceId:selection.choiceId,commandId:advancement.command_id,level:advancement.level}});}
  }
  return expected;
}

export { progressionReferenceKey };
