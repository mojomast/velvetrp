import { describe,it,expect } from "vitest";
import { createOmniVoiceAdapter, readVoiceConfig, profileDigest } from "../src/voice/omnivoice.js";
const voice={id:"synthetic",label:"Synthetic",language:"en",seed:42,instruct:"A synthetic clear adult narrator",revision:"v1",model:"omnivoice"};
export function wav(){const b=Buffer.alloc(4844);b.write("RIFF");b.writeUInt32LE(b.length-8,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(4800,40);return b;}
describe("OmniVoice boundary",()=>{
 it("defaults off and only accepts operator-fixed HTTP config",()=>{
  expect(readVoiceConfig({})).toBeNull();
  expect(()=>readVoiceConfig({VELVET_VOICE_ENABLED:"true",OMNIVOICE_BASE_URL:"file:///etc",VELVET_VOICE_DEFINITIONS:JSON.stringify([voice])})).toThrow();
 });
 it("posts bounded synthetic text as multipart, receives WAV bytes and never forwards paths",async()=>{
  const calls:string[]=[];
  const adapter=createOmniVoiceAdapter("http://localhost:3900",async(url,init)=>{
   calls.push(String(url));const form=init?.body as FormData;
   expect(form.get("text")).toBe("Hello.");expect(form.get("seed")).toBe("42");expect(form.has("ref_audio")).toBe(false);
   return new Response(wav(),{headers:{"content-type":"audio/wav","X-Audio-Path":"private.wav"}});
  });
  expect(await adapter("Hello.",voice,new AbortController().signal)).toEqual(wav());expect(calls).toEqual(["http://localhost:3900/generate"]);
 });
 it("fails closed for missing or edited approved profiles before generation",async()=>{
  let calls=0;const profile={id:"approved",is_locked:1,locked_audio_path:"internal",ref_text:"Hello",seed:42};
  const adapter=createOmniVoiceAdapter("http://localhost:3900",async()=>{calls++;return Response.json({...profile,seed:43});});
  await expect(adapter("Hello.",{...voice,profileId:"approved",profileDigest:profileDigest(profile)},new AbortController().signal)).rejects.toThrow();expect(calls).toBe(1);
 });
 it("rejects malformed backend audio rather than serving arbitrary bytes",async()=>{
  const adapter=createOmniVoiceAdapter("http://localhost:3900",async()=>new Response("not audio",{headers:{"content-type":"audio/wav"}}));
  await expect(adapter("Hello.",voice,new AbortController().signal)).rejects.toThrow();
 });
});
