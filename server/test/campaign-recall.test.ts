import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";
import { createRepository } from "../src/repo/index.js";
import { MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { orchestrateAdventureTurn } from "../src/agent/adventureOrchestrator.js";
import { dmDependencies } from "./fixtures/dmCampaign.js";
import { CAMPAIGN_RECALL_MAX_BYTES, type CampaignRecallQuery } from "../src/repo/campaign/campaignRecallReadRepo.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
type Fixture = Awaited<ReturnType<typeof dmFixture>>;
function query(f: Fixture, text: string): CampaignRecallQuery {
  return { campaignId: f.campaign.id, sessionId: f.session.id, audience: { kind: "player", actorId: f.actorId },
    query: text, purpose: "public-narration" };
}
function declare(f: Fixture, text: string, idempotencyKey: string) {
  return f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, sessionId: f.session.id,
    timelineId: f.repo.getCampaign("local-owner", f.campaign.id)!.activeTimelineId, actorId: f.actorId, declaration: text,
    expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey });
}
function narrate(f: Fixture, id: string, text: string) {
  let turn = f.repo.getAdventureTurn("local-owner", id)!;
  turn = f.repo.updateAdventureTurnNarration("local-owner", { turnId: id, expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `start-${id}`, narrationStatus: "in-progress" });
  return f.repo.updateAdventureTurnNarration("local-owner", { turnId: id, expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `finish-${id}`, narrationStatus: "completed",
    terminalState: "completed", fallbackNarration: text });
}

describe("bounded source-attributed campaign recall", () => {
  it("freezes query-derived planning recall in the existing request ledger and rejects changed evidence before executing", async () => {
    const f=await dmFixture();
    declare(f,"I ask about the moonstone promise","old-promise");
    const current=declare(f,"What was the moonstone promise?","question");
    let calls=0;
    const dependencies={...dmDependencies(async input=>{
      calls++;
      expect(JSON.stringify(input.messages)).toContain("moonstone promise");
      expect(JSON.stringify(input.messages)).toContain("HISTORICAL RECALL");
      declare(f,"The moonstone promise has another witness","new-evidence");
      return {message:{role:"assistant" as const,content:"The promise was discussed."},usage:null,model:{requestedModel:"fake-dm",responseModel:"fake-dm"}};
    }),now:f.options.clock.now};
    const result=await orchestrateAdventureTurn(f.repo,current.turnId,dependencies);
    expect(result.outcome).toBe("fallback");
    const db=database();
    const stored=db.prepare("SELECT request_json FROM agent_provider_contexts_v39 WHERE turn_id=?").get(current.turnId) as {request_json:string};
    expect(stored.request_json).toContain("moonstone promise");
    expect(stored.request_json).not.toContain("another witness");
    db.close();
    await orchestrateAdventureTurn(f.repo,current.turnId,dependencies);
    expect(calls).toBe(1);
    f.repo.close();
  });

  it("recalls committed director receipts without successful narration and never hydrates director prose", async () => {
    const f=await dmFixture();f.graph();
    f.repo.setDmControl("local-owner",f.campaign.id,{mode:"ai",expectedRevision:0,idempotencyKey:"auto"});
    const run=f.repo.openDmBeat("local-owner",f.campaign.id,f.session.id,{intent:"open",expectedModeRevision:1,idempotencyKey:"open"});
    const work=f.repo.claimDmPlanning("local-owner",run.runId,"fake","fake")!;
    const candidate=work.candidates.find(candidate=>candidate.action==="reveal-node")!;
    f.repo.settleDmPlanning("local-owner",run.runId,work.claimId,{candidateId:candidate.candidateId,digest:candidate.digest},{promptTokens:1,completionTokens:1});
    f.repo.executeDmBeat("local-owner",run.runId);
    const request={...query(f,"gate"),audience:{kind:"dm" as const},purpose:"dm-narration" as const};
    const result=f.repo.getCampaignRecall("local-owner",request)!;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({sourceKind:"director-receipt",authority:"committed-outcome",sourceId:run.runId});
    expect(result.hits[0]!.text).toContain("Scene revealed");
    expect(JSON.stringify(result)).not.toContain("SECRET_GATE");
    declare(f,"I claim the gate is destroyed","gate-intent");
    expect(f.repo.getCampaignRecall("local-owner",request)!.hits).toEqual(result.hits);
    f.repo.close();
  });
  it("retrieves old intent and presentation beyond 100 later turns and old recaps beyond latest three, with no filler", async () => {
    const f = await dmFixture();
    const old = declare(f, "I ask the ferryman about the silver heron", "old");
    narrate(f, old.turnId, 'The ferryman claims, "The silver heron arrives at dusk."');
    for (let i = 0; i < 105; i++) { f.advance(); declare(f, `I inspect ordinary cobblestones number ${i}`, `noise-${i}`); }
    for (let i = 0; i < 6; i++) f.repo.createCampaignRecap("local-owner", f.campaign.id, {
      timelineId: f.campaign.activeTimelineId, throughRevision: f.repo.getCampaignTimeline("local-owner", f.campaign.id, f.campaign.activeTimelineId)!.revision,
      selectedSessionIds: [f.session.id], visibility: "members", text: i === 0 ? "The silver heron was discussed." : `Routine day ${i}`,
      expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: `recap-${i}` });
    const request = query(f, "What did the ferryman say about the silver heron?");
    const recall = f.repo.getCampaignRecall("local-owner", request)!;
    expect(recall.hits.map(hit => hit.sourceKind).sort()).toEqual(["declaration", "presentation", "recap"]);
    expect(recall.hits.find(hit => hit.sourceKind === "declaration")).toMatchObject({ sourceId: old.turnId,
      rootTurnId: old.turnId, actorId: f.actorId, authority: "intent" });
    expect(recall.hits.find(hit => hit.sourceKind === "presentation")).toMatchObject({ rootTurnId: old.turnId, authority: "noncanonical-presentation" });
    expect(recall.hits.every(hit => /^[a-f0-9]{64}$/.test(hit.digest))).toBe(true);
    expect(f.repo.getCampaignRecall("local-owner", request)).toEqual(recall);
    expect(f.repo.getCampaignRecall("local-owner", { ...request, audience: { actorId: f.actorId, kind: "player" } })).toEqual(recall);
    expect(f.repo.getCampaignRecall("local-owner", query(f, "quartz zeppelin"))!.hits).toEqual([]);
    expect(f.repo.getCampaignRecall("local-owner", query(f, "what did we do?"))!.hits).toEqual([]);
    expect(f.repo.getCampaignRecall("local-owner", query(f, "her"))!.hits).toEqual([]);
    f.repo.close();
  });

  it("applies player policy before ranking even for local-owner, excludes GM recaps and revoked membership", async () => {
    const f = await dmFixture();
    declare(f, "The amber lantern is my intended destination", "mine");
    const persona=f.repo.createCharacter({name:"Other Hero",age:30,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const draft=f.repo.createCharacterDraft("local-owner",f.campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",
      allocation:{method:"standard-array",scores:Object.fromEntries(["might","agility","resolve","insight","presence","craft"]
        .map((name,index)=>[name,CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any},idempotencyKey:"other-draft"});
    const definitions=MECHANICS_STARTER_CATALOG.definitions;
    const selected=f.repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"other-select",selections:{
      race:definitions.find(definition=>definition.reference.kind==="race")!.reference,
      background:definitions.find(definition=>definition.reference.kind==="background")!.reference,
      class:definitions.find(definition=>definition.reference.kind==="class")!.reference,starterGrant:"kit"}} as any);
    const otherActor=f.repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:"other-final"}).receipt.actorId;
    const participants=database();participants.prepare("INSERT INTO session_characters VALUES(?,?,1)").run(f.session.id,persona.id);participants.close();
    const before = f.repo.getCampaignRecall("local-owner", query(f, "amber lantern"))!;
    for(let i=0;i<70;i++)f.repo.createAdventureTurn("local-owner",{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,
      sessionId:f.session.id,actorId:otherActor,declaration:"amber lantern amber lantern OTHER_ACTOR_SECRET",
      expectedCampaignRevision:f.repo.getCampaignAdministration("local-owner",f.campaign.id)!.revision,idempotencyKey:`other-actor-${i}`});
    expect(f.repo.getCampaignRecall("local-owner", query(f, "amber lantern"))).toEqual(before);
    const other = await dmFixture();
    declare(other, "amber lantern amber lantern private other campaign", "other");
    expect(f.repo.getCampaignRecall("local-owner", query(f, "amber lantern"))).toEqual(before);
    f.repo.createCampaignRecap("local-owner", f.campaign.id, { timelineId: f.campaign.activeTimelineId,
      throughRevision: 0, selectedSessionIds: [], visibility: "gm-only", text: "amber lantern GM_SECRET",
      expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "private" });
    const player = f.repo.getCampaignRecall("local-owner", query(f, "amber lantern"))!;
    expect(player.hits).toEqual(before.hits);
    expect(player.incomplete).toBe(false);
    expect(JSON.stringify(player)).not.toContain("GM_SECRET");
    const dm = f.repo.getCampaignRecall("local-owner", { ...query(f, "GM_SECRET"), audience: { kind: "dm" }, purpose: "dm-planning" })!;
    expect(JSON.stringify(dm)).toContain("GM_SECRET");
    expect(f.repo.getCampaignRecall("local-owner", { ...query(f, "amber lantern"), audience: { kind: "dm" } })).toBeNull();
    const db = database();
    db.prepare("INSERT INTO principals VALUES('recall-player','Player',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?,'recall-player','player',?)").run(f.campaign.id, f.options.clock.now().toISOString());
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='recall-player' WHERE actor_id=?").run(f.actorId);
    expect(f.repo.getCampaignRecall("recall-player", query(f, "amber lantern"))!.hits).toEqual(before.hits);
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='local-owner' WHERE actor_id=?").run(f.actorId);
    expect(f.repo.getCampaignRecall("recall-player", query(f, "amber lantern"))).toBeNull();
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id='recall-player'").run(f.campaign.id);
    expect(f.repo.getCampaignRecall("recall-player", query(f, "amber lantern"))).toBeNull();
    db.close(); other.repo.close(); f.repo.close();
  });

  it("bounds the complete JSON byte packet, never slices records, admits at most eight, and caps candidates", async () => {
    const f = await dmFixture();
    const text = 'opal "\\\n' + "\u00e9".repeat(700);
    for (let i = 0; i < 70; i++) declare(f, text, `bytes-${i}`);
    const result = f.repo.getCampaignRecall("local-owner", query(f, "opal"))!;
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(8);
    expect(result.hits.every(hit => hit.text === text)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(CAMPAIGN_RECALL_MAX_BYTES);
    expect(result.incomplete).toBe(true);
    expect(result.scan).toBe("direct-sql-unbounded");
    expect(Buffer.byteLength(f.repo.getCampaignRecall("local-owner", query(f, "\u754c".repeat(2000)))!.query)).toBeLessThanOrEqual(1024);
    f.repo.close();
  });

  it("deduplicates narration retries and excludes all old turn/recap history after a timeline fork", async () => {
    const f = await dmFixture();
    const original = declare(f, "I ask about the violet compass", "original");
    f.repo.updateAdventureTurnNarration("local-owner", { turnId: original.turnId, expectedTurnRevision: original.revision,
      expectedCampaignRevision: original.campaignRevision, idempotencyKey: "cancel", narrationStatus: "pending", terminalState: "cancelled" });
    const retry = f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
      sessionId: f.session.id, actorId: f.actorId, declaration: original.declaration, mode: "narration-retry", priorTurnId: original.turnId,
      expectedCampaignRevision: original.campaignRevision, idempotencyKey: "retry" });
    narrate(f, retry.turnId, "The violet compass glimmers. This is descriptive prose.");
    expect(f.repo.getCampaignRecall("local-owner", query(f, "violet compass"))!.hits.map(hit => hit.rootTurnId)).toEqual([original.turnId, original.turnId]);
    const revision = f.repo.getCampaignTimeline("local-owner", f.campaign.id, f.campaign.activeTimelineId)!.revision;
    const checkpoint = f.repo.createCampaignCheckpoint("local-owner", f.campaign.id, { timelineId: f.campaign.activeTimelineId,
      timelineRevision: revision, label: "Fork", expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      idempotencyKey: "checkpoint" }).value;
    f.repo.forkCampaignTimeline("local-owner", f.campaign.id, { checkpointId: checkpoint.id,
      expectedRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "fork" });
    expect(f.repo.getCampaignRecall("local-owner", query(f, "violet compass"))!.hits).toEqual([]);
    expect(f.repo.getAdventureTurnTranscript("local-owner", f.campaign.id, f.session.id)).toEqual([]);
    f.repo.close();
  });

  it("upgrades the exact pre-recall schema without deleting durable data", async () => {
    const f = await dmFixture();
    declare(f, "Remember the jade raven", "survives");
    f.repo.close();
    const db = database();
    db.exec(`DROP TRIGGER campaign_context_inspection_sources_v61_replace;
      DROP TRIGGER campaign_context_inspection_sources_v61_delete;
      DROP TRIGGER campaign_context_inspection_sources_v61_update;
      DROP TRIGGER campaign_context_inspection_headers_v61_replace;
      DROP TRIGGER campaign_context_inspection_headers_v61_delete;
      DROP TRIGGER campaign_context_inspection_headers_v61_update;
      DROP TABLE campaign_context_inspection_sources_v61;
      DROP TABLE campaign_context_inspection_headers_v61;`);
    db.exec("DROP TABLE adventure_narration_contexts");
    db.close();
    const repo = createRepository(f.options);
    expect(repo.getCampaignRecall("local-owner", query(f, "jade raven"))!.hits).toHaveLength(1);
    repo.close();
  });
});
