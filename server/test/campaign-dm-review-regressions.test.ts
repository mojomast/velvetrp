import DatabaseDriver from 'better-sqlite3';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generatedCampaignContentProviderSchema } from '@velvet/contracts';
import { dmFixture, dmDependencies, dmCompletion } from './fixtures/dmCampaign.js';
import { useTmpDataDir } from './helpers.js';
import { orchestrateCampaignDmBeat } from '../src/agent/campaignDmOrchestrator.js';
import { orchestrateAdventureTurn } from '../src/agent/adventureOrchestrator.js';
import { createRepository } from '../src/repo/index.js';

useTmpDataDir();
const database=()=>new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,'velvet.sqlite'));
const delegate=(f:Awaited<ReturnType<typeof dmFixture>>)=>f.repo.setDmControl('local-owner',f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'auto'});
async function beat(f:Awaited<ReturnType<typeof dmFixture>>,key:string,evidenceTurnId?:string){
  const run=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:key==='open'?'open':'continue',expectedModeRevision:1,idempotencyKey:key,...(evidenceTurnId?{evidenceTurnId}:{})});
  await orchestrateCampaignDmBeat(f.repo,'local-owner',run.runId,dmDependencies(async input=>dmCompletion(input,key==='open'?'reveal-node':'resolve-node')));
  return f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,run.runId);
}
describe('reproduced director review findings',()=>{
  it.each(['story-node','clue'] as const)('never advertises or publishes accepted GM-only %s text, including historical manual reveals',async(kind)=>{
    const f=await dmFixture();f.advance();const db=database();
    const content=generatedCampaignContentProviderSchema.parse({[kind==='clue'?'clues':'storyNodes']:[{key:'secret',title:'SECRET_TITLE',description:'SECRET_MAYOR_IS_MURDERER',visibility:'gm'}]});
    const context=f.repo.getCampaignGenerationContext('local-owner',f.campaign.id,[])!;
    const draft=f.repo.createGenerationDraft('local-owner',{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,kind:'content-pack',
      stagedContent:{kind:'campaign-content',requestDigest:'a'.repeat(64),baseContentRevision:context.revision,dependencyDigests:{},...content},
      validation:{valid:true,issues:[],validatedAt:f.options.clock.now().toISOString()},expectedCampaignRevision:f.repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision,idempotencyKey:'draft'});
    f.repo.recordCampaignGenerationCandidate(draft.draftId,content,[]);
    f.repo.applyCampaignContentGenerationDraftAtomically('local-owner',{draftId:draft.draftId,expectedDraftRevision:0,expectedCampaignRevision:draft.campaignRevision,idempotencyKey:'accept',selectedArtifactKeys:['secret']});
    delegate(f);
    const complete=vi.fn(async input=>dmCompletion(input));
    const run=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'open',expectedModeRevision:1,idempotencyKey:'open'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',run.runId,dmDependencies(complete));expect(complete).not.toHaveBeenCalled();
    expect(f.repo.getDmProposal('local-owner',f.campaign.id,f.session.id,run.runId).proposal).toBeNull();
    expect(JSON.stringify(f.repo.getDmHistory('local-owner',f.campaign.id,f.session.id))).not.toContain('SECRET_');
    const node=(f.repo.getCampaignStory('local-owner',f.campaign.id)!.story as any).nodes[0];
    // Reproduce an immutable historical run emitted by the vulnerable director, without disabling guards.
    const legacy=`legacy-${kind}`,commandKey=`dm-command:${legacy}`,at=f.options.clock.now().toISOString();
    db.prepare(`INSERT INTO dm_runs VALUES(?,?,?,?,?,?,'ai',1,'continue',?,?,?,?,?,'awaiting-approval',1,?,'[]',?,?)`).run(
      legacy,f.campaign.id,f.session.id,f.campaign.activeTimelineId,'local-owner','local-owner','legacy',
      JSON.stringify({intent:'continue',expectedModeRevision:1,idempotencyKey:'legacy'}),'{}',JSON.stringify([{candidate:{candidateId:'legacy',digest:'a'.repeat(64),action:'reveal-node',label:'SECRET_TITLE'},target:node.nodeId,revision:1}]),
      'a'.repeat(64),JSON.stringify({candidateId:'legacy',digest:'a'.repeat(64)}),at,new Date(f.options.clock.now().getTime()+60000).toISOString());
    db.prepare("INSERT INTO dm_decisions VALUES(?,?,'ai-policy-v1','{}',?)").run(legacy,'local-owner',at);
    const revealed=f.repo.executeStorylineCommand('local-owner',node.storylineId,{kind:'reveal-node',targetId:node.nodeId,data:{},expectedRevision:f.repo.getCampaignStory('local-owner',f.campaign.id)!.revision,idempotencyKey:commandKey});
    db.prepare('INSERT INTO dm_receipts VALUES(?,?,?,?,?)').run(legacy,commandKey,'reveal-node',JSON.stringify(revealed.receipt),JSON.stringify({action:'reveal-node',summary:'SECRET_MAYOR_IS_MURDERER'}));
    db.prepare('INSERT INTO dm_public_history VALUES(?,?,?)').run(legacy,'SECRET_MAYOR_IS_MURDERER',at);
    db.prepare("UPDATE dm_runs SET state='completed',revision=2 WHERE run_id=?").run(legacy);
    expect(f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,legacy)).toMatchObject({state:'blocked',receipts:[],narration:null});
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('player','Player',0)").run();f.advance();
    f.repo.addCampaignMembership('local-owner',f.campaign.id,{principalId:'player',role:'player'});
    expect(JSON.stringify(f.repo.getCampaignStory('player',f.campaign.id))).not.toContain('SECRET_');
    f.graph(); // A separate explicitly public graph remains playable.
    const next=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'public-open'});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',next.runId,dmDependencies(async input=>{
      if(input.promptVersion==='campaign-dm-narration-v1')expect(JSON.stringify(input.messages)).not.toContain('SECRET_');
      return dmCompletion(input,'reveal-node');
    }));
    expect(JSON.stringify(f.repo.getDmHistory('player',f.campaign.id,f.session.id))).not.toContain('SECRET_');
    expect(db.prepare('SELECT public_json FROM dm_receipts WHERE run_id<>?').all(legacy).every((r:any)=>!r.public_json.includes('SECRET_'))).toBe(true);
    db.close();f.repo.close();
  });

  it('a pebble check cannot resolve the gate, but an exact GM-authored check binding can',async()=>{
    const f=await dmFixture(true);f.graph();delegate(f);await beat(f,'open');f.advance();f.options.rng.integer=(_min,max)=>max-1;
    const revision=f.repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision;
    const check=async(key:string,declaration:string)=>{
      const turn=f.repo.createAdventureTurn('local-owner',{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.session.id,
        actorId:f.actorId,declaration:`Strength (Strength), Easy difficulty, normal. ${declaration}`,expectedCampaignRevision:revision,idempotencyKey:key});
      const selected=f.repo.generateAdventureCheckCandidates('local-owner',turn.turnId).find(c=>c.label==='Strength (Strength), Easy difficulty, normal')!;
      let result=(await orchestrateAdventureTurn(f.repo,turn.turnId,{...dmDependencies(async()=>({message:{role:'assistant',content:null,
        toolCalls:[{id:'check',name:'exact_srd_check.select',arguments:JSON.stringify({candidateId:selected.candidateId,digest:selected.digest})}]},usage:null,model:{requestedModel:'fake',responseModel:'fake'}})),now:f.options.clock.now})).turn;
      result=f.repo.updateAdventureTurnNarration('local-owner',{turnId:turn.turnId,expectedTurnRevision:result.revision,expectedCampaignRevision:revision,idempotencyKey:`${key}-narrating`,narrationStatus:'in-progress'});
      f.repo.updateAdventureTurnNarration('local-owner',{turnId:turn.turnId,expectedTurnRevision:result.revision,expectedCampaignRevision:revision,idempotencyKey:`${key}-done`,narrationStatus:'completed',terminalState:'completed',fallbackNarration:declaration});
      return turn;
    };
    const pebble=await check('pebble','I lift a pebble. I do not touch the gate.');
    const unrelated=await beat(f,'unrelated',pebble.turnId);expect(unrelated.receipts).toEqual([]);
    expect(unrelated.blockers).toContain('scene-resolution-requires-gm-binding-or-human-adjudication');
    expect((f.repo.getCampaignStory('local-owner',f.campaign.id)!.story as any).nodes.find((n:any)=>n.nodeId==='gate').status).toBe('revealed');
    f.advance();const gate=await check('gate-check','I test the gate mechanism.');
    const input={nodeId:'gate',evidence:{kind:'check-turn' as const,targetId:gate.turnId},expectedStoryRevision:f.repo.getCampaignStory('local-owner',f.campaign.id)!.revision,idempotencyKey:'bind-gate'};
    expect(f.repo.bindDmSceneEvidence('local-owner',f.campaign.id,input)).toEqual(input);
    expect((await beat(f,'still-unrelated',pebble.turnId)).receipts).toEqual([]);
    expect((await beat(f,'bound',gate.turnId)).receipts[0]?.action).toBe('resolve-node');f.repo.close();
  });

  it.each(['gm','player'] as const)('removes a historical %s membership while preserving ledgers and invalidating pending work',async(kind)=>{
    const f=await dmFixture();f.graph();f.advance();const db=database();db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('departing','Departing',0)").run();
    f.repo.addCampaignMembership('local-owner',f.campaign.id,{principalId:'departing',role:kind});
    f.repo.setDmControl(kind==='gm'?'departing':'local-owner',f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'delegate'});
    const run=f.repo.openDmBeat(kind==='player'?'departing':'local-owner',f.campaign.id,f.session.id,{intent:'open',expectedModeRevision:1,idempotencyKey:'open'});
    const counts=db.prepare('SELECT count(*) n FROM dm_runs').get();f.advance();
    f.repo.removeAuditedCampaignMembership('local-owner',f.campaign.id,'departing',{expectedRevision:f.repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision,idempotencyKey:'remove'});
    expect(db.prepare("SELECT role FROM campaign_memberships WHERE principal_id='departing'").get()).toBeUndefined();
    expect(db.prepare('SELECT count(*) n FROM dm_runs').get()).toEqual(counts);
    const complete=vi.fn(async input=>dmCompletion(input));await orchestrateCampaignDmBeat(f.repo,'local-owner',run.runId,dmDependencies(complete));expect(complete).not.toHaveBeenCalled();
    expect(f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,run.runId)).toMatchObject({state:'cancelled',receipts:[]});
    if(kind==='gm')expect(f.repo.getDmControl('local-owner',f.campaign.id)).toMatchObject({mode:'human',revision:2});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);db.close();f.repo.close();
    const reopened=createRepository(f.options);expect(reopened.getDmRun('local-owner',f.campaign.id,f.session.id,run.runId).state).toBe('cancelled');reopened.close();
  });

  it.each(['planning','narration'] as const)('rejects %s over-reservation usage and retains the actual 2000-token bill',async(phase)=>{
    const f=await dmFixture();f.graph();delegate(f);const db=database();
    const run=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'open',expectedModeRevision:1,idempotencyKey:'over-budget'});
    const complete=vi.fn(async input=>{const result=dmCompletion(input);return (input.promptVersion==='campaign-dm-narration-v1')===(phase==='narration')?
      {...result,usage:{promptTokens:10,completionTokens:2000,totalTokens:2010}}:result;});
    const deps=dmDependencies(complete),provider=await deps.getProvider();deps.getProvider=async()=>({...provider,pricing:{promptPerMillion:0,completionPerMillion:100},
      adventureTurnBudget:{maxTotalTokens:24000,maxEstimatedCostUsd:phase==='planning'?0.03:0.11}});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',run.runId,deps);
    const result=f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,run.runId);
    if(phase==='planning')expect(result).toMatchObject({state:'unknown',receipts:[],narration:null});
    else {expect(result.state).toBe('completed');expect(result.narration).toBe(result.receipts[0]!.summary);}
    expect(db.prepare('SELECT source,prompt_tokens,completion_tokens,total_tokens,cost_usd FROM dm_review_provider_usage WHERE run_id=? AND phase=?').get(run.runId,phase))
      .toEqual({source:'provider',prompt_tokens:10,completion_tokens:2000,total_tokens:2010,cost_usd:0.2});
    if(phase==='planning')expect(db.prepare('SELECT completion_tokens FROM dm_dispatches WHERE run_id=?').get(run.runId)).toEqual({completion_tokens:2000});
    const calls=complete.mock.calls.length;await orchestrateCampaignDmBeat(f.repo,'local-owner',run.runId,deps);expect(complete).toHaveBeenCalledTimes(calls);db.close();f.repo.close();
  });
});
