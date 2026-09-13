import type DatabaseDriver from "better-sqlite3";
import { dnd5eProficiencyBonus } from "../../../rulesets/index.js";

export function survival(db:DatabaseDriver.Database,encounterId:string,combatantId:string){return db.prepare("SELECT successes,failures,stable FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").get(encounterId,combatantId) as {successes:number;failures:number;stable:number}??{successes:0,failures:0,stable:0};}
export function setSurvival(db:DatabaseDriver.Database,encounterId:string,combatantId:string,successes:number,failures:number,stable:boolean){db.prepare(`INSERT INTO combat_survival_v61(encounter_id,combatant_id,successes,failures,stable) VALUES(?,?,?,?,?)
  ON CONFLICT(encounter_id,combatant_id) DO UPDATE SET successes=excluded.successes,failures=excluded.failures,stable=excluded.stable`).run(encounterId,combatantId,successes,failures,stable?1:0);}
/** D&D actors remain targetable at zero; a damaging hit adds one failed save. */
export function dndDamageStatus(db:DatabaseDriver.Database,target:any,hitPointsAfter:number,damage:number):string{
  if(!target.actor_id)return hitPointsAfter===0?"defeated":"active";
  if(target.hit_points>0&&hitPointsAfter===0){setSurvival(db,target.encounter_id,target.combatant_id,0,0,false);return "unconscious";}
  if(target.hit_points===0&&damage>0){const prior=survival(db,target.encounter_id,target.combatant_id),failures=Math.min(3,prior.failures+1);setSurvival(db,target.encounter_id,target.combatant_id,prior.successes,failures,prior.stable===1);return failures===3?"dead":target.status;}
  return target.status;
}

/** Bounded contest scores use the actor's raw ability modifier; enemy templates have no ability-score schema. */
export function contestScore(db:DatabaseDriver.Database,campaignId:string,combatant:any,mode:"athletics"|"best"):number{
  if(!combatant.actor_id)return 0;
  const row=db.prepare(`SELECT actor.sheet_id,progression.level,
      strength.value strength,dexterity.value dexterity FROM campaign_actors actor
    JOIN character_progression_v23 progression ON progression.campaign_id=actor.campaign_id AND progression.actor_id=actor.id
    JOIN rpg_character_attributes strength ON strength.campaign_id=actor.campaign_id
      AND strength.sheet_id=actor.sheet_id AND strength.attribute_id='strength'
    LEFT JOIN rpg_character_attributes dexterity ON dexterity.campaign_id=actor.campaign_id
      AND dexterity.sheet_id=actor.sheet_id AND dexterity.attribute_id='dexterity'
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,combatant.actor_id) as
    {sheet_id:string;level:number;strength:number;dexterity:number|null}|undefined;
  if(!row)return 0;
  const proficient=(skill:string)=>Boolean(db.prepare(`SELECT 1 FROM rpg_character_proficiencies
    WHERE campaign_id=? AND sheet_id=? AND category='skill' AND proficiency_id=?`).get(campaignId,row.sheet_id,skill));
  const bonus=dnd5eProficiencyBonus(Number.isInteger(row.level)?row.level:1);
  const athletics=Math.floor((row.strength-10)/2)+(proficient("athletics")?bonus:0);
  if(mode==="athletics")return athletics;
  const acrobatics=Number.isInteger(row.dexterity)?Math.floor(((row.dexterity as number)-10)/2)+(proficient("acrobatics")?bonus:0):null;
  return acrobatics===null?athletics:Math.max(athletics,acrobatics);
}
