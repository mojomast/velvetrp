import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { DM_PROVIDER_DEADLINE_MS } from "../src/repo/campaignDmRepo.js";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { orchestrateAdventureTurn } from "../src/agent/adventureOrchestrator.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database=()=>new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
describe("DM recovery and execution fences",()=>{
  it("rejects unadvertised mutations and enforces pre-dispatch budgets without paid requests",async()=>{
    const f=await dmFixture();f.graph();
    const first=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:0,idempotencyKey:"bad"});
    await orchestrateCampaignDmBeat(f.repo,"local-owner",first.runId,dmDependencies(async()=>({message:{role:"assistant",content:null,
      toolCalls:[{id:"hostile",name:"select_dm_beat",arguments:JSON.stringify({selection:{candidateId:"forged",digest:"0".repeat(64)}})}]},usage:null,model:{requestedModel:"fake",responseModel:"fake"}})));
    expect(f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,first.runId)).toMatchObject({state:"unknown",receipts:[]});
    const next=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:0,idempotencyKey:"budget"});
    const complete=vi.fn(async input=>dmCompletion(input)),deps=dmDependencies(complete),provider=await deps.getProvider();
    deps.getProvider=async()=>({...provider,adventureTurnBudget:{maxTotalTokens:1,maxEstimatedCostUsd:null}});
    await orchestrateCampaignDmBeat(f.repo,"local-owner",next.runId,deps);expect(complete).not.toHaveBeenCalled();
    expect(f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,next.runId)).toMatchObject({state:"blocked",blockers:["director-budget-exceeded-before-dispatch"]});
    f.repo.close();
  });
  it("dispatches a rich planning context beyond the old 23,744-byte prompt cap",async()=>{
    const f=await dmFixture();f.graph();
    // A large private story graph previously produced a >23,744-byte planning prompt and blocked before any provider call.
    f.repo.createCampaignStorylineGraph("local-owner",f.campaign.id,{expectedRevision:f.repo.getCampaignStory("local-owner",f.campaign.id)!.revision,
      idempotencyKey:"big-story",storyline:{storylineId:"big",title:"Big story",summary:"A long public storyline",plotPoints:[],clues:[],edges:[],
        nodes:Array.from({length:30},(_,i)=>({nodeId:`big-${i}`,title:`Long scene ${i}`,description:"y".repeat(700),gmNotes:"",revealThreshold:0}))}});
    const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:0,idempotencyKey:"rich-context"});
    const db=database();
    const size=(db.prepare("SELECT length(context_json) n FROM dm_runs WHERE run_id=?").get(run.runId) as {n:number}).n;
    expect(size).toBeGreaterThan(23_744);
    const complete=vi.fn(async()=>{throw new Error("stop after dispatch");});
    await orchestrateCampaignDmBeat(f.repo,"local-owner",run.runId,dmDependencies(complete));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,run.runId).blockers).not.toContain("director-budget-exceeded-before-dispatch");
    // The durable reservation must be a token estimate, never a byte count.
    const reserved=db.prepare('SELECT reserved_prompt_tokens tokens FROM dm_provider_requests WHERE run_id=?').get(run.runId) as {tokens:number}|undefined;
    if(reserved)expect(reserved.tokens).toBeLessThanOrEqual(23_744);
    db.close();f.repo.close();
  });
  it.each(["mode","safety","delegation"] as const)("fences %s changes during provider dispatch before mutation or publication",async(kind)=>{
    const f=await dmFixture();f.graph();f.advance();
    const db=database();db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('gm','GM',0)").run();
    f.repo.addCampaignMembership("local-owner",f.campaign.id,{principalId:"gm",role:"gm"});
    f.repo.setDmControl("gm",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"delegate"});
    const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:1,idempotencyKey:"open"});
    await orchestrateCampaignDmBeat(f.repo,"local-owner",run.runId,dmDependencies(async input=>{
      if(kind==="mode")f.repo.setDmControl("local-owner",f.campaign.id,{mode:"human",expectedRevision:1,idempotencyKey:"takeover"});
      if(kind==="delegation")db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id='gm'").run(f.campaign.id);
      if(kind==="safety") { f.advance();const revision=f.repo.getCampaignAdministration("local-owner",f.campaign.id)!.revision;
        f.repo.requestCampaignSafetyAction("local-owner",f.campaign.id,{action:"pause",confirmed:true,expectedRevision:revision,idempotencyKey:"pause"}); }
      return dmCompletion(input);
    }));
    expect(f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,run.runId)).toMatchObject({state:"cancelled",receipts:[],narration:null});
    expect(db.prepare("SELECT count(*) n FROM dm_public_history").get()).toEqual({n:0});db.close();f.repo.close();
  });

  it("serializes concurrent room beats and recovers settled selections across reopen without a paid call",async()=>{
    const f=await dmFixture();f.graph();f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"delegate"});
    const input={intent:"open" as const,expectedModeRevision:1,idempotencyKey:"open"};
    const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,input);
    expect(()=>f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{...input,idempotencyKey:"race"})).toThrow();
    const work=f.repo.claimDmPlanning("local-owner",run.runId,"fake","fake")!;
    expect(f.repo.claimDmPlanning("local-owner",run.runId,"fake","fake")).toBeNull();
    const selected=work.candidates[0]!;const selection={candidateId:selected.candidateId,digest:selected.digest};
    f.repo.settleDmPlanning("local-owner",run.runId,work.claimId,selection,{promptTokens:2,completionTokens:1});
    expect(()=>f.repo.settleDmPlanning("local-owner",run.runId,work.claimId,null,{promptTokens:2,completionTokens:1})).toThrow();
    f.repo.close();const repo=createRepository(f.options),complete=vi.fn(async()=>{throw new Error("no paid replay");});
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,{...dmDependencies(complete),getProvider:async()=>{throw new Error("settings not needed");}});
    const finished=repo.getDmRun("local-owner",f.campaign.id,f.session.id,run.runId);expect(finished.state).toBe("completed");expect(complete).not.toHaveBeenCalled();
    expect(repo.openDmBeat("local-owner",f.campaign.id,f.session.id,input)).toEqual(finished);
    expect(()=>repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{...input,intent:"continue"})).toThrow();
    repo.close();
  });

  it("marks expired dispatch unknown after restart and never accepts late success or automatically retries",async()=>{
    const f=await dmFixture();f.graph();const request={intent:"open" as const,expectedModeRevision:0,idempotencyKey:"open"};
    const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,request),work=f.repo.claimDmPlanning("local-owner",run.runId,"fake","fake")!;
    f.repo.close();f.advance(DM_PROVIDER_DEADLINE_MS+1_000);const repo=createRepository(f.options),complete=vi.fn(async input=>dmCompletion(input));
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,dmDependencies(complete));
    expect(repo.getDmRun("local-owner",f.campaign.id,f.session.id,run.runId).state).toBe("unknown");
    repo.settleDmPlanning("local-owner",run.runId,work.claimId,{candidateId:work.candidates[0]!.candidateId,digest:work.candidates[0]!.digest},null);
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,dmDependencies(complete));expect(complete).not.toHaveBeenCalled();
    expect(repo.openDmBeat("local-owner",f.campaign.id,f.session.id,request).receipts).toEqual([]);repo.close();
  });

  it("does not execute stale approvals and preserves committed mechanics when narration publication fails",async()=>{
    const f=await dmFixture();f.graph();const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:0,idempotencyKey:"open"});
    await orchestrateCampaignDmBeat(f.repo,"local-owner",run.runId,dmDependencies());
    const proposed=f.repo.getDmProposal("local-owner",f.campaign.id,f.session.id,run.runId);
    f.repo.executeStorylineCommand("local-owner","story",{kind:"reveal-node",targetId:"gate",data:{},expectedRevision:1,idempotencyKey:"external"});
    expect(f.repo.decideDmBeat("local-owner",f.campaign.id,f.session.id,run.runId,{decision:"approved",expectedRevision:proposed.run.revision,idempotencyKey:"stale"}).state).toBe("blocked");
    f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"auto"});
    const next=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"continue",expectedModeRevision:1,idempotencyKey:"clue"});
    const db=database();
    await expect(orchestrateCampaignDmBeat(f.repo,"local-owner",next.runId,dmDependencies(async input=>{
      if(input.promptVersion==='campaign-dm-narration-v1')db.exec("CREATE TRIGGER dm_inject_failure BEFORE INSERT ON dm_public_history BEGIN SELECT RAISE(ABORT,'injected'); END");return dmCompletion(input,"reveal-clue");
    }))).rejects.toThrow('injected');
    expect(f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,next.runId)).toMatchObject({state:"planning",narration:null});
    expect(db.prepare("SELECT count(*) n FROM story_discoveries_v34").get()).toEqual({n:1});
    expect(db.prepare("SELECT count(*) n FROM dm_receipts").get()).toEqual({n:1});db.exec("DROP TRIGGER dm_inject_failure");
    const complete=vi.fn(async()=>{throw new Error('must not redispatch');});
    await orchestrateCampaignDmBeat(f.repo,'local-owner',next.runId,dmDependencies(complete));expect(complete).not.toHaveBeenCalled();
    expect(f.repo.getDmRun('local-owner',f.campaign.id,f.session.id,next.runId).state).toBe('completed');db.close();f.repo.close();
  });

  it("requires unused successful committed evidence to resolve the scene and unlock the finale",async()=>{
    const f=await dmFixture(true);f.graph();f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"auto"});
    const beat=async(key:string,action:"reveal-node"|"resolve-node",evidenceTurnId?:string)=>{
      const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:key==="open"?"open":"continue",expectedModeRevision:1,idempotencyKey:key,...(evidenceTurnId?{evidenceTurnId}:{})});
      const calls=vi.fn(async input=>dmCompletion(input,action));await orchestrateCampaignDmBeat(f.repo,"local-owner",run.runId,dmDependencies(calls));
      return {run:f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,run.runId),calls};
    };
    await beat("open","reveal-node");const noEvidence=await beat("no-evidence","resolve-node");
    const options=JSON.parse(noEvidence.calls.mock.calls[0]![0].messages[1]!.content as string).candidates;
    expect(options.some((c:any)=>c.action==="resolve-node")).toBe(false);
    f.advance();f.options.rng.integer=(_min,max)=>max-1;
    const revision=f.repo.getCampaignAdministration("local-owner",f.campaign.id)!.revision;
    const turn=f.repo.createAdventureTurn("local-owner",{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.session.id,
      actorId:f.actorId,declaration:"Strength (Strength), Easy difficulty, normal. I force the gate open.",expectedCampaignRevision:revision,idempotencyKey:"evidence"});
    const candidate=f.repo.generateAdventureCheckCandidates("local-owner",turn.turnId).find(c=>c.label==="Strength (Strength), Easy difficulty, normal")!;
    expect(candidate).toBeDefined();
    let result=(await orchestrateAdventureTurn(f.repo,turn.turnId,{...dmDependencies(async()=>({message:{role:"assistant",content:null,
      toolCalls:[{id:"check",name:"exact_srd_check.select",arguments:JSON.stringify({candidateId:candidate.candidateId,digest:candidate.digest})}]},usage:null,model:{requestedModel:"fake",responseModel:"fake"}})),now:f.options.clock.now})).turn;
    expect(result.receiptLinks).toHaveLength(1);
    result=f.repo.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:result.revision,expectedCampaignRevision:revision,idempotencyKey:"narrating",narrationStatus:"in-progress"});
    f.repo.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:result.revision,expectedCampaignRevision:revision,idempotencyKey:"done",narrationStatus:"completed",terminalState:"completed",fallbackNarration:"The strength check succeeds."});
    f.repo.bindDmSceneEvidence('local-owner',f.campaign.id,{nodeId:'gate',evidence:{kind:'check-turn',targetId:turn.turnId},
      expectedStoryRevision:f.repo.getCampaignStory('local-owner',f.campaign.id)!.revision,idempotencyKey:'bind-gate-check'});
    expect((await beat("resolve","resolve-node",turn.turnId)).run.receipts[0]?.action).toBe("resolve-node");
    expect((await beat("finale","reveal-node")).run.narration).toContain("The road is open");
    const reuse=await beat("reuse","resolve-node",turn.turnId);expect(reuse.run.blockers).toContain("evidence-unavailable-or-already-used");f.repo.close();
  });
});
