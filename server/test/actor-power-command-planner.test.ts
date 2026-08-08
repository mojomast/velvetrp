import type DatabaseDriver from "better-sqlite3";
import { describe,expect,it } from "vitest";
import { planActorPowerCommands,plannedPowerSelection } from "../src/repo/actorPowerCommandPlanner.js";

const reference={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"area"};
const definition=(target:"area"|"ally"|"enemy"|"single")=>({reference,name:"Wave",description:"A bounded wave.",tags:[],mechanics:{actionCost:"action",recovery:"none",uses:0,target,effects:[{type:"damage",damageType:"physical",dice:{count:1,sides:4,modifier:0}}]}});

function fakeDatabase(target:"area"|"ally"|"enemy"|"single"){
  const actorIds=["source",...Array.from({length:40},(_,index)=>`target-${String(index).padStart(2,"0")}`)].sort();
  return {prepare(sql:string){return {
    all(){
      if(sql.includes("character_known_powers_v23"))return [{kind:"ability",pack_id:"pack",pack_version:"1.0.0",definition_id:"area",public_definition_json:JSON.stringify(definition(target))}];
      if(sql.includes("persona.name label"))return actorIds.map((actor_id)=>({actor_id,label:actor_id}));
      if(sql.startsWith("SELECT name FROM rpg_actor_resources"))return [{name:"health"}];
      throw new Error(`unexpected planner all: ${sql}`);
    },get(){throw new Error(`unexpected planner get: ${sql}`);},
  };}} as unknown as DatabaseDriver.Database;
}

describe("actor power command planner fail-closed targeting",()=>{
  it.each(["ally","enemy"] as const)("omits %s powers without authoritative team semantics",(target)=>{
    expect(planActorPowerCommands(fakeDatabase(target),"campaign","source")).toEqual([]);
  });

  it("caps area candidates and selected subsets at the request contract's exact bound",()=>{
    const [plan]=planActorPowerCommands(fakeDatabase("area"),"campaign","source");expect(plan).toBeDefined();
    expect(plan).toMatchObject({targeting:"area",maxTargets:32});expect(plan!.validTargets).toHaveLength(32);
    const selected=plan!.validTargets.map((target)=>target.actorId);
    const intent={powerRef:reference,targetIds:selected,choices:[] as [],expectedRevision:0,idempotencyKey:"area"};
    expect(plannedPowerSelection(plan!,"source",intent)).toEqual(selected);
    expect(plannedPowerSelection(plan!,"source",{...intent,targetIds:selected.slice(0,2)})).toEqual(selected.slice(0,2));
    expect(plannedPowerSelection(plan!,"source",{...intent,targetIds:[...selected,"target-39"]})).toBeNull();
    expect(plannedPowerSelection(plan!,"source",{...intent,targetIds:["target-39"]})).toBeNull();
  });

  it("keeps explicit generic single targeting to one exact same-campaign candidate",()=>{
    const [plan]=planActorPowerCommands(fakeDatabase("single"),"campaign","source");expect(plan).toMatchObject({targeting:"single",maxTargets:1});
    const selected=plan!.validTargets[7]!.actorId,intent={powerRef:reference,targetIds:[selected],choices:[] as [],expectedRevision:0,idempotencyKey:"single"};
    expect(plannedPowerSelection(plan!,"source",intent)).toEqual([selected]);expect(plannedPowerSelection(plan!,"source",{...intent,targetIds:[selected,plan!.validTargets[8]!.actorId]})).toBeNull();
  });
});
