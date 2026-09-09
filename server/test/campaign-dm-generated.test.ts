import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { useTmpDataDir } from "./helpers.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";

useTmpDataDir();
describe("accepted encounter director integration",()=>{
  it.each([true,false])("materializes only an exact accepted catalog roster (bound=%s)",async(bound)=>{
    const f=await dmFixture();f.advance();const {repo,campaign,session}=f;
    const content=generatedCampaignContentProviderSchema.parse({
      locations:[{key:"road",name:"Old Road",description:"Rain falls.",visibility:"public"}],
      encounters:[{key:"ambush",title:"SECRET_AMBUSH_PLAN",description:"SECRET_TACTICS",visibility:"gm",locationKey:"road",enemyReferences:bound?[f.enemy]:[]}],
    });
    const context=repo.getCampaignGenerationContext("local-owner",campaign.id,[])!;
    const draft=repo.createGenerationDraft("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,kind:"content-pack",
      stagedContent:{kind:"campaign-content",requestDigest:"a".repeat(64),baseContentRevision:context.revision,dependencyDigests:{},...content},
      validation:{valid:true,issues:[],validatedAt:f.options.clock.now().toISOString()},expectedCampaignRevision:repo.getCampaignAdministration("local-owner",campaign.id)!.revision,idempotencyKey:"prepared-content"});
    repo.recordCampaignGenerationCandidate(draft.draftId,content,[]);
    repo.applyCampaignContentGenerationDraftAtomically("local-owner",{draftId:draft.draftId,expectedDraftRevision:0,expectedCampaignRevision:draft.campaignRevision,
      idempotencyKey:"accept",selectedArtifactKeys:["road","ambush"]});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const location=(db.prepare("SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key='road'").get(campaign.id) as any).server_resource_id;
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id,f.actorId,location,session.id,f.options.clock.now().toISOString());
    repo.setDmControl("local-owner",campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"auto"});
    const request={intent:"open" as const,expectedModeRevision:1,idempotencyKey:"open"};const run=repo.openDmBeat("local-owner",campaign.id,session.id,request);
    await orchestrateCampaignDmBeat(repo,"local-owner",run.runId,dmDependencies());
    const result=repo.getDmRun("local-owner",campaign.id,session.id,run.runId);
    expect(JSON.stringify(result)).not.toContain("SECRET_");
    if(bound){
      expect(result.receipts[0]?.action,JSON.stringify(result)).toBe("encounter-materialize");
      expect(repo.listEncounters("local-owner",campaign.id)).toHaveLength(1);
      expect(repo.listEncounters("local-owner",campaign.id)![0]!.status).toBe("active");
      await orchestrateCampaignDmBeat(repo,"local-owner",repo.openDmBeat("local-owner",campaign.id,session.id,request).runId,dmDependencies(async()=>{throw new Error("no replay");}));
      expect(db.prepare("SELECT count(*) n FROM dm_encounter_bindings").get()).toEqual({n:1});
    } else {
      expect(result.receipts).toEqual([]);expect(result.blockers).toContain("encounter-preparation-requires-exact-catalog-roster");
      expect(repo.listEncounters("local-owner",campaign.id)).toEqual([]);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();repo.close();
  });
});
