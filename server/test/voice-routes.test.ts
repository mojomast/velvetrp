import Fastify from "fastify";
import { describe,it,expect } from "vitest";
import { join } from "node:path";
import { voiceRoutes } from "../src/voice/routes.js";
import { VoiceService } from "../src/voice/service.js";
import { useTmpDataDir } from "./helpers.js";
useTmpDataDir();
describe("voice HTTP",()=>{
 it.each(['text','revision'] as const)("rejects stale source %s on attribution save even with equal script revisions (review 4)",async(field)=>{
  const source={kind:'dm',id:'source',text:'Original public.',revision:'1',sessionId:'room'};
  const service=new VoiceService(join(process.env.VELVET_DATA_DIR!,"source-version.sqlite"),{authorize:()=>{},list:()=>[],resolve:()=>source,speakers:()=>[{id:'narrator',label:'Narrator'},{id:'npc:a',label:'A'}]},
   {timeoutMs:1000,voices:[]},async()=>Buffer.from('unused'));
  const app=Fastify();await app.register(voiceRoutes,{factory:()=>service});
  try{
   const url='/api/campaigns/c/voice/sources/dm/source';
   const old=(await app.inject(url)).json();
   source[field]=field==='text'?'Replacement public.':'2';
   const result=await app.inject({method:'PUT',url,payload:{sourceVersion:old.sourceVersion,expectedRevision:old.revision,speakerIds:['npc:a']}});
   expect(result.statusCode).toBe(409);
   const fresh=(await app.inject(url)).json();
   expect(fresh.sourceVersion).toMatch(/^[a-f0-9]{64}$/);expect(fresh.sourceVersion).not.toBe(old.sourceVersion);
   expect(fresh.revision).toBe(0);expect(fresh.segments[0].speakerId).toBe('narrator');
   for(const sourceVersion of [undefined,'invalid'])expect((await app.inject({method:'PUT',url,payload:{sourceVersion,expectedRevision:0,speakerIds:['npc:a']}})).statusCode).toBe(400);
   const saved=await app.inject({method:'PUT',url,payload:{sourceVersion:fresh.sourceVersion,expectedRevision:0,speakerIds:['npc:a']}});
   expect(saved.statusCode).toBe(200);expect(saved.json().segments[0].text).toBe(source.text);expect(saved.json().segments[0].speakerId).toBe('npc:a');
   expect((await app.inject({method:'PUT',url,payload:{sourceVersion:fresh.sourceVersion,expectedRevision:0,speakerIds:['narrator']}})).statusCode).toBe(409);
  }finally{await app.close();}
 });
 it("accepts a specifically configured reverse-proxy browser origin",async()=>{
  const old=process.env.VELVET_VOICE_ALLOWED_ORIGINS;process.env.VELVET_VOICE_ALLOWED_ORIGINS='http://localhost:5173';
  const app=Fastify();await app.register(voiceRoutes,{factory:()=>null});
  try{expect((await app.inject({url:'/api/campaigns/c/voice',headers:{origin:'http://localhost:5173'}})).statusCode).toBe(200);}finally{await app.close();if(old===undefined)delete process.env.VELVET_VOICE_ALLOWED_ORIGINS;else process.env.VELVET_VOICE_ALLOWED_ORIGINS=old;}
 });
 it("is disabled by default without touching a database",async()=>{
  const app=Fastify();await app.register(voiceRoutes,{factory:()=>null});
  expect((await app.inject('/api/campaigns/c/voice')).json()).toEqual({enabled:false});
  expect((await app.inject({method:'POST',url:'/api/campaigns/c/voice/play',payload:{kind:'dm',id:'source'}})).statusCode).toBe(404);await app.close();
 });
 it("streams authorized audio with range/HEAD and rejects text, URLs, cross-scope reads and CSRF",async()=>{
  const service=new VoiceService(join(process.env.VELVET_DATA_DIR!,"voice.sqlite"),{authorize:()=>{},list:()=>[],resolve:(c,k,id)=>c==='c'&&k==='dm'&&id==='source'?{kind:k,id,text:'Published caption.',revision:'1',sessionId:'room'}:null,speakers:()=>[{id:'narrator',label:'Narrator'}]},
   {timeoutMs:1000,voices:[{id:'synthetic',label:'Synthetic',language:'en',instruct:'Synthetic adult',seed:42,model:'omnivoice',revision:'v1'}]},async()=>Buffer.from('0123456789'));
  const app=Fastify();await app.register(voiceRoutes,{factory:()=>service});
  try{
   const base='/api/campaigns/c/voice';
   expect((await app.inject({method:'PUT',url:base+'/casting',payload:{speakerId:'narrator',voiceId:'synthetic',expectedRevision:0}})).statusCode).toBe(200);
   for(const payload of [{text:'untrusted'}, {kind:'dm',id:'source',url:'http://evil'}])expect((await app.inject({method:'POST',url:base+'/play',payload})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:base+'/play',headers:{origin:'https://evil.test'},payload:{kind:'dm',id:'source'}})).statusCode).toBe(403);
   const play=await app.inject({method:'POST',url:base+'/play',payload:{kind:'dm',id:'source'}});expect(play.statusCode).toBe(200);
   await new Promise(r=>setTimeout(r,10));const url=base+'/jobs/'+play.json().id+'/audio/0';
   const audio=await app.inject({url,headers:{range:'bytes=2-5'}});expect(audio.statusCode).toBe(206);expect(audio.body).toBe('2345');expect(audio.headers['content-range']).toBe('bytes 2-5/10');expect(audio.headers['content-type']).toBe('audio/wav');
   expect((await app.inject({method:'HEAD',url})).body).toBe('');
   expect((await app.inject({url,headers:{range:'bytes=99-'}})).statusCode).toBe(416);
   expect((await app.inject(url.replace('/campaigns/c/','/campaigns/other/'))).statusCode).toBe(404);
   expect((await app.inject(base+'?text=secret')).statusCode).toBe(400);
  }finally{await app.close();}
 });
});
