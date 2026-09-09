import { afterEach, expect, it, vi } from "vitest";
import { readAuthoringField, writeAuthoringField } from "./generationRecovery";

afterEach(()=>{sessionStorage.clear();vi.unstubAllGlobals();});
it("retains bounded authoring and exact keys across a fresh module load",async()=>{
  const input={campaignId:"campaign",brief:"Exact brief",tone:"hopeful",exclusions:[],idempotencyKey:"exact-reload",sections:["handouts"],expandArtifactKeys:[],revisionFeedback:null,retryFailedAttempt:null};
  writeAuthoringField("campaign","generationIntent",{input,failedAttempt:null,ambiguous:true});
  writeAuthoringField("campaign","answers",{premise:"Saved premise",heroes:"",stakes:"",opening:""});
  vi.resetModules();const restarted=await import("./generationRecovery");
  expect(restarted.readAuthoringField("campaign","generationIntent")).toEqual({input,failedAttempt:null,ambiguous:true});
  expect(restarted.readAuthoringField("campaign","answers")).toMatchObject({premise:"Saved premise"});
  expect(restarted.readAuthoringField("other","generationIntent")).toBeUndefined();
});

it("rejects corrupt, cross-campaign and unbounded persisted intents and excludes previews",()=>{
  const key="velvet-campaign-authoring-v1:campaign";
  sessionStorage.setItem(key,"not-json");expect(readAuthoringField("campaign","generationIntent")).toBeUndefined();
  expect(()=>writeAuthoringField("campaign","answers",{premise:"x".repeat(901),heroes:"",stakes:"",opening:""})).toThrow();
  sessionStorage.clear();writeAuthoringField("campaign","draft",{privatePreview:"not persisted"});expect(sessionStorage.length).toBe(0);
  const value={input:{campaignId:"other",brief:"Other",tone:"hopeful",exclusions:[],sections:["handouts"],idempotencyKey:"key"},failedAttempt:null,ambiguous:true};
  sessionStorage.setItem(key,JSON.stringify({generationIntent:value}));expect(readAuthoringField("campaign","generationIntent")).toBeUndefined();
});

it("retains a bounded staged hydration cursor and named context choices",()=>{
  const plan={version:1 as const,currentStep:1,completed:[{stepId:"foundation",draftId:"draft-one",returnedCount:4,acceptedCount:2}],contextOptions:[{key:"old-harbor",label:"Old Harbor",kind:"Location"}],contextKeys:["old-harbor"]};
  writeAuthoringField("campaign","hydrationPlan",plan);
  expect(readAuthoringField("campaign","hydrationPlan")).toEqual(plan);
  expect(()=>writeAuthoringField("campaign","hydrationPlan",{...plan,contextKeys:Array.from({length:17},(_,index)=>`key-${index}`)})).toThrow();
});
