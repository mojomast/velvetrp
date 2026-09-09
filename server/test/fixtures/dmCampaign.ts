import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS, type CampaignDmCandidate } from "@velvet/contracts";
import { createRepository, createSession, MECHANICS_STARTER_CATALOG, SRD_5_1_STARTER_CATALOG } from "../../src/repo/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../src/defaults.js";
import type { AdventureAgentDependencies } from "../../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../../src/provider/index.js";

export async function dmFixture(dnd = false) {
  let time = Date.parse("2036-01-01T00:00:00.000Z");
  const options = { clock: { now: () => new Date(time) }, rng: { integer: (min: number, _max: number) => min } };
  const repo = createRepository(options);
  const campaign = repo.createCampaign("local-owner", { name: "Director campaign" });
  const catalog = dnd ? SRD_5_1_STARTER_CATALOG : MECHANICS_STARTER_CATALOG;
  if (dnd) { repo.installSrdStarterCatalog("local-owner"); repo.configureSrdStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"}); }
  else { repo.installMechanicsStarterCatalog("local-owner"); repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"}); }
  const persona = repo.createCharacter({name:"Hero",age:30,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
  const keys = dnd ? SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS : ["might","agility","resolve","insight","presence","craft"];
  const draft = repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",
    allocation:{method:"standard-array",scores:Object.fromEntries(keys.map((key,i)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as any},idempotencyKey:"draft"});
  const definitions=catalog.definitions;
  const selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"select",selections:{
    race:definitions.find(d=>d.reference.kind==="race")!.reference,background:definitions.find(d=>d.reference.kind==="background")!.reference,
    class:definitions.find(d=>d.reference.kind==="class")!.reference,starterGrant:"kit"}} as any);
  const actorId=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:"final"}).receipt.actorId;
  const session=await createSession({characterId:persona.id,title:"Director room"});
  repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
  repo.transitionSession(session.id,"active","Begin play");
  const enemy=definitions.find(d=>d.reference.definitionId===(dnd?"srd-5.1:enemy-template:goblin":"velvet:mechanics:enemy-template:gloam-mite"))!.reference as any;
  const prepare=()=>repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Prepared ambush",
    combatants:[{kind:"actor",actorId,team:"allies"},{kind:"enemy",template:enemy,team:"enemies"}],idempotencyKey:"prepare"}).encounter;
  const graph=()=>repo.createCampaignStorylineGraph("local-owner",campaign.id,{expectedRevision:repo.getCampaignStory('local-owner',campaign.id)!.revision,idempotencyKey:"story",storyline:{
    storylineId:"story",title:"Journey",summary:"A public quest",nodes:[
      {nodeId:"gate",title:"The gate",description:"A stone gate blocks the road.",gmNotes:"SECRET_GATE",revealThreshold:0},
      {nodeId:"finale",title:"SECRET_FINALE_TITLE",description:"The road is open.",gmNotes:"SECRET_FINALE",revealThreshold:1}],
    edges:[{edgeId:"next",kind:"requires",fromNodeId:"gate",toNodeId:"finale"}],plotPoints:[],
    clues:[{clueId:"key",title:"A key",content:"A brass key is revealed.",truth:"SECRET_TRUTH",gmNotes:"SECRET_CLUE",revealThreshold:1,
      sources:[{sourceId:"gate-key",kind:"node",targetId:"gate"}]}]}});
  return {repo,campaign,session,actorId,enemy,prepare,graph,options,advance:(ms=1000)=>{time+=ms;}};
}
export function dmCompletion(input: ProviderCompletionInput, action?: CampaignDmCandidate["action"]): ProviderCompletionResult {
  if(input.promptVersion==='campaign-dm-narration-v1')return {message:{role:'assistant',content:null,toolCalls:[{
    id:'public-scene',name:'submit_dm_scene',arguments:JSON.stringify({atmosphere:'A quiet moment leaves room to consider the scene.',dialogue:[],question:'What would you like to inspect?'})}]},
    usage:{promptTokens:10,completionTokens:20,totalTokens:30},model:{requestedModel:'fake-dm',responseModel:'fake-dm'}};
  const data=JSON.parse(input.messages[1]!.content as string) as {candidates:CampaignDmCandidate[]};
  const selected=action?data.candidates.find(candidate=>candidate.action===action):data.candidates[0];
  return {message:{role:"assistant",content:"SECRET_PROVIDER_PROSE",toolCalls:[{id:"choice",name:"select_dm_beat",
    arguments:JSON.stringify({selection:selected?{candidateId:selected.candidateId,digest:selected.digest}:null})}]},
    usage:{promptTokens:10,completionTokens:5,totalTokens:15},model:{requestedModel:"fake-dm",responseModel:"fake-dm"}};
}
export function dmDependencies(complete: AdventureAgentDependencies["complete"] = async input=>dmCompletion(input)): AdventureAgentDependencies {
  return {complete,getProvider:async()=>({...defaultProviderSettings(),model:"fake-dm"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
}
