import { createHash } from "node:crypto";
import type { VoiceConfig, VoiceDefinition, Synthesizer } from "./service.js";
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
export function profileDigest(profile:Record<string,unknown>):string {
 // Usage counters and timestamps must not invalidate identity. Paths are hashed, never disclosed.
 const fields=["id","ref_audio_path","locked_audio_path","ref_text","instruct","language","seed","is_locked"];
 return createHash("sha256").update(JSON.stringify(fields.map(k=>[k,profile[k]??null]))).digest("hex");
}
export function readVoiceConfig(env:NodeJS.ProcessEnv={
 VELVET_VOICE_ENABLED:process.env.VELVET_VOICE_ENABLED,
 OMNIVOICE_BASE_URL:process.env.OMNIVOICE_BASE_URL,
 VELVET_VOICE_DEFINITIONS:process.env.VELVET_VOICE_DEFINITIONS,
 VELVET_VOICE_TIMEOUT_MS:process.env.VELVET_VOICE_TIMEOUT_MS,
}):(VoiceConfig & {baseUrl:string})|null {
 if(env.VELVET_VOICE_ENABLED!=="true")return null;
 const url=new URL(env.OMNIVOICE_BASE_URL??"");
 if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("Invalid OmniVoice base URL");
 const voices:unknown=JSON.parse(env.VELVET_VOICE_DEFINITIONS??"[]");
 if(!Array.isArray(voices)||voices.length<1||voices.length>32)throw new Error("Configure 1–32 approved voice definitions");
 const ids=new Set<string>();
 for(const raw of voices){
  const v=raw as VoiceDefinition;
  if(!v||!ID.test(v.id)||ids.has(v.id)||typeof v.label!=="string"||v.label.length<1||v.label.length>100||typeof v.language!=="string"||!/^[A-Za-z-]{2,20}$/.test(v.language)||typeof v.revision!=="string"||!ID.test(v.revision)||typeof v.model!=="string"||v.model.length<1||v.model.length>128||!Number.isSafeInteger(v.seed)||v.seed<0||v.seed>2147483647)throw new Error("Invalid voice definition");
  if(v.profileId){if(!ID.test(v.profileId)||!v.profileDigest||!/^[a-f0-9]{64}$/.test(v.profileDigest))throw new Error("Approved profiles need a pinned digest");}
  else if(typeof v.instruct!=="string"||!v.instruct.trim()||v.instruct.length>500)throw new Error("Synthetic voices need a bounded instruction");
  ids.add(v.id);
 }
 const timeoutMs=Number(env.VELVET_VOICE_TIMEOUT_MS??300000);
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error("Voice deadline must be 1000–600000ms");
 return {baseUrl:url.origin,voices:voices as VoiceDefinition[],timeoutMs};
}
async function boundedBody(response:Response,limit:number){
 if(!response.ok||!response.body)throw new Error("Voice backend unavailable");
 if(Number(response.headers.get("content-length"))>limit)throw new Error("Voice response too large");
 const reader=response.body.getReader();let size=0;const parts:Buffer[]=[];
 try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error("Voice response too large");parts.push(Buffer.from(value));}}
 catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
 return Buffer.concat(parts);
}
export function validateWav(bytes:Buffer){
 if(bytes.length<44||bytes.toString("ascii",0,4)!=="RIFF"||bytes.toString("ascii",8,12)!=="WAVE")throw new Error("Invalid WAV");
 let format=false,data=false,byteRate=0,dataLength=0;
 for(let at=12;at+8<=bytes.length;){
  const tag=bytes.toString("ascii",at,at+4),length=bytes.readUInt32LE(at+4),end=at+8+length;
  if(end>bytes.length)throw new Error("Truncated WAV");
  if(tag==="fmt "){
   if(length<16)throw new Error("Invalid WAV format");
   const codec=bytes.readUInt16LE(at+8),channels=bytes.readUInt16LE(at+10),rate=bytes.readUInt32LE(at+12);byteRate=bytes.readUInt32LE(at+16);
   if(![1,3].includes(codec)||channels<1||channels>2||rate<8000||rate>96000||byteRate<8000||byteRate>768000)throw new Error("Unsupported WAV format");format=true;
  }
  if(tag==="data"){data=true;dataLength=length;}
  at=end+(length%2);
 }
 if(!format||!data||dataLength===0||dataLength/byteRate>120)throw new Error("Invalid or oversized WAV duration");
}
export function createOmniVoiceAdapter(baseUrl:string,http:typeof fetch=fetch):Synthesizer {
 const base=new URL(baseUrl);if(!["http:","https:"].includes(base.protocol))throw new Error("Invalid voice backend");
 return async(text,voice,signal)=>{
  if(!text.trim()||text.length>240)throw new Error("Utterance out of bounds");
  if(voice.profileId){
   // The inspected Studio /generate silently falls through on an unknown profile. Fail closed first.
   const response=await http(new URL(`/profiles/${encodeURIComponent(voice.profileId)}`,base),{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),redirect:"error"});
   const profile=JSON.parse((await boundedBody(response,32768)).toString()) as Record<string,unknown>;
   if(profile.id!==voice.profileId||!profile.is_locked||!profile.locked_audio_path||profileDigest(profile)!==voice.profileDigest)throw new Error("Approved voice profile changed or missing");
  }
  const form=new FormData();form.set("text",text);form.set("language",voice.language);form.set("seed",String(voice.seed));form.set("num_step","16");form.set("speed","1");form.set("effect_preset","raw");
  if(voice.profileId)form.set("profile_id",voice.profileId);else form.set("instruct",voice.instruct!);
  const response=await http(new URL("/generate",base),{method:"POST",body:form,signal,redirect:"error"});
  if(!/^audio\/(?:wav|x-wav)(?:;|$)/i.test(response.headers.get("content-type")??""))throw new Error("Backend did not return WAV");
  const bytes=await boundedBody(response,8*1024*1024);validateWav(bytes);return bytes;
 };
}
