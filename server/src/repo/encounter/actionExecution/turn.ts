import type DatabaseDriver from "better-sqlite3";
import { EncounterTurnError } from "../encounterErrors.js";
import { beginDndCombatTurn, endDndCombatTurn } from "../combatActionPlan.js";
import { canonical, id, type EncounterDependencies } from "./shared.js";

export function next(db:DatabaseDriver.Database,e:string,current:string,round:number){const rows=db.prepare("SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active' ORDER BY initiative DESC,initiative_tiebreaker,combatant_id").all(e) as any[];const i=rows.findIndex(x=>x.combatant_id===current),n=rows[(i+1+rows.length)%rows.length];return n&&{combatantId:n.combatant_id,round:i===rows.length-1?round+1:round};}
export function turn(db:DatabaseDriver.Database,e:string,encounter:any,current:string,at:string){const n=next(db,e,current,encounter.round_number);if(n)db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(n.combatantId,n.round,at,e);}
export function complete(db:DatabaseDriver.Database,e:string,at:string){db.prepare("UPDATE encounter SET status='completed',current_turn_combatant_id=NULL,state_revision=state_revision+1,updated_at=? WHERE encounter_id=?").run(at,e);}

export type TurnAdvancePlan={event:any;nextId:string|null;round:number};
export function planTurnAdvance(db:DatabaseDriver.Database,encounterId:string,encounter:any,currentId:string,
  overrides:ReadonlyMap<string,string>):TurnAdvancePlan{
  const rows=db.prepare(`SELECT combatant_id,team,status FROM combatant WHERE encounter_id=?
    ORDER BY initiative DESC,initiative_tiebreaker,combatant_id`).all(encounterId) as Array<{combatant_id:string;team:string;status:string}>;
  const status=(row:{combatant_id:string;status:string})=>overrides.get(row.combatant_id)??row.status;
   const activeTeams=new Set(rows.filter((row)=>["active","unconscious","stable"].includes(status(row))).map((row)=>row.team)).size;
  let event:any,nextId:string|null=null,round=encounter.round_number;
  if(activeTeams<2){
    event={kind:"combat_terminal"};
  }else{
    const order=rows;
    const currentIndex=order.findIndex((value)=>value.combatant_id===currentId);
    if(currentIndex<0)throw new EncounterTurnError("current combatant is outside turn order");
    for(let step=1;step<=order.length;step+=1){
      const index=(currentIndex+step)%order.length,candidate=order[index]!;
       if(["active","unconscious"].includes(status(candidate))){
        nextId=candidate.combatant_id;
        if(index<=currentIndex)round+=1;
        break;
      }
    }
    event=nextId===null?{kind:"combat_terminal"}:{kind:"turn_advanced",combatantId:nextId};
  }
  return {event,nextId,round};
}

export function persistTurnAdvance(db:DatabaseDriver.Database,d:EncounterDependencies,encounterId:string,
  plan:TurnAdvancePlan,at:string,commandId:string,revision:number){
  const eventId=id(d);
  db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)")
    .run(eventId,encounterId,commandId,revision,"encounter_state_changed",canonical(plan.event),at);
  db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)")
    .run(id(d),encounterId,null,eventId,2,"encounter_state",canonical(plan.event),at);
  db.prepare(`UPDATE encounter SET current_turn_combatant_id=?,round_number=?,
    state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(plan.nextId,plan.round,at,encounterId);
  endDndCombatTurn(db,encounterId,at);
  const campaign=(db.prepare("SELECT campaign_id FROM encounter WHERE encounter_id=?").get(encounterId) as {campaign_id:string}).campaign_id;
  if(plan.nextId)beginDndCombatTurn(db,campaign,encounterId,plan.nextId,plan.round,id(d),at);
}
