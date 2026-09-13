import type Database from "better-sqlite3";
import type { Repository } from "../repo/index.js";
import { VoiceError, type Source, type SourceReader } from "./service.js";
const PRINCIPAL="local-owner";
/** Read only: existing repository projections remain the sole publication/visibility authority. */
export function createVoiceSourceReader(repo:Repository,db:Database.Database):SourceReader {
 const rooms=(campaign:string)=>(db.prepare("SELECT session_id FROM campaign_sessions WHERE campaign_id=? ORDER BY attached_at DESC LIMIT 32").all(campaign) as {session_id:string}[]).map(r=>r.session_id);
 const authorize=(campaign:string)=>{
  const member=db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaign,PRINCIPAL) as {role:string}|undefined;
  if(!member||!['owner','gm'].includes(member.role)||!repo.getCampaign(PRINCIPAL,campaign))throw new VoiceError(404,"Campaign voice unavailable");
 };
 const resolve=(campaign:string,kind:string,id:string):Source|null=>{
  try{
   authorize(campaign);
   if(kind==='dm'){
    const row=db.prepare(`SELECT run.session_id FROM dm_runs run JOIN campaigns c ON c.id=run.campaign_id
     WHERE run.run_id=? AND run.campaign_id=? AND run.timeline_id=c.active_timeline_id`).get(id,campaign) as {session_id:string}|undefined;
    if(!row)return null;
    const run=repo.getDmRun(PRINCIPAL,campaign,row.session_id,id);
    if(run.state!=='completed'||!run.narration)return null;
    return {kind,id,text:run.narration,sessionId:row.session_id,revision:String(run.revision)};
   }
   if(kind==='adventure'){
    const row=db.prepare("SELECT session_id FROM adventure_turns WHERE id=? AND campaign_id=? AND mode='original'").get(id,campaign) as {session_id:string}|undefined;
    if(!row)return null;
    // This is the same latest-selected, active-timeline projection shown in the transcript.
    // Source digest includes exact text + completion revision; an old swipe cannot be played as its replacement.
    const turn=repo.getAdventureTurnTranscript(PRINCIPAL,campaign,row.session_id,100).find(t=>t.turnId===id);
    if(!turn)return null;
    return {kind,id,text:turn.narration,sessionId:row.session_id,revision:turn.completedAt};
   }
   return null;
  }catch{return null;}
 };
 return {
  authorize,resolve,
  list(campaign){
   authorize(campaign);const found:{kind:string;id:string;label:string}[]=[];
   for(const session of rooms(campaign)){
    for(const run of repo.getDmHistory(PRINCIPAL,campaign,session).runs){if(run.state==='completed'&&run.narration){const source=resolve(campaign,'dm',run.runId);if(source)found.push({kind:'dm',id:run.runId,label:`Director: ${source.text.slice(0,80)}`});}}
    for(const turn of repo.getAdventureTurnTranscript(PRINCIPAL,campaign,session,50))found.push({kind:'adventure',id:turn.turnId,label:`Adventure: ${turn.narration.slice(0,80)}`});
    if(found.length>=100)break;
   }
   return found.slice(-100);
  },
  speakers(campaign,sessionId){
   authorize(campaign);const speakers=new Map<string,string>([['narrator','Narrator']]);
   for(const room of sessionId?[sessionId]:rooms(campaign)){
    const cast=repo.getNpcCast(PRINCIPAL,campaign,room);
    // Never project owner-only NPC private state. Only present public identities are eligible, not the library.
    if(cast?.state==='running')for(const npc of cast.presentCast)speakers.set(`npc:${npc.npcId}`,npc.publicState.name);
   }
   return [...speakers].map(([id,label])=>({id,label}));
  }
 };
}
