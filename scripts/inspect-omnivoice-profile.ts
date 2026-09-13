import { profileDigest } from '../server/src/voice/omnivoice.js';
const base=process.env.OMNIVOICE_BASE_URL,id=process.env.OMNIVOICE_APPROVED_PROFILE_ID;
if(!base||!id||!/^[A-Za-z0-9._:-]{1,128}$/.test(id))throw new Error('Set OMNIVOICE_BASE_URL and one explicitly approved OMNIVOICE_APPROVED_PROFILE_ID');
const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid backend origin');
const response=await fetch(new URL('/profiles/'+encodeURIComponent(id),url),{redirect:'error',signal:AbortSignal.timeout(5000)});
if(!response.ok||!response.body)throw new Error('Approved profile unavailable');
const reader=response.body.getReader();let size=0;const chunks:Buffer[]=[];
try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>32768)throw new Error('Profile response too large');chunks.push(Buffer.from(next.value));}}finally{await reader.cancel();reader.releaseLock();}
const profile=JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>;
if(profile.id!==id||!profile.is_locked||!profile.locked_audio_path)throw new Error('Approve and lock the game-only profile in Studio first');
console.log(JSON.stringify({profileId:id,profileDigest:profileDigest(profile)}));
