import { describe,it,expect } from "vitest";
import { dmFixture,createSettledDmDispatches } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";
import { createVoiceSourceReader } from "../src/voice/sources.js";
import { getDb } from "../src/repo/db/connection.js";
useTmpDataDir();
describe("voice publication authorization",()=>{
 it("offers only present NPC stable IDs and keeps same-name NPC casting distinct",async()=>{
  const f=await dmFixture(),db=getDb();
  try{
   const reader=createVoiceSourceReader(f.repo,db);const ids:string[]=[];
   for(let i=0;i<3;i++){
    const persona=f.repo.createCharacter({name:'Mira',age:30,archetype:'Guide',boundaries:'',fictionalConfirmed:true});
    const revision=(db.prepare('SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?').get(f.campaign.id) as {revision:number}|undefined)?.revision??0;
    const npc=f.repo.createCampaignNpc('local-owner',f.campaign.id,{personaId:persona.id,publicState:{name:'Mira'},privateState:{goals:'SECRET',gmNotes:'SECRET',merchantState:null},expectedRevision:revision,idempotencyKey:`voice-npc-${i}`}).npc;ids.push(npc.npcId);
    if(i<2)f.repo.mutateNpcPresence('local-owner',{campaignId:f.campaign.id,sessionId:f.session.id,npcId:npc.npcId,expectedRevision:i,idempotencyKey:`voice-place-${i}`,mutation:{kind:'place',locationId:null}});
   }
   const speakers=reader.speakers(f.campaign.id,f.session.id);
   expect(speakers.filter(s=>s.label==='Mira').map(s=>s.id).sort()).toEqual(ids.slice(0,2).map(id=>`npc:${id}`).sort());
   expect(speakers.some(s=>s.id===`npc:${ids[2]}`)).toBe(false);expect(JSON.stringify(speakers)).not.toContain('SECRET');
  }finally{f.repo.close();}
 });
 it("uses only guarded public publication, not private provider/planning context",async()=>{
  const f=await dmFixture();
  try{
   const reader=createVoiceSourceReader(f.repo,getDb());
   expect(reader.list(f.campaign.id)).toEqual([]);
   const run=await createSettledDmDispatches(f);
   const source=reader.resolve(f.campaign.id,"dm",run.runId);
   expect(source?.text).toContain("quiet moment");expect(JSON.stringify(source)).not.toContain("SECRET");
   expect(reader.resolve("wrong-campaign","dm",run.runId)).toBeNull();
   expect(reader.resolve(f.campaign.id,"private",run.runId)).toBeNull();
   expect(reader.speakers(f.campaign.id)).toEqual([{id:"narrator",label:"Narrator"}]);
   expect(()=>reader.authorize("wrong-campaign")).toThrow();
  }finally{f.repo.close();}
 });
});
