import { describe, expect, it } from "vitest";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, createRepository, createSession } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at="2035-01-01T00:00:00.000Z";

describe("M1.7 encounter repository",()=>{
  it("authorizes before replay and has exact retry, stale, and active-session behavior",async()=>{
    let n=0; const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date(at)},ids:{nextId:()=>`m17-${++n}`},rng:{integer:()=>10}});
    const campaign=repo.createCampaign("local-owner",{name:"Encounter fixture"});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const character=repo.createCharacter({name:"Session character",age:30,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const session=await createSession({characterId:character.id,title:"Combat"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const command:any={type:"create_encounter",campaignId:campaign.id,encounterId:"encounter",sessionId:session.id,kind:"improvised",enemySpawns:[],expectedRevision:0,idempotencyKey:"create",createdAt:at};
    const first=repo.executeEncounterCommand("local-owner",command);
    expect(repo.executeEncounterCommand("local-owner",command)).toEqual(first);
    expect(()=>repo.executeEncounterCommand("not-a-member",command)).toThrow(EncounterAuthorizationError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,expectedRevision:1})).toThrow(EncounterConflictError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,encounterId:"other",idempotencyKey:"stale",expectedRevision:1})).toThrow(EncounterStaleError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,encounterId:"other",idempotencyKey:"other"})).toThrow();
    repo.close();
  });
});
