import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { join } from "node:path";
import { createRepository, type Repository } from "../repo/index.js";
import { getDb, resolveDataDir } from "../repo/db/connection.js";
import { readRpgFeatureFlags } from "../features.js";
import { createVoiceSourceReader } from "./sources.js";
import { readVoiceConfig, createOmniVoiceAdapter } from "./omnivoice.js";
import { VoiceService, VoiceError } from "./service.js";
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
type Params={campaignId:string;jobId:string;index:string;kind:string;sourceId:string};
const fields=(body:unknown,keys:string[]):Record<string,unknown>=>{
 if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k)))throw new VoiceError(400,"Invalid voice request");
 return body as Record<string,unknown>;
};
const id=(value:unknown)=>{if(typeof value!=="string"||!ID.test(value))throw new VoiceError(400,"Invalid voice identity");return value;};
const revision=(value:unknown)=>{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)throw new VoiceError(400,"Invalid voice revision");return value;};
export const voiceRoutes:FastifyPluginAsync<{factory?:()=>VoiceService|null}>=async(app,options)=>{
 let service:VoiceService|null|undefined,repo:Repository|undefined;
 const get=()=>{
  if(service!==undefined)return service;
  if(options.factory)return service=options.factory();
  const flags=readRpgFeatureFlags();if(!flags.campaign||!flags.mechanics)return service=null;
  try{
   const config=readVoiceConfig();if(!config)return service=null;
   repo=createRepository();service=new VoiceService(join(resolveDataDir(),"voice","presentation.sqlite"),createVoiceSourceReader(repo,getDb()),config,createOmniVoiceAdapter(config.baseUrl));
  }catch{app.log.warn("Optional voice unavailable: check server-side voice configuration and sidecar");service=null;}
  return service;
 };
 app.addHook('onClose',async()=>{service?.close();repo?.close();});
 const run=(action:(service:VoiceService,p:Params,body:unknown,req:FastifyRequest,reply:FastifyReply)=>unknown)=>async(req:FastifyRequest<{Params:Params}>,reply:FastifyReply)=>{
  reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff');
  try{
   if(req.url.includes('?'))throw new VoiceError(400,"Voice routes do not accept query parameters");
   if(Object.values(req.params).some(v=>!ID.test(v)))throw new VoiceError(404,"Voice resource unavailable");
   if(req.headers['sec-fetch-site']==='cross-site')throw new VoiceError(403,"Cross-site voice request denied");
   const origin=req.headers.origin;
   if(origin){let host:string;try{host=new URL(origin).host;}catch{throw new VoiceError(403,"Invalid origin");}const allowed=(process.env.VELVET_VOICE_ALLOWED_ORIGINS??'').split(',').map(v=>v.trim());if(host!==req.headers.host&&!allowed.includes(origin))throw new VoiceError(403,"Cross-site voice request denied");}
   const svc=get();
   if(!svc){if(req.method==='GET'&&req.routeOptions.url==='/api/campaigns/:campaignId/voice')return {enabled:false};throw new VoiceError(404,"Voice is disabled");}
   return await action(svc,req.params,req.body,req,reply);
  }catch(error){return reply.code(error instanceof VoiceError?error.statusCode:503).send({error:error instanceof VoiceError?error.message:"Text ready; voice unavailable"});}
 };
 const root='/api/campaigns/:campaignId/voice';
 app.get<{Params:Params}>(root,run((s,p)=>s.status(p.campaignId)));
 app.put<{Params:Params}>(root+'/casting',{bodyLimit:4096},run((s,p,body)=>{const b=fields(body,['speakerId','voiceId','expectedRevision']);return s.cast(p.campaignId,id(b.speakerId),id(b.voiceId),revision(b.expectedRevision));}));
 app.get<{Params:Params}>(root+'/sources/:kind/:sourceId',run((s,p)=>s.script(p.campaignId,p.kind,p.sourceId)));
 app.put<{Params:Params}>(root+'/sources/:kind/:sourceId',{bodyLimit:8192},run((s,p,body)=>{
  const b=fields(body,['expectedRevision','speakerIds','sourceVersion']);if(typeof b.sourceVersion!=='string'||! /^[a-f0-9]{64}$/.test(b.sourceVersion)||!Array.isArray(b.speakerIds)||b.speakerIds.length>32)throw new VoiceError(400,"Invalid script");
  return s.setScript(p.campaignId,p.kind,p.sourceId,revision(b.expectedRevision),b.speakerIds.map(id),b.sourceVersion);
 }));
 app.post<{Params:Params}>(root+'/play',{bodyLimit:4096},run((s,p,body)=>{const b=fields(body,['kind','id']);return s.play(p.campaignId,id(b.kind),id(b.id));}));
 app.get<{Params:Params}>(root+'/jobs/:jobId',run((s,p)=>s.job(p.campaignId,p.jobId)));
 app.delete<{Params:Params}>(root+'/jobs/:jobId',run((s,p,body)=>{if(body!==undefined)throw new VoiceError(400,"Cancel accepts no body");return s.cancel(p.campaignId,p.jobId);}));
 app.get<{Params:Params}>(root+'/jobs/:jobId/audio/:index',run((s,p,_body,req,reply)=>{
  if(!/^\d{1,2}$/.test(p.index))throw new VoiceError(404,"Audio unavailable");
  const audio=s.audio(p.campaignId,p.jobId,Number(p.index),false);let start=0,end=audio.length-1;
  reply.header('accept-ranges','bytes').type('audio/wav');
  const range=req.headers.range;
  if(range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(range);
   if(!match||(!match[1]&&!match[2]))return reply.code(416).header('content-range',`bytes */${audio.length}`).send();
   if(!match[1])start=Math.max(0,audio.length-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=audio.length)return reply.code(416).header('content-range',`bytes */${audio.length}`).send();
   reply.code(206).header('content-range',`bytes ${start}-${end}/${audio.length}`);
  }
  reply.header('content-length',end-start+1);
  if(req.method==='HEAD')return reply.send();
  s.audio(p.campaignId,p.jobId,Number(p.index));
  // Byte streaming with Node backpressure. Studio already buffered this short utterance.
  return reply.send(Readable.from((function*(){for(let at=start;at<=end;at+=16384)yield audio.subarray(at,Math.min(end+1,at+16384));})()));
 }));
};
