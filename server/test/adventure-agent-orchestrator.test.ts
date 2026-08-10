import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { POST_V38_AGENT_TOOL_REGISTRY_VERSION, adventureTurnStreamEventSchema } from "@velvet/contracts";
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
import type { AddressInfo } from "node:net";
import { completeWithProvider } from "../src/provider/index.js";
import { deriveConfirmationPolicy } from "../src/agent/confirmationPolicy.js";

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
    expect(response.body).not.toMatch(/private-call|1d20|promptTokens|providerCalls|argumentsJson|executionBinding|local-owner/);
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
