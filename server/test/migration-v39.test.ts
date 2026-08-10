import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS } from "../src/repo/db/migrations/v39_agent_response_provenance.js";
import { CONFIRMATION_POLICY_V40_MANAGED_OBJECTS } from "../src/repo/db/migrations/v40_confirmation_policy.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const dbPath=()=>path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite");
const at="2035-01-01T00:00:00.000Z";
function dropFutureV40(db:DatabaseDriver.Database){for(const [type,name] of [...CONFIRMATION_POLICY_V40_MANAGED_OBJECTS].reverse()){
  if(type==="trigger")db.exec(`DROP TRIGGER IF EXISTS "${name}"`);else db.exec(`DROP TABLE IF EXISTS "${name}"`);
}}
function populatedV38(){const first=createRepository();const campaign=first.createCampaign("local-owner",{name:"Migration campaign"});first.close();
  const db=new DatabaseDriver(dbPath());db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Rules','[]')").run();db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','profile','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','hero','Hero','Background','[]')").run();db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign.id);db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id,at,at);db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','hero',?,?)").run(campaign.id,at,at);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id,at,at);db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id,at);db.close();
  const repo=createRepository();const turn=repo.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"migrate",expectedCampaignRevision:0,idempotencyKey:"migration-turn"});
  const state=repo.getDurableAgentPlanningState("local-owner",turn.turnId)!;repo.startAgentProviderCall("local-owner",{turnId:turn.turnId,providerCallId:"provider",provider:"fake",model:"fake",attempt:1,expectedCampaignRevision:0,expectedTurnRevision:0,expectedExecutionRevision:state.executionRevision,idempotencyKey:"start"});repo.close();return{turnId:turn.turnId,campaignId:campaign.id,timelineId:campaign.activeTimelineId};}

describe("schema v39 agent response provenance",()=>{
  it("migrates an exact v38 database and seals the additive inventory",()=>{
    createRepository().close();const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys=OFF");dropFutureV40(db);
    for(const [type,name] of [...AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS].reverse()){
      if(type==="trigger")db.exec(`DROP TRIGGER "${name}"`);else if(type==="table")db.exec(`DROP TABLE "${name}"`);
    }
    db.prepare("UPDATE meta SET value='38' WHERE key='schemaVersion'").run();db.close();
    const migrated=createRepository();migrated.close();const verify=new DatabaseDriver(dbPath(),{readonly:true});
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({value:"40"});
    expect(verify.prepare("SELECT count(*) count FROM agent_response_provenance_attestation_v39").get()).toEqual({count:1});verify.close();
  });
  it("rejects a modified attestation on startup",()=>{
    createRepository().close();const db=new DatabaseDriver(dbPath());db.exec("DROP TRIGGER agent_response_provenance_attestation_v39_update_v39");
    db.prepare("UPDATE agent_response_provenance_attestation_v39 SET layout_digest=?").run("0".repeat(64));db.close();
    expect(()=>createRepository()).toThrow(/schema v39 inventory incompatible|v39 attestation mismatch/);
  });
  it("preserves populated v38 provider starts and validates populated digest provenance",()=>{
    const fixture=populatedV38();const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys=OFF");dropFutureV40(db);
    for(const [type,name] of AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS)if(type==="trigger")db.exec(`DROP TRIGGER "${name}"`);
    for(const name of ["agent_response_provenance_attestation_v39","agent_generalized_receipts_v39","agent_combat_proposal_bindings_v39","agent_provider_responses_v39","agent_provider_dispatch_claims_v39","agent_provider_contexts_v39"])db.exec(`DROP TABLE "${name}"`);
    db.prepare("UPDATE meta SET value='38' WHERE key='schemaVersion'").run();db.close();const migrated=createRepository();
    expect(migrated.getDurableAgentPlanningState("local-owner",fixture.turnId)?.providerStarts).toBe(1);
    migrated.bindAgentProviderContext("local-owner",{turnId:fixture.turnId,providerCallId:"provider",round:1,expectedCampaignRevision:0,expectedTurnRevision:0,
      timelineId:fixture.timelineId,timelineRevision:0,context:{decisionIdentity:{timelineId:fixture.timelineId,timelineRevision:0,campaignRevision:0,authority:{role:"owner",control:"all"},audience:{kind:"player",actorId:"actor"},encounter:null,legalActions:[],attributeCandidates:[]},contextDigest:"0".repeat(64)},
      request:{messages:[],advertisedTools:["campaign_context.read","world_state.read","quest_state.read","actor_resources.read","actor_inventory.read","actor_powers.read","actor_dice.roll"]}});migrated.close();
    const damage=new DatabaseDriver(dbPath());const trigger=(damage.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='agent_provider_contexts_v39_update_v39'").get() as {sql:string}).sql;
    damage.exec("DROP TRIGGER agent_provider_contexts_v39_update_v39");damage.prepare("UPDATE agent_provider_contexts_v39 SET context_digest=?").run("0".repeat(64));damage.exec(trigger);damage.close();
    expect(()=>createRepository()).toThrow(/context digest mismatch/);
  });
  it("rejects a tampered v39 shell behind a rewound marker",()=>{
    createRepository().close();const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys=OFF");dropFutureV40(db);
    db.exec("DROP TRIGGER agent_response_provenance_attestation_v39_update_v39");
    db.prepare("UPDATE agent_response_provenance_attestation_v39 SET layout_digest=?").run("0".repeat(64));
    db.prepare("UPDATE meta SET value='38' WHERE key='schemaVersion'").run();db.close();
    expect(()=>createRepository()).toThrow(/malformed future v39 artifacts/);
  });
});
