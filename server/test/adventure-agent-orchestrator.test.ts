import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST_V38_AGENT_TOOL_REGISTRY_VERSION, adventureTurnStreamEventSchema,canonicalAgentJson,
  canonicalExactCandidateActionFrame,canonicalExactCandidateEnvelopeFrame,computeExactCandidateActionDigest,
  computeExactCandidateEnvelopeDigest,projectExactCandidateForProvider } from "@velvet/contracts";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { executeDeterministicEnemyFallback, orchestrateAdventureTurn,
  type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { ADVENTURE_TOOL_LIMITATIONS, selectAdventureTools } from "../src/agent/toolRegistry.js";
import type { CampaignAgentContextSnapshot } from "../src/context.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { createServer } from "node:http";
import {createHash} from "node:crypto";
import type { AddressInfo } from "node:net";
import { completeWithProvider } from "../src/provider/index.js";
import { deriveConfirmationPolicy } from "../src/agent/confirmationPolicy.js";
import {narrationFallback} from "../src/routes/rpg/v1/adventureTurns.js";
import { assertExactCandidateProviderBinding } from "../src/repo/candidateRepo/providerBindingIntegrity.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

function seed() {
  const first = createRepository();
  const campaign = first.createCampaign("local-owner", { name: "Agent campaign" });
  first.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','profile','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','hero',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_character_attributes VALUES (?,'sheet',0,'strength',10)").run(campaign.id);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('origin',?,NULL,'Old Gate','','public',?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('destination',?,NULL,'Silver Harbor','','public',?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('safe-road',?,'origin','destination','public','open','none',NULL,NULL,?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('gm-destination',?,NULL,'Secret Vault','','gm',?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('gm-destination-two',?,NULL,'Hidden Annex','','gm',?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('gm-road',?,'origin','gm-destination','gm','open','none',NULL,NULL,?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('public-to-gm',?,'origin','gm-destination-two','public','open','none',NULL,NULL,?)").run(campaign.id,at);
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'origin','session',0,?)").run(campaign.id,"actor",at);
  db.close();
  return campaign;
}

const completion = (toolCalls?: Array<{ id: string; name: string; arguments: string }>): ProviderCompletionResult => ({
  message: { role: "assistant", content: toolCalls ? null : "Private planning prose", ...(toolCalls ? { toolCalls } : {}) },
  usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
  model: { requestedModel: "fake", responseModel: "fake" },
});

function dependencies(results: ProviderCompletionResult[]): AdventureAgentDependencies {
  return { complete: async () => { const next = results.shift(); if (!next) throw new Error("unexpected provider call"); return next; },
    getProvider: async () => ({ ...defaultProviderSettings(), baseUrl: "http://127.0.0.1:1/v1", model: "fake" }),
    getHarness: async () => defaultHarnessSettings(), now: () => new Date() };
}

describe("server-selected adventure tool registry", () => {
  it.each([
    ["currency_transfer","currency-transfer","controller"],["purchase_item","purchase","controller"],
    ["item_remove","important-item-loss","controller"],["item_consume","important-item-consume","controller"],
    ["item_gift","important-item-gift","controller"],["resource_spend","ambiguous-limited-resource-use","controller"],
    ["rest_party","rest-timing","controller"],["companion_add","companion-change","gm"],
    ["combat_start","combat-start","gm"],["combat_action","combat-action-consequential","controller"],
    ["world_change","generated-world-change","gm"],["quest_change","generated-quest-change","gm"],
    ["story_change","generated-story-change","gm"],["set_actor_attribute","gm-override","gm"],
    ["roll_actor_dice","deterministic-roll","controller"],["unknown_mutation","ambiguous-consequential-change","controller"],
  ] as const)("derives closed server policy for %s",(toolName,category,authorizer)=>{
    const policy=deriveConfirmationPolicy({toolName,arguments:{},campaignRevision:0,turnRevision:0,timelineRevision:0,at});
    expect(policy).toMatchObject({category,requiredAuthorizer:authorizer,
      requiresConfirmation:category!=="deterministic-roll"});
  });
  const snapshot = (patch: Partial<CampaignAgentContextSnapshot> = {}): CampaignAgentContextSnapshot => ({
    campaignId: "campaign", timelineId: "timeline", timelineRevision: 0, campaignRevision: 0, sessionId: "session",
    audience: { kind: "player", actorId: "actor" }, authority: { role: "player", control: "controlled" }, speakerPersona: null,
    safetyControl: [], humanCanon: [], committedMechanics: [], visibleWorld: [], visibleCast: [], visibleQuests: [], legalActions: [],
    privateTargetFacts: [],attributeCandidates:[{candidateId:"attribute:opaque",commandAttributeId:"strength",digest:"a".repeat(64),currentValue:1}], synthesizedSummaryFacts: [], recap: [], encounter: null, ...patch,
  });

  it("selects actor reads and limited mutations only with control outside combat", () => {
    const names = selectAdventureTools(snapshot()).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["actor_resources.read", "actor_inventory.read", "actor_powers.read",
      "actor_attribute.set", "actor_dice.roll"]));
    expect(names).not.toContain("actor_resource.initialize");
    expect(ADVENTURE_TOOL_LIMITATIONS.join(" ")).toMatch(/Deletion.*SQL.*network/i);
  });

  it("removes generic mutations in combat and all actor tools for enemies", () => {
    const encounter = { encounterId: "combat", phase: "active" as const, revision: 2, currentCombatantId: "enemy",
      currentCombatantKind: "enemy" as const, currentActorId: null,legalActionCandidates:[] };
    const combatNames = selectAdventureTools(snapshot({ encounter })).map((tool) => tool.name);
    expect(combatNames).toContain("combat_state.read");
    expect(combatNames).not.toContain("actor_dice.roll");
    const enemyNames = selectAdventureTools(snapshot({ encounter, audience: { kind: "enemy", combatantId: "enemy" },
      authority: { role: "gm", control: "all" } })).map((tool) => tool.name);
    expect(enemyNames).not.toContain("actor_inventory.read");
  });
  it.each([
    ["player-current",{kind:"player",actorId:"actor"},{role:"player",control:"controlled"},"actor",true,"required"],
    ["player-not-current",{kind:"player",actorId:"actor"},{role:"player",control:"controlled"},"other",false,null],
    ["observer",{kind:"player",actorId:"actor"},{role:"observer",control:"none"},"actor",false,null],
    ["enemy-current",{kind:"enemy",combatantId:"enemy"},{role:"gm",control:"all"},null,true,"never"],
    ["dm",{kind:"dm"},{role:"gm",control:"all"},null,false,null],
  ] as const)("selects legal combat action for %s by exact audience",(_name,audience,authority,currentActor,expected,confirmation)=>{
    const encounter={encounterId:"combat",phase:"active" as const,revision:2,currentCombatantId:audience.kind==="enemy"?"enemy":"current",
      currentCombatantKind:(audience.kind==="enemy"?"enemy":"actor") as "enemy"|"actor",currentActorId:currentActor,
       legalActionCandidates:[{legalActionId:"end-turn",commandLegalActionId:"end-turn",digest:"a".repeat(64),kind:"end-turn" as const,targetId:null}]};
    const tool=selectAdventureTools(snapshot({audience:audience as any,authority:authority as any,encounter})).find((item)=>item.name==="combat_action.execute");
    expect(Boolean(tool)).toBe(expected);if(confirmation)expect(tool?.confirmation).toBe(confirmation);
  });

  it("uses the first exact authoritative enemy action as deterministic fallback", () => {
    const encounter = { encounterId: "combat", phase: "active" as const, revision: 2, currentCombatantId: "enemy",
      currentCombatantKind: "enemy" as const, currentActorId: null,legalActionCandidates:[] };
    const enemy = snapshot({ encounter, audience: { kind: "enemy", combatantId: "enemy" }, authority: { role: "gm", control: "all" } });
    let command: unknown;
    const repository = { getCombatState: () => ({ campaignId: "campaign", encounterId: "combat", combatId: "combat", round: 1,
      currentCombatant: "enemy", combatants: [], revision: 2, legalActions: [
        { legalActionId: "attack:basic", kind: "attack", targetIds: ["hero"] },
        { legalActionId: "end-turn", kind: "end-turn", targetIds: [] },
      ] }), resolveCombatAction: (_principal: string, _combat: string, input: unknown) => { command = input; return {}; },
      getCombatCommandResult:()=>null,linkAgentCombatReceipt:()=>undefined };
    executeDeterministicEnemyFallback(repository as never, enemy, "turn");
    expect(command).toMatchObject({ legalActionId: "attack:basic", targetIds: ["hero"], expectedRevision: 2,
      idempotencyKey: expect.stringMatching(/^agent-enemy-fallback:/) });
  });
  it("persists an explicit failed turn when enemy fallback has no legal candidate",()=>{
    const encounter={encounterId:"combat",phase:"active" as const,revision:2,currentCombatantId:"enemy",currentCombatantKind:"enemy" as const,currentActorId:null,legalActionCandidates:[]};
    const enemy=snapshot({encounter,audience:{kind:"enemy",combatantId:"enemy"},authority:{role:"gm",control:"all"}});let terminal:unknown;
    const repository={getCombatState:()=>({campaignId:"campaign",combatId:"combat",currentCombatant:"enemy",legalActions:[],revision:2}),
      getCombatCommandResult:()=>null,getAdventureTurn:()=>({declaration:"act",state:"declared",revision:0,campaignRevision:0}),updateAdventureTurnNarration:(_p:string,input:unknown)=>{terminal=input;return{};}};
    executeDeterministicEnemyFallback(repository as never,enemy,"turn");expect(terminal).toMatchObject({terminalState:"failed",narrationStatus:"failed"});
  });
  it("recovers a fallback command committed before its link even after turn advance",()=>{
    const encounter={encounterId:"combat",phase:"active" as const,revision:2,currentCombatantId:"enemy",currentCombatantKind:"enemy" as const,currentActorId:null,legalActionCandidates:[]};
    const enemy=snapshot({encounter,audience:{kind:"enemy",combatantId:"enemy"},authority:{role:"gm",control:"all"}});let linked=false;
    const repository={getCombatState:()=>({campaignId:"campaign",combatId:"combat",currentCombatant:"hero",legalActions:[],revision:3}),
      getCombatCommandResult:()=>({operation:"action"}),
      linkAgentCombatReceipt:()=>{linked=true;}};
    executeDeterministicEnemyFallback(repository as never,enemy,"turn");expect(linked).toBe(true);
  });
  it("retries a fresh deterministic end-turn candidate after an uncommitted attack failure",()=>{
    const encounter={encounterId:"combat",phase:"active" as const,revision:2,currentCombatantId:"enemy",currentCombatantKind:"enemy" as const,currentActorId:null,legalActionCandidates:[]};
    const enemy=snapshot({encounter,audience:{kind:"enemy",combatantId:"enemy"},authority:{role:"gm",control:"all"}});const attempted:string[]=[];
    const repository={getCombatState:()=>({campaignId:"campaign",combatId:"combat",currentCombatant:"enemy",revision:2,legalActions:[{legalActionId:"attack",kind:"attack",targetIds:["hero"]},{legalActionId:"end-turn",kind:"end-turn",targetIds:[]}]}),
      getCombatCommandResult:()=>null,resolveCombatAction:(_p:string,_e:string,input:any)=>{attempted.push(input.legalActionId);if(input.legalActionId==="attack")throw new Error("rejected");return{};},linkAgentCombatReceipt:()=>undefined};
    executeDeterministicEnemyFallback(repository as never,enemy,"turn");expect(attempted).toEqual(["attack","end-turn"]);
  });
});

describe("bounded adventure orchestrator", () => {
  it("resolves inherited exact travel narration receipts for retry and swipe turns",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});const turn=repository.createAdventureTurn("local-owner",{
      campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel onward",
      expectedCampaignRevision:0,idempotencyKey:"inherited-travel"});const deps=dependencies([]);deps.now=()=>new Date(at);
    deps.complete=async(input)=>{const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
      return completion([{id:"inherited-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({
        candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
    let root=(await orchestrateAdventureTurn(repository,turn.turnId,deps)).turn;const commandId=root.receiptLinks[0]!.commandId;
    root=repository.updateAdventureTurnNarration("local-owner",{turnId:root.turnId,expectedTurnRevision:root.revision,expectedCampaignRevision:0,
      idempotencyKey:"inherited-root-narrating",narrationStatus:"in-progress"});
    root=repository.updateAdventureTurnNarration("local-owner",{turnId:root.turnId,expectedTurnRevision:root.revision,expectedCampaignRevision:0,
      idempotencyKey:"inherited-root-done",narrationStatus:"completed",terminalState:"completed",fallbackNarration:"Arrived."});
    const retry=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:root.declaration,mode:"narration-retry",priorTurnId:root.turnId,expectedCampaignRevision:0,idempotencyKey:"inherited-retry"});
    const swipe=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:root.declaration,mode:"narration-swipe",priorTurnId:root.turnId,expectedCampaignRevision:0,idempotencyKey:"inherited-swipe"});
    for(const derivative of [retry,swipe])expect(repository.getExactCandidateTravelNarrationReceipt("local-owner",derivative.turnId,commandId))
      .toEqual({destination:"Silver Harbor"});
    const hidden=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));hidden.prepare(
      "UPDATE campaign_location_connections_v28 SET visibility='gm' WHERE campaign_id=? AND connection_id='safe-road'").run(campaign.id);hidden.close();
    for(const derivative of [retry,swipe])expect(repository.getExactCandidateTravelNarrationReceipt("local-owner",derivative.turnId,commandId)).toBeNull();
    const text=narrationFallback(root.declaration,[{kind:"travel",destination:"Silver Harbor"}]);
    expect(text).toContain("Silver Harbor");expect(text).not.toMatch(/safe-road|gm-road|Secret Vault/);repository.close();
  });
  it("binds one exact provider travel selection and recovers without duplicate mechanics",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,
      timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel onward",expectedCampaignRevision:0,idempotencyKey:"exact-travel"});
    let calls=0;const deps=dependencies([]);deps.now=()=>new Date(at);deps.complete=async(input)=>{calls+=1;const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
      expect(tool.parameters.additionalProperties).toBe(false);expect(tool.parameters.properties.candidateId.enum).toHaveLength(1);
      return completion([{id:"travel-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
    const result=await orchestrateAdventureTurn(repository,turn.turnId,deps);expect(result.outcome).toBe("mechanics-committed");
    expect(result.turn.receiptLinks).toHaveLength(1);const recovered=await orchestrateAdventureTurn(repository,turn.turnId,deps);
    expect(recovered.outcome).toBe("completed");expect(calls).toBe(1);
    const state=repository.getCampaignWorld("local-owner",campaign.id)!;expect(state.currentLocations).toContainEqual(expect.objectContaining({actorId:"actor",locationId:"destination"}));
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(db.prepare("SELECT provider_tool_call_id,round_number,tool_name FROM exact_candidate_provider_bindings_v48").get())
      .toEqual({provider_tool_call_id:"travel-choice",round_number:1,tool_name:"exact_actor_travel.select"});
    expect(JSON.parse((db.prepare("SELECT request_json FROM agent_provider_contexts_v39").get() as {request_json:string}).request_json))
      .toMatchObject({exactCandidateProjection:{version:"v1",candidates:[{kind:"actor.travel"}]},advertisedToolSchemas:expect.arrayContaining([
        expect.objectContaining({name:"exact_actor_travel.select",parameters:expect.objectContaining({additionalProperties:false})})])});
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28 WHERE command_type='travel'").get()).toEqual({count:1});db.close();repository.close();
    const reopened=createRepository({clock:{now:()=>new Date(at)}});expect(reopened.getDurableAgentPlanningState("local-owner",turn.turnId))
      .toMatchObject({decisionRounds:1,totalToolCalls:1,mutationCalls:1,executionRevision:2});
    expect(reopened.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,result.turn.receiptLinks[0]!.commandId))
      .toEqual({destination:"Silver Harbor",revisionBefore:0,revisionAfter:1,occurredAt:at});
    const memberships=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    memberships.prepare("INSERT INTO principals VALUES('receipt-member','Member',0),('receipt-observer','Observer',0),('receipt-outsider','Outsider',0)").run();
    memberships.prepare("INSERT INTO campaign_memberships VALUES(?,'receipt-member','player',?),(?,'receipt-observer','observer',?)")
      .run(campaign.id,at,campaign.id,at);memberships.close();
    for(const principal of ["receipt-member","receipt-observer"])
      expect(reopened.getExactCandidateTravelPublicReceipt(principal,campaign.id,result.turn.receiptLinks[0]!.commandId))
        .toEqual({destination:"Silver Harbor",revisionBefore:0,revisionAfter:1,occurredAt:at});
    expect(reopened.getExactCandidateTravelPublicReceipt("receipt-outsider",campaign.id,result.turn.receiptLinks[0]!.commandId)).toBeNull();
    expect(reopened.getExactCandidateTravelPublicReceipt("local-owner","wrong-campaign",result.turn.receiptLinks[0]!.commandId)).toBeNull();
    expect(reopened.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,"wrong-command")).toBeNull();
    expect(reopened.getExactCandidateTravelNarrationReceipt("local-owner",turn.turnId,result.turn.receiptLinks[0]!.commandId))
      .toEqual({destination:"Silver Harbor"});
    expect((await orchestrateAdventureTurn(reopened,turn.turnId,deps)).outcome).toBe("completed");reopened.close();
    const staged=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    staged.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_delete_v48");
    staged.prepare("DELETE FROM exact_candidate_provider_bindings_v48").run();
    staged.prepare("UPDATE sessions SET state='stopped',stopped_at='2035-01-01T00:00:02.000Z' WHERE id='session'").run();
    staged.exec("CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_delete_v48 BEFORE DELETE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END");staged.close();
    const late=createRepository({clock:{now:()=>new Date("2035-01-02T00:00:00.000Z")}});
    expect((await orchestrateAdventureTurn(late,turn.turnId,deps)).outcome).toBe("mechanics-committed");
    expect(late.getAdventureTurn("local-owner",turn.turnId)).toMatchObject({receiptLinks:[{commandId:result.turn.receiptLinks[0]!.commandId}]});late.close();
    const once=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(once.prepare("SELECT (SELECT count(*) FROM exact_candidate_provider_bindings_v48) bindings,(SELECT count(*) FROM world_commands_v28 WHERE command_type='travel') commands").get())
      .toEqual({bindings:1,commands:1});once.close();
    const narration=narrationFallback("Travel onward",[{kind:"travel",destination:"Silver Harbor"}]);
    expect(narration).toContain("Silver Harbor");expect(narration).not.toContain("safe-road");expect(narration).not.toContain("Secret Vault");
    const categories=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    categories.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48");
    const original=categories.prepare("SELECT * FROM exact_candidate_provider_bindings_v48").get() as any;
    for(const [column,value] of [["selection_json",'{"candidateId":"wrong","choices":[],"kind":"actor.travel","version":"v1"}'],
      ["selection_digest","1".repeat(64)],["provider_call_id","wrong-call"],["provider_tool_call_id","wrong-tool-call"],
      ["round_number",2],["execution_id","wrong-execution"],["world_command_id","wrong-command"],
      ["linked_at","2035-01-01T00:00:03.000Z"]] as const){
      categories.pragma("foreign_keys=OFF");categories.prepare(`UPDATE exact_candidate_provider_bindings_v48 SET ${column}=?`).run(value);
      expect(() => assertExactCandidateProviderBinding(categories, original.binding_id), column).toThrow();
      categories.prepare(`UPDATE exact_candidate_provider_bindings_v48 SET ${column}=?`).run(original[column]);categories.pragma("foreign_keys=ON");
    }
    categories.exec("CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END");categories.close();
    const corrupt=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    corrupt.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48");
    corrupt.prepare("UPDATE exact_candidate_provider_bindings_v48 SET provider_projection_digest=?").run("0".repeat(64));
    corrupt.exec("CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END");corrupt.close();
    const corrupted = createRepository();
    expect(() => corrupted.getExactCandidateTravelPublicReceipt("local-owner", campaign.id, result.turn.receiptLinks[0]!.commandId))
      .toThrow("exact-candidate provider binding is malformed");
    corrupted.close();
    const mismatch=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));mismatch.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48");
    const changed='{"candidates":[],"version":"v1"}';mismatch.prepare("UPDATE exact_candidate_provider_bindings_v48 SET provider_projection_json=?,provider_projection_digest=?")
      .run(changed,createHash("sha256").update(changed).digest("hex"));
    mismatch.exec("CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END");mismatch.close();
    const mismatched = createRepository();
    expect(() => mismatched.getExactCandidateTravelPublicReceipt("local-owner", campaign.id, result.turn.receiptLinks[0]!.commandId))
      .toThrow("exact-candidate provider binding is malformed");
    mismatched.close();
  });
  it("scopes receipt integrity verification to the selected v48 binding",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});
    const execute=async(idempotencyKey:string,choiceId:string)=>{const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,
      timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel",expectedCampaignRevision:0,idempotencyKey});
      const deps=dependencies([]);deps.now=()=>new Date(at);deps.complete=async(input)=>{const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
        return completion([{id:choiceId,name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
      return {turnId:turn.turnId,commandId:(await orchestrateAdventureTurn(repository,turn.turnId,deps)).turn.receiptLinks[0]!.commandId};};
    const first=await execute("scoped-first","scoped-choice-first");
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('return-road',?,'destination','origin','public','open','none',NULL,NULL,?)").run(campaign.id,at);db.close();
    const second=await execute("scoped-second","scoped-choice-second");
    const corrupt=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));corrupt.exec("DROP TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48");
    corrupt.prepare("UPDATE exact_candidate_provider_bindings_v48 SET provider_projection_digest=? WHERE world_command_id=?").run("0".repeat(64),second.commandId);corrupt.close();
    expect(repository.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,first.commandId)).toEqual({destination:"Silver Harbor",revisionBefore:0,revisionAfter:1,occurredAt:at});
    expect(repository.getExactCandidateTravelNarrationReceipt("local-owner",first.turnId,first.commandId)).toEqual({destination:"Silver Harbor"});
    expect(()=>repository.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,second.commandId)).toThrow(/exact-candidate provider binding/);
    expect(()=>repository.getExactCandidateTravelNarrationReceipt("local-owner",second.turnId,second.commandId)).toThrow(/exact-candidate provider binding/);
    const inspect=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true}),bindingStatement=inspect.prepare(
      "SELECT provider_call_id,provider_tool_call_id,round_number,selection_json FROM exact_candidate_provider_bindings_v48 WHERE world_command_id=?");
    const firstBinding=bindingStatement.get(first.commandId) as any,secondBinding=bindingStatement.get(second.commandId) as any;inspect.close();
    expect(()=>repository.bindExactCandidateProviderExecution("local-owner",{turnId:second.turnId,providerCallId:secondBinding.provider_call_id,
      providerToolCallId:secondBinding.provider_tool_call_id,round:secondBinding.round_number,selection:JSON.parse(secondBinding.selection_json)})).toThrow(/exact-candidate provider binding/);
    expect(repository.bindExactCandidateProviderExecution("local-owner",{turnId:first.turnId,providerCallId:firstBinding.provider_call_id,
      providerToolCallId:firstBinding.provider_tool_call_id,round:firstBinding.round_number,selection:JSON.parse(firstBinding.selection_json)}).actorTravelResult.receipt.commandId).toBe(first.commandId);
    repository.close();
  });
  it("limits discovered travel receipts to the still-authorized source-turn principal",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});const turn=repository.createAdventureTurn("local-owner",{
      campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel onward",
      expectedCampaignRevision:0,idempotencyKey:"discovered-receipt"});const deps=dependencies([]);deps.now=()=>new Date(at);
    deps.complete=async(input)=>{const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
      return completion([{id:"discovered-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
    const commandId=(await orchestrateAdventureTurn(repository,turn.turnId,deps)).turn.receiptLinks[0]!.commandId;
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO principals VALUES('other-player','Other player',0),('other-observer','Other observer',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?,'other-player','player',?),(?,'other-observer','observer',?)").run(campaign.id,at,campaign.id,at);
    db.prepare("UPDATE campaign_location_connections_v28 SET visibility='discovered' WHERE campaign_id=? AND connection_id='safe-road'").run(campaign.id);
    db.prepare("UPDATE campaign_locations_v28 SET visibility='discovered' WHERE campaign_id=? AND location_id='destination'").run(campaign.id);
    db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(campaign.id,"actor","destination",at);db.close();
    expect(repository.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,commandId)).toEqual({destination:"Silver Harbor",revisionBefore:0,revisionAfter:1,occurredAt:at});
    for(const principal of ["other-player","other-observer"])
      expect(repository.getExactCandidateTravelPublicReceipt(principal,campaign.id,commandId)).toBeNull();
    const lost=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));lost.pragma("foreign_keys=OFF");
    lost.prepare("UPDATE campaign_memberships SET role='observer' WHERE campaign_id=? AND principal_id='local-owner'").run(campaign.id);
    lost.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player' WHERE campaign_id=? AND actor_id='actor'").run(campaign.id);lost.close();
    expect(repository.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,commandId)).toBeNull();
    const hidden=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));hidden.prepare(
      "UPDATE campaign_location_connections_v28 SET visibility='gm' WHERE campaign_id=? AND connection_id='safe-road'").run(campaign.id);hidden.close();
    expect(repository.getExactCandidateTravelPublicReceipt("other-player",campaign.id,commandId)).toBeNull();repository.close();
  });
  it("masks discovered narration after root authority loss and for an unrelated derivative principal",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});const root=repository.createAdventureTurn("local-owner",{
      campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel onward",expectedCampaignRevision:0,idempotencyKey:"narration-discovered"});
    const deps=dependencies([]);deps.now=()=>new Date(at);deps.complete=async(input)=>{const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
      return completion([{id:"narration-discovered-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
    let committed=(await orchestrateAdventureTurn(repository,root.turnId,deps)).turn;const commandId=committed.receiptLinks[0]!.commandId;
    committed=repository.updateAdventureTurnNarration("local-owner",{turnId:committed.turnId,expectedTurnRevision:committed.revision,expectedCampaignRevision:0,idempotencyKey:"narration-discovered-progress",narrationStatus:"in-progress"});
    committed=repository.updateAdventureTurnNarration("local-owner",{turnId:committed.turnId,expectedTurnRevision:committed.revision,expectedCampaignRevision:0,idempotencyKey:"narration-discovered-done",narrationStatus:"completed",terminalState:"completed",fallbackNarration:"Done"});
    const retry=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:committed.declaration,mode:"narration-retry",priorTurnId:committed.turnId,expectedCampaignRevision:0,idempotencyKey:"narration-discovered-retry"});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.prepare("INSERT INTO principals VALUES('derivative-other','Other',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?,'derivative-other','player',?)").run(campaign.id,at);
    db.prepare("UPDATE campaign_location_connections_v28 SET visibility='discovered' WHERE campaign_id=? AND connection_id='safe-road'").run(campaign.id);
    db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(campaign.id,"actor","destination",at);db.close();
    expect(repository.getExactCandidateTravelNarrationReceipt("local-owner",retry.turnId,commandId)).toEqual({destination:"Silver Harbor"});
    expect(repository.getExactCandidateTravelNarrationReceipt("derivative-other",retry.turnId,commandId)).toBeNull();
    const lost=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));lost.pragma("foreign_keys=OFF");lost.prepare(
      "UPDATE campaign_memberships SET role='observer' WHERE campaign_id=? AND principal_id='local-owner'").run(campaign.id);lost.prepare(
      "UPDATE campaign_actor_private_state SET controller_principal_id='derivative-other' WHERE campaign_id=? AND actor_id='actor'").run(campaign.id);lost.close();
    expect(repository.getExactCandidateTravelNarrationReceipt("local-owner",retry.turnId,commandId)).toBeNull();repository.close();
  });
  it("rejects coordinated candidate batch and provider projection tampering",async()=>{
    const campaign=seed(),repository=createRepository({clock:{now:()=>new Date(at)}});const turn=repository.createAdventureTurn("local-owner",{
      campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Travel onward",
      expectedCampaignRevision:0,idempotencyKey:"coordinated-tamper"});const deps=dependencies([]);deps.now=()=>new Date(at);
    deps.complete=async(input)=>{const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
      return completion([{id:"tamper-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]);};
    const committed=await orchestrateAdventureTurn(repository,turn.turnId,deps),commandId=committed.turn.receiptLinks[0]!.commandId;
    repository.close();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const triggerNames=["exact_candidates_v46_immutable_update_v46","exact_candidate_batches_v46_immutable_update_v46",
      "exact_candidate_provider_bindings_v48_immutable_update_v48","agent_provider_contexts_v39_update_v39"];
    const triggerSql=triggerNames.map((name)=>(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql:string}).sql);
    for(const name of triggerNames)db.exec(`DROP TRIGGER ${name}`);
    const row=db.prepare("SELECT * FROM exact_candidates_v46 ORDER BY position LIMIT 1").get() as any,candidate=JSON.parse(row.envelope_json);
    candidate.label.routeOption=32;const crypto={sha256:(value:string)=>createHash("sha256").update(value).digest("hex")};
    candidate.canonicalActionDigest=computeExactCandidateActionDigest(candidate,crypto);candidate.canonicalEnvelopeDigest=computeExactCandidateEnvelopeDigest(candidate,crypto);
    db.prepare(`UPDATE exact_candidates_v46 SET action_frame=?,action_digest=?,envelope_frame=?,envelope_digest=?,envelope_json=? WHERE candidate_id=?`)
      .run(canonicalExactCandidateActionFrame(candidate),candidate.canonicalActionDigest,canonicalExactCandidateEnvelopeFrame(candidate),candidate.canonicalEnvelopeDigest,JSON.stringify(candidate),row.candidate_id);
    const candidates=(db.prepare("SELECT envelope_json FROM exact_candidates_v46 WHERE batch_id=? ORDER BY position").all(row.batch_id) as any[]).map((item)=>JSON.parse(item.envelope_json));
    const requestDigest=crypto.sha256(canonicalAgentJson({turnId:turn.turnId,worldRevision:0,candidates} as never));
    db.prepare("UPDATE exact_candidate_batches_v46 SET request_digest=? WHERE batch_id=?").run(requestDigest,row.batch_id);
    const projection={version:"v1",candidates:candidates.map((value)=>projectExactCandidateForProvider(value,value.issuedAt))};const projectionJson=canonicalAgentJson(projection as never);
    db.prepare("UPDATE exact_candidate_provider_bindings_v48 SET provider_projection_json=?,provider_projection_digest=?").run(projectionJson,crypto.sha256(projectionJson));
    const context=db.prepare("SELECT context_id,request_json FROM agent_provider_contexts_v39").get() as any,request=JSON.parse(context.request_json);
    request.exactCandidateProjection=projection;const tool=request.advertisedToolSchemas.find((item:any)=>item.name==="exact_actor_travel.select");
    tool.parameters.properties.candidateId.enum=projection.candidates.map((value:any)=>value.candidateId);const requestJson=canonicalAgentJson(request);
    db.prepare("UPDATE agent_provider_contexts_v39 SET request_json=?,request_digest=? WHERE context_id=?").run(requestJson,crypto.sha256(requestJson),context.context_id);
    for(const sql of triggerSql)db.exec(sql);db.close();
    const corrupted=createRepository();
    expect(()=>corrupted.getExactCandidateTravelPublicReceipt("local-owner",campaign.id,commandId)).toThrow(/candidate|provider (binding|projection)/);
    corrupted.close();
  });
  it("scopes identical provider call IDs across turns and campaigns",()=>{
    const first=seed();let repository=createRepository({clock:{now:()=>new Date(at)}});
    const second=repository.createCampaign("local-owner",{name:"Other provider campaign"});repository.close();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(second.id);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(second.id);
    db.prepare("INSERT INTO campaign_characters VALUES ('cc-2',?,'persona',?,?)").run(second.id,at,at);
    db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet-2',?,'cc-2','pack','1','race','human','pack','1','background','hero',?,?)").run(second.id,at,at);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?,'sheet-2',0,'strength',10)").run(second.id);
    db.prepare("INSERT INTO campaign_actors VALUES ('actor-2',?,'cc-2','sheet-2','player-character','principal',?,?)").run(second.id,at,at);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor-2',?,'local-owner',NULL)").run(second.id);
    db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session-2','persona','Other','active','default',?)").run(at);
    db.prepare("INSERT INTO session_characters VALUES('session-2','persona',0)").run();
    db.prepare("INSERT INTO campaign_sessions VALUES('session-2',?,?)").run(second.id,at);db.close();
    repository=createRepository({clock:{now:()=>new Date(at)}});
    const turns=[
      repository.createAdventureTurn("local-owner",{campaignId:first.id,timelineId:first.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"one",expectedCampaignRevision:0,idempotencyKey:"same-call-one"}),
      repository.createAdventureTurn("local-owner",{campaignId:first.id,timelineId:first.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"two",expectedCampaignRevision:0,idempotencyKey:"same-call-two"}),
      repository.createAdventureTurn("local-owner",{campaignId:second.id,timelineId:second.activeTimelineId,sessionId:"session-2",actorId:"actor-2",declaration:"three",expectedCampaignRevision:0,idempotencyKey:"same-call-three"}),
    ];
    for(const [index,turn] of turns.entries()){
      const audience={kind:"player" as const,actorId:index===2?"actor-2":"actor"};
      const snapshot=repository.getCampaignAgentContextSnapshot("local-owner",turn.campaignId,index===2?"session-2":"session",audience)!;
      const planning=repository.getDurableAgentPlanningState("local-owner",turn.turnId)!;
      repository.claimAgentProviderRound("local-owner",{turnId:turn.turnId,providerCallId:"shared-provider-call",provider:"fake",model:"fake",attempt:1,
        expectedCampaignRevision:0,expectedTurnRevision:0,expectedExecutionRevision:planning.executionRevision,idempotencyKey:`shared-${index}`,
        round:1,timelineId:turn.timelineId,timelineRevision:snapshot.timelineRevision,
        context:{decisionIdentity:{timelineId:snapshot.timelineId,timelineRevision:snapshot.timelineRevision,campaignRevision:0,turnRevision:0,roundNumber:1,
          authority:snapshot.authority,audience:snapshot.audience,encounter:snapshot.encounter,legalActions:snapshot.legalActions,attributeCandidates:snapshot.attributeCandidates},contextDigest:"0".repeat(64)} as any,
        request:{messages:[],advertisedTools:selectAdventureTools(snapshot).map((tool)=>tool.name),postV38ToolRegistryVersion:POST_V38_AGENT_TOOL_REGISTRY_VERSION}});
    }
    expect(turns.map((turn)=>repository.getAgentProviderRecovery("local-owner",turn.turnId)?.providerCallId))
      .toEqual(["shared-provider-call","shared-provider-call","shared-provider-call"]);
    repository.settleAgentProviderResponse("local-owner",{turnId:turns[1]!.turnId,providerCallId:"shared-provider-call",status:"failed",outcomeCode:"turn-two"});
    expect(repository.getAgentProviderRecovery("local-owner",turns[0]!.turnId)?.response).toBeNull();
    expect(repository.getAgentProviderRecovery("local-owner",turns[1]!.turnId)?.response?.status).toBe("failed");
    expect(repository.getAgentProviderRecovery("local-owner",turns[2]!.turnId)?.response).toBeNull();repository.close();
  });

  it("durably replans instead of executing a stale approved attribute command",async()=>{
    const campaign=seed(),repository=createRepository();const created=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,
      timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Become stronger",expectedCampaignRevision:0,idempotencyKey:"stale-approval"});
    let calls=0;const deps=dependencies([]);deps.complete=async(input)=>{calls+=1;const tool=input.tools?.find((item)=>item.name==="actor_attribute.set") as any;
      return completion([{id:`attribute-${calls}`,name:"actor_attribute.set",arguments:JSON.stringify({
        attributeCandidateId:tool.parameters.properties.attributeCandidateId.enum[0],
        attributeCandidateDigest:tool.parameters.properties.attributeCandidateDigest.enum[0],value:11})}]);};
    const pending=await orchestrateAdventureTurn(repository,created.turnId,deps);expect(pending.outcome).toBe("awaiting-confirmation");
    const proposal=pending.turn.toolCalls[0]!.proposal;const approved=repository.decideToolProposals("local-owner",{turnId:created.turnId,
      proposalIds:[proposal.proposalId],decision:"approved",expectedTurnRevision:pending.turn.revision,expectedCampaignRevision:0,idempotencyKey:"approve-stale"});
    repository.executeRollActorDice("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,actorId:"actor",sourceTurnId:null,
      commandId:"outside-command",idempotencyKey:"outside-roll",expectedRevision:0,command:{type:"roll_actor_dice",payload:{expression:"1d20"}}});
    const replanned=await orchestrateAdventureTurn(repository,approved.turnId,deps);
    expect(replanned.turn.turnId).toBe(created.turnId);expect(replanned.outcome).toBe("awaiting-confirmation");expect(calls).toBe(2);
    expect(repository.getCampaignAgentContextSnapshot("local-owner",campaign.id,"session",{kind:"player",actorId:"actor"})?.attributeCandidates)
      .toContainEqual(expect.objectContaining({commandAttributeId:"strength",currentValue:10}));repository.close();
  });
  it("persists read rounds, executes a deterministic dice command, and links its receipt", async () => {
    const campaign = seed(); const repository = createRepository();
    const created = repository.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I listen and test my luck", expectedCampaignRevision: 0, idempotencyKey: "agent-turn" });
    const result = await orchestrateAdventureTurn(repository, created.turnId, dependencies([
      completion([{ id: "read-1", name: "actor_resources.read", arguments: "{}" }]),
      completion([{ id: "roll-1", name: "actor_dice.roll", arguments: '{"expression":"1d20"}' }]),
    ]));
    expect(result.outcome).toBe("mechanics-committed");
    expect(result.turn.toolCalls).toHaveLength(1);
    expect(result.turn.toolCalls[0]).toMatchObject({ status: "committed", proposal: { toolName: "roll_actor_dice" } });
    expect(result.turn.receiptLinks).toHaveLength(1);
    const planning = repository.getDurableAgentPlanningState("local-owner", created.turnId)!;
    expect(planning.decisionRounds).toBe(2); expect(planning.providerStarts).toBe(2);
    expect(planning.toolCalls.find((call) => call.providerToolCallId === "read-1")?.status).toBe("read-succeeded");
    repository.close();
  });

  it("fails a heterogeneous provider batch atomically without persisting or executing calls", async () => {
    const campaign = seed(); const repository = createRepository();
    const created = repository.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I consider two things", expectedCampaignRevision: 0, idempotencyKey: "invalid-turn" });
    const result = await orchestrateAdventureTurn(repository, created.turnId, dependencies([completion([
      { id: "read", name: "campaign_context.read", arguments: "{}" },
      { id: "roll", name: "actor_dice.roll", arguments: '{"expression":"1d20"}' },
    ])]));
    expect(result.outcome).toBe("fallback");
    expect(repository.getDurableAgentPlanningState("local-owner", created.turnId)?.toolCalls).toEqual([]);
    expect(repository.getAdventureTurn("local-owner", created.turnId)).toMatchObject({ toolCalls: [], receiptLinks: [] });
    repository.close();
  });

  it("integrates a fake tool call with conditional redacted SSE events", async () => {
    const campaign = seed();
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true";
    let wire:Record<string,unknown>|null=null;const providerServer=createServer((request,response)=>{let body="";request.on("data",chunk=>body+=String(chunk));request.on("end",()=>{
       const parsed=JSON.parse(body);if(parsed.tools)wire=parsed;response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({model:"fake",choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"private-call",type:"function",function:{name:"actor_dice.roll",arguments:'{"expression":"1d20"}'}}]}}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}));});});
    await new Promise<void>((resolve)=>providerServer.listen(0,"127.0.0.1",resolve));const port=(providerServer.address() as AddressInfo).port;
    const realDependencies:AdventureAgentDependencies={complete:completeWithProvider,getProvider:async()=>({...defaultProviderSettings(),baseUrl:`http://127.0.0.1:${port}/v1`,model:"fake",requestTimeoutSeconds:2}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app = buildApp({ campaignRepositoryFactory: () => createRepository(), adventureAgentDependencies: realDependencies });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { campaignId: campaign.id, sessionId: "session", actorId: "actor",
        declaration: "I test the lock", expectedRevision: 0, idempotencyKey: "route-agent" } });
    expect(response.statusCode).toBe(200);
    const events = response.body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
      const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "))!;
      return adventureTurnStreamEventSchema.parse(JSON.parse(line.slice(6)));
    });
    expect(events.map((event) => event.type)).toEqual(["turn_started", "agent_status", "tool_proposed",
      "mechanics_committed", "agent_status", "narration_delta", "terminal"]);
    for(const event of events)expect(JSON.stringify(event)).not.toMatch(/private-call|promptTokens|providerCalls|argumentsJson|executionBinding|local-owner/);
    expect(events.some((event)=>JSON.stringify(event).includes('"expression":"1d20"'))).toBe(false);
    expect((wire as any).tools.find((tool:any)=>tool.function.name==="actor_dice.roll").function).toMatchObject({strict:true,parameters:{additionalProperties:false}});
    await app.close();await new Promise<void>((resolve)=>providerServer.close(()=>resolve()));
    const audit=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(audit.prepare(`SELECT context.timeline_revision,response.status,
      response.response_digest=round.response_digest response_matches,context.request_digest=round.provider_request_digest request_matches
      FROM agent_provider_contexts_v39 context JOIN agent_provider_responses_v39 response USING(context_id)
      JOIN agent_decision_rounds_v38 round ON round.provider_call_id=response.provider_call_id`).get()).toEqual({timeline_revision:0,status:"succeeded",response_matches:1,request_matches:1});audit.close();
  });

  it("recovers a nonterminal automatic turn through GET-issued resume token without replaying POST",async()=>{
    const campaign=seed();process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";
    const repository=createRepository();const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,
      sessionId:"session",actorId:"actor",declaration:"I wait",expectedCampaignRevision:0,idempotencyKey:"lost-initial"});repository.close();
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies([completion()])});
    const read=await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${turn.turnId}`});expect(read.json().resumeToken).toMatch(/^v1\./);
    const resumed=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{resumeToken:read.json().resumeToken}});
    expect(resumed.body).not.toContain("event: turn_started");expect(resumed.body).toContain('"outcome":"done"');await app.close();
  });
  it("claims provider dispatch exclusively across concurrent resumes",async()=>{
    const campaign=seed(),repository=createRepository();const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,
      sessionId:"session",actorId:"actor",declaration:"Concurrent",expectedCampaignRevision:0,idempotencyKey:"concurrent"});
    let calls=0,release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;});const deps=dependencies([]);deps.complete=async()=>{calls+=1;await gate;return completion();};
    const first=orchestrateAdventureTurn(repository,turn.turnId,deps);await new Promise((resolve)=>setTimeout(resolve,20));
    const second=await orchestrateAdventureTurn(repository,turn.turnId,deps);expect(second.outcome).toBe("in-progress");expect(calls).toBe(1);
    release();await first;expect(calls).toBe(1);repository.close();
  });
  it("replays provider settlement exactly and conflicts on changed accounting",()=>{
    const campaign=seed(),repository=createRepository();const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,
      timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",declaration:"Settle",expectedCampaignRevision:0,idempotencyKey:"settle"});
    const planning=repository.getDurableAgentPlanningState("local-owner",turn.turnId)!;
    expect(repository.claimAgentProviderRound("local-owner",{turnId:turn.turnId,providerCallId:"settlement",provider:"fake",model:"fake",attempt:1,
      round:1,timelineId:campaign.activeTimelineId,timelineRevision:0,context:{orphanedBeforeDispatch:true},request:{},
      expectedCampaignRevision:0,expectedTurnRevision:0,expectedExecutionRevision:planning.executionRevision,idempotencyKey:"settlement-start"}).claimed).toBe(true);
    const settlement={turnId:turn.turnId,providerCallId:"settlement",status:"failed" as const,outcomeCode:"network",promptTokens:3,completionTokens:1};
    repository.settleAgentProviderResponse("local-owner",settlement);repository.settleAgentProviderResponse("local-owner",settlement);
    expect(()=>repository.settleAgentProviderResponse("local-owner",{...settlement,promptTokens:4})).toThrow(/response changed/);
    repository.close();
  });
  it("settles a crashed claimed dispatch after its durable lease without rebilling",async()=>{
    const campaign=seed();let clock=new Date(at);const repository=createRepository({clock:{now:()=>clock}});const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,
      sessionId:"session",actorId:"actor",declaration:"Crash",expectedCampaignRevision:0,idempotencyKey:"crash-claim"});const planning=repository.getDurableAgentPlanningState("local-owner",turn.turnId)!;
    repository.startAgentProviderCall("local-owner",{turnId:turn.turnId,providerCallId:"claimed",provider:"fake",model:"fake",attempt:1,expectedCampaignRevision:0,expectedTurnRevision:0,expectedExecutionRevision:planning.executionRevision,idempotencyKey:"claimed-start"});
    repository.bindAgentProviderContext("local-owner",{turnId:turn.turnId,providerCallId:"claimed",round:1,expectedCampaignRevision:0,expectedTurnRevision:0,timelineId:campaign.activeTimelineId,timelineRevision:0,
      context:{orphanedBeforeDispatch:true},request:{}});expect(repository.claimAgentProviderDispatch("local-owner",turn.turnId,"claimed").claimed).toBe(true);clock=new Date(clock.getTime()+120_000);
    let calls=0;const deps=dependencies([]);deps.complete=async()=>{calls+=1;return completion();};await orchestrateAdventureTurn(repository,turn.turnId,deps);
    expect(calls).toBe(0);expect(repository.getAgentProviderRecovery("local-owner",turn.turnId)?.response?.status).toBe("failed");repository.close();
  });
  it("atomically orphans a late successful worker response",()=>{
    const campaign=seed();let clock=new Date(at);const repository=createRepository({clock:{now:()=>clock}});
    const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:"Late worker",expectedCampaignRevision:0,idempotencyKey:"late-worker"});const planning=repository.getDurableAgentPlanningState("local-owner",turn.turnId)!;
    repository.claimAgentProviderRound("local-owner",{turnId:turn.turnId,providerCallId:"late-success",provider:"fake",model:"fake",attempt:1,round:1,
      timelineId:campaign.activeTimelineId,timelineRevision:0,context:{orphanedBeforeDispatch:true},request:{},expectedCampaignRevision:0,
      expectedTurnRevision:0,expectedExecutionRevision:planning.executionRevision,idempotencyKey:"late-success-start"});clock=new Date(clock.getTime()+120_000);
    expect(repository.settleAgentProviderResponse("local-owner",{turnId:turn.turnId,providerCallId:"late-success",status:"succeeded",
      response:{result:"complete",calls:[]},outcomeCode:"ok"})).toEqual({status:"failed"});
    expect(repository.getAgentProviderRecovery("local-owner",turn.turnId)?.response).toMatchObject({status:"failed",response:null});repository.close();
  });
  it("recovers an unresolved claim even after the turn became terminal",async()=>{
    const campaign=seed();const repository=createRepository({clock:{now:()=>new Date(at)}});
    const turn=repository.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:"Terminal recovery",expectedCampaignRevision:0,idempotencyKey:"terminal-recovery"});const planning=repository.getDurableAgentPlanningState("local-owner",turn.turnId)!;
    repository.claimAgentProviderRound("local-owner",{turnId:turn.turnId,providerCallId:"terminal-claim",provider:"fake",model:"fake",attempt:1,round:1,
      timelineId:campaign.activeTimelineId,timelineRevision:0,context:{orphanedBeforeDispatch:true},request:{},expectedCampaignRevision:0,
      expectedTurnRevision:0,expectedExecutionRevision:planning.executionRevision,idempotencyKey:"terminal-claim-start"});
    repository.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:0,expectedCampaignRevision:0,
      idempotencyKey:"terminal-before-response",narrationStatus:"none",terminalState:"failed"});
    let calls=0;const deps=dependencies([]);deps.complete=async()=>{calls+=1;return completion();};
    await orchestrateAdventureTurn(repository,turn.turnId,deps);expect(calls).toBe(0);
    expect(repository.getAgentProviderRecovery("local-owner",turn.turnId)?.response?.status).toBe("failed");repository.close();
  });
  it("links a command committed before its combat proposal link before terminal-state return",async()=>{
    let linked=false;const base:any={declaration:"act",mode:"original",state:"mechanics-committed",turnId:"turn",campaignId:"campaign",toolCalls:[{status:"approved",proposal:{proposalId:"proposal",position:0,executionBinding:{commandType:"combat_action",encounterId:"combat",idempotencyKey:"key"}}}]};
    const repository={getAdventureTurn:()=>linked?{...base,toolCalls:[{...base.toolCalls[0],status:"committed"}]}:base,
      getCombatCommandResult:()=>({operation:"action"}),linkAgentCombatReceipt:()=>{linked=true;}};
    const result=await orchestrateAdventureTurn(repository as never,"turn",dependencies([]));expect(linked).toBe(true);expect(result.outcome).toBe("completed");
  });
});
