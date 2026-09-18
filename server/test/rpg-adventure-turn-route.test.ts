import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema, canonicalAgentJson } from "@velvet/contracts";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionResult, ProviderCompletionUsage } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { createRepository } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { narrationFallback, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";
import { DND_5E_RULESET_DESCRIPTOR, VELVET_LEGACY_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const expires = "2099-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT; delete process.env.VELVET_SSE_HEARTBEAT_MS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };
const narrationResult = (narration: string, usage: ProviderCompletionUsage | null = null): ProviderCompletionResult => ({
  message: { role: "assistant", content: null, toolCalls: [{ id: "qwen-narration-call", name: "submit_adventure_narration",
    arguments: JSON.stringify({ narration }) }] }, usage, model: { requestedModel: "test", responseModel: "test" },
});

function seed(ruleset: "velvet"|"dnd" = "velvet") {
  const initial = createRepository();
  const campaign = initial.createCampaign("local-owner", { name: "HTTP turns" });
  initial.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  const rulesetId=ruleset==="dnd"?DND_5E_RULESET_DESCRIPTOR.id:VELVET_LEGACY_RULESET_DESCRIPTOR.id;
  const rulesetVersion=ruleset==="dnd"?DND_5E_RULESET_DESCRIPTOR.version:VELVET_LEGACY_RULESET_DESCRIPTOR.version;
  db.prepare("INSERT INTO rpg_rules_profile_bindings_v60 VALUES ('turn-profile',?,?)").run(rulesetId,rulesetVersion);
  db.prepare("INSERT INTO campaign_ruleset_bindings_v60(campaign_id,rules_profile_id,ruleset_id,ruleset_version,bound_at) VALUES(?,'turn-profile',?,?,?)")
    .run(campaign.id,rulesetId,rulesetVersion,at);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)").run(campaign.id, at, at);
   db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
   db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner',NULL)").run(campaign.id);
   db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.close();
  return campaign;
}

function events(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return adventureTurnStreamEventSchema.parse(JSON.parse(data));
  });
}

describe("M2.11 adventure turn routes", () => {
  it("scopes actor history before the limit in planning and public narration without changing room transcript defaults",async()=>{
    enable();const campaign=seed(),repo=createRepository();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO characters VALUES ('persona-b','Other Hero',30,'hero','',1,0,?)").run(at);
    db.prepare("INSERT INTO campaign_characters VALUES ('cc-b',?,'persona-b',?,?)").run(campaign.id,at,at);
    db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet-b',?,'cc-b','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)").run(campaign.id,at,at);
    db.prepare("INSERT INTO campaign_actors VALUES ('actor-b',?,'cc-b','sheet-b','player-character','principal',?,?)").run(campaign.id,at,at);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-b',?,'local-owner',NULL)").run(campaign.id);
    db.prepare("INSERT INTO session_characters VALUES('session','persona-b',1)").run();
    for(const actorId of ["actor","actor-b"]){
      for(let i=0;i<(actorId==="actor"?2:6);i++){
        const text=`${actorId==="actor"?"A_HISTORY":"B_PRIVATE_DECLARATION"}_${i}`;
        let turn=repo.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId,
          declaration:text,expectedCampaignRevision:0,idempotencyKey:text});
        turn=repo.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:0,
          narrationStatus:"in-progress",idempotencyKey:`start-${text}`});
        repo.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:0,
          narrationStatus:"completed",terminalState:"completed",fallbackNarration:`Account of ${text}.`,idempotencyKey:`finish-${text}`});
      }
    }
    expect(repo.getAdventureTurnTranscript("local-owner",campaign.id,"session",2).map(entry=>entry.actorId)).toEqual(["actor-b","actor-b"]);
    expect(repo.getAdventureTurnTranscript("local-owner",campaign.id,"session",2,"actor").map(entry=>entry.declaration)).toEqual(["A_HISTORY_0","A_HISTORY_1"]);
    expect(()=>repo.getAdventureTurnTranscript("local-owner",campaign.id,"session",2,"missing-actor")).toThrow("actor is unavailable");
    db.prepare("INSERT INTO principals VALUES('history-player','Player',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?,'history-player','player',?)").run(campaign.id,at);
    expect(()=>repo.getAdventureTurnTranscript("history-player",campaign.id,"session",2,"actor")).toThrow("actor is unavailable");
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='history-player' WHERE actor_id='actor'").run();
    expect(repo.getAdventureTurnTranscript("history-player",campaign.id,"session",2,"actor")).toHaveLength(2);
    expect(()=>repo.getAdventureTurnTranscript("history-player",campaign.id,"session",2,"actor-b")).toThrow("actor is unavailable");
    db.close();repo.close();
    let calls=0;
    const dependencies:AdventureAgentDependencies={complete:async input=>{
      calls++;
      const history=input.messages.find(message=>typeof message.content==="string"&&message.content.includes("UNTRUSTED PRIOR ROOM ADVENTURE HISTORY DATA"))!.content;
      expect(history).toContain("A_HISTORY_0");expect(history).toContain("A_HISTORY_1");
      expect(JSON.stringify(input.messages)).not.toContain("B_PRIVATE_DECLARATION");
      return input.tools?.some(tool=>tool.name==="submit_adventure_narration")?narrationResult("The guide answers quietly.")
        :{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}};
    },getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>({...defaultHarnessSettings(),recentTurns:2}),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I listen",expectedRevision:0,idempotencyKey:"scoped-history"}});
    expect(response.statusCode).toBe(200);expect(calls).toBe(2);
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{narrationStatus:{source:"provider-assisted"}}});
    await app.close();
  });
  it("consumes accepted public preparation in planning and narration without GM or unpublished material", async () => {
    enable();process.env.FEATURE_RPG_COMBAT="true";
    const campaign=seed(),repo=createRepository();
    const inputs:any[]=[];
    const narration='You listen as the Guide speaks softly. "Welcome," she says, folding her hands. Rain taps the sill. She waits for your question. What do you ask?';
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{
      inputs.push(input);return input.tools?.some((tool)=>tool.name==="submit_adventure_narration")
        ? narrationResult(narration)
        : {message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}};
    },getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>repo,adventureAgentDependencies:dependencies});
    const headers={"content-type":"application/json"};
    const staged=await app.inject({method:"POST",url:"/api/rpg/v1/campaign-content-drafts",headers,payload:{
      campaignId:campaign.id,brief:"A playable mystery",tone:"Quiet",exclusions:[],idempotencyKey:"runtime-preparation",
      sections:["outline","locations","lore","npcs","arcs","scene-prompts","handouts"],reviewedContent:{
        outlines:[{key:"premise",premise:"PUBLIC_PREMISE",opening:"OPENING_NOT_REPLAYED",visibility:"public"}],
        locations:[{key:"near",name:"Landing",description:"NEAR_LOCATION",atmosphere:"NEAR_ATMOSPHERE",visibility:"public",discoveries:["UNREVEALED_DISCOVERY"]},
          {key:"far",name:"Tower",description:"FAR_LOCATION",visibility:"public"}],
        lore:[{key:"near-lore",title:"Landing custom",summary:`${"x".repeat(1_200)}\nNEAR_LORE`,
          details:Array.from({length:8},(_,index)=>`LOCAL_DETAIL_${index}_${"d".repeat(480)}`),locationKeys:["near"],visibility:"public"},
          {key:"far-lore",title:"Tower custom",summary:"FAR_LORE",locationKeys:["far"],visibility:"public"}],
        npcs:[{key:"guide",name:"Guide",archetype:"Guide",description:'PUBLIC_PORTRAYAL: speaks softly, folds her hands, says "Welcome".',privateGoals:"GM_SECRET_GOAL",visibility:"public"},
          {key:"hidden-npc",name:"GM_SECRET_NPC",archetype:"Spy",description:"GM_SECRET_PORTRAYAL",visibility:"gm"},
          {key:"absent-npc",name:"Absent Guide",archetype:"Guide",description:"ABSENT_PORTRAYAL",visibility:"public"}],
        arcs:[{key:"finale",title:"Finale",summary:"GM_SECRET_FINALE",visibility:"gm"}],
        scenePrompts:[{key:"public-scene",title:"Greeting",prompt:"PUBLIC_PUBLISHED_SCENE",visibility:"public",npcKeys:["guide"]},
          {key:"gm-scene",title:"Recovery",prompt:"GM_SECRET_CLUE_RECOVERY",visibility:"gm"}],
        handouts:[{key:"letter",title:"Letter",content:"UNPUBLISHED_LETTER",visibility:"public"},
          {key:"unaccepted",title:"Unaccepted",content:"UNACCEPTED_SENTINEL",visibility:"public"}],
      }}});
    expect(staged.statusCode,staged.body).toBe(201);
    expect(repo.getCampaignAgentContextSnapshot("local-owner",campaign.id,"session",{kind:"player",actorId:"actor"})!.publicPreparation).toEqual([]);
    const applied=await app.inject({method:"POST",url:`/api/rpg/v1/campaign-content-drafts/${staged.json().draft.draftId}/apply`,headers,
      payload:{expectedRevision:0,idempotencyKey:"runtime-preparation-apply",selectedArtifactKeys:["premise","near","far","near-lore","far-lore","guide","hidden-npc","absent-npc","finale","public-scene","gm-scene","letter"]}});
    expect(applied.statusCode,applied.body).toBe(200);
    const artifacts=repo.getCampaignGenerationContext("local-owner",campaign.id,["guide","hidden-npc"])!.artifacts;
    for(const [index,artifact] of artifacts.entries())repo.mutateNpcPresence("local-owner",{campaignId:campaign.id,sessionId:"session",
      npcId:artifact.serverResourceId!,expectedRevision:index,idempotencyKey:`place-prepared-${index}`,mutation:{kind:"place",locationId:null}});
    const beforePublication=repo.getCampaignAgentContextSnapshot("local-owner",campaign.id,"session",{kind:"player",actorId:"actor"})!;
    expect(JSON.stringify(beforePublication)).not.toMatch(/GM_SECRET_|PUBLIC_PUBLISHED_SCENE|UNPUBLISHED_|UNACCEPTED_|OPENING_NOT_REPLAYED/);
    const dm=repo.getCampaignAgentContextSnapshot("local-owner",campaign.id,"session",{kind:"dm"})!;
    expect(dm.privateTargetFacts.join(" ")).toContain("GM_SECRET_FINALE");
    expect(dm.privateTargetFacts.join(" ")).toContain("GM_SECRET_CLUE_RECOVERY");
    expect(JSON.stringify(dm.publicPreparation)).not.toContain("GM_SECRET_");
    const published=await app.inject({method:"POST",url:`/api/rpg/v1/campaigns/${campaign.id}/material-publications`,headers,
      payload:{artifactKey:"public-scene",expectedRevision:0,idempotencyKey:"publish-greeting"}});
    expect(published.statusCode,published.body).toBe(200);
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers,
      payload:{campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I greet the Guide",expectedRevision:repo.getCampaignAdministration("local-owner",campaign.id)!.revision,idempotencyKey:"prepared-roleplay"}});
    expect(response.statusCode,response.body).toBe(200);expect(inputs).toHaveLength(2);
    for(const input of inputs){
      const text=JSON.stringify(input.messages);
      for(const sentinel of ["PUBLIC_PREMISE","PUBLIC_PORTRAYAL","PUBLIC_PUBLISHED_SCENE"])expect(text).toContain(sentinel);
      expect(text).not.toMatch(/GM_SECRET_|UNPUBLISHED_|UNACCEPTED_|OPENING_NOT_REPLAYED|NEAR_|FAR_|UNREVEALED_|ABSENT_/);
      for(const name of ["combat_start","story_change"])expect(input.tools.map((tool:any)=>tool.name)).not.toContain(name);
    }
    expect(inputs[1].messages[0].content).toContain("at most 8 sentences and 180 words");
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[],narrationStatus:{text:narration,source:"provider-assisted"}}});
    expect(response.body).not.toMatch(/GM_SECRET_|UNPUBLISHED_|UNACCEPTED_/);
    const turnId=response.headers["x-adventure-turn-id"] as string;
    const read=await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${turnId}`});
    expect(read.body).not.toMatch(/GM_SECRET_|UNPUBLISHED_|UNACCEPTED_/);
    const near=repo.getCampaignGenerationContext("local-owner",campaign.id,["near"])!.artifacts[0]!.serverResourceId!;
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,? ,?,'session',0,?)").run(campaign.id,"actor",near,at);
    const playerSnapshot=()=>repo.getCampaignAgentContextSnapshot("local-owner",campaign.id,"session",{kind:"player",actorId:"actor"})!;
    expect(JSON.stringify(playerSnapshot().publicPreparation)).not.toContain("NEAR_");
    db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(campaign.id,"actor",near,at);
    const relevant=playerSnapshot().publicPreparation!;
    for(const sentinel of ["NEAR_LOCATION","NEAR_ATMOSPHERE","NEAR_LORE"])expect(relevant.join(" ")).toContain(sentinel);
    expect(relevant.join(" ")).not.toMatch(/FAR_|UNREVEALED_|GM_SECRET_/);
    expect(relevant.join("\n").length).toBeLessThanOrEqual(4_000);
    expect(relevant.join(" ")).not.toContain("x".repeat(1_200));
    expect(relevant.filter((line)=>line.includes("LOCAL_DETAIL_")).length).toBeLessThan(8);
    expect(playerSnapshot().publicPreparation).toEqual(relevant);
    for(const role of ["player","observer"]){
      db.prepare("INSERT INTO principals VALUES(?,?,0)").run(`preparation-${role}`,role);
      db.prepare("INSERT INTO campaign_memberships VALUES(?,?,?,?)").run(campaign.id,`preparation-${role}`,role,at);
      expect(repo.getCampaignAgentContextSnapshot(`preparation-${role}`,campaign.id,"session",{kind:"dm"})).toBeNull();
    }
    db.close();
    await app.close();
  });
  it("degrades a planning budget denial to deterministic fallback narration without provider dispatch", async () => {
    enable(); const campaign = seed(); let calls = 0;
    const dependencies: AdventureAgentDependencies = {
      complete: async () => { calls += 1; throw new Error("must not dispatch"); },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "test", samplers: { ...defaultProviderSettings().samplers, maxTokens: 20 },
        adventureTurnBudget: { maxTotalTokens: 10, maxEstimatedCostUsd: null } }),
      getHarness: async () => defaultHarnessSettings(), now: () => new Date(),
    };
    const app = buildApp({ campaignRepositoryFactory: () => createRepository(), adventureAgentDependencies: dependencies });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" },
      payload: { campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: "I force the gate", expectedRevision: 0,
        idempotencyKey: "budget-denial" } });
    expect(calls).toBe(0);
    // A local budget denial is backpressure, not a provider failure: the turn completes with the
    // deterministic narration fallback and no mechanics.
    expect(events(response.body).at(-1)).toMatchObject({
      type: "terminal",
      payload: { outcome: "done", receipts: [], narrationStatus: { status: "completed", source: "deterministic-fallback", text: narrationFallback("I force the gate", []) } },
    });
    const turnId = response.headers["x-adventure-turn-id"] as string;
    const repository = createRepository(); const turn = repository.getAdventureTurn("local-owner", turnId);
    expect(turn).toMatchObject({ state: "completed", narrationStatus: "completed" });
    const providerCalls = turn && "providerCalls" in turn ? turn.providerCalls : [];
    expect(providerCalls.some((call) => call.phase === "failed" && call.outcomeCode?.startsWith("budget-"))).toBe(true);
    repository.close(); await app.close();
  });

  it.each([
    ["social", "I ask the ferryman what he saw", "The ferryman lowers his voice as rain ticks against the landing.", "velvet"],
    ["exploration", "I study the carvings along the flooded arch", "Salt-bright lines emerge where your lamp crosses the weathered arch.", "dnd"],
  ] as const)("persists provider-authored DM narration for read-only %s scenes", async (_kind, declaration, narration, ruleset) => {
    enable(); const campaign=seed(ruleset);let calls=0;let planningInput:any,narrationInput:any;
    const harness={...defaultHarnessSettings(),systemPrompt:"Favor mystery",personaPreamble:"Patient guide",styleGuide:"Use rain imagery",
      postHistoryInstructions:"Preserve continuity",recentTurns:4};
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{calls+=1;if(calls===1)planningInput=input;else narrationInput=input;return calls===1
      ?{message:{role:"assistant",content:"complete",toolCalls:[]},usage:{promptTokens:2,completionTokens:1,totalTokens:3},model:{requestedModel:"test",responseModel:"test"}}
      :narrationResult(narration,{promptTokens:10,completionTokens:12,totalTokens:22});},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>harness,now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},
      payload:{campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration,expectedRevision:0,idempotencyKey:`read-${_kind}`}});
    expect(response.statusCode).toBe(200);expect(calls).toBe(2);const streamed=events(response.body),terminal=streamed.at(-1);
    expect(streamed.find((event)=>event.type==="narration_delta")).toMatchObject({payload:{text:narration}});
    expect(terminal).toMatchObject({type:"terminal",payload:{narrationStatus:{status:"completed",text:narration,source:"provider-assisted"},receipts:[]}});
    if(terminal?.type!=="terminal")throw new Error("terminal missing");
    const read=await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}`});
    expect(read.json()).toMatchObject({proposals:[],receipts:[],narrationStatus:{status:"completed",text:narration,source:"provider-assisted"}});
    expect(read.body).not.toContain("submit_adventure_narration");
    const usage=(await app.inject({method:"GET",url:"/api/usage"})).json().usage;
    expect(usage).toMatchObject({calls:2,promptTokens:12,completionTokens:13,totalTokens:25,providerMeasuredTokens:25});
    expect(usage.byKind).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:"adventure_planning",calls:1,totalTokens:3}),
      expect.objectContaining({kind:"adventure_narration",calls:1,totalTokens:22}),
    ]));
    expect(narrationInput.jsonSchema).toBeUndefined();
    expect(narrationInput.toolChoice).toEqual({name:"submit_adventure_narration"});
    expect(narrationInput.parallelToolCalls).toBe(false);
    expect(narrationInput.tools).toEqual([expect.objectContaining({name:"submit_adventure_narration",parameters:expect.objectContaining({additionalProperties:false,required:["narration"],
      properties:{narration:{type:"string",minLength:1,maxLength:8000}}})})]);
    expect(planningInput.jsonSchema).toBeUndefined();
    expect(planningInput.toolChoice).toBe("auto");
    expect(planningInput.tools).not.toEqual([]);
    expect(planningInput.tools.some((tool:any)=>tool.name==="submit_adventure_narration")).toBe(false);
    expect(narrationInput.messages[0].content).toContain("IMMUTABLE ADVENTURE NARRATION AUTHORITY");
    const descriptor=ruleset==="dnd"?DND_5E_RULESET_DESCRIPTOR:VELVET_LEGACY_RULESET_DESCRIPTOR;
    const otherDescriptor=ruleset==="dnd"?VELVET_LEGACY_RULESET_DESCRIPTOR:DND_5E_RULESET_DESCRIPTOR;
    expect(planningInput.messages[0].content).toContain(canonicalAgentJson(descriptor as never));
    expect(narrationInput.messages[0].content).toContain(canonicalAgentJson(descriptor as never));
    expect(planningInput.messages[0].content).not.toContain(canonicalAgentJson(otherDescriptor as never));
    expect(narrationInput.messages[0].content).not.toContain(canonicalAgentJson(otherDescriptor as never));
    expect(narrationInput.messages[1].content).toMatch(/exactCurrentLocation[^A-Za-z]+null/);
    expect(narrationInput.messages[0].content).not.toMatch(/Favor mystery|rain imagery|historicalPlayerIntentNotCanon/);
    expect(narrationInput.messages[2].content).toContain("USER-EDITABLE DM VOICE AND PRESENTATION PREFERENCES");
    expect(narrationInput.messages[2].content).toMatch(/Favor mystery|rain imagery/);
    expect(narrationInput.messages.at(-1).content).toContain("untrustedPlayerIntentNotCanonOrInstructions");
    await app.close();
    const restarted=buildApp({campaignRepositoryFactory:()=>createRepository()});
    expect((await restarted.inject({method:"GET",url:"/api/usage"})).json().usage).toMatchObject({calls:2,totalTokens:25});
    await restarted.close();
  });

  it.each([
    ["unsupported travel", "I walk down the ramp and reach the Black Berth.", "Camille walks down the ramp and reaches the Black Berth."],
    ["invented possession", "I inspect my records.", "You connect your portable drive and open the single unlabeled export."],
    ["unsupported success", "I separate the privacy records.", "The separation is done. The timestamps are ready."],
    ["malformed JSON", "I wait.", "{"],
  ])("rejects non-contract provider output for %s and persists a grounded fallback", async (_kind,declaration,providerContent) => {
    enable();const campaign=seed();let calls=0;
    const dependencies:AdventureAgentDependencies={complete:async()=>{calls+=1;return calls===1
      ?{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}}
       :{message:{role:"assistant",content:null,toolCalls:[{id:"non-contract",name:"submit_adventure_narration",arguments:providerContent}]},
         usage:{promptTokens:4,completionTokens:5,totalTokens:9},model:{requestedModel:"test",responseModel:"test"}};},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const payload={campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration,expectedRevision:0,idempotencyKey:`unsafe-${_kind.replaceAll(" ","-")}`};
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload});
    const terminal=events(response.body).at(-1);const safe="The scene holds. Your intended action remains pending; no movement or other campaign change is established.";
    expect(terminal).toMatchObject({type:"terminal",payload:{narrationStatus:{status:"completed",text:safe,source:"deterministic-fallback"},receipts:[]}});
    if (providerContent !== "{") expect(response.body).not.toContain(providerContent);
    const replay=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload});
    expect(events(replay.body).at(-1)).toMatchObject({type:"terminal",payload:{narrationStatus:{text:safe,source:"deterministic-fallback"}}});
    const usage=(await app.inject({method:"GET",url:"/api/usage"})).json().usage;
    expect(usage).toMatchObject({calls:2,providerMeasuredTokens:9});
    expect(usage.estimatedTokens).toBeGreaterThan(0);
    await app.close();
  });

  it.each([
    ["content only", { role:"assistant",content:'{"narration":"Content only."}',toolCalls:[] }],
    ["multiple calls", { role:"assistant",content:null,toolCalls:[
      {id:"one",name:"submit_adventure_narration",arguments:'{"narration":"One."}'},
      {id:"two",name:"submit_adventure_narration",arguments:'{"narration":"Two."}'},
    ] }],
    ["wrong tool", { role:"assistant",content:null,toolCalls:[{id:"wrong",name:"adventure_action",arguments:'{"narration":"Wrong."}'}] }],
    ["extra argument", { role:"assistant",content:null,toolCalls:[{id:"extra",name:"submit_adventure_narration",arguments:'{"narration":"Extra.","action":"mutate"}'}] }],
    ["malformed arguments", { role:"assistant",content:null,toolCalls:[{id:"malformed",name:"submit_adventure_narration",arguments:"{"}] }],
    ["missing narration", { role:"assistant",content:null,toolCalls:[{id:"missing",name:"submit_adventure_narration",arguments:"{}"}] }],
    ["malformed narration", { role:"assistant",content:null,toolCalls:[{id:"type",name:"submit_adventure_narration",arguments:'{"narration":7}'}] }],
    ["incomplete call", { role:"assistant",content:null,toolCalls:[{id:"",name:"submit_adventure_narration",arguments:'{"narration":"No ID."}'}] }],
  ] as const)("rejects %s narration transport and uses deterministic fallback",async(_label,message)=>{
    enable();const campaign=seed();let calls=0;
    const dependencies:AdventureAgentDependencies={complete:async()=>{calls+=1;return calls===1
      ?{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}}
      :{message,usage:{promptTokens:4,completionTokens:5,totalTokens:9},model:{requestedModel:"test",responseModel:"test"}} as ProviderCompletionResult;},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I wait.",expectedRevision:0,idempotencyKey:`invalid-transport-${_label.replaceAll(" ","-")}`}});
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{narrationStatus:{source:"deterministic-fallback",
      text:"The scene holds. Your intended action remains pending; no movement or other campaign change is established."}}});
    await app.close();
  });

  it("falls back safely when the narration provider fails",async()=>{
    enable();const campaign=seed();let calls=0;
    const dependencies:AdventureAgentDependencies={complete:async()=>{calls+=1;if(calls===2)throw new Error("fake narration failure");
      return{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}};},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I leave now",expectedRevision:0,idempotencyKey:"narration-provider-failure"}});
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done",narrationStatus:{source:"deterministic-fallback",
      text:"The scene holds. Your intended action remains pending; no movement or other campaign change is established."}}});
    await app.close();
  });

  it("persists provider provenance when provider text equals the deterministic fallback",async()=>{
    enable();const campaign=seed();let calls=0;const fallback=narrationFallback("I wait",[]);
    const dependencies:AdventureAgentDependencies={complete:async()=>{calls+=1;return calls===1
      ?{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}}
      :narrationResult(fallback);},getProvider:async()=>({...defaultProviderSettings(),model:"test"}),
      getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I wait",expectedRevision:0,idempotencyKey:"equal-fallback"}});
    const terminal=events(response.body).at(-1);expect(terminal).toMatchObject({type:"terminal",payload:{narrationStatus:{
      text:fallback,source:"provider-assisted"}}});
    if(terminal?.type!=="terminal")throw new Error("terminal missing");
    expect((await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}`})).json())
      .toMatchObject({narrationStatus:{text:fallback,source:"provider-assisted"}});
    await app.close();
  });

  it("durably gives one of two repository workers the narration dispatch",()=>{
    enable();const campaign=seed();const first=createRepository(),second=createRepository();
    let turn=first.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:"I listen",expectedCampaignRevision:0,idempotencyKey:"two-worker-turn"});
    turn=first.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:0,
      idempotencyKey:"two-worker-narrating",narrationStatus:"in-progress"});
    const context={historicalRecall:first.getCampaignRecall("local-owner",{campaignId:campaign.id,sessionId:"session",audience:{kind:"player",actorId:"actor"},
      query:"listen",purpose:"public-narration",excludeRootTurnId:turn.turnId})};
    const input={turnId:turn.turnId,callId:"narration-call",provider:"test",model:"test",fallbackNarration:narrationFallback(turn.declaration,[]),leaseMs:90_000,
      context,request:{messages:[{role:"user",content:JSON.stringify(context)}]}};
    expect(first.claimNarrationProviderDispatch("local-owner",input)).toMatchObject({state:"claimed"});
    expect(second.claimNarrationProviderDispatch("local-owner",input)).toMatchObject({state:"in-progress"});
    expect(second.claimNarrationProviderDispatch("local-owner",{...input,context:{changed:true}})).toMatchObject({state:"in-progress"});
    expect(second.getNarrationProviderContext("local-owner",turn.turnId,input.callId)).toEqual(context);
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    expect(()=>db.exec("UPDATE adventure_narration_contexts SET context_json='{}'")).toThrow("immutable");
    expect(()=>db.exec("INSERT OR REPLACE INTO adventure_narration_contexts SELECT * FROM adventure_narration_contexts")).toThrow("immutable");
    db.close();
    first.close();second.close();
  });

  it("dispatches narration once across two route worker instances",async()=>{
    enable();const campaign=seed();let narrationCalls=0,release:((value:ProviderCompletionResult)=>void)|undefined;
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{
      if(!input.tools?.some(tool=>tool.name==="submit_adventure_narration"))return{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,
        model:{requestedModel:"test",responseModel:"test"}};
      narrationCalls+=1;return new Promise<ProviderCompletionResult>(resolve=>{release=resolve;});},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const first=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const second=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const request={method:"POST" as const,url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I listen",expectedRevision:0,idempotencyKey:"two-route-workers"}};
    const firstResponse=first.inject(request);
    for(let attempts=0;narrationCalls===0&&attempts<100;attempts+=1)await new Promise(resolve=>setTimeout(resolve,10));
    expect(narrationCalls).toBe(1);const secondResponse=second.inject(request);await new Promise(resolve=>setTimeout(resolve,20));
    release?.(narrationResult("The ferryman answers quietly."));
    const [left,right]=await Promise.all([firstResponse,secondResponse]);expect(narrationCalls).toBe(1);
    expect(events(left.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done",narrationStatus:{source:"provider-assisted"}}});
    expect(events(right.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done",narrationStatus:{source:"provider-assisted"}}});
    await first.close();await second.close();
  });

  it("seals an expired narration lease to fallback after restart and rejects late success",()=>{
    enable();const campaign=seed();let current=new Date("2035-01-01T00:00:00.000Z");const clock={now:()=>current};
    const owner=createRepository({clock});let turn=owner.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,
      sessionId:"session",actorId:"actor",declaration:"I listen",expectedCampaignRevision:0,idempotencyKey:"expired-lease-turn"});
    turn=owner.updateAdventureTurnNarration("local-owner",{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:0,
      idempotencyKey:"expired-lease-narrating",narrationStatus:"in-progress"});
    const fallback=narrationFallback(turn.declaration,[]),input={turnId:turn.turnId,callId:"expired-call",provider:"test",model:"test",
      fallbackNarration:fallback,leaseMs:100};
    const claimed=owner.claimNarrationProviderDispatch("local-owner",input);if(claimed.state!=="claimed")throw new Error("claim missing");
    current=new Date("2035-01-01T00:00:01.000Z");const restarted=createRepository({clock});
    expect(restarted.claimNarrationProviderDispatch("local-owner",input)).toMatchObject({state:"settled",source:"deterministic-fallback",
      narration:fallback,outcomeCode:"dispatch-lease-expired"});
    expect(owner.settleNarrationProviderDispatch("local-owner",{turnId:turn.turnId,callId:input.callId,claimId:claimed.claimId,
      source:"provider-assisted",narration:"A late answer.",outcomeCode:"ok",promptTokens:1,completionTokens:1}))
      .toMatchObject({state:"settled",source:"deterministic-fallback",narration:fallback});
    owner.close();restarted.close();
  });

  it("rejects explicit unsupported mechanics while allowing dialogue and current-location continuity",()=>{
    for(const narration of ["You take 7 damage.","You heal for 4 HP.","You gain a sword.","You lose 2 gold.",
      "You arrive at Black Berth.","The quest is completed.","You level up."]){
      expect(providerNarrationMatchesReceipts(narration,[]),narration).toBe(false);
    }
    expect(providerNarrationMatchesReceipts("The ferryman lowers his voice while rain taps the roof.",[])).toBe(true);
    expect(providerNarrationMatchesReceipts("At Parc des Pionniers, the ferryman recalls Place La Salle.",[],"Parc des Pionniers")).toBe(true);
    expect(providerNarrationMatchesReceipts("You arrive at Black Berth and receive 50 gold.",[
      {kind:"travel",destination:"Black Berth"} as any],"Black Berth")).toBe(false);
    const damageReceipt={kind:"combat",action:"attack",outcome:{kind:"damage",damageType:"physical",requested:5,applied:5,
      hitPointsBefore:15,hitPointsAfter:10,statusAfter:"active"},roundBefore:1,roundAfter:1} as any;
    expect(providerNarrationMatchesReceipts("The attack deals 5 physical damage. The target has 10 HP and is active. It then takes 2 damage.",
      [damageReceipt])).toBe(false);
    expect(providerNarrationMatchesReceipts("The attack deals 5 physical damage. The target has 10 HP and is active. You heal for 3 HP.",
      [damageReceipt])).toBe(false);
    const defeatReceipt={kind:"combat",action:"attack",outcome:{kind:"damage",damageType:"slashing",requested:11,applied:11,
      hitPointsBefore:11,hitPointsAfter:0,statusAfter:"defeated"},roundBefore:2,roundAfter:2} as any;
    expect(providerNarrationMatchesReceipts("Your longsword bites home for 11 damage; the bandit drops to 0 hit points.",
      [defeatReceipt])).toBe(true);
    expect(providerNarrationMatchesReceipts("Your longsword bites home for 6 damage; the bandit drops to 0 hit points.",
      [defeatReceipt])).toBe(false);
  });

  it("rejects replayed recovery and purchase claims when no matching receipt grounds them",()=>{
    // Recorded live failures: a provider-assisted short-rest replay whose numbers were copied from a
    // prior turn's receipt, and a narrated purchase on a turn with no commerce candidate or receipt.
    const replayedRest=`You find a corner out of the lamplight, wedge your back against damp stone, and let the quiet do its work. No talk, no story — just breath, and the ache in your arms easing out.

When you stand again, the short rest has done what you needed. Your Health recovers from 8 to 12. Your Hit Dice D10 recovers from 1 to 0.

You roll your shoulders, set your grip, and step back toward the stair. The lamp-line waits, the cold below waits, and whatever's down past the third landing hasn't gone anywhere.`;
    const narratedPurchase="You count the coin onto the board, flat, no haggling — and lift the brass lamp-trimmer off it, clasp closed, maker's mark still turned up. The stallkeeper sweeps the coin into his palm without counting it twice and says nothing more about the last man.";
    expect(providerNarrationMatchesReceipts(replayedRest,[])).toBe(false);
    expect(providerNarrationMatchesReceipts("The scene settles. Your Health recovers from 8 to 12. Your Hit Dice D10 recovers from 1 to 0.",[])).toBe(false);
    expect(providerNarrationMatchesReceipts("Short rest completed. Your Health recovers from 8 to 12. Your Hit Dice D10 recovers from 1 to 0.",[])).toBe(false);
    expect(providerNarrationMatchesReceipts(narratedPurchase,[])).toBe(false);
    expect(providerNarrationMatchesReceipts("You count the coin onto the board and lift the brass lamp-trimmer off it, then turn to leave.",[])).toBe(false);
    // The matching committed rest receipt still grounds the same recovery prose.
    const restReceipt={kind:"rest",restKind:"short",restName:"Short rest",recovery:[{label:"Health",before:8,after:12},{label:"Hit Dice D10",before:1,after:0}]} as any;
    expect(providerNarrationMatchesReceipts(replayedRest,[restReceipt])).toBe(true);
    expect(providerNarrationMatchesReceipts("Short rest completed. Your Health recovers from 8 to 12. Your Hit Dice D10 recovers from 1 to 0.",[restReceipt])).toBe(true);
    // A grounded turn whose receipts lack the claimed kind is rejected as well.
    const checkReceipt={kind:"check",checkKind:"ability",ability:"Wisdom",skill:null,mode:"normal",difficulty:"Medium",rolls:[{value:10,kept:true}],
      abilityModifier:1,proficiencyBonus:2,modifier:3,total:13,dc:15,outcome:"failure"} as any;
    expect(providerNarrationMatchesReceipts(replayedRest,[checkReceipt])).toBe(false);
    // Prose that denies a transaction is not a transaction claim.
    expect(providerNarrationMatchesReceipts("The keeper sells salvage off the docks, but no coin has changed hands.",[])).toBe(true);
    // Ordinary prose with zero receipts is untouched.
    for(const narration of ["You take a breath and let the rain settle.","You take your weapon in hand and wait.","You gain a sense of unease.",
      "The rest of the room stays quiet.","You finish the rest of the descent in silence.","You pay attention to the ferryman's story.",
      "You take the well-worn path back to the landing.","You lift your gaze to the rain-bright road.",
      "The ferryman lowers his voice while rain taps the roof."]){
      expect(providerNarrationMatchesReceipts(narration,[]),narration).toBe(true);
    }
  });

  it("keeps travel pending when no exact legal candidate exists",async()=>{
    enable();const campaign=seed();let calls=0;
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{calls+=1;if(calls===1)expect(input.tools?.some((tool)=>tool.name==="exact_actor_travel.select")).toBe(false);
      return calls===1?{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}}
        :narrationResult("You remain aboard while the route stays unresolved.");},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date()};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository(),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I disembark and head to the Black Berth now",expectedRevision:0,idempotencyKey:"illegal-travel"}});
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[],narrationStatus:{text:"You remain aboard while the route stays unresolved.",source:"provider-assisted"}}});
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(db.prepare("SELECT count(*) count FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id='actor'").get(campaign.id)).toEqual({count:0});db.close();
    await app.close();
  });

  it("narrates completed travel only from its committed exact-travel receipt",async()=>{
    enable();const campaign=seed();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('origin',?,NULL,'Ferry Deck','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('destination',?,NULL,'Black Berth','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('return-route',?,'origin','destination','public','open','none',NULL,NULL,?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'origin','session',0,?)").run(campaign.id,"actor",at);db.close();
    let calls=0;let narrationInput:any;const dependencies:AdventureAgentDependencies={complete:async(input)=>{calls+=1;if(calls===1){const tool=input.tools?.find((item)=>item.name==="exact_actor_travel.select") as any;
        expect(tool).toBeDefined();return{message:{role:"assistant",content:null,toolCalls:[{id:"return-choice",name:"exact_actor_travel.select",arguments:JSON.stringify({
          candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};}
      narrationInput=input;return narrationResult("Rain trails from your coat as you arrive at Black Berth.");},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at)};
    let app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I return to the Black Berth",expectedRevision:0,idempotencyKey:"legal-return-travel"}});
    const terminal=events(response.body).at(-1);expect(terminal).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{status:"completed",
      text:"Rain trails from your coat as you arrive at Black Berth.",source:"provider-assisted"}}});
    expect(narrationInput.messages[1].content).toMatch(/exactCurrentLocation[^A-Za-z]+Black Berth/);
    if(terminal?.type!=="terminal")throw new Error("travel terminal missing");const read=await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}`});
    expect(read.json()).toMatchObject({turn:{state:"completed"},receipts:terminal.payload.receipts,narrationStatus:{status:"completed"}});
    const world=createRepository({clock:{now:()=>new Date(at)}});expect(world.getCampaignWorld("local-owner",campaign.id)?.currentLocations)
      .toContainEqual(expect.objectContaining({actorId:"actor",locationId:"destination"}));world.close();await app.close();
  });

  it("shows each exact travel destination and rejects unresolved narration after the selected arrival commits",async()=>{
    enable();const campaign=seed();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('place-la-salle',?,NULL,'Place La Salle','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('pointe-saint-gilles',?,NULL,'Pointe-Saint-Gilles','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('parc-des-pionniers',?,NULL,'Parc des Pionniers','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('route-a-pointe',?,'place-la-salle','pointe-saint-gilles','public','open','none',NULL,NULL,?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('route-b-parc',?,'place-la-salle','parc-des-pionniers','public','open','none',NULL,NULL,?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'place-la-salle','session',0,?)").run(campaign.id,"actor",at);db.close();
    let calls=0;const dependencies:AdventureAgentDependencies={complete:async(input)=>{calls+=1;if(calls===1){
        const content=input.messages.at(-2)!.content!;
        expect(content).toContain("UNTRUSTED CURRENT EXACT CANDIDATE TABLE");
        const options=(JSON.parse(content.slice(content.indexOf("{"))) as any).candidateOptions;
        const travel=options.filter((candidate:any)=>candidate.toolName==="exact_actor_travel.select");
        expect(travel.map((candidate:any)=>[candidate.label.source,candidate.label.target])).toEqual([
           ["Place La Salle","Pointe-Saint-Gilles"],["Place La Salle","Parc des Pionniers"]]);
        expect(JSON.stringify(travel)).not.toMatch(/place-la-salle|pointe-saint-gilles|parc-des-pionniers|route-[ab]-/);
        const selected=travel.find((candidate:any)=>candidate.label.target==="Parc des Pionniers");
        return{message:{role:"assistant",content:null,toolCalls:[{id:"parc-choice",name:selected.toolName,arguments:JSON.stringify(selected.arguments)}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};}
      return narrationResult("Fog gathers at Pointe-Saint-Gilles while your movement and arrival remain unresolved.");},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at)};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"Travel from Place La Salle to Parc des Pionniers",expectedRevision:0,idempotencyKey:"live-routetok-regression"}});
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{source:"deterministic-fallback",text:"The authoritative result is clear. You arrive at Parc des Pionniers."}}});
    expect(response.body).not.toContain("movement and arrival remain unresolved");
    const world=createRepository({clock:{now:()=>new Date(at)}});expect(world.getCampaignWorld("local-owner",campaign.id)?.currentLocations)
      .toContainEqual(expect.objectContaining({actorId:"actor",locationId:"parc-des-pionniers"}));world.close();await app.close();
  });

  it("grounds quest narration at the post-travel visible location instead of stale room history",async()=>{
    enable();const campaign=seed();const setup=createRepository({clock:{now:()=>new Date(at)}});
    setup.createCampaignStorylineGraph("local-owner",campaign.id,{storyline:{storylineId:"park-story",title:"Park work",summary:null,
      nodes:[],edges:[],plotPoints:[],clues:[]},expectedRevision:0,idempotencyKey:"park-story-create"});
    setup.createCampaignQuest("local-owner",campaign.id,{quest:{questId:"park-quest",storylineId:"park-story",title:"Survey the Park",
      description:"Record the conditions at the park.",visibility:"public",journalText:"The survey awaits.",objectives:[{
        objectiveId:"park-survey",description:"Complete the park survey",targetProgress:1,dependencyObjectiveIds:[],visibility:"public"}],rewards:[]},
      expectedRevision:0,idempotencyKey:"park-quest-create"});
    setup.executeQuestCommand("local-owner","park-quest",{kind:"accept",expectedRevision:1,idempotencyKey:"park-quest-accept"});setup.close();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('place-la-salle',?,NULL,'Place La Salle','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_locations_v28 VALUES('parc-des-pionniers',?,NULL,'Parc des Pionniers','','public',?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_location_connections_v28 VALUES('place-to-parc',?,'place-la-salle','parc-des-pionniers','public','open','none',NULL,NULL,?)").run(campaign.id,at);
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'place-la-salle','session',0,?)").run(campaign.id,"actor",at);
    db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,'place-la-salle',?)").run(campaign.id,"actor",at);db.close();
    let narrationCalls=0;let finalNarrationInput:any;
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{
      if(input.tools?.some(tool=>tool.name==="submit_adventure_narration")){
        narrationCalls+=1;
        if(narrationCalls===1)return narrationResult("At Place La Salle, the ferryman answers your question.");
        if(narrationCalls===2)return narrationResult("Leaving Place La Salle behind, you arrive at Parc des Pionniers.");
        finalNarrationInput=input;
        return narrationResult("At Place La Salle, Survey the Park advances to 1 of 1 as you complete the park survey.");
      }
      const currentIntent=input.messages.at(-1)?.content??"";
      if(currentIntent.includes("Travel to Parc des Pionniers")){
        const tool=input.tools?.find(item=>item.name==="exact_actor_travel.select") as any;
        return{message:{role:"assistant",content:null,toolCalls:[{id:"travel-to-parc",name:"exact_actor_travel.select",arguments:JSON.stringify({
          candidateId:tool.parameters.properties.candidateId.enum[0],kind:"actor.travel",version:"v1",choices:[]})}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};
      }
      if(currentIntent.includes("Complete the park survey")){
        const tool=input.tools?.find(item=>item.name==="exact_quest_objective.select") as any;
        return{message:{role:"assistant",content:null,toolCalls:[{id:"complete-park-survey",name:"exact_quest_objective.select",arguments:JSON.stringify({
          candidateId:tool.parameters.properties.candidateId.enum[0],digest:tool.parameters.properties.digest.enum[0]})}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};
      }
      return{message:{role:"assistant",content:"complete",toolCalls:[]},usage:null,model:{requestedModel:"test",responseModel:"test"}};
    },getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at)};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const turn=async(declaration:string,idempotencyKey:string)=>app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",
      headers:{"content-type":"application/json"},payload:{campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration,expectedRevision:0,idempotencyKey}});
    expect(events((await turn("I ask the ferryman about the square","place-dialogue")).body).at(-1)).toMatchObject({type:"terminal",payload:{narrationStatus:{source:"provider-assisted",text:expect.stringContaining("Place La Salle")}}});
    expect(events((await turn("Travel to Parc des Pionniers","travel-to-parc")).body).at(-1)).toMatchObject({type:"terminal",payload:{narrationStatus:{source:"provider-assisted",text:"Leaving Place La Salle behind, you arrive at Parc des Pionniers."}}});
    const questTerminal=events((await turn("Complete the park survey","survey-at-parc")).body).at(-1);
    expect(questTerminal).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{source:"deterministic-fallback",
      text:"The authoritative result is clear. Quest objective advanced for Survey the Park: Complete the park survey (1 of 1). The objective is complete. The quest is complete."}}});
    expect(finalNarrationInput.messages[1].content).toMatch(/exactCurrentLocation[^A-Za-z]+Parc des Pionniers/);
    expect(finalNarrationInput.messages.find((message:any)=>message.content.startsWith("UNTRUSTED PRIOR ROOM ADVENTURE HISTORY DATA")).content)
      .toMatch(/Place La Salle[\s\S]*Parc des Pionniers/);
    await app.close();
  });

  it("advances dependent public quest objectives from typed declarations and replays exactly once",async()=>{
    enable();const campaign=seed();const setup=createRepository({clock:{now:()=>new Date(at)}});
    setup.createCampaignStorylineGraph("local-owner",campaign.id,{storyline:{storylineId:"typed-story",title:"Typed progress",summary:null,
      nodes:[],edges:[],plotPoints:[],clues:[]},expectedRevision:0,idempotencyKey:"typed-story-create"});
    setup.createCampaignQuest("local-owner",campaign.id,{quest:{questId:"typed-quest",storylineId:"typed-story",title:"Protect the Records",
      description:"Compare the source records, then protect the private material.",visibility:"public",journalText:"The records need careful handling.",objectives:[
        {objectiveId:"compare-records",description:"Compare the ferry trace with the port manifest",targetProgress:1,dependencyObjectiveIds:[],visibility:"public"},
        {objectiveId:"protect-records",description:"Separate and protect the private recordings",targetProgress:1,dependencyObjectiveIds:["compare-records"],visibility:"public"},
      ],rewards:[]},expectedRevision:0,idempotencyKey:"typed-quest-create"});
    setup.executeQuestCommand("local-owner","typed-quest",{kind:"accept",expectedRevision:1,idempotencyKey:"typed-quest-accept"});setup.close();
    const seenObjectives:string[][]=[];let planningCalls=0,narrationCalls=0;
    const dependencies:AdventureAgentDependencies={complete:async(input)=>{if(input.tools?.some(tool=>tool.name==="submit_adventure_narration")){narrationCalls+=1;
        const narration=narrationCalls===3?"Protect the Records advances to 1 of 1 as the protected records settle into their final order." : "Protect the Records advances to 1 of 1 as the ferry trace aligns with the port manifest.";
        return narrationResult(narration);}
      planningCalls+=1;const tool=input.tools?.find((item)=>item.name==="exact_quest_objective.select") as any;expect(tool).toBeDefined();
      const prompt=input.messages.map((message)=>message.content??"").join("\n");seenObjectives.push([prompt.includes("Compare the ferry trace with the port manifest")?"compare":"",
        prompt.includes("Separate and protect the private recordings")?"protect":""].filter(Boolean));
      return{message:{role:"assistant",content:null,toolCalls:[{id:`quest-choice-${planningCalls}`,name:"exact_quest_objective.select",arguments:JSON.stringify({
        candidateId:tool.parameters.properties.candidateId.enum[0],digest:tool.parameters.properties.digest.enum[0]})}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at)};
    let app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const firstPayload={campaignId:campaign.id,sessionId:"session",actorId:"actor",
      declaration:"I compare the ferry trace with the port manifest and record the matching timestamp.",expectedRevision:0,idempotencyKey:"typed-progress-one"};
    const first=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:firstPayload});
    const firstTerminal=events(first.body).at(-1);expect(firstTerminal).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{status:"completed",source:"provider-assisted",
       text:"Protect the Records advances to 1 of 1 as the ferry trace aligns with the port manifest."}}});
    if(firstTerminal?.type!=="terminal")throw new Error("first terminal missing");const firstRead=await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${firstTerminal.payload.turn.turnId}`});
    expect(firstRead.json()).toMatchObject({turn:{state:"completed"},receipts:firstTerminal.payload.receipts,narrationStatus:{status:"completed"}});
    expect(first.body).not.toMatch(/compare-records|protect-records|typed-quest/);
    expect(seenObjectives[0]).toEqual(["compare"]);
    const duplicate=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:firstPayload});
    expect(events(duplicate.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done"}});
    await app.close();app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const retry=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{variant:"narration-retry",
      campaignId:campaign.id,sessionId:"session",actorId:"actor",priorTurnId:firstTerminal.payload.turn.turnId,expectedRevision:0,idempotencyKey:"typed-progress-retry"}});
    expect(events(retry.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{text:
       "Protect the Records advances to 1 of 1 as the ferry trace aligns with the port manifest."}}});
    const second=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I separate the private recordings and secure them from disclosure.",expectedRevision:0,idempotencyKey:"typed-progress-two"}});
    expect(events(second.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[expect.any(Object)],narrationStatus:{text:
       "Protect the Records advances to 1 of 1 as the protected records settle into their final order."}}});
    expect(seenObjectives[1]).toEqual(["protect"]);
    const state=createRepository();expect(state.listCampaignQuests("local-owner",campaign.id)).toMatchObject({revision:4,
      quests:[expect.objectContaining({questId:"typed-quest",status:"completed"})],objectives:[
        expect.objectContaining({objectiveId:"compare-records",progress:1}),expect.objectContaining({objectiveId:"protect-records",progress:1})]});
    expect(state.getDurableAgentPlanningState("local-owner",firstTerminal.payload.turn.turnId)).toMatchObject({decisionRounds:1,totalToolCalls:1,mutationCalls:1,providerStarts:2});
    expect(state.getAgentProviderRecovery("local-owner",firstTerminal.payload.turn.turnId)).toBeNull();
    const audit=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect(audit.prepare("SELECT count(*) count FROM quest_domain_commands_v33 WHERE idempotency_key LIKE 'adventure-quest:%'").get()).toEqual({count:2});audit.close();
    state.close();await app.close();
  });

  it("rejects provider-authored quest target fields without advancing the objective",async()=>{
    enable();const campaign=seed();const setup=createRepository({clock:{now:()=>new Date(at)}});
    setup.createCampaignStorylineGraph("local-owner",campaign.id,{storyline:{storylineId:"tamper-story",title:"Tamper",summary:null,nodes:[],edges:[],plotPoints:[],clues:[]},
      expectedRevision:0,idempotencyKey:"tamper-story-create"});
    setup.createCampaignQuest("local-owner",campaign.id,{quest:{questId:"tamper-quest",storylineId:"tamper-story",title:"Tamper Quest",description:null,
      visibility:"public",journalText:"Pending",objectives:[{objectiveId:"tamper-objective",description:"Complete the reviewed task",targetProgress:1,
        dependencyObjectiveIds:[],visibility:"public"}],rewards:[]},expectedRevision:0,idempotencyKey:"tamper-quest-create"});
    setup.executeQuestCommand("local-owner","tamper-quest",{kind:"accept",expectedRevision:1,idempotencyKey:"tamper-quest-accept"});setup.close();
    let calls=0;const dependencies:AdventureAgentDependencies={complete:async(input)=>{calls+=1;if(calls===1){const tool=input.tools?.find((item)=>item.name==="exact_quest_objective.select") as any;
        return{message:{role:"assistant",content:null,toolCalls:[{id:"tampered-choice",name:"exact_quest_objective.select",arguments:JSON.stringify({
          candidateId:tool.parameters.properties.candidateId.enum[0],digest:tool.parameters.properties.digest.enum[0],objectiveId:"tamper-objective"})}]},usage:null,model:{requestedModel:"test",responseModel:"test"}};}
      return narrationResult("The task remains unresolved.");},
      getProvider:async()=>({...defaultProviderSettings(),model:"test"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at)};
    const app=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:dependencies});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{
      campaignId:campaign.id,sessionId:"session",actorId:"actor",declaration:"I complete the reviewed task",expectedRevision:0,idempotencyKey:"tampered-progress"}});
    expect(events(response.body).at(-1)).toMatchObject({type:"terminal",payload:{receipts:[],narrationStatus:{text:"The task remains unresolved."}}});
    const state=createRepository();expect(state.listCampaignQuests("local-owner",campaign.id)?.objectives[0]?.progress).toBe(0);state.close();await app.close();
  });

  it("does not treat an ordinary quest command with an adventure-shaped key as a turn receipt",()=>{
    enable();const campaign=seed();const repo=createRepository({clock:{now:()=>new Date(at)}});
    repo.createCampaignStorylineGraph("local-owner",campaign.id,{storyline:{storylineId:"forgery-story",title:"Forgery",summary:null,nodes:[],edges:[],plotPoints:[],clues:[]},
      expectedRevision:0,idempotencyKey:"forgery-story-create"});
    repo.createCampaignQuest("local-owner",campaign.id,{quest:{questId:"forgery-quest",storylineId:"forgery-story",title:"Forgery Quest",description:null,
      visibility:"public",journalText:"Pending",objectives:[{objectiveId:"forgery-objective",description:"Perform the public task",targetProgress:2,
        dependencyObjectiveIds:[],visibility:"public"}],rewards:[]},expectedRevision:0,idempotencyKey:"forgery-quest-create"});
    repo.executeQuestCommand("local-owner","forgery-quest",{kind:"accept",expectedRevision:1,idempotencyKey:"forgery-quest-accept"});
    const turn=repo.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:"I perform the public task",expectedCampaignRevision:0,idempotencyKey:"forgery-turn"});
    repo.executeQuestCommand("local-owner","forgery-quest",{kind:"advance-objective",objectiveId:"forgery-objective",expectedRevision:2,
      idempotencyKey:`adventure-quest:${"a".repeat(32)}:${"b".repeat(32)}`});
    expect(repo.getAdventureTurn("local-owner",turn.turnId)).toMatchObject({state:"declared",receiptLinks:[]});repo.close();
  });

  it("persists fallback narration, replays duplicate initial requests, and reconciles after restart", async () => {
    enable(); process.env.VELVET_SSE_HEARTBEAT_MS = "1"; const campaign = seed();
    const payload = { campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: "I study the quiet door",
      expectedRevision: 0, idempotencyKey: "initial" };
    let app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const first = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload });
    expect(first.statusCode).toBe(200); expect(first.headers["content-type"]).toContain("text/event-stream");
    expect(first.headers["cache-control"]).toBe("private, no-store, no-transform");
    expect(first.body).toContain(": heartbeat\n\n");
    const firstEvents = events(first.body); expect(firstEvents.map(({ type }) => type)).toEqual([
      "turn_started", "agent_status", "agent_status", "narration_delta", "terminal",
    ]);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    const started = firstEvents.find((event) => event.type === "turn_started");
    if (!started || started.type !== "turn_started") throw new Error("turn_started missing");
    const turnId = started.payload.turn.turnId;
    expect(first.headers["x-adventure-turn-id"]).toBe(turnId);
    const duplicate = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload });
    expect(events(duplicate.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done", turn: { turnId } } });
    await app.close();

    app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const located = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/reconcile-initial?${new URLSearchParams({
      campaignId: campaign.id, sessionId: "session", actorId: "actor", idempotencyKey: "initial",
    })}` });
    expect(located.statusCode).toBe(200); expect(located.json()).toMatchObject({ result: { turn: { turnId } } });
    const absent = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/reconcile-initial?${new URLSearchParams({
      campaignId: campaign.id, sessionId: "session", actorId: "actor", idempotencyKey: "not-committed",
    })}` });
    expect(absent.json()).toEqual({ result: null });
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` });
    expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({ turn: { turnId, state: "completed" }, proposals: [], receipts: [],
      narrationStatus: { status: "completed", text: expect.stringContaining("remains pending"),source:"deterministic-fallback" } });
    expect(read.body).not.toMatch(/providerCalls|argumentsJson|principalId/);
    await app.close();
  });

  it.each(["approve", "reject"] as const)("recovers a lost %s confirmation response by GET and resumes after restart", async (decision) => {
    enable(); const campaign = seed(); const repo = createRepository();
    const turn = repo.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I choose", expectedCampaignRevision: 0, idempotencyKey: `lost-${decision}` });
    const proposed = repo.appendToolProposal("local-owner", { turnId: turn.turnId, toolName: "roll-check", arguments: {}, requiresConfirmation: true,
      confirmationExpiresAt: expires, expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: `proposal-${decision}` });
    repo.waitForToolConfirmation("local-owner", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: `wait-${decision}` });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const confirmed = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" },
      payload: { proposalIds: [proposed.toolCalls[0]!.proposal.proposalId], decision, expectedRevision: 2, idempotencyKey: `confirm-${decision}` } });
    expect(confirmed.statusCode).toBe(200); await app.close();
    const restarted = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const read = await restarted.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turn.turnId}` });
    expect(read.json().resumeToken).toMatch(/^v1\./); expect(read.body).not.toMatch(/decisionId|principalId|batch:/);
    expect(read.json().resumeToken).toBe(confirmed.json().resumeToken);
    const resumed = await restarted.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" },
      payload: { resumeToken: read.json().resumeToken } });
    expect(resumed.statusCode).toBe(200);const streamed=events(resumed.body);if(decision==="reject"){expect(streamed).toHaveLength(2);expect(streamed[0]).toMatchObject({type:"agent_status",payload:{status:"decision-rejected"}});expect(streamed[1]).toMatchObject({type:"terminal"});}
    else expect(streamed[0]).toMatchObject({type:"agent_status"});
    await restarted.close();
  });

  it("seals duplicate confirmation and validates a restart-safe resume token", async () => {
    enable(); const campaign = seed(); const repo = createRepository();
    const turn = repo.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I open it", expectedCampaignRevision: 0, idempotencyKey: "confirm-turn" });
    const proposed = repo.appendToolProposal("local-owner", { turnId: turn.turnId, toolName: "roll-check", arguments: {}, requiresConfirmation: true,
      confirmationExpiresAt: expires, expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "proposal" });
    repo.waitForToolConfirmation("local-owner", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "wait" });
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const payload = { proposalIds: [proposalId], decision: "approve", expectedRevision: 2, idempotencyKey: "confirm" };
    const first = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" }, payload });
    const second = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" }, payload });
    expect(first.statusCode).toBe(200); expect(second.json()).toEqual(first.json()); expect(first.json().resumeToken).toMatch(/^v1\./);
    await app.close();
    const restarted = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const resumed = await restarted.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: { resumeToken: first.json().resumeToken } });
    expect(resumed.headers["x-adventure-turn-id"]).toBe(turn.turnId);
    expect(events(resumed.body).map(({ type }) => type)).toEqual(["agent_status", "terminal"]);
    expect(resumed.body).not.toContain("turn_started"); expect(resumed.body).not.toContain("mechanics_committed");
    await restarted.close();
  });

  it("streams durable proposal, atomic confirmation, crash receipt recovery, and resumed narration without rerunning mechanics", async () => {
    enable(); const campaign = seed(); let repo = createRepository();
    const create = { campaignId: campaign.id, timelineId: campaign.activeTimelineId, sessionId: "session", actorId: "actor",
      declaration: "I test the ancient lock", expectedCampaignRevision: 0, idempotencyKey: "full-turn" };
    const turn = repo.createAdventureTurn("local-owner", create);
    const proposed = repo.appendToolProposal("local-owner", { turnId: turn.turnId, toolName: "roll-check", arguments: {}, requiresConfirmation: true,
      confirmationExpiresAt: expires, expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "full-proposal" });
    repo.waitForToolConfirmation("local-owner", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "full-wait" });
    let app = buildApp({ campaignRepositoryFactory: () => repo });
    const waiting = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: {
      campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: create.declaration, expectedRevision: 0, idempotencyKey: create.idempotencyKey,
    } });
    expect(events(waiting.body).map(({ type }) => type)).toEqual([
      "turn_started", "agent_status", "tool_proposed", "confirmation_required", "terminal",
    ]);
    expect(waiting.body).not.toMatch(/executionBinding|mechanics:[a-f0-9]+/);
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const confirmed = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" },
      payload: { proposalIds: [proposalId], decision: "approve", expectedRevision: 2, idempotencyKey: "full-confirm" } });
    expect(confirmed.statusCode).toBe(200); const token = confirmed.json().resumeToken as string;
    await app.close();

    repo = createRepository();
    repo.executeRollActorDice("local-owner", { commandId: "full-command", idempotencyKey: proposed.toolCalls[0]!.proposal.executionBinding.idempotencyKey, campaignId: campaign.id,
      timelineId: campaign.activeTimelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: turn.turnId,
       command: { type: "roll_actor_dice", payload: { expression: "1d20+8" } } });
    repo.close();
    app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const recovered = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turn.turnId}` });
    expect(recovered.json()).toMatchObject({ turn: { state: "mechanics-committed" }, receipts: [{ commandId: "full-command", proposalId }] });
    const before = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(before.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(turn.turnId)).toEqual({ count: 0 }); before.close();
    const resumed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: { resumeToken: token } });
    expect(events(resumed.body).map(({ type }) => type)).toEqual([
      "agent_status", "mechanics_committed", "agent_status", "narration_delta", "terminal",
    ]);
    const after = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(after.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(turn.turnId)).toEqual({ count: 1 });
    expect(after.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(turn.turnId)).toEqual({ count: 1 }); after.close();
    const rollNarration=events(resumed.body).find((event)=>event.type==="narration_delta");
    expect(rollNarration).toMatchObject({type:"narration_delta",payload:{text:expect.stringMatching(/^The authoritative result is clear\. The dice come up \d+\. The attempt is made and the moment is still open; no success or failure is recorded yet\.$/)}});

    let priorTurnId = turn.turnId;
    for (const [variant, key] of [["narration-retry", "retry-one"], ["narration-retry", "retry-two"], ["narration-swipe", "swipe"]] as const) {
      const derivative = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" },
        payload: { variant, campaignId: campaign.id, sessionId: "session", actorId: "actor", priorTurnId, expectedRevision: 0, idempotencyKey: key } });
      expect(derivative.statusCode).toBe(200);
      const derivativeEvents = events(derivative.body); expect(derivativeEvents.map(({ type }) => type)).toEqual([
        "turn_started", "agent_status", "mechanics_committed", "agent_status", "narration_delta", "terminal",
      ]);
      const startedDerivative = derivativeEvents[0]; if (startedDerivative?.type !== "turn_started") throw new Error("derivative start missing");
      expect(startedDerivative.payload.turn).toMatchObject({ mode: variant, priorTurnId });
      const terminalDerivative = derivativeEvents.at(-1); expect(terminalDerivative).toMatchObject({ payload: { receipts: [{ commandId: "full-command", proposalId }] } });
      priorTurnId = startedDerivative.payload.turn.turnId;
    }
    const derivativeDb = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(derivativeDb.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(turn.turnId)).toEqual({ count: 1 });
    expect(derivativeDb.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id<>?").get(turn.turnId)).toEqual({ count: 0 });
    expect(derivativeDb.prepare("SELECT revision FROM adventure_turns WHERE id=?").get(priorTurnId)).toEqual({ revision: 4 });
    derivativeDb.close();
    await app.close();
  });

  it("aborts provider orchestration when the SSE client disconnects", async () => {
    enable(); const campaign = seed(); let completeStarted = false; let completeAborted = false;
    const dependencies: AdventureAgentDependencies = {
      complete: async ({ signal }) => new Promise((_resolve, reject) => {
        completeStarted = true;
        signal?.addEventListener("abort", () => { completeAborted = true; reject(new Error("stream disconnected")); }, { once: true });
      }),
      getProvider: async () => ({ ...defaultProviderSettings(), baseUrl: "http://127.0.0.1:1/v1", model: "fake" }),
      getHarness: async () => defaultHarnessSettings(), now: () => new Date(),
    };
    const app = buildApp({ campaignRepositoryFactory: () => createRepository(), adventureAgentDependencies: dependencies });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/rpg/v1/adventure-turns/stream`, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignId: campaign.id, sessionId: "session", actorId: "actor",
        declaration: "I wait beside the arch", expectedRevision: 0, idempotencyKey: "disconnect-turn" }) });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let received = "";
    while (!received.includes("event: turn_started")) received += decoder.decode((await reader.read()).value, { stream: true });
    const match = received.match(/data: (\{[^\n]+\})/); if (!match) throw new Error("turn_started data missing");
    const started = adventureTurnStreamEventSchema.parse(JSON.parse(match[1]!));
    if (started.type !== "turn_started") throw new Error("unexpected first event");
    for (let attempts = 0; !completeStarted && attempts < 100; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completeStarted).toBe(true);
    controller.abort();
    for (let attempts = 0; !completeAborted && attempts < 100; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completeAborted).toBe(true);
    const reconciled = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${started.payload.turn.turnId}` });
    expect(reconciled.json()).toMatchObject({ turn: { state: "declared" }, narrationStatus: { status: "none" } });
    await app.close();
  });

  it("gets a bounded room transcript with narration derivatives collapsed and internals absent",async()=>{
    enable();const campaign=seed();const repo=createRepository({clock:{now:()=>new Date(at)}});
    let original=repo.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",
      actorId:"actor",declaration:"I ask what waits beyond",expectedCampaignRevision:0,idempotencyKey:"http-transcript-original"});
    original=repo.updateAdventureTurnNarration("local-owner",{turnId:original.turnId,expectedTurnRevision:original.revision,expectedCampaignRevision:0,
      idempotencyKey:"http-transcript-original-progress",narrationStatus:"in-progress"});
    original=repo.updateAdventureTurnNarration("local-owner",{turnId:original.turnId,expectedTurnRevision:original.revision,expectedCampaignRevision:0,
      idempotencyKey:"http-transcript-original-done",narrationStatus:"completed",terminalState:"completed",fallbackNarration:"The first answer."});
    let swipe=repo.createAdventureTurn("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,sessionId:"session",actorId:"actor",
      declaration:original.declaration,mode:"narration-swipe",priorTurnId:original.turnId,expectedCampaignRevision:0,idempotencyKey:"http-transcript-swipe"});
    swipe=repo.updateAdventureTurnNarration("local-owner",{turnId:swipe.turnId,expectedTurnRevision:swipe.revision,expectedCampaignRevision:0,
      idempotencyKey:"http-transcript-swipe-progress",narrationStatus:"in-progress"});
    repo.updateAdventureTurnNarration("local-owner",{turnId:swipe.turnId,expectedTurnRevision:swipe.revision,expectedCampaignRevision:0,
      idempotencyKey:"http-transcript-swipe-done",narrationStatus:"completed",terminalState:"completed",fallbackNarration:"The revised answer."});
    const app=buildApp({campaignRepositoryFactory:()=>repo});const response=await app.inject({method:"GET",
      url:`/api/rpg/v1/adventure-turns/transcript?${new URLSearchParams({campaignId:campaign.id,sessionId:"session"})}`});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({campaignId:campaign.id,sessionId:"session",turns:[{
      turnId:original.turnId,actorId:"actor",declaration:"I ask what waits beyond",narration:"The revised answer.",completedAt:at}]});
    expect(response.body).not.toMatch(/priorTurnId|provider|proposal|receipt|tool|principal|idempotency/);
    expect((await app.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/transcript?campaignId=${campaign.id}&sessionId=session&limit=99`})).statusCode).toBe(400);
    await app.close();
  });

  it("gates before access and returns heartbeat-safe redacted framing and problems", async () => {
    let accesses = 0;
    const app = buildApp({ campaignRepositoryFactory: () => { accesses += 1; return { close() {}, listCampaigns: () => [] } as unknown as CampaignListRepository; } });
    const gated = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream?private=1", headers: { "content-type": "application/json" }, payload: {} });
    expect(gated.statusCode).toBe(404); expect(accesses).toBe(0); expect(gated.body).not.toContain("private=1");
    enable();
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream?private=1", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/adventure-turns/private-turn/confirm" })).json()).toMatchObject({
      code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/adventure-turns/:turnId/confirm",
    });
    await app.close();
  });

  it("uses the static safe instance for initial reconciliation failures and unsupported methods", async () => {
    enable();
    const repo = createRepository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const instance = "/api/rpg/v1/adventure-turns/reconcile-initial";

    const malformed = await app.inject({
      method: "GET",
      url: `${instance}?campaignId=query-secret&sessionId=session&actorId=actor`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", instance });
    expect(malformed.body).not.toContain("query-secret");

    const unsupported = await app.inject({
      method: "POST",
      url: `${instance}?idempotencyKey=unsupported-secret`,
    });
    expect(unsupported.statusCode).toBe(404);
    expect(unsupported.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance });
    expect(unsupported.body).not.toContain("unsupported-secret");

    repo.getAdventureTurnByInitialIdempotencyKey = () => { throw new Error("repository failed"); };
    const failed = await app.inject({
      method: "GET",
      url: `${instance}?${new URLSearchParams({
        campaignId: "campaign", sessionId: "session", actorId: "actor", idempotencyKey: "internal-secret",
      })}`,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", instance });
    expect(failed.body).not.toContain("internal-secret");

    await app.close();
  });
});
