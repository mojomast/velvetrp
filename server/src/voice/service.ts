import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, realpathSync } from "node:fs";
import { dirname } from "node:path";

export interface VoiceDefinition { id:string; label:string; language:string; revision:string; model:string; seed:number; instruct?:string; profileId?:string; profileDigest?:string }
export interface VoiceConfig { voices:VoiceDefinition[]; timeoutMs:number }
export interface Source { kind:string; id:string; text:string; sessionId:string; revision:string }
export interface SourceReader { authorize(campaignId:string):void; list(campaignId:string):{kind:string;id:string;label:string}[]; resolve(campaignId:string,kind:string,id:string):Source|null; speakers(campaignId:string,sessionId?:string):{id:string;label:string}[] }
export type Synthesizer = (text:string,voice:VoiceDefinition,signal:AbortSignal)=>Promise<Buffer>;
export class VoiceError extends Error { constructor(public statusCode:number,message:string){super(message);} }
export class VoiceService {
 private db:Database.Database;
 private owner?:Database.Database;
 private running=false;
 private unavailable=false;
 private ensureAvailable(){if(this.closed||this.unavailable)throw new VoiceError(503,"Text ready; voice unavailable. Restart voice service to recover storage.");}
 private disable(){this.unavailable=true;this.current?.controller.abort();this.touch.clear();}
 private wake(){void this.pump().catch(()=>this.disable());}
 private closed=false;
 private current:{id:string;controller:AbortController}|null=null;
 private timer:ReturnType<typeof setInterval>;
 private touch=new Map<string,number>();
 constructor(path:string,private reader:SourceReader,private config:VoiceConfig,private synthesize:Synthesizer){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.db=new Database(path);
  try{
  chmodSync(path,0o600);
  // A dedicated SQLite connection holds an OS-backed exclusive lock for the
  // service lifetime. Crash cleanup is automatic; no unsafe stale-PID lease.
  // Resolve symlinks so alternate spellings share the same ownership boundary.
  const ownerPath=realpathSync(path)+'.owner.sqlite';
  this.owner=new Database(ownerPath,{timeout:0});chmodSync(ownerPath,0o600);
  try{this.owner.exec('BEGIN EXCLUSIVE');}catch{throw new VoiceError(503,'Voice sidecar already in use by another owner');}
  this.db.pragma("journal_mode=WAL");this.db.pragma("busy_timeout=5000");
  const version=this.db.pragma("user_version",{simple:true});
  if(version!==0&&version!==1){this.db.close();throw new Error("Unsupported voice sidecar version");}
  this.db.transaction(()=>{this.db.exec(`CREATE TABLE IF NOT EXISTS casting(campaign TEXT NOT NULL,speakerId TEXT NOT NULL,voiceId TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(campaign,speakerId)); CREATE TABLE IF NOT EXISTS scripts(campaign TEXT NOT NULL,sourceKey TEXT NOT NULL,revision INTEGER NOT NULL,speakers TEXT NOT NULL,PRIMARY KEY(campaign,sourceKey));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,campaign TEXT NOT NULL,source TEXT NOT NULL,sourceKey TEXT NOT NULL,renderKey TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS segments(job TEXT NOT NULL,position INTEGER NOT NULL,text TEXT NOT NULL,speakerId TEXT NOT NULL,voice TEXT NOT NULL,state TEXT NOT NULL,audio BLOB,PRIMARY KEY(job,position));
PRAGMA user_version=1;`);})();
  // Do not replay unknown external POST outcomes after a crash. Explicit audio retry is safe for gameplay.
  this.db.prepare("UPDATE jobs SET state='cancelled' WHERE state='pending'").run();
  this.timer=setInterval(()=>{try{if(this.unavailable)return;for(const [id,at] of this.touch)if(Date.now()-at>60_000)this.cancelInternal(id);this.prune();}catch{this.disable();/* Cache maintenance must never crash gameplay. */}},15_000);
  this.timer.unref();
  }catch(error){this.owner?.close();if(this.db.open)this.db.close();throw error;}
 }
 status(campaign:string){this.ensureAvailable();this.reader.authorize(campaign);return {enabled:true,voices:this.config.voices.map(({id,label})=>({id,label})),speakers:this.reader.speakers(campaign),sources:this.reader.list(campaign),assignments:this.db.prepare("SELECT speakerId,voiceId,revision FROM casting WHERE campaign=? ORDER BY speakerId").all(campaign)};}
 cast(campaign:string,speakerId:string,voiceId:string,expectedRevision:number){
  this.ensureAvailable();this.reader.authorize(campaign);
  if(!this.reader.speakers(campaign).some(s=>s.id===speakerId)||!this.config.voices.some(v=>v.id===voiceId))throw new VoiceError(404,"Voice or speaker unavailable");
  return this.db.transaction(()=>{
   const old=this.db.prepare("SELECT revision FROM casting WHERE campaign=? AND speakerId=?").get(campaign,speakerId) as {revision:number}|undefined;
   if((old?.revision??0)!==expectedRevision)throw new VoiceError(409,"Casting changed; refresh first");
   this.db.prepare("INSERT INTO casting VALUES(?,?,?,?) ON CONFLICT(campaign,speakerId) DO UPDATE SET voiceId=excluded.voiceId,revision=excluded.revision").run(campaign,speakerId,voiceId,expectedRevision+1);
   return {speakerId,voiceId,revision:expectedRevision+1};
  })();
 }
 private source(campaign:string,kind:string,id:string){
  this.ensureAvailable();this.reader.authorize(campaign);const source=this.reader.resolve(campaign,kind,id);
  if(!source||!source.text.trim())throw new VoiceError(404,"Published narration unavailable");
  if(source.text.length>7680)throw new VoiceError(413,"Narration exceeds voice limit (7680 characters)");
  return source;
 }
 private key(source:Source){return createHash("sha256").update(JSON.stringify(source)).digest("hex");}
 script(campaign:string,kind:string,id:string){
  const source=this.source(campaign,kind,id),key=this.key(source);
  const saved=this.db.prepare("SELECT revision,speakers FROM scripts WHERE campaign=? AND sourceKey=?").get(campaign,key) as {revision:number;speakers:string}|undefined;
  const ids:string[]=saved?JSON.parse(saved.speakers):[];
  const chunks:string[]=[];let rest=source.text;
  while(rest.length){
   let end=Math.min(240,rest.length);
   if(end<rest.length){const space=rest.lastIndexOf(" ",end-1);if(space>120)end=space+1;}
   chunks.push(rest.slice(0,end));rest=rest.slice(end);
  }
  if(chunks.length>32)throw new VoiceError(413,"Narration exceeds 32 utterances");
  return {sourceVersion:key,revision:saved?.revision??0,segments:chunks.map((text,index)=>({index,text,speakerId:ids[index]??"narrator"})),speakers:this.reader.speakers(campaign,source.sessionId)};
 }
 setScript(campaign:string,kind:string,id:string,expectedRevision:number,speakerIds:string[],sourceVersion:string){
  const source=this.source(campaign,kind,id),script=this.script(campaign,kind,id);
  if(script.sourceVersion!==sourceVersion)throw new VoiceError(409,"Published source changed; reload first");
  if(speakerIds.length!==script.segments.length||speakerIds.some(id=>!script.speakers.some(s=>s.id===id)))throw new VoiceError(400,"Only eligible NPCs or narrator may speak exact published lines");
  this.db.transaction(()=>{
   const fresh=this.script(campaign,kind,id);
   if(fresh.sourceVersion!==sourceVersion||fresh.revision!==expectedRevision)throw new VoiceError(409,"Script changed; refresh first");
   this.db.prepare("INSERT INTO scripts VALUES(?,?,?,?) ON CONFLICT(campaign,sourceKey) DO UPDATE SET revision=excluded.revision,speakers=excluded.speakers").run(campaign,this.key(source),expectedRevision+1,JSON.stringify(speakerIds));
  })();return this.script(campaign,kind,id);
 }
 play(campaign:string,kind:string,id:string){
  const source=this.source(campaign,kind,id),script=this.script(campaign,kind,id);
  const segments=script.segments.map(s=>{
   if(!script.speakers.some(v=>v.id===s.speakerId))throw new VoiceError(409,"Speaker no longer eligible");
   const assignment=this.db.prepare("SELECT voiceId,revision FROM casting WHERE campaign=? AND speakerId=?").get(campaign,s.speakerId) as {voiceId:string;revision:number}|undefined;
   const voice=this.config.voices.find(v=>v.id===assignment?.voiceId);
   if(!voice)throw new VoiceError(409,"Cast every speaker before listening");
   return {...s,voice,assignmentRevision:assignment!.revision};
  });
  const renderKey=createHash("sha256").update(JSON.stringify({source,segments})).digest("hex");
  const prior=this.db.prepare("SELECT id FROM jobs WHERE campaign=? AND renderKey=? AND state='ready' ORDER BY created DESC LIMIT 1").get(campaign,renderKey) as {id:string}|undefined;
  if(prior)return this.job(campaign,prior.id);
  this.prune(0,1);
  const pending=(this.db.prepare("SELECT count(*) n FROM jobs WHERE state='pending'").get() as {n:number}).n;
  if(pending>=8)throw new VoiceError(429,"Voice queue full; text is ready");
  const job=randomUUID();
  this.db.transaction(()=>{
   this.db.prepare("INSERT INTO jobs(id,campaign,source,sourceKey,renderKey,state,created) VALUES(?,?,?,?,?,'pending',?)").run(job,campaign,JSON.stringify(source),this.key(source),renderKey,Date.now());
   const insert=this.db.prepare("INSERT INTO segments VALUES(?,?,?,?,?,'pending',NULL)");
   for(const s of segments)insert.run(job,s.index,s.text,s.speakerId,JSON.stringify({ ...s.voice,assignmentRevision:s.assignmentRevision }));
  })();this.touch.set(job,Date.now());this.wake();return this.job(campaign,job);
 }
 private authorizedJob(campaign:string,id:string){
  this.ensureAvailable();this.reader.authorize(campaign);
  const row=this.db.prepare("SELECT * FROM jobs WHERE campaign=? AND id=?").get(campaign,id) as JobRow|undefined;
  if(!row)throw new VoiceError(404,"Audio unavailable");
  const old=JSON.parse(row.source) as Source;
  const now=this.source(campaign,old.kind,old.id);
  if(this.key(now)!==row.sourceKey)throw new VoiceError(404,"Published source changed");
  const eligible=this.reader.speakers(campaign,now.sessionId);
  const speakers=this.db.prepare("SELECT DISTINCT speakerId FROM segments WHERE job=?").all(id) as {speakerId:string}[];
  if(speakers.some(s=>!eligible.some(e=>e.id===s.speakerId)))throw new VoiceError(404,"Speaker unavailable");
  return row;
 }
 job(campaign:string,id:string){
  const row=this.authorizedJob(campaign,id);if(row.state==='pending')this.touch.set(id,Date.now());
  const segments=this.db.prepare("SELECT position AS 'index',text,speakerId,state FROM segments WHERE job=? ORDER BY position").all(id) as {index:number;text:string;speakerId:string;state:string}[];
  return {id,state:row.state,segments:segments.map(s=>({...s,...(s.state==='ready'?{audioUrl:`/api/campaigns/${encodeURIComponent(campaign)}/voice/jobs/${id}/audio/${s.index}`}:{})})),...(row.state==='failed'?{error:"Text ready; voice unavailable. Retry audio explicitly."}:{})};
 }
 audio(campaign:string,id:string,index:number,consume=true){
  const job=this.authorizedJob(campaign,id);
  if(job.state==='cancelled')throw new VoiceError(410,"Listening stopped");
  const row=this.db.prepare("SELECT audio FROM segments WHERE job=? AND position=? AND state='ready'").get(id,index) as {audio:Buffer}|undefined;
  if(!row)throw new VoiceError(404,"Audio not ready");
  // One-utterance lookahead: only consumption of ready audio unlocks the next synthesis.
  if(consume)this.db.prepare("UPDATE jobs SET requested=max(requested,?) WHERE id=?").run(index+1,id);
  if(job.state==='pending')this.touch.set(id,Date.now());this.wake();return row.audio;
 }
 cancel(campaign:string,id:string){this.authorizedJob(campaign,id);this.cancelInternal(id);return {id,state:"cancelled"};}
 private cancelInternal(id:string){
  this.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=? AND state='pending'").run(id);
  this.touch.delete(id);if(this.current?.id===id)this.current.controller.abort();
 }
 private async pump(){
  if(this.running||this.closed||this.unavailable)return;this.running=true;
  try{while(!this.closed&&!this.unavailable){
   const row=this.db.prepare(`SELECT j.*,s.position,s.text,s.voice FROM jobs j JOIN segments s ON s.job=j.id
    WHERE j.state='pending' AND s.state='pending' AND s.position<=j.requested ORDER BY j.created,s.position LIMIT 1`).get() as (JobRow & {position:number;text:string;voice:string})|undefined;
   if(!row)break;
   const controller=new AbortController();this.current={id:row.id,controller};
   const timeout=setTimeout(()=>controller.abort(),this.config.timeoutMs);
   try{
    this.authorizedJob(row.campaign,row.id);
    const data=await this.synthesize(row.text,JSON.parse(row.voice) as VoiceDefinition,controller.signal);
    if(this.closed)break;
    const current=this.db.prepare("SELECT state FROM jobs WHERE id=?").get(row.id) as {state:string}|undefined;
    if(current?.state!=='pending')continue;
    if(controller.signal.aborted)throw new Error('Voice deadline exceeded');
    this.authorizedJob(row.campaign,row.id);
    if(data.length>8*1024*1024)throw new Error("Audio size exceeded");
    try{this.prune(data.length);}catch(error){if(!(error instanceof VoiceError))this.disable();throw error;}
    const usage=(this.db.prepare("SELECT coalesce(sum(length(audio)),0) n FROM segments").get() as {n:number}).n;
    if(usage+data.length>128*1024*1024)throw new Error("Voice cache quota reached");
    this.db.transaction(()=>{
     this.db.prepare("UPDATE segments SET state='ready',audio=? WHERE job=? AND position=?").run(data,row.id,row.position);
     const remaining=(this.db.prepare("SELECT count(*) n FROM segments WHERE job=? AND state<>'ready'").get(row.id) as {n:number}).n;
     if(!remaining){this.db.prepare("UPDATE jobs SET state='ready' WHERE id=?").run(row.id);this.touch.delete(row.id);}
    })();
   }catch{
    if(!this.closed){this.db.prepare("UPDATE jobs SET state='failed' WHERE id=? AND state='pending'").run(row.id);this.touch.delete(row.id);}
   }finally{clearTimeout(timeout);this.current=null;}
  }}catch{this.disable();}finally{this.running=false;if(this.closed)this.owner?.close();}
 }
 private prune(incomingBytes=0,incomingJobs=0){
  // Bounded cache: idle/terminal jobs expire, and oldest terminal audio is evicted under quota.
  const rows=this.db.prepare("SELECT id FROM jobs WHERE state<>'pending' AND created<?").all(Date.now()-24*60*60*1000) as {id:string}[];
  const remove=(id:string)=>this.db.transaction(()=>{this.db.prepare("DELETE FROM segments WHERE job=?").run(id);this.db.prepare("DELETE FROM jobs WHERE id=?").run(id);})();
  for(const row of rows)remove(row.id);
  while(true){
   const usage=this.db.prepare("SELECT coalesce(sum(length(audio)),0) bytes FROM segments").get() as {bytes:number};
   const count=(this.db.prepare("SELECT count(*) n FROM jobs").get() as {n:number}).n;
   if(usage.bytes+incomingBytes<=128*1024*1024&&count+incomingJobs<=128)break;
   const oldest=this.db.prepare("SELECT id FROM jobs WHERE state<>'pending' ORDER BY created LIMIT 1").get() as {id:string}|undefined;
   if(!oldest)throw new VoiceError(429,"Voice storage busy");remove(oldest.id);
  }
 }
 close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.current?.controller.abort();this.db.close();if(!this.running)this.owner?.close();}
}
interface JobRow {id:string;campaign:string;source:string;sourceKey:string;state:string;requested:number;created:number}
