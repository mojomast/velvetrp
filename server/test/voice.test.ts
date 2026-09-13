import { describe, it, expect } from "vitest";
import { VoiceService } from "../src/voice/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("optional voice sidecar",()=>{
 it("never republishes or retries a provider result received after its deadline",async()=>{
  const dir=mkdtempSync(join(tmpdir(),'velvet-voice-'));let calls=0;
  const service=new VoiceService(join(dir,'voice.sqlite'),{authorize:()=>{},list:()=>[],resolve:()=>({kind:'dm',id:'s',text:'Public.',sessionId:'r',revision:'1'}),speakers:()=>[{id:'narrator',label:'Narrator'}]},
   {timeoutMs:1,voices:[{id:'v',label:'V',language:'en',seed:1,instruct:'Synthetic',revision:'1',model:'omnivoice'}]},async()=>{calls++;await new Promise(r=>setTimeout(r,10));return Buffer.from('late');});
  try{service.cast('c','narrator','v',0);const job=service.play('c','dm','s');await new Promise(r=>setTimeout(r,25));expect(service.job('c',job.id).state).toBe('failed');expect(calls).toBe(1);}finally{service.close();rmSync(dir,{recursive:true,force:true});}
 });
 it("fences late cancellation, bounds queued work and isolates backend failure",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"velvet-voice-"));
  const source={kind:'dm',id:'source',text:'Public text.',sessionId:'room',revision:'1'};
  const reader={authorize:()=>{},list:()=>[],resolve:()=>source,speakers:()=>[{id:'narrator',label:'Narrator'}]};
  let finish:((b:Buffer)=>void)|undefined;let calls=0;
  const service=new VoiceService(join(dir,'voice.sqlite'),reader,{timeoutMs:1000,voices:[{id:'v',label:'V',language:'en',seed:1,instruct:'Synthetic',revision:'1',model:'omnivoice'}]},async()=>{calls++;return await new Promise<Buffer>(r=>{finish=r;});});
  try{
   service.cast('c','narrator','v',0);const first=service.play('c','dm','source');
   for(let i=0;i<7;i++)service.play('c','dm','source');
   expect(()=>service.play('c','dm','source')).toThrow('queue full');expect(calls).toBe(1);
   service.cancel('c',first.id);finish!(Buffer.from('late'));await new Promise(r=>setTimeout(r,10));
   expect(service.job('c',first.id).state).toBe('cancelled');expect(()=>service.audio('c',first.id,0)).toThrow();
   source.text='Changed variant';expect(()=>service.job('c',first.id)).toThrow('changed');
  }finally{service.close();finish?.(Buffer.from('late'));rmSync(dir,{recursive:true,force:true});}
 });
 it("fails once on backend error and never retries mechanics or synthesis automatically",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"velvet-voice-"));let calls=0;
  const reader={authorize:()=>{},list:()=>[],resolve:()=>({kind:'dm',id:'source',text:'Public.',sessionId:'room',revision:'1'}),speakers:()=>[{id:'narrator',label:'Narrator'}]};
  const service=new VoiceService(join(dir,'voice.sqlite'),reader,{timeoutMs:1000,voices:[{id:'v',label:'V',language:'en',seed:1,instruct:'Synthetic',revision:'1',model:'omnivoice'}]},async()=>{calls++;throw new Error('private backend path');});
  try{service.cast('c','narrator','v',0);const job=service.play('c','dm','source');await new Promise(r=>setTimeout(r,10));expect(service.job('c',job.id).state).toBe('failed');expect(JSON.stringify(service.job('c',job.id))).not.toContain('private backend');expect(calls).toBe(1);}finally{service.close();rmSync(dir,{recursive:true,force:true});}
 });
 it("synthesizes committed captions sequentially with backpressure and durable replay",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"velvet-voice-"));let allowed=true;
  const source={kind:"dm",id:"published",text:"a".repeat(240)+" "+"The lantern shines on the quiet road. ".repeat(18),sessionId:"room",revision:"1"};
  const reader={authorize:()=>{if(!allowed)throw new Error("denied");},list:()=>[],resolve:(_c:string,_k:string,id:string)=>id==="published"?source:null,speakers:()=>[{id:"narrator",label:"Narrator"},{id:"npc:a",label:"Mira"}]};
  const config={voices:[{id:"warm",label:"Warm",language:"en",instruct:"Synthetic adult",seed:42,revision:"v1",model:"omnivoice"}],timeoutMs:1000};
  const calls:string[]=[];let service=new VoiceService(join(dir,"voice.sqlite"),reader,config,async(text)=>{calls.push(text);return Buffer.from("audio");});
  try {
   service.cast("campaign","narrator","warm",0);service.cast("campaign","npc:a","warm",0);
   expect(()=>service.play("campaign","dm","private")).toThrow();
   const script=service.script("campaign","dm","published");
   expect(script.segments.map(s=>s.text).join('')).toBe(source.text);
   expect(script.segments.every(s=>s.text.length<=240)).toBe(true);
   service.setScript("campaign","dm","published",0,script.segments.map((_,i)=>i===0?"npc:a":"narrator"),script.sourceVersion);
   const job=service.play("campaign","dm","published");
   await new Promise(r=>setTimeout(r,20));
   expect(calls.length).toBe(1);expect(service.job("campaign",job.id).segments[0]?.speakerId).toBe("npc:a");
   service.audio("campaign",job.id,0);await new Promise(r=>setTimeout(r,20));
   expect(calls.length).toBe(2);
   service.cancel("campaign",job.id);expect(service.job("campaign",job.id).state).toBe("cancelled");
   expect(()=>service.audio("other",job.id,0)).toThrow();
   allowed=false;expect(()=>service.job("campaign",job.id)).toThrow();allowed=true;
   service.close();service=new VoiceService(join(dir,"voice.sqlite"),reader,config,async()=>Buffer.from("audio"));
   expect(service.script("campaign","dm","published").segments[0]?.speakerId).toBe("npc:a");
   expect(service.job("campaign",job.id).state).toBe("cancelled");
  }finally{service.close();rmSync(dir,{recursive:true,force:true});}
 });
 it("persists campaign casting by stable speaker ID with optimistic revisions",()=>{
  const dir=mkdtempSync(join(tmpdir(),"velvet-voice-"));
  const reader={list:()=>[],resolve:()=>null,speakers:()=>[{id:"narrator",label:"Narrator"},{id:"npc:a",label:"Mira"},{id:"npc:b",label:"Mira"}],authorize:()=>{}};
  const config={voices:[{id:"warm",label:"Warm",language:"en",instruct:"Synthetic friendly adult",seed:42,revision:"v1",model:"omnivoice"}],timeoutMs:1000};
  let service=new VoiceService(join(dir,"voice.sqlite"),reader,config,async()=>Buffer.alloc(0));
  try {
   expect(service.cast("campaign","npc:a","warm",0).revision).toBe(1);
   expect(()=>service.cast("campaign","npc:a","warm",0)).toThrow();
   service.close();service=new VoiceService(join(dir,"voice.sqlite"),reader,config,async()=>Buffer.alloc(0));
   expect(service.status("campaign").assignments).toEqual([{speakerId:"npc:a",voiceId:"warm",revision:1}]);
   expect(()=>service.cast("campaign","npc:hidden","warm",0)).toThrow();
  } finally { service.close();rmSync(dir,{recursive:true,force:true}); }
 });
});
