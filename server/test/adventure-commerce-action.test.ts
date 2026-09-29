import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY,type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { defaultHarnessSettings,defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn,type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { createRepository,MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { recordSystemOneDecision, type RecordSystemOneDecisionInput } from "../src/repo/index.js";
import { narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at="2035-01-01T00:00:00.000Z",item={kind:"item" as const,packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion,definitionId:"velvet:mechanics:item:waylamp"},currency={kind:"currency" as const,packId:MECHANICS_STARTER_CATALOG.manifest.packId,packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion,definitionId:"velvet:mechanics:currency:glimmer"};
const scores=Object.fromEntries(["might","agility","resolve","insight","presence","craft"].map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]]))as CharacterBuilderAttributeScores;
let sequence=0;
function fixture(){let time=new Date(at);const repo=createRepository({clock:{now:()=>time}}),campaign=repo.createCampaign("local-owner",{name:"Vendor adventure"});repo.installMechanicsStarterCatalog("local-owner");repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:`pins-${++sequence}`});const actorPersona=repo.createCharacter({name:"Aster",age:25,archetype:"Warden",boundaries:"",fictionalConfirmed:true}),vendorPersona=repo.createCharacter({name:"Mara",age:40,archetype:"Merchant",boundaries:"",fictionalConfirmed:true});const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:actorPersona.id,controllerPrincipalId:"local-owner",durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:`draft-${++sequence}`}),definitions=MECHANICS_STARTER_CATALOG.definitions,selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:`select-${++sequence}`,selections:{race:definitions.find(x=>x.reference.kind==="race")!.reference as any,background:definitions.find(x=>x.reference.kind==="background")!.reference as any,class:definitions.find(x=>x.reference.kind==="class")!.reference as any,starterGrant:"kit"}}as any),actorId=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:`final-${++sequence}`}).receipt.actorId,sessionId=`vendor-session-${++sequence}`;
  repo.createLocation("local-owner",{campaignId:campaign.id,locationId:"market",name:"Market",description:"Open stalls"});repo.createNpc("local-owner",{campaignId:campaign.id,npcId:"mara",personaId:vendorPersona.id,name:"Mara",speechControl:"manual"});
  const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.pragma("foreign_keys=ON");db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId,actorPersona.id,at);db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId,actorPersona.id);db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId,campaign.id,at);db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id,actorId,"market",sessionId,at);for(const reference of [item,currency])db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25 VALUES(?,?,?,?,?)").run(campaign.id,reference.packId,reference.packVersion,reference.kind,reference.definitionId);db.prepare("INSERT INTO rpg_currency_references_v25 VALUES(?,?,?,?,?,?)").run(campaign.id,"GLM",currency.packId,currency.packVersion,"currency",currency.definitionId);db.prepare("INSERT INTO rpg_wallets_v25 VALUES(?,?,?,?,?)").run(campaign.id,actorId,"GLM",30,at);db.prepare("INSERT INTO rpg_shop_definitions_v25 VALUES('shop',?,?,?)").run(campaign.id,"Mara's Goods",at);db.prepare("INSERT INTO rpg_shop_stock_v25 VALUES('stock',?,'shop',?,?, 'item',?,3,10,'GLM')").run(campaign.id,item.packId,item.packVersion,item.definitionId);db.close();repo.mutateNpcPresence("local-owner",{campaignId:campaign.id,sessionId,npcId:"mara",expectedRevision:0,idempotencyKey:`presence-${++sequence}`,mutation:{kind:"place",locationId:"market"}});repo.associateNpcShop("local-owner",campaign.id,"mara","shop");repo.setShopBuyPolicy("local-owner",campaign.id,"shop","stock",4);return{repo,campaign,actorId,sessionId,setTime:(value:string)=>{time=new Date(value);}};}
function turn(f:ReturnType<typeof fixture>,text:string){return f.repo.createAdventureTurn("local-owner",{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.sessionId,actorId:f.actorId,declaration:text,expectedCampaignRevision:1,idempotencyKey:`turn-${++sequence}`});}
const deps=(candidate:{candidateId:string;digest:string}):AdventureAgentDependencies=>({getProvider:async()=>({...defaultProviderSettings(),model:"fake"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(at),complete:async input=>{const parameters=input.tools?.find(value=>value.name==="exact_vendor_commerce.select")?.parameters as any;expect(parameters.oneOf[0].required).toEqual(["candidateId","digest"]);return{message:{role:"assistant",content:null,toolCalls:[{id:`commerce-call-${++sequence}`,name:"exact_vendor_commerce.select",arguments:JSON.stringify({candidateId:candidate.candidateId,digest:candidate.digest})}]},usage:null,model:{requestedModel:"fake",responseModel:"fake"}};}});

/** Records one already-settled server/lane commerce decision the lane proposal must bind. */
function laneDecision(f:ReturnType<typeof fixture>,turnId:string,overrides:Partial<RecordSystemOneDecisionInput>={}){
  const input:RecordSystemOneDecisionInput={decisionId:"commerce-lane-decision:1",lane:"adventure-selection",campaignId:f.campaign.id,
    sessionId:f.sessionId,turnId,provider:"typesafe",model:"fake",confidencePolicyVersion:"v1",state:{declaration:"buy a waylamp"},
    questions:{support:0.9},answers:{support:0.9},selection:{method:"act",selection:null},confidenceBand:"act",fallbackUsed:false,
    shadow:false,usage:null,latencyMs:1,createdAt:at,...overrides};
  recordSystemOneDecision(input);return input;
}

describe("exact adventure vendor commerce",()=>{
  it("confirms, buys, publishes safe balances, narrates receipts, and replays after restart",async()=>{const f=fixture(),created=turn(f,"buy a waylamp from Mara"),candidate=f.repo.generateAdventureCommerceCandidates("local-owner",created.turnId).find(value=>value.action==="buy")!;expect(candidate).toMatchObject({vendorLabel:"Mara",shopLabel:"Mara's Goods",itemLabel:"Waylamp",priceMinorUnits:10,confirmationRequired:true});const waiting=await orchestrateAdventureTurn(f.repo,created.turnId,deps(candidate));expect(waiting.outcome).toBe("awaiting-confirmation");const proposal=waiting.turn.toolCalls[0]!.proposal;expect(proposal.policy.review.summary).toMatch(/Mara.*Waylamp.*10 Glimmer/i);f.repo.decideToolProposals("local-owner",{turnId:created.turnId,proposalIds:[proposal.proposalId],decision:"approved",expectedTurnRevision:waiting.turn.revision,expectedCampaignRevision:1,idempotencyKey:`approve-${++sequence}`});const completed=await orchestrateAdventureTurn(f.repo,created.turnId,{...deps(candidate),complete:async()=>{throw new Error("must not redispatch");}}),command=completed.turn.receiptLinks[0]!.commandId,receipt=f.repo.getAdventureCommercePublicReceipt("local-owner",f.campaign.id,command)!;expect(receipt).toMatchObject({action:"buy",balanceBefore:30,balanceAfter:20,debitMinorUnits:10,creditMinorUnits:0});expect(JSON.stringify(receipt)).not.toMatch(/candidate|actorId|npcId|shopId|entryId|packId|definitionId|provider|digest/);expect(narrationFallback("",[{kind:"commerce",action:receipt.action,vendorLabel:receipt.vendorLabel,shopLabel:receipt.shopLabel,itemLabel:receipt.itemLabel,quantity:receipt.quantity,currencyLabel:receipt.currencyLabel,priceMinorUnits:receipt.priceMinorUnits,balanceBefore:receipt.balanceBefore,balanceAfter:receipt.balanceAfter}])).toContain("balance changes from 30 to 20");f.repo.close();const reopened=createRepository({clock:{now:()=>new Date(at)}}),replayed=await orchestrateAdventureTurn(reopened,created.turnId,{...deps(candidate),complete:async()=>{throw new Error("must not redispatch");}});expect(replayed.turn.receiptLinks[0]!.commandId).toBe(command);reopened.close();});
  it("fails closed for hidden and absent vendors",()=>{const f=fixture();const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.prepare("UPDATE campaign_locations_v28 SET visibility='gm' WHERE location_id='market'").run();db.close();expect(f.repo.generateAdventureCommerceCandidates("local-owner",turn(f,"hidden").turnId)).toEqual([]);const visible=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));visible.prepare("UPDATE campaign_locations_v28 SET visibility='public' WHERE location_id='market'").run();visible.close();f.repo.mutateNpcPresence("local-owner",{campaignId:f.campaign.id,sessionId:f.sessionId,npcId:"mara",expectedRevision:1,idempotencyKey:`leave-${++sequence}`,mutation:{kind:"remove"}});expect(f.repo.generateAdventureCommerceCandidates("local-owner",turn(f,"absent").turnId)).toEqual([]);f.repo.close();});
  it("issues a standalone vendor sale quote and sells through the economy lane",()=>{
    const f=fixture();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    const entry=db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND item_definition_id=? AND equipped=0").get(f.campaign.id,f.actorId,"velvet:mechanics:item:waylamp")as{entry_id:string}|undefined;
    db.close();expect(entry).toBeDefined();
    const quote=f.repo.requestVendorSaleQuote("local-owner",f.campaign.id,f.actorId,{entryId:entry!.entry_id,quantity:1});
    expect(quote).toMatchObject({shopId:"shop",entryId:entry!.entry_id,quantity:1,payout:{minorUnits:4,currency:{kind:"currency",definitionId:"velvet:mechanics:currency:glimmer"}}});
    const result=f.repo.mutateEconomyForActor("local-owner",f.campaign.id,f.actorId,{kind:"sell_to_shop",quoteId:quote!.quoteId,expectedRevision:quote!.expectedRevision,idempotencyKey:"standalone-sell-once"});
    expect((result as unknown as {sale:{disposition:string;quantity:number;total:{minorUnits:number}}}).sale).toMatchObject({disposition:"sell",quantity:1,total:{minorUnits:4}});
    expect(f.repo.requestVendorSaleQuote("local-owner",f.campaign.id,f.actorId,{entryId:entry!.entry_id,quantity:9})).toBeNull();
    f.repo.close();
  });

  it.each(["sell","give"] as const)("confirms and commits a natural-language vendor %s without dropping the item",async action=>{const f=fixture(),created=turn(f,`${action} my waylamp to Mara`),candidate=f.repo.generateAdventureCommerceCandidates("local-owner",created.turnId).find(value=>value.action===action)!;expect(candidate).toBeDefined();const waiting=await orchestrateAdventureTurn(f.repo,created.turnId,deps(candidate)),proposal=waiting.turn.toolCalls[0]!.proposal;expect(waiting.outcome).toBe("awaiting-confirmation");expect(proposal.policy.review.summary).toContain("Waylamp");f.repo.decideToolProposals("local-owner",{turnId:created.turnId,proposalIds:[proposal.proposalId],decision:"approved",expectedTurnRevision:waiting.turn.revision,expectedCampaignRevision:1,idempotencyKey:`approve-${++sequence}`});const completed=await orchestrateAdventureTurn(f.repo,created.turnId,{...deps(candidate),complete:async()=>{throw new Error("must not redispatch");}}),receipt=f.repo.getAdventureCommercePublicReceipt("local-owner",f.campaign.id,completed.turn.receiptLinks[0]!.commandId)!;expect(receipt.action).toBe(action);expect(receipt.creditMinorUnits).toBe(action==="sell"?4:0);const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});expect(db.prepare("SELECT available_quantity FROM rpg_shop_stock_v25 WHERE stock_id='stock'").get()).toEqual({available_quantity:4});expect(db.prepare("SELECT count(*) count FROM rpg_vendor_sale_receipts_v57 WHERE disposition=?").get(action)).toEqual({count:1});db.close();f.repo.close();});

  it("appends one lane-origin confirmation-required commerce proposal and replays per decision",()=>{
    const f=fixture(),created=turn(f,"buy a waylamp from Mara"),candidate=f.repo.generateAdventureCommerceCandidates("local-owner",created.turnId).find(value=>value.action==="buy")!;
    laneDecision(f,created.turnId);
    const input={turnId:created.turnId,decisionId:"commerce-lane-decision:1",candidateId:candidate.candidateId,digest:candidate.digest,
      expectedTurnRevision:created.revision,expectedCampaignRevision:created.campaignRevision,idempotencyKey:"lane-commerce-append"};
    const first=f.repo.appendAdventureCommerceProposalFromLane("local-owner",input);
    expect(first.toolCalls).toHaveLength(1);
    const proposal=first.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("vendor_buy");
    expect(proposal.confirmation.state).toBe("pending");
    expect(proposal.policy.review.summary).toMatch(/Mara.*Waylamp.*10 Glimmer/i);

    const replay=f.repo.appendAdventureCommerceProposalFromLane("local-owner",input);
    expect(replay.toolCalls).toHaveLength(1);
    expect(replay.toolCalls[0]!.proposal.proposalId).toBe(proposal.proposalId);

    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_commerce_bindings_v57 WHERE campaign_id=? AND turn_id=?").get(f.campaign.id,created.turnId))
      .toMatchObject({origin:"lane",system_one_decision_id:"commerce-lane-decision:1",provider_call_id:null,provider_tool_call_id:null,
        candidate_id:candidate.candidateId,candidate_digest:candidate.digest});
    db.close();f.repo.close();
  });

  it("commits a lane-origin commerce proposal only through the ordinary confirmation API",()=>{
    const f=fixture(),created=turn(f,"buy a waylamp from Mara"),candidate=f.repo.generateAdventureCommerceCandidates("local-owner",created.turnId).find(value=>value.action==="buy")!;
    laneDecision(f,created.turnId);
    const proposed=f.repo.appendAdventureCommerceProposalFromLane("local-owner",{turnId:created.turnId,decisionId:"commerce-lane-decision:1",
      candidateId:candidate.candidateId,digest:candidate.digest,expectedTurnRevision:created.revision,expectedCampaignRevision:created.campaignRevision,
      idempotencyKey:"lane-commerce-commit-append"});
    const proposalId=proposed.toolCalls[0]!.proposal.proposalId;
    // Without an approved confirmation nothing can execute, so the server never spends silently.
    expect(()=>f.repo.executeAdventureCommerceProposal("local-owner",created.turnId,proposalId)).toThrow("not executable");

    const waiting=f.repo.waitForToolConfirmation("local-owner",{turnId:created.turnId,expectedTurnRevision:proposed.revision,
      expectedCampaignRevision:proposed.campaignRevision,idempotencyKey:"lane-commerce-wait"});
    expect(waiting.state).toBe("awaiting-confirmation");
    f.repo.decideToolProposals("local-owner",{turnId:created.turnId,proposalIds:[proposalId],decision:"approved",
      expectedTurnRevision:waiting.revision,expectedCampaignRevision:waiting.campaignRevision,idempotencyKey:"lane-commerce-approve"});
    const committed=f.repo.executeApprovedAgentProposalAtomically("local-owner",created.turnId,proposalId);
    expect(committed.status).toBe("committed");
    expect(committed.turn.receiptLinks).toHaveLength(1);
    const commandId=committed.turn.receiptLinks[0]!.commandId;
    const receipt=f.repo.getAdventureCommercePublicReceipt("local-owner",f.campaign.id,commandId)!;
    expect(receipt).toMatchObject({action:"buy",itemLabel:"Waylamp",balanceBefore:30,balanceAfter:20,debitMinorUnits:10});

    const replay=f.repo.executeApprovedAgentProposalAtomically("local-owner",created.turnId,proposalId);
    expect(replay.status).toBe("committed");
    expect(replay.turn.receiptLinks[0]!.commandId).toBe(commandId);

    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    expect(db.prepare("SELECT * FROM adventure_commerce_executions_v57 WHERE turn_id=?").get(created.turnId))
      .toMatchObject({origin:"lane",system_one_decision_id:"commerce-lane-decision:1",provider_call_id:null,provider_tool_call_id:null,command_id:commandId});
    expect(db.prepare("SELECT count(*) count FROM adventure_commerce_executions_v57 WHERE turn_id=?").get(created.turnId)).toEqual({count:1});
    db.close();f.repo.close();
  });

  it("rejects unavailable decisions, tampered selections, and unadvertised lane candidates without writing",()=>{
    const f=fixture(),created=turn(f,"buy a waylamp from Mara"),candidate=f.repo.generateAdventureCommerceCandidates("local-owner",created.turnId).find(value=>value.action==="buy")!;
    laneDecision(f,created.turnId);
    const base={turnId:created.turnId,decisionId:"commerce-lane-decision:1",candidateId:candidate.candidateId,digest:candidate.digest,
      expectedTurnRevision:created.revision,expectedCampaignRevision:created.campaignRevision,idempotencyKey:"lane-commerce-reject"};
    const append=(overrides:Record<string,unknown>)=>f.repo.appendAdventureCommerceProposalFromLane("local-owner",{...base,...overrides});
    expect(()=>append({decisionId:"missing-decision"})).toThrow("not bound to an advertised lane candidate");
    expect(()=>append({digest:"0".repeat(64)})).toThrow("not bound to an advertised lane candidate");
    expect(()=>append({candidateId:`commerce-candidate:${"0".repeat(48)}`})).toThrow("not bound to an advertised lane candidate");
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    expect(db.prepare("SELECT count(*) count FROM adventure_commerce_bindings_v57 WHERE campaign_id=? AND turn_id=?").get(f.campaign.id,created.turnId)).toEqual({count:0});
    db.close();f.repo.close();
  });
});
