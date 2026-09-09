import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";};
const content={handouts:[{key:"letter",title:"Letter",content:"Meet at dawn",visibility:"public"}]};
const input=(campaignId:string)=>({campaignId,brief:"A letter",tone:"hopeful",exclusions:[],sections:["handouts"],idempotencyKey:"recover-exact"});
const database=()=>new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
const post=(payload:unknown,url="/api/rpg/v1/campaign-content-drafts")=>({method:"POST" as const,url,headers:{"content-type":"application/json"},payload:JSON.stringify(payload)});

describe("durable campaign generation recovery",()=>{
  it.each([
    "CREATE TRIGGER inject_failure BEFORE INSERT ON generation_drafts BEGIN SELECT RAISE(ABORT,'injected'); END",
    "CREATE TRIGGER inject_failure BEFORE INSERT ON campaign_generation_candidate_artifacts_v52 BEGIN SELECT RAISE(ABORT,'injected'); END",
    "CREATE TRIGGER inject_failure BEFORE UPDATE ON campaign_generation_jobs_v52 WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'injected'); END",
  ])("rolls back draft, candidates and terminal staging on injected failure: %s",async(sql)=>{
    enable();const repo=createRepository(),campaign=repo.createCampaign("local-owner",{name:"Rollback"}),db=database();
    // Inject only after acquisition: the existing incompatible-schema guard
    // correctly refuses an altered schema during initial provider settings reads.
    const generate=vi.fn().mockImplementationOnce(async()=>{db.exec(sql);return content;}).mockResolvedValue(content),app=buildApp({campaignRepositoryFactory:()=>repo,campaignContentGeneration:generate});
    const result=await app.inject(post(input(campaign.id)));expect(result.statusCode).toBe(503);
    expect(db.prepare("SELECT count(*) count FROM generation_drafts WHERE campaign_id=?").get(campaign.id)).toEqual({count:0});
    expect(db.prepare("SELECT count(*) count FROM campaign_generation_candidate_artifacts_v52").get()).toEqual({count:0});
    expect(db.prepare("SELECT state,draft_id FROM campaign_generation_jobs_v52 WHERE campaign_id=?").get(campaign.id)).toEqual({state:"failed",draft_id:null});
    db.exec("DROP TRIGGER inject_failure");await app.close();
    const reopened=createRepository(),restarted=buildApp({campaignRepositoryFactory:()=>reopened,campaignContentGeneration:generate});
    const reconciled=await restarted.inject(post(input(campaign.id),"/api/rpg/v1/campaign-content-drafts/reconcile"));expect(reconciled.json()).toMatchObject({state:"failed",attempt:1,draftId:null});
    expect((await restarted.inject(post(input(campaign.id)))).statusCode).toBe(409);expect(generate).toHaveBeenCalledTimes(1);
    const retry=await restarted.inject(post({...input(campaign.id),retryFailedAttempt:{failedAttempt:1}}));expect(retry.statusCode,retry.body).toBe(201);expect(generate).toHaveBeenCalledTimes(2);
    expect((await restarted.inject(post(input(campaign.id)))).json()).toEqual(retry.json());expect(generate).toHaveBeenCalledTimes(2);
    db.close();await restarted.close();
  });

  it("recovers expired ownership after reopen without redispatch and fences a late provider result",async()=>{
    enable();const repo=createRepository(),campaign=repo.createCampaign("local-owner",{name:"Restart"});let release!:(value:unknown)=>void;
    const generate=vi.fn(()=>new Promise((resolve)=>{release=resolve;})),app=buildApp({campaignRepositoryFactory:()=>repo,campaignContentGeneration:generate});
    const pending=app.inject(post(input(campaign.id)));while(!generate.mock.calls.length)await new Promise((resolve)=>setTimeout(resolve,5));
    const db=database();db.prepare("UPDATE campaign_generation_jobs_v52 SET updated_at='2000-01-01T00:00:00.000Z' WHERE campaign_id=?").run(campaign.id);
    const reopened=createRepository(),replacement=vi.fn().mockResolvedValue(content),restarted=buildApp({campaignRepositoryFactory:()=>reopened,campaignContentGeneration:replacement});
    const recovery=await restarted.inject(post(input(campaign.id),"/api/rpg/v1/campaign-content-drafts/reconcile"));expect(recovery.statusCode,recovery.body).toBe(200);expect(recovery.json()).toMatchObject({state:"outcome-uncertain",attempt:1,draftId:null});
    expect((await restarted.inject(post(input(campaign.id)))).statusCode).toBe(409);expect(replacement).not.toHaveBeenCalled();
    const retry=await restarted.inject(post({...input(campaign.id),retryFailedAttempt:{failedAttempt:1}}));expect(retry.statusCode,retry.body).toBe(201);expect(replacement).toHaveBeenCalledTimes(1);
    release(content);expect((await pending).statusCode).toBe(409);
    expect(db.prepare("SELECT count(*) count FROM generation_drafts WHERE campaign_id=?").get(campaign.id)).toEqual({count:1});
    expect(db.prepare("SELECT attempt,outcome_code FROM campaign_generation_attempts_v52 ORDER BY attempt").all()).toEqual([{attempt:1,outcome_code:"outcome-uncertain"},{attempt:2,outcome_code:"ok"}]);
    const exact=await restarted.inject(post(input(campaign.id)));expect(exact.json()).toEqual(retry.json());expect(replacement).toHaveBeenCalledTimes(1);
    db.close();await app.close();await restarted.close();
  });

  it("reconciles missing work and reviewed content without any provider dispatch",async()=>{
    enable();const repo=createRepository(),campaign=repo.createCampaign("local-owner",{name:"Reviewed recovery"}),generate=vi.fn().mockRejectedValue(new Error("must not dispatch")),app=buildApp({campaignRepositoryFactory:()=>repo,campaignContentGeneration:generate});
    const payload={...input(campaign.id),reviewedContent:content};
    expect((await app.inject(post(payload,"/api/rpg/v1/campaign-content-drafts/reconcile"))).json()).toMatchObject({state:"not-found",attempt:0,draftId:null});
    const created=await app.inject(post(payload));expect(created.statusCode,created.body).toBe(201);
    expect((await app.inject(post(payload,"/api/rpg/v1/campaign-content-drafts/reconcile"))).json()).toMatchObject({state:"succeeded",attempt:1,draftId:created.json().draft.draftId});
    expect((await app.inject(post(payload))).json()).toEqual(created.json());expect(generate).not.toHaveBeenCalled();await app.close();
  });
});
