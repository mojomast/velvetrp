import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { CampaignDmConflictError, CampaignDmUnavailableError } from "../src/repo/campaignDmRepo.js";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";
import { dmCompletion, dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";

useTmpDataDir();
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const database=()=>new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
describe("durable DM director",()=>{
  it("defaults human, keeps planning secret, approves exact scene then reveals clue on continue",async()=>{
    const f=await dmFixture();f.graph();const {repo,campaign,session}=f;
    expect(repo.getDmControl("local-owner",campaign.id)).toEqual({campaignId:campaign.id,mode:"human",revision:0});
    const complete=vi.fn(async(input)=>{if(input.promptVersion!=="campaign-dm-narration-v1")expect(JSON.stringify(input.messages)).toContain("SECRET_GATE");return dmCompletion(input,"reveal-node");});
    const request={intent:"open" as const,expectedModeRevision:0,idempotencyKey:"open"};
    const run=repo.openDmBeat("local-owner",campaign.id,session.id,request);
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,dmDependencies(complete));
    const proposed=repo.getDmProposal("local-owner",campaign.id,session.id,run.runId);
    expect(proposed.run.state).toBe("awaiting-approval");expect(proposed.proposal?.action).toBe("reveal-node");
    expect(JSON.stringify(repo.getDmHistory("local-owner",campaign.id,session.id))).not.toContain("SECRET_");
    expect((repo.getCampaignStory("local-owner",campaign.id)!.story as any).nodes[0].status).toBe("hidden");
    const decision={decision:"approved" as const,expectedRevision:proposed.run.revision,idempotencyKey:"approve"};
    repo.decideDmBeat("local-owner",campaign.id,session.id,run.runId,decision);
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,dmDependencies(complete));
    const committed=repo.getDmRun("local-owner",campaign.id,session.id,run.runId);
    expect(committed.state).toBe("completed");expect(committed.narration).toContain("stone gate");
    expect(repo.decideDmBeat("local-owner",campaign.id,session.id,run.runId,decision)).toEqual(committed);
    const replay=repo.openDmBeat("local-owner",campaign.id,session.id,request);
    await orchestrateCampaignDmBeat(repo,"local-owner",replay.runId,dmDependencies(complete));expect(complete).toHaveBeenCalledTimes(2);
    expect(()=>repo.openDmBeat("local-owner",campaign.id,session.id,{...request,idempotencyKey:"another-open"})).toThrow(CampaignDmConflictError);
    repo.setDmControl("local-owner",campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"ai"});
    const next=repo.openDmBeat("local-owner",campaign.id,session.id,{intent:"continue",expectedModeRevision:1,idempotencyKey:"clue"});
    await orchestrateCampaignDmBeat(repo,"local-owner",next.runId,dmDependencies(async input=>dmCompletion(input,"reveal-clue")));
    expect(repo.getDmRun("local-owner",campaign.id,session.id,next.runId)).toMatchObject({state:"completed",narration:expect.stringContaining("brass key")});
    expect(JSON.stringify(repo.getDmHistory("local-owner",campaign.id,session.id))).not.toContain("SECRET_");
    const db=database();expect(db.prepare("SELECT count(*) n FROM adventure_turns").get()).toEqual({n:0});
    expect(db.prepare("SELECT kind FROM dm_decisions ORDER BY rowid").all()).toEqual([{kind:"human-approved"},{kind:"ai-policy-v1"}]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();repo.close();
  });

  it("allows players to request under delegation, never to read GM proposals or set mode",async()=>{
    const f=await dmFixture();f.graph();const db=database();db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('player','Player',0)").run();
    f.advance();f.repo.addCampaignMembership("local-owner",f.campaign.id,{principalId:"player",role:"player"});
    const request={intent:"open" as const,expectedModeRevision:0,idempotencyKey:"player-open"};
    expect(()=>f.repo.openDmBeat("player",f.campaign.id,f.session.id,request)).toThrow(CampaignDmUnavailableError);
    expect(()=>f.repo.setDmControl("player",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"escalate"})).toThrow(CampaignDmUnavailableError);
    f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"delegate"});
    const run=f.repo.openDmBeat("player",f.campaign.id,f.session.id,{...request,expectedModeRevision:1});
    await orchestrateCampaignDmBeat(f.repo,"player",run.runId,dmDependencies());
    expect(f.repo.getDmRun("player",f.campaign.id,f.session.id,run.runId).state).toBe("completed");
    expect(()=>f.repo.getDmProposal("player",f.campaign.id,f.session.id,run.runId)).toThrow(CampaignDmUnavailableError);
    expect(JSON.stringify(f.repo.getDmHistory("player",f.campaign.id,f.session.id))).not.toMatch(/SECRET_|proposal|delegator|gm_principal/);
    db.close();f.repo.close();
  });

  it.each([false,true])("starts prepared combat, advances actual enemy mechanics and completes once (D&D=%s)",async(dnd)=>{
    const f=await dmFixture(dnd),prepared=f.prepare();f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"delegate"});
    const beat=async(key:string)=>{const r=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:key==="open"?"open":"continue",expectedModeRevision:1,idempotencyKey:key});
      await orchestrateCampaignDmBeat(f.repo,"local-owner",r.runId,dmDependencies());return f.repo.getDmRun("local-owner",f.campaign.id,f.session.id,r.runId);};
    expect((await beat("open")).receipts[0]?.action).toBe("encounter-start");
    let combat=f.repo.getCombatState("local-owner",prepared.encounterId)!;
    if(combat.combatants.find(c=>c.combatantId===combat.currentCombatant)?.kind==="actor") combat=f.repo.resolveCombatAction("local-owner",combat.combatId,
      {legalActionId:"end-turn",targetIds:[],choices:[],expectedRevision:combat.revision,idempotencyKey:"yield"}).combat;
    expect(combat.combatants.find(c=>c.combatantId===combat.currentCombatant)?.kind).toBe("enemy");
    expect((await beat("enemy")).receipts[0]?.action).toBe("enemy-turn");
    combat=f.repo.getCombatState("local-owner",prepared.encounterId)!;
    // Win legacy combat for reward availability; flee D&D without bypassing terminal checks.
    let count=0;
    while(combat.currentCombatant!==null&&count++<30){
      const current=combat.combatants.find(c=>c.combatantId===combat.currentCombatant)!;
      if(current.kind==="enemy"){await beat(`enemy-${count}`);combat=f.repo.getCombatState("local-owner",prepared.encounterId)!;}
      else {const action=combat.legalActions.find(a=>a.kind===(dnd?"flee":"attack"))!;
        combat=f.repo.resolveCombatAction("local-owner",combat.combatId,{legalActionId:action.legalActionId,
          targetIds:action.targetIds.slice(0,1),choices:[],expectedRevision:combat.revision,idempotencyKey:`finish-${count}`}).combat;}
    }
    expect(combat.currentCombatant).toBeNull();const completed=await beat("complete");
    expect(completed.receipts[0]?.action).toBe("encounter-complete");expect(completed.narration).toContain("No reward has been claimed");
    if(!dnd){expect(completed.narration).toContain("1 reward bundles");expect(f.repo.listCombatRewards("local-owner",combat.combatId)![0]!.claim.state).toBe("unclaimed");}
    expect((await beat("complete"))).toEqual(completed);expect(f.repo.listEncounters("local-owner",f.campaign.id)![0]!.status).toBe("completed");f.repo.close();
  });

  it("exposes a no-store HTTP control/history with no provider on GET or mode switch",async()=>{
    const f=await dmFixture();f.graph();process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";
    const complete=vi.fn(async input=>dmCompletion(input));const app=buildApp({campaignRepositoryFactory:()=>f.repo,adventureAgentDependencies:dmDependencies(complete)});
    const base=`/api/rpg/v1/campaigns/${f.campaign.id}`,room=`${base}/rooms/${f.session.id}/dm`;
    expect((await app.inject({method:"GET",url:`${base}/dm`})).json()).toMatchObject({mode:"human",revision:0});
    const mode=await app.inject({method:"POST",url:`${base}/dm/mode-commands`,payload:{mode:"ai",expectedRevision:0,idempotencyKey:"mode"}});expect(mode.statusCode,mode.body).toBe(200);
    const history=await app.inject({method:"GET",url:room});expect(history.statusCode).toBe(200);expect(history.headers["cache-control"]).toContain("no-store");expect(complete).not.toHaveBeenCalled();
    const run=await app.inject({method:"POST",url:`${room}/beat-commands`,payload:{intent:"open",expectedModeRevision:1,idempotencyKey:"open"}});
    expect(run.statusCode,run.body).toBe(200);expect(run.json().state).toBe("completed");expect(run.body).not.toContain("SECRET_");
    expect((await app.inject({method:"GET",url:`${room}/runs/${run.json().runId}`})).json()).toEqual(run.json());expect(complete).toHaveBeenCalledTimes(2);
    expect((await app.inject({method:"POST",url:`${room}/runs/${run.json().runId}/resume-commands`,payload:{}})).json()).toEqual(run.json());
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await app.inject({method:"GET",url:`${room}?private=true`})).statusCode).toBe(400);
    await app.close();
  });
});
