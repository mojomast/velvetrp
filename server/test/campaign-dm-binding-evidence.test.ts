import { describe, expect, it } from 'vitest';
import type { PrivateAdventureTurn } from '@velvet/contracts';
import { createSession } from '../src/repo/index.js';
import { orchestrateAdventureTurn } from '../src/agent/adventureOrchestrator.js';
import { orchestrateCampaignDmBeat } from '../src/agent/campaignDmOrchestrator.js';
import { dmFixture, dmCompletion, dmDependencies } from './fixtures/dmCampaign.js';
import { useTmpDataDir } from './helpers.js';

useTmpDataDir();
type Fixture=Awaited<ReturnType<typeof dmFixture>>;
const owner='local-owner';
function finish(f:Fixture,turn:PrivateAdventureTurn){
  expect(turn.receiptLinks).toHaveLength(1);
  const narrating=f.repo.updateAdventureTurnNarration(owner,{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:turn.campaignRevision,
    idempotencyKey:`${turn.turnId}:narrating`,narrationStatus:'in-progress'});
  f.repo.updateAdventureTurnNarration(owner,{turnId:turn.turnId,expectedTurnRevision:narrating.revision,expectedCampaignRevision:turn.campaignRevision,
    idempotencyKey:`${turn.turnId}:completed`,narrationStatus:'completed',terminalState:'completed',fallbackNarration:'The verified action is complete.'});
  return turn.turnId;
}
async function director(f:Fixture,key:string,evidenceTurnId?:string){
  const run=f.repo.openDmBeat(owner,f.campaign.id,f.session.id,{intent:key==='open'?'open':'continue',expectedModeRevision:1,idempotencyKey:key,...(evidenceTurnId?{evidenceTurnId}:{})});
  await orchestrateCampaignDmBeat(f.repo,owner,run.runId,dmDependencies(async input=>dmCompletion(input,key==='open'?'reveal-node':'resolve-node')));
  return f.repo.getDmRun(owner,f.campaign.id,f.session.id,run.runId);
}
function bind(f:Fixture,kind:'quest-objective'|'encounter',targetId:string,key:string){
  f.repo.bindDmSceneEvidence(owner,f.campaign.id,{nodeId:'gate',evidence:{kind,targetId},expectedStoryRevision:f.repo.getCampaignStory(owner,f.campaign.id)!.revision,idempotencyKey:key});
}
async function setup(){
  const f=await dmFixture();f.graph();f.repo.setDmControl(owner,f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'delegate'});
  await director(f,'open');f.advance();return f;
}
describe('authoritative quest and encounter scene bindings',()=>{
  it('requires the exact completed quest objective, not another objective from the same campaign',async()=>{
    const f=await setup();
    for(const id of ['gate-quest','lantern-quest']){
      f.repo.createCampaignQuest(owner,f.campaign.id,{quest:{questId:id,storylineId:'story',title:id,description:null,visibility:'public',journalText:'Offered',
        objectives:[{objectiveId:`${id}-objective`,description:`Complete ${id}`,targetProgress:1,dependencyObjectiveIds:[],visibility:'public'}],rewards:[]},
        expectedRevision:f.repo.listCampaignQuests(owner,f.campaign.id)!.revision,idempotencyKey:`create-${id}`});
      f.repo.executeQuestCommand(owner,id,{kind:'accept',expectedRevision:f.repo.listCampaignQuests(owner,f.campaign.id)!.revision,idempotencyKey:`accept-${id}`});
    }
    bind(f,'quest-objective','lantern-quest-objective','wrong-objective');
    const created=f.repo.createAdventureTurn(owner,{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.session.id,actorId:f.actorId,
      declaration:'I complete gate-quest.',expectedCampaignRevision:f.repo.getCampaignAdministration(owner,f.campaign.id)!.revision,idempotencyKey:'objective-turn'});
    const candidate=f.repo.listAdventureQuestObjectiveCandidates(owner,created.turnId).find(value=>value.objectiveId==='gate-quest-objective')!;
    expect(candidate).toBeDefined();
    const completed=await orchestrateAdventureTurn(f.repo,created.turnId,{...dmDependencies(async()=>({message:{role:'assistant',content:null,
      toolCalls:[{id:'objective',name:'exact_quest_objective.select',arguments:JSON.stringify({candidateId:candidate.candidateId,digest:candidate.digest})}]},
      usage:null,model:{requestedModel:'fake',responseModel:'fake'}})),now:f.options.clock.now});
    const evidence=finish(f,completed.turn);
    const wrong=await director(f,'wrong-objective',evidence);expect(wrong.receipts).toEqual([]);
    expect(wrong.blockers).toContain('scene-resolution-requires-gm-binding-or-human-adjudication');
    bind(f,'quest-objective','gate-quest-objective','correct-objective');
    expect((await director(f,'correct-objective',evidence)).receipts[0]?.action).toBe('resolve-node');f.repo.close();
  });

  it('requires the exact completed encounter, not another prepared encounter',async()=>{
    const f=await setup();
    f.repo.createCampaignStorylineGraph(owner,f.campaign.id,{storyline:{storylineId:'other-story',title:'Other story',summary:null,
      nodes:[{nodeId:'other-scene',title:'Other scene',description:'An unrelated problem.',gmNotes:null,revealThreshold:0}],edges:[],plotPoints:[],clues:[]},
      expectedRevision:f.repo.getCampaignStory(owner,f.campaign.id)!.revision,idempotencyKey:'other-story'});
    f.repo.executeStorylineCommand(owner,'other-story',{kind:'reveal-node',targetId:'other-scene',data:{},expectedRevision:f.repo.getCampaignStory(owner,f.campaign.id)!.revision,idempotencyKey:'reveal-other'});
    f.advance();const prepared=f.prepare();
    let combat=f.repo.startEncounter(owner,prepared.encounterId,{expectedRevision:prepared.revision,idempotencyKey:'start'}).combat;
    let steps=0;
    while(steps++<30){
      const enemy=combat.combatants.find(value=>value.kind==='enemy')!;
      const current=combat.combatants.find(value=>value.combatantId===combat.currentCombatant)!;
      if(current.kind==='actor'&&enemy.hitPoints===1)break;
      const action=combat.legalActions.find(value=>value.kind===(current.kind==='actor'?'attack':'end-turn'))!;
      combat=f.repo.resolveCombatAction(owner,combat.combatId,{legalActionId:action.legalActionId,targetIds:action.targetIds.slice(0,1),choices:[],expectedRevision:combat.revision,idempotencyKey:`setup-${steps}`}).combat;
    }
    expect(combat.combatants.find(value=>value.kind==='enemy')!.hitPoints).toBe(1);
    const created=f.repo.createAdventureTurn(owner,{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.session.id,actorId:f.actorId,
      declaration:'I strike the remaining foe.',expectedCampaignRevision:f.repo.getCampaignAdministration(owner,f.campaign.id)!.revision,idempotencyKey:'victory-turn'});
    const candidate=f.repo.getCampaignAgentContextSnapshot(owner,f.campaign.id,f.session.id,{kind:'player',actorId:f.actorId})!.encounter!.legalActionCandidates.find(value=>value.kind==='attack')!;
    const deps={...dmDependencies(async()=>({message:{role:'assistant' as const,content:null,toolCalls:[{id:'strike',name:'combat_action.execute',
      arguments:JSON.stringify({legalActionId:candidate.legalActionId,legalActionDigest:candidate.digest})}]},usage:null,model:{requestedModel:'fake',responseModel:'fake'}})),now:f.options.clock.now};
    const pending=await orchestrateAdventureTurn(f.repo,created.turnId,deps);expect(pending.outcome).toBe('awaiting-confirmation');
    f.repo.decideToolProposals(owner,{turnId:created.turnId,proposalIds:[pending.turn.toolCalls[0]!.proposal.proposalId],decision:'approved',
      expectedTurnRevision:pending.turn.revision,expectedCampaignRevision:pending.turn.campaignRevision,idempotencyKey:'approve-strike'});
    const evidence=finish(f,(await orchestrateAdventureTurn(f.repo,created.turnId,{...deps,complete:async()=>{throw new Error('must not redispatch');}})).turn);
    combat=f.repo.getCombatState(owner,prepared.encounterId)!;expect(combat.currentCombatant).toBeNull();
    // A defeated foe is insufficient until terminal combat is durably completed.
    bind(f,'encounter',prepared.encounterId,'correct-encounter');
    f.repo.endCombat(owner,combat.combatId,{expectedRevision:combat.revision,idempotencyKey:'complete'});
    const otherRoom=await createSession({characterId:f.session.characterId,title:'Other room'});
    f.repo.attachCampaignSession(owner,{campaignId:f.campaign.id,sessionId:otherRoom.id});
    const other=f.repo.createEncounter(owner,f.campaign.id,{sessionId:otherRoom.id,name:'Other fight',combatants:[{kind:'actor',actorId:f.actorId,team:'allies'},
      {kind:'enemy',template:f.enemy,team:'enemies'}],idempotencyKey:'other-fight'}).encounter;
    // Use another revealed public node to isolate the wrong-target binding from the correct gate binding.
    f.repo.bindDmSceneEvidence(owner,f.campaign.id,{nodeId:'other-scene',evidence:{kind:'encounter',targetId:other.encounterId},expectedStoryRevision:f.repo.getCampaignStory(owner,f.campaign.id)!.revision,idempotencyKey:'wrong-encounter'});
    const run=f.repo.openDmBeat(owner,f.campaign.id,f.session.id,{intent:'continue',expectedModeRevision:1,idempotencyKey:'resolve-encounter',evidenceTurnId:evidence});
    const work=f.repo.claimDmPlanning(owner,run.runId,'fake','fake')!;
    expect(work.candidates.filter(value=>value.action==='resolve-node').map(value=>value.label)).toEqual(['Resolve bound scene: The gate']);
    const selected=work.candidates.find(value=>value.action==='resolve-node')!;
    f.repo.settleDmPlanning(owner,run.runId,work.claimId,{candidateId:selected.candidateId,digest:selected.digest},null);
    await orchestrateCampaignDmBeat(f.repo,owner,run.runId,dmDependencies());
    expect(f.repo.getDmRun(owner,f.campaign.id,f.session.id,run.runId).receipts[0]?.action).toBe('resolve-node');f.repo.close();
  });
});
