import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { createRepository } from "../src/repo/index.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { dmNarrationMessages, validDmScene, parseDmScene, dmNarrationTool } from "../src/agent/dmNarration.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database=()=>new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
const scene='Rain beads on the stone beside the gate. Mara tilts her lantern and murmurs, "A patient eye is worth a hurried step." Would you like to examine the stonework or speak with Mara?';
const response=(text=scene):ProviderCompletionResult=>{
  const index=Math.max(text.lastIndexOf('Would you'),text.lastIndexOf('What '));
  return {message:{role:'assistant',content:'DISCARDED_PROVIDER_PROSE',
    toolCalls:[{id:'narration',name:'submit_dm_scene',arguments:JSON.stringify({atmosphere:text.slice(0,index).trim(),dialogue:[],question:text.slice(index)})}]},
    usage:{promptTokens:10,completionTokens:30,totalTokens:40},model:{requestedModel:'fake-dm',responseModel:'fake-dm'}};
};
async function prepare(){
  const f=await dmFixture();f.graph();f.repo.setDmControl('local-owner',f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'auto'});
  const request={intent:'open' as const,expectedModeRevision:1,idempotencyKey:'open'};
  const run=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,request);
  return {...f,run,request};
}
function commitWithoutNarration(f:Awaited<ReturnType<typeof prepare>>){
  const work=f.repo.claimDmPlanning('local-owner',f.run.runId,'fake','fake')!;
  const candidate=work.candidates[0]!;
  f.repo.settleDmPlanning('local-owner',f.run.runId,work.claimId,{candidateId:candidate.candidateId,digest:candidate.digest},{promptTokens:10,completionTokens:10});
  return f.repo.executeDmBeat('local-owner',f.run.runId);
}
describe('public AI DM narration',()=>{
  it('uses public place and NPC portrayal, committed reveals and public history, never private plans or harness strings',async()=>{
    const f=await dmFixture();f.graph();f.advance();const db=database();
    const content=generatedCampaignContentProviderSchema.parse({
      locations:[{key:'road',name:'Rain Road',description:'Wet stone beside an old gate.',atmosphere:'Rain patters on slate.',visibility:'public'}],
      npcs:[{key:'mara',name:'Mara',archetype:'Patient lantern keeper',description:'A cautious guide with a dry voice.',privateGoals:'SECRET_NPC_GOAL',visibility:'public',locationKey:'road'}],
      handouts:[{key:'letter',title:'SECRET_UNPUBLISHED_TITLE',content:'SECRET_UNPUBLISHED_CONTENT',visibility:'public'}],
    });
    const context=f.repo.getCampaignGenerationContext('local-owner',f.campaign.id,[])!;
    const draft=f.repo.createGenerationDraft('local-owner',{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,kind:'content-pack',
      stagedContent:{kind:'campaign-content',requestDigest:'a'.repeat(64),baseContentRevision:context.revision,dependencyDigests:{},...content},
      validation:{valid:true,issues:[],validatedAt:f.options.clock.now().toISOString()},expectedCampaignRevision:f.repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision,idempotencyKey:'public-preparation'});
    f.repo.recordCampaignGenerationCandidate(draft.draftId,content,[]);
    f.repo.applyCampaignContentGenerationDraftAtomically('local-owner',{draftId:draft.draftId,expectedDraftRevision:0,expectedCampaignRevision:draft.campaignRevision,idempotencyKey:'accept',selectedArtifactKeys:['road','mara','letter']});
    const resource=(key:string)=>(db.prepare('SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key=?').get(f.campaign.id,key) as any).server_resource_id;
    db.prepare('INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)').run(f.campaign.id,f.actorId,resource('road'),f.session.id,f.options.clock.now().toISOString());
    const presence=db.prepare('SELECT location_id FROM campaign_npc_presence_v43 WHERE campaign_id=? AND session_id=? AND npc_id=?').get(f.campaign.id,f.session.id,resource('mara')) as {location_id:string}|undefined;
    if(presence?.location_id!==resource('road'))f.repo.mutateNpcPresence('local-owner',{campaignId:f.campaign.id,sessionId:f.session.id,npcId:resource('mara'),
      expectedRevision:(db.prepare('SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?').get(f.campaign.id,f.session.id) as {revision:number}|undefined)?.revision??0,
      idempotencyKey:'present',mutation:{kind:presence?'move':'place',locationId:resource('road')}});
    const first=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'open',expectedModeRevision:0,idempotencyKey:'open'});
    let publicCalls=0;
    const complete=vi.fn(async input=>{
      if(input.promptVersion!=='campaign-dm-narration-v1'){expect(JSON.stringify(input.messages)).toContain('SECRET_GATE');return dmCompletion(input);}
      publicCalls++;const prompt=JSON.stringify(input.messages);
      expect(prompt).not.toMatch(/SECRET_|gmNotes|privateGoals|candidateId|proposal/);
      expect(JSON.stringify(input.harness)).not.toContain('SECRET_HARNESS');
      expect(prompt).toContain('Rain patters');expect(prompt).toContain('Patient lantern keeper');
      expect(prompt).toContain('stone gate');
      expect((db.prepare("SELECT status FROM story_node_state_v34 WHERE node_id='gate'").get() as any).status).toBe('revealed');
      if(publicCalls===2){expect(prompt).not.toContain('Mara tilts her lantern');expect(JSON.parse(input.messages[1]!.content as string).publicScene.history).toContain('Scene revealed: The gate. A stone gate blocks the road.');}
      return response();
    });
    const deps=dmDependencies(complete),harness=await deps.getHarness();deps.getHarness=async()=>({...harness,systemPrompt:'SECRET_HARNESS'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',first.runId,deps);
    expect(publicCalls).toBe(0);expect(f.repo.getDmNarrationWork('local-owner',first.runId)).toBeNull();
    const pending=f.repo.getDmProposal('local-owner',f.campaign.id,f.session.id,first.runId);
    f.repo.decideDmBeat('local-owner',f.campaign.id,f.session.id,first.runId,{decision:'approved',expectedRevision:pending.run.revision,idempotencyKey:'approve'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',first.runId,deps);
    const result=f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,first.runId);
    expect(result.narration).toContain(scene);expect(result.narration).toContain(result.receipts[0]!.summary);
    expect(JSON.stringify(result)).not.toContain('SECRET_');
    f.repo.setDmControl('local-owner',f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'auto'});
    const next=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'next'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',next.runId,deps);
    expect(publicCalls).toBe(2);
    const requests=db.prepare('SELECT request_json FROM dm_narration_dispatches').all();expect(JSON.stringify(requests)).not.toMatch(/SECRET_|privateContext/);
    expect(db.prepare("SELECT count(*) n FROM dm_narration_dispatches WHERE source='provider-assisted'").get()).toEqual({n:2});db.close();f.repo.close();
  });

  it.each(['failure','mechanics'] as const)('seals deterministic fallback on %s without rerunning mechanics or retrying a paid call',async(kind)=>{
    const f=await prepare();const complete=vi.fn(async input=>{
      if(input.promptVersion!=='campaign-dm-narration-v1')return dmCompletion(input);
      if(kind==='failure')throw new Error('ambiguous paid failure');return response('You gain 100 gold and defeat the dragon. What do you do?');
    });
    await orchestrateCampaignDmBeat(f.repo,'local-owner',f.run.runId,dmDependencies(complete));
    const result=f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId);
    expect(result.state).toBe('completed');expect(result.narration).toBe(result.receipts[0]!.summary);expect(complete).toHaveBeenCalledTimes(2);
    f.repo.close();const repo=createRepository(f.options),again=vi.fn(async()=>{throw new Error('must not call');});
    await orchestrateCampaignDmBeat(repo,'local-owner',f.run.runId,dmDependencies(again));expect(again).not.toHaveBeenCalled();
    expect(repo.openDmBeat('local-owner',f.campaign.id,f.session.id,f.request)).toEqual(result);
    const db=database();expect(db.prepare('SELECT count(*) n FROM dm_receipts').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM dm_public_history').get()).toEqual({n:1});db.close();repo.close();
  });

  it.each(['claimed','settled'] as const)('recovers %s narration across restart, preserving receipts and never repaying',async(phase)=>{
    const f=await prepare();const committed=commitWithoutNarration(f);expect(committed).toMatchObject({state:'planning',narration:null});expect(committed.receipts).toHaveLength(1);
    const work=f.repo.getDmNarrationWork('local-owner',f.run.runId)!;
    const claim=f.repo.claimDmNarration('local-owner',f.run.runId,'fake','fake',{messages:dmNarrationMessages(work.context,work.fallback)},100,100)!;
    expect(f.repo.claimDmNarration('local-owner',f.run.runId,'fake','fake',{},100,100)).toBeNull();
    if(phase==='settled')f.repo.settleDmNarration('local-owner',f.run.runId,claim,scene,'ok');
    f.repo.close();f.advance(31_000);const repo=createRepository(f.options),complete=vi.fn(async()=>{throw new Error('must not call');});
    await orchestrateCampaignDmBeat(repo,'local-owner',f.run.runId,dmDependencies(complete));expect(complete).not.toHaveBeenCalled();
    const result=repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId);expect(result.state).toBe('completed');
    if(phase==='settled')expect(result.narration).toContain(scene);else expect(result.narration).toBe(result.receipts[0]!.summary);
    repo.settleDmNarration('local-owner',f.run.runId,claim,scene,'late');expect(repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId)).toEqual(result);repo.close();
  });

  it.each(['mode','safety'] as const)('blocks publication on %s changes during narration but keeps mechanics',async(kind)=>{
    const f=await prepare();const complete=vi.fn(async input=>{
      if(input.promptVersion!=='campaign-dm-narration-v1')return dmCompletion(input);
      expect(f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId).receipts).toHaveLength(1);
      if(kind==='mode')f.repo.setDmControl('local-owner',f.campaign.id,{mode:'human',expectedRevision:1,idempotencyKey:'takeover'});
      else {f.advance();f.repo.requestCampaignSafetyAction('local-owner',f.campaign.id,{action:'pause',confirmed:true,
        expectedRevision:f.repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision,idempotencyKey:'pause'});}
      return response();
    });
    await orchestrateCampaignDmBeat(f.repo,'local-owner',f.run.runId,dmDependencies(complete));
    expect(f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId)).toMatchObject({state:'cancelled',narration:null,receipts:[{action:'reveal-node'}]});
    const db=database();expect(db.prepare('SELECT count(*) n FROM dm_public_history').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM dm_receipts').get()).toEqual({n:1});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',f.run.runId,dmDependencies(complete));expect(complete).toHaveBeenCalledTimes(2);db.close();f.repo.close();
  });

  it('holds the room lock during narration and charges both reservations to one aggregate budget',async()=>{
    const f=await prepare();const db=database();let limit=24000;
    const complete=vi.fn(async input=>{
      expect(input.promptVersion).toBe('campaign-dm-v1');
      const reservation=db.prepare('SELECT reserved_prompt_tokens+reserved_completion_tokens tokens FROM dm_provider_requests WHERE run_id=?').get(f.run.runId) as any;
      limit=reservation.tokens+64;return dmCompletion(input);
    });
    const deps=dmDependencies(complete),provider=await deps.getProvider();deps.getProvider=async()=>({...provider,adventureTurnBudget:{maxTotalTokens:limit,maxEstimatedCostUsd:null}});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',f.run.runId,deps);expect(complete).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT source,outcome_code FROM dm_narration_dispatches').get()).toEqual({source:'deterministic-fallback',outcome_code:'aggregate-budget-exceeded'});
    const next=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'next'});
    const work=f.repo.claimDmPlanning('local-owner',next.runId,'fake','fake')!;f.repo.settleDmPlanning('local-owner',next.runId,work.claimId,null,null);
    expect(()=>f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'concurrent'})).toThrow();
    db.close();f.repo.close();
  });

  it('requires an actionable question and rejects player control and mechanical inventions',()=>{
    expect(validDmScene(scene)).toBe(true);
    for(const text of ['You decide to leave. What next?','You gain 50 gold. What next?','The scene is resolved. What next?','You feel afraid. What next?','Rain falls.'])expect(validDmScene(text)).toBe(false);
  });
  it('accepts bounded public NPC dialogue but rejects unadvertised speakers, extra fields, and inflected agency/outcome claims',()=>{
    const context={cast:[{name:'Mara',description:'A cautious guide.'}],players:[{name:'Hero'}],scenes:[{title:'The gate',description:'A stone gate blocks the road.'}],receipts:[{action:'reveal-node',summary:'Scene revealed: The gate.'}]};
    const value={atmosphere:'Rain beads on the stone beside the gate.',dialogue:[{speaker:'Mara',text:'A patient eye is worth a hurried step.'}],question:'Would you like to inspect the stonework or speak with Mara?'};
    expect(parseDmScene(value,context)).toContain('Mara: "A patient eye');
    expect(dmNarrationTool(context).parameters.required).toEqual(['atmosphere','dialogue','question']);
    expect(parseDmScene({...value,dialogue:[{speaker:'Secret villain',text:'Wait here.'}]},context)).toBeNull();
    expect(parseDmScene({...value,scene:'extra'},context)).toBeNull();
    for(const atmosphere of [
      'You agreed to serve the mayor and handed him your sword. The gate swings wide and the king lies dead.',
      'You had already promised to follow the mayor.', 'Hero handed the mayor your sword.',
      'The door swung open.', 'The king was killed.', 'You accepted the bargain and gave away your shield.',
    ]){expect(validDmScene(`${atmosphere} What would you like to inspect?`,context)).toBe(false);expect(parseDmScene({...value,atmosphere},context)).toBeNull();}
  });
  it('falls back on the reproduced agency/death/opening bypass and never feeds that prose into later canonical history',async()=>{
    const f=await prepare();
    const malicious='You agreed to serve the mayor and handed him your sword. The gate swings wide and the king lies dead.';
    await orchestrateCampaignDmBeat(f.repo,'local-owner',f.run.runId,dmDependencies(async input=>input.promptVersion==='campaign-dm-narration-v1'
      ?response(`${malicious} What would you like to inspect?`):dmCompletion(input)));
    const result=f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,f.run.runId);
    expect(result.narration).toBe(result.receipts[0]!.summary);expect(result.narration).not.toContain('agreed');
    const next=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'next'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',next.runId,dmDependencies(async input=>{
      expect(JSON.stringify(input.messages)).not.toContain('agreed to serve');return dmCompletion(input);
    }));f.repo.close();
  });
});
