import type DatabaseDriver from "better-sqlite3";
import { dnd5eProficiencyBonus } from "../../../rulesets/index.js";
import { resolveCombatArmorClassBonus } from "../combatConditionRuntime.js";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import type { Row } from "./types.js";

/** Spell attack bonus and save DC from the caster's class casting ability and level. */
export function spellCasterStats(db:DatabaseDriver.Database,campaignId:string,actorId:string):{attackBonus:number;saveDc:number}|null{
  const row=db.prepare(`SELECT actor.sheet_id,cls.pack_id,cls.pack_version,cls.definition_id,cls.level FROM campaign_actors actor
    JOIN rpg_character_classes cls ON cls.campaign_id=actor.campaign_id AND cls.sheet_id=actor.sheet_id AND cls.position=0
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,actorId)as {sheet_id:string;pack_id:string;pack_version:string;definition_id:string;level:number}|undefined;
  if(!row)return null;
  const classRow=db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='class' AND definition.definition_id=?`)
    .get(campaignId,row.pack_id,row.pack_version,row.definition_id)as {definition_json:string}|undefined;
  let attribute:string|null=null;try{attribute=classRow?JSON.parse(classRow.definition_json).mechanics?.primaryAttribute:null;}catch{attribute=null;}
  const value=attribute?db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?")
    .get(campaignId,row.sheet_id,attribute)as {value:number}|undefined:undefined;
  const modifier=Number.isInteger(value?.value)?Math.floor(((value as {value:number}).value-10)/2):0,proficiency=dnd5eProficiencyBonus(Number.isInteger(row.level)?row.level:1);
  return {attackBonus:proficiency+modifier,saveDc:8+proficiency+modifier};
}
/** Target armor class from equipped armor (actor) or the pinned enemy definition, including active defense modifiers. */
export function targetArmorClass(db:DatabaseDriver.Database,campaignId:string,target:Row,at:string):number|null{
  if(target.actor_id){try{return resolveSrdEquipment(db,campaignId,target.actor_id).armorClass+resolveCombatArmorClassBonus(db,campaignId,target.actor_id,at);}catch{return null;}}
  const raw=db.prepare(`SELECT definition.definition_json FROM encounter_enemy_provenance_v31 provenance
    JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id AND definition.pack_version=provenance.pack_version
      AND definition.kind=provenance.kind AND definition.definition_id=provenance.definition_id
    WHERE provenance.combatant_id=?`).get(target.combatant_id)as {definition_json:string}|undefined;
  if(!raw)return null;try{const value=Number(JSON.parse(raw.definition_json).mechanics?.defense);return Number.isInteger(value)?value:null;}catch{return null;}
}
/** Target save modifier for one ability; enemies have no modeled saves. */
export function targetSaveBonus(db:DatabaseDriver.Database,campaignId:string,target:Row,ability:string):number{
  if(!target.actor_id)return 0;
  const actor=db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId,target.actor_id)as {sheet_id:string}|undefined;
  if(!actor)return 0;
  const value=db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?").get(campaignId,actor.sheet_id,ability)as {value:number}|undefined;
  if(!Number.isInteger(value?.value))return 0;
  const level=(db.prepare("SELECT level FROM rpg_character_classes WHERE campaign_id=? AND sheet_id=? AND position=0").get(campaignId,actor.sheet_id)as {level:number}|undefined)?.level;
  const proficient=Boolean(db.prepare("SELECT 1 FROM rpg_character_proficiencies WHERE campaign_id=? AND sheet_id=? AND category='saving-throw' AND proficiency_id=?")
    .get(campaignId,actor.sheet_id,ability));
  return Math.floor(((value as {value:number}).value-10)/2)+(proficient?dnd5eProficiencyBonus(Number.isInteger(level)?(level as number):1):0);
}
