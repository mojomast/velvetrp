import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOmniVoiceAdapter,validateWav } from "../server/src/voice/omnivoice.js";
// Explicit operator-run smoke only. No profile catalog, personal reference audio, or game DB access.
const base=process.env.OMNIVOICE_BASE_URL;
if(!base)throw new Error("Set OMNIVOICE_BASE_URL for the explicitly authorized synthetic smoke");
const started=Date.now();
const audio=await createOmniVoiceAdapter(base)("The lantern is lit.",{
 id:"synthetic-smoke",label:"Synthetic smoke",language:"en",seed:4271,
 instruct:"male, middle-aged, moderate pitch, british accent",revision:"smoke-v1",model:"omnivoice-operator-installed",
},AbortSignal.timeout(300000));
validateWav(audio);
const output=resolve(process.env.VELVET_VOICE_SMOKE_OUTPUT??"omnivoice-synthetic-smoke.wav");
writeFileSync(output,audio,{mode:0o600});
console.log(JSON.stringify({ok:true,syntheticOnly:true,bytes:audio.length,elapsedMs:Date.now()-started,output}));
