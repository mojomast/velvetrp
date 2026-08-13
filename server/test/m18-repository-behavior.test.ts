import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { WorldAuthorizationError, WorldConflictError, WorldStaleError, WorldUnavailableError, createRepository, createSession, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { executeActorTravelInTransaction } from "../src/repo/world/internal.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const scores: CharacterBuilderAttributeScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;

/** Builds finalized, controller-bound actors, then seeds only world state. */
async function fixture() {
  let sequence = 0;
  const dependencies = {
    clock: { now: () => new Date(at) },
    ids: { nextId: () => `m18-${++sequence}` },
  };
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    ...dependencies,
  });
  const campaign = repo.createCampaign("local-owner", { name: "M1.8 world fixture" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES ('world-player','World player',0)").run();
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "world-player", role: "player" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 1, idempotencyKey: "pins" });

  const actor = (name: string, controller = "local-owner") => {
    const persona = repo.createCharacter({ name, age: 31, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: controller, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft` });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-select`, selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference as any,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference as any,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference as any,
      starterGrant: "kit",
    } } as any);
    return { actorId: repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId, personaId: persona.id };
  };
  const owner = actor("Owner");
  const companion = actor("Companion");
  const player = actor("Player", "world-player");
  const sessionPersona = repo.createCharacter({ name: "Session", age: 30, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
  const session = await createSession({ characterId: sessionPersona.id, title: "World session" });
  db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(session.id);
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);

  for (const [locationId, name, visibility] of [["origin", "Origin", "public"], ["destination", "Destination", "public"], ["secret", "Secret", "gm"]] as const) {
    repo.createLocation("local-owner", { campaignId: campaign.id, locationId, name, visibility });
  }
  repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "road", fromLocationId: "origin", toLocationId: "destination", visibility: "public", routeState: "open" });
  repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "secret-road", fromLocationId: "origin", toLocationId: "secret", visibility: "hidden", routeState: "open" });
  for (const actorId of [owner.actorId, companion.actorId, player.actorId]) {
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id, actorId, "origin", session.id, at);
  }
  return { repo, db, dependencies, campaignId: campaign.id, sessionId: session.id, owner, companion, player, actor };
}

describe("M1.8 world repository", () => {
  it("places actors only through a GM revisioned command scoped to its session", async () => {
    const f = await fixture();
    const command = { type: "set_actor_location", campaignId: f.campaignId, actorId: f.owner.actorId, locationId: "destination", expectedRevision: 0, idempotencyKey: "place-owner" };
    const first = f.repo.setActorLocation("local-owner", f.sessionId, command);
    expect(f.repo.setActorLocation("local-owner", f.sessionId, command)).toEqual(first);
    expect(() => f.repo.setActorLocation("world-player", f.sessionId, command)).toThrow(WorldAuthorizationError);
    expect(f.db.prepare("SELECT location_id,session_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?").get(f.campaignId, f.owner.actorId, f.sessionId)).toEqual({ location_id: "destination", session_id: f.sessionId, state_revision: 1 });
    f.db.close(); f.repo.close();
  });

  it("uses exact retries before stale checks, while authorization and campaign ancestry remain authoritative", async () => {
    const f = await fixture();
    const command: any = { type: "travel", campaignId: f.campaignId, travelId: "journey", locationConnectionId: "road", selectedPartyActorIds: [f.owner.actorId], expectedRevision: 0, idempotencyKey: "journey" };
    const first = f.repo.travel("local-owner", f.sessionId, command);
    expect(f.repo.executeWorldCommand("local-owner", f.sessionId, command)).toEqual(first);
    expect(() => f.repo.travel("local-owner", f.sessionId, { ...command, expectedRevision: 1 })).toThrow(WorldConflictError);
    expect(() => f.repo.travel("local-owner", f.sessionId, { ...command, travelId: "stale", idempotencyKey: "stale" })).toThrow(WorldStaleError);
    expect(() => f.repo.travel("world-player", f.sessionId, command)).toThrow(WorldAuthorizationError);
    const foreign = await createSession({ characterId: f.actor("Foreign").personaId, title: "Foreign" });
    expect(() => f.repo.travel("local-owner", foreign.id, { ...command, travelId: "foreign", idempotencyKey: "foreign" })).toThrow(WorldUnavailableError);
    expect(f.repo.getWorldProjection("local-owner", f.campaignId, foreign.id)).toBeNull();
    f.db.close(); f.repo.close();
  });

  it("keeps legacy travel policy in parity for observers, GMs, and stopped sessions",async()=>{
    const f=await fixture();const command:any={type:"travel",campaignId:f.campaignId,travelId:"legacy-policy",locationConnectionId:"road",
      selectedPartyActorIds:[f.owner.actorId],expectedRevision:0,idempotencyKey:"legacy-policy"};
    f.db.prepare("INSERT INTO principals VALUES('world-observer','Observer',0)").run();
    f.db.prepare("INSERT INTO campaign_memberships VALUES(?,'world-observer','observer',?)").run(f.campaignId,at);
    expect(()=>f.repo.executeWorldCommand("world-observer",f.sessionId,command)).toThrow(WorldAuthorizationError);
    const hidden={...command,travelId:"hidden-gm",locationConnectionId:"secret-road",idempotencyKey:"hidden-gm"};
    const first=f.repo.travel("local-owner",f.sessionId,hidden);expect(first.destinationLocationId).toBe("secret");
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(at,f.sessionId);
    expect(f.repo.travel("local-owner",f.sessionId,hidden)).toEqual(first);
    expect(()=>f.repo.travel("local-owner",f.sessionId,{...hidden,travelId:"stopped-fresh",expectedRevision:1,idempotencyKey:"stopped-fresh"})).toThrow(WorldUnavailableError);
    f.db.close();f.repo.close();
  });

  it("rejects non-adjacent, closed, hidden, undiscovered, and uncontrolled party travel", async () => {
    const f = await fixture();
    const travel = (key: string, actorId = f.player.actorId, expectedRevision = 0) => f.repo.travel("world-player", f.sessionId, { type: "travel", campaignId: f.campaignId, travelId: key, locationConnectionId: "road", selectedPartyActorIds: [actorId], expectedRevision, idempotencyKey: key } as any);
    f.db.prepare("UPDATE campaign_location_connections_v28 SET route_state='closed' WHERE connection_id='road'").run();
    expect(() => travel("closed")).toThrow(WorldUnavailableError);
    expect(() => f.repo.travel("world-player", f.sessionId, { type: "travel", campaignId: f.campaignId, travelId: "hidden", locationConnectionId: "secret-road", selectedPartyActorIds: [f.player.actorId], expectedRevision: 0, idempotencyKey: "hidden" })).toThrow(WorldUnavailableError);
    f.db.prepare("UPDATE campaign_location_connections_v28 SET route_state='open',visibility='discovered' WHERE connection_id='road'").run();
    expect(() => travel("undiscovered")).toThrow(WorldUnavailableError);
    f.repo.executeWorldCommand("local-owner", f.sessionId, { type: "discover_location", campaignId: f.campaignId, actorId: f.player.actorId, locationId: "destination", expectedRevision: 0, idempotencyKey: "discover-destination" });
    expect(() => travel("uncontrolled", f.owner.actorId)).toThrow(WorldAuthorizationError);
    f.db.prepare("DELETE FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?").run(f.campaignId, f.player.actorId);
    f.db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(f.campaignId, f.player.actorId, "secret", f.sessionId, at);
    expect(() => travel("not-adjacent", f.player.actorId, 1)).toThrow(WorldUnavailableError);
    f.db.close(); f.repo.close();
  });

  it("atomically records travel provenance and moves every selected party member", async () => {
    const f = await fixture();
    const result = f.repo.travel("local-owner", f.sessionId, { type: "travel", campaignId: f.campaignId, travelId: "party-trip", locationConnectionId: "road", selectedPartyActorIds: [f.owner.actorId, f.companion.actorId], expectedRevision: 0, idempotencyKey: "party-trip" });
    expect(result.receipt).toMatchObject({ revisionBefore: 0, revisionAfter: 1, occurredAt: at });
    expect(f.db.prepare("SELECT actor_id,location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id IN (?,?) ORDER BY actor_id").all(f.campaignId, f.companion.actorId, f.owner.actorId)).toEqual([f.companion.actorId, f.owner.actorId].sort().map((actor_id) => ({ actor_id, location_id: "destination", state_revision: 1 })));
    expect(f.db.prepare("SELECT event_type,resulting_revision FROM world_events_v28").all()).toEqual([{ event_type: "travelled", resulting_revision: 1 }]);
    expect(f.db.prepare("SELECT actor_id FROM world_travel_party_members_v28 ORDER BY actor_id").all()).toEqual([f.companion.actorId, f.owner.actorId].sort().map((actor_id) => ({ actor_id })));
    f.db.close(); f.repo.close();
  });

  it("projects the unique campaign world and replays full actor-bound travel results",async()=>{
    const f=await fixture();
    const initial=f.repo.getCampaignWorld("local-owner",f.campaignId)!;
    expect(initial).toMatchObject({campaignId:f.campaignId,sessionId:f.sessionId,revision:0,
      currentLocations:expect.arrayContaining([{actorId:f.owner.actorId,locationId:"origin",revision:0,updatedAt:at}])});
    expect(initial.visibleLocations.map((location)=>location.locationId)).toEqual(["destination","origin","secret"]);
    const command={connectionId:"road",partyActorIds:[f.owner.actorId,f.companion.actorId],expectedRevision:0,idempotencyKey:"http-travel"};
    const first=f.repo.travelActor("local-owner",f.owner.actorId,command);
    expect(first).toMatchObject({campaignId:f.campaignId,sessionId:f.sessionId,
      locations:[{actorId:f.owner.actorId,locationId:"destination",revision:1},{actorId:f.companion.actorId,locationId:"destination",revision:1}],
      discoveries:[{actorId:f.owner.actorId,locationId:"destination"},{actorId:f.companion.actorId,locationId:"destination"}],
      receipt:{revisionBefore:0,revisionAfter:1}});
    expect(f.repo.travelActor("local-owner",f.owner.actorId,command)).toEqual(first);
    expect(f.repo.getCampaignWorld("local-owner",f.campaignId)).toMatchObject({revision:1});
    expect(()=>f.repo.travelActor("local-owner",f.owner.actorId,{...command,expectedRevision:1})).toThrow(WorldConflictError);
    f.db.close();f.repo.close();
  });

  it("executes actor travel only inside the caller transaction and matches the public wrapper",async()=>{
    const f=await fixture();
    const command={connectionId:"road",partyActorIds:[f.owner.actorId,f.companion.actorId],expectedRevision:0,idempotencyKey:"transaction-travel"};
    const before=f.db.prepare("SELECT count(*) count FROM world_commands_v28").get();
    let clockCalls=0,idCalls=0;
    const isolatedDependencies={clock:{now:()=>{clockCalls++;return new Date(at);}},ids:{nextId:()=>{idCalls++;return `adapter-${idCalls}`;}}};
    expect(()=>executeActorTravelInTransaction(f.db,isolatedDependencies,"local-owner",f.sessionId,f.owner.actorId,command))
      .toThrow("actor travel requires a caller-owned transaction");
    expect(f.db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual(before);
    expect({clockCalls,idCalls}).toEqual({clockCalls:0,idCalls:0});

    f.db.exec("BEGIN IMMEDIATE");
    const direct=executeActorTravelInTransaction(f.db,isolatedDependencies,"local-owner",f.sessionId,f.owner.actorId,command);
    f.db.exec("ROLLBACK");
    const publicResult=f.repo.travelActor("local-owner",f.owner.actorId,command);
    expect({...direct,receipt:{...direct.receipt,commandId:publicResult.receipt.commandId}}).toEqual(publicResult);
    expect(f.db.prepare("SELECT actor_id,location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id IN (?,?) ORDER BY actor_id")
      .all(f.campaignId,f.owner.actorId,f.companion.actorId)).toEqual([f.owner.actorId,f.companion.actorId].sort()
        .map((actor_id)=>({actor_id,location_id:"destination",state_revision:1})));
    f.db.close();f.repo.close();
  });

  it("keeps actor travel replay independent and rechecks route, revision, and authority",async()=>{
    const f=await fixture();
    const command={connectionId:"road",partyActorIds:[f.player.actorId],expectedRevision:0,idempotencyKey:"actor-policy"};
    f.db.prepare("UPDATE campaign_location_connections_v28 SET route_state='closed' WHERE campaign_id=? AND connection_id='road'").run(f.campaignId);
    expect(()=>f.repo.travelActor("world-player",f.player.actorId,command)).toThrow(WorldUnavailableError);
    f.db.prepare("UPDATE campaign_location_connections_v28 SET route_state='open' WHERE campaign_id=? AND connection_id='road'").run(f.campaignId);
    expect(()=>f.repo.travelActor("world-player",f.player.actorId,{...command,expectedRevision:1,idempotencyKey:"actor-stale"})).toThrow(WorldStaleError);
    expect(()=>f.repo.travelActor("world-player",f.owner.actorId,{...command,partyActorIds:[f.owner.actorId],idempotencyKey:"actor-authority"})).toThrow(WorldAuthorizationError);
    const first=f.repo.travelActor("world-player",f.player.actorId,command);
    f.db.prepare("UPDATE campaign_location_connections_v28 SET route_state='closed' WHERE campaign_id=? AND connection_id='road'").run(f.campaignId);
    const replayDependencies={clock:{now:()=>{throw new Error("replay clock dependency");}},ids:{nextId:()=>{throw new Error("replay ID dependency");}}};
    f.db.exec("BEGIN IMMEDIATE");
    const replay=executeActorTravelInTransaction(f.db,replayDependencies,"world-player",f.sessionId,f.player.actorId,command);
    f.db.exec("COMMIT");
    expect(replay).toEqual(first);
    f.db.prepare("DELETE FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=?").run(f.campaignId,f.player.actorId);
    f.db.exec("BEGIN IMMEDIATE");
    expect(()=>executeActorTravelInTransaction(f.db,replayDependencies,"world-player",f.sessionId,f.player.actorId,command)).toThrow(WorldAuthorizationError);
    f.db.exec("ROLLBACK");
    f.db.close();f.repo.close();
  });

  it("replays the old actor travel after stop and session rollover without dependencies",async()=>{
    const f=await fixture();
    const stoppedPersona=f.repo.createCharacter({name:"Stopped",age:30,archetype:"Guide",boundaries:"",fictionalConfirmed:true});
    const stopped=await createSession({characterId:stoppedPersona.id,title:"Stopped"});
    f.repo.attachCampaignSession("local-owner",{campaignId:f.campaignId,sessionId:stopped.id} as any);
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(at,stopped.id);
    const command={connectionId:"road",partyActorIds:[f.owner.actorId],expectedRevision:0,idempotencyKey:"running-only"};
    const first=f.repo.travelActor("local-owner",f.owner.actorId,command);expect(first.sessionId).toBe(f.sessionId);
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(at,f.sessionId);
    const nextPersona=f.repo.createCharacter({name:"Next",age:30,archetype:"Guide",boundaries:"",fictionalConfirmed:true});
    const next=await createSession({characterId:nextPersona.id,title:"Next"});f.db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(next.id);
    f.repo.attachCampaignSession("local-owner",{campaignId:f.campaignId,sessionId:next.id} as any);
    expect(f.repo.travelActor("local-owner",f.owner.actorId,command)).toEqual(first);
    expect(()=>f.repo.travelActor("local-owner",f.owner.actorId,{...command,expectedRevision:1})).toThrow(WorldConflictError);
    expect(()=>f.repo.travelActor("local-owner",f.owner.actorId,{...command,idempotencyKey:"fresh-rollover"})).toThrow(WorldUnavailableError);
    f.db.exec("BEGIN IMMEDIATE");
    expect(executeActorTravelInTransaction(f.db,{clock:{now:()=>{throw new Error("clock");}},ids:{nextId:()=>{throw new Error("id");}}},
      "local-owner",f.sessionId,f.owner.actorId,command)).toEqual(first);
    f.db.exec("COMMIT");
    const oldCommand=f.db.prepare("SELECT * FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND idempotency_key=?").get(f.campaignId,f.sessionId,command.idempotencyKey) as any;
    const oldReceipt=f.db.prepare("SELECT * FROM world_receipts_v28 WHERE campaign_id=? AND session_id=? AND command_id=?").get(f.campaignId,f.sessionId,oldCommand.command_id) as any;
    f.db.transaction(()=>{f.db.prepare("INSERT INTO world_mutation_revisions_v28 VALUES(?,?,1,?)").run(f.campaignId,next.id,at);
      f.db.prepare("INSERT INTO world_commands_v28 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(f.campaignId,next.id,"ambiguous-command",oldCommand.actor_id,"travel",oldCommand.idempotency_key,
        oldCommand.canonical_request_json,oldCommand.request_digest,0,1,at);
      f.db.prepare("INSERT INTO world_receipts_v28 VALUES(?,?,?,?,?,?,?)").run(f.campaignId,next.id,"ambiguous-command",1,oldReceipt.canonical_result_json,oldReceipt.result_digest,at);})();
    expect(()=>f.repo.travelActor("local-owner",f.owner.actorId,command)).toThrow(WorldConflictError);
    f.db.close();f.repo.close();
  });

  it("rejects two running attachments and rolls back a late SQLite-trigger failure",async()=>{
    const f=await fixture();const secondPersona=f.repo.createCharacter({name:"Second",age:30,archetype:"Guide",boundaries:"",fictionalConfirmed:true});
    const second=await createSession({characterId:secondPersona.id,title:"Second"});f.db.prepare("UPDATE sessions SET state='active' WHERE id=?").run(second.id);
    f.repo.attachCampaignSession("local-owner",{campaignId:f.campaignId,sessionId:second.id} as any);
    const command={connectionId:"road",partyActorIds:[f.owner.actorId],expectedRevision:0,idempotencyKey:"ambiguous"};
    expect(()=>f.repo.travelActor("local-owner",f.owner.actorId,command)).toThrow(WorldConflictError);
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(at,second.id);
    f.db.exec(`CREATE TEMP TRIGGER actor_travel_late_failure BEFORE INSERT ON world_travel_destinations_v28
      BEGIN SELECT RAISE(IGNORE); END;BEGIN IMMEDIATE`);
    expect(()=>executeActorTravelInTransaction(f.db,f.dependencies,"local-owner",f.sessionId,f.owner.actorId,command)).toThrow(WorldConflictError);f.db.exec("ROLLBACK");
    for(const table of ["world_mutation_revisions_v28","world_commands_v28","world_receipts_v28","world_events_v28","world_travel_party_members_v28","world_travel_destinations_v28","campaign_location_discoveries_v28"])
      expect(f.db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({count:0});
    expect(f.db.prepare("SELECT location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=? AND actor_id=?")
      .get(f.campaignId,f.sessionId,f.owner.actorId)).toEqual({location_id:"origin",state_revision:0});f.db.close();f.repo.close();
  });

  it("projects only a player's discoveries, controlled locations, and no secret world state", async () => {
    const f = await fixture();
    f.repo.executeWorldCommand("local-owner", f.sessionId, { type: "discover_location", campaignId: f.campaignId, actorId: f.player.actorId, locationId: "origin", expectedRevision: 0, idempotencyKey: "discover-origin" });
    f.db.prepare("INSERT INTO campaign_location_private_state_v28 VALUES(?,?,?)").run(f.campaignId, "origin", "GM route notes");
    const npcPersona = f.repo.createCharacter({ name: "NPC persona", age: 40, archetype: "Merchant", boundaries: "", fictionalConfirmed: true });
    f.db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,?,?,?)").run("merchant", f.campaignId, npcPersona.id, "manual", "Merchant", at);
    f.db.prepare("INSERT INTO campaign_npc_private_state_v28 VALUES(?,?,?,?,NULL)").run(f.campaignId, "merchant", "Profit", "GM NPC notes");
    const projection: any = f.repo.getWorldProjection("world-player", f.campaignId, f.sessionId);
    expect(projection).toMatchObject({ audience: "player", locations: [{ locationId: "origin" }], connections: [], npcs: [], actorLocations: [{ actorId: f.player.actorId }] });
    expect(projection.locations.map((location: any) => location.locationId)).toEqual(["origin"]);
    expect(projection.actorLocations).toHaveLength(1);
    expect(JSON.stringify(projection)).not.toContain("secret");
    expect(JSON.stringify(projection)).not.toContain("GM ");
    f.db.close(); f.repo.close();
  });

  it("changes reputation deterministically with an immutable exact retry", async () => {
    const f = await fixture();
    f.db.prepare("INSERT INTO campaign_factions_v28 VALUES(?,?,?,?,?)").run("guild", f.campaignId, "Guild", "public", at);
    const change: any = { type: "change_reputation", campaignId: f.campaignId, actorId: f.owner.actorId, factionId: "guild", delta: 7, reason: "Saved the caravan", expectedRevision: 0, idempotencyKey: "guild-seven", reputationLedgerEntryId: "guild-entry" };
    const first = f.repo.changeReputation("local-owner", f.sessionId, change);
    expect(f.repo.changeReputation("local-owner", f.sessionId, change)).toEqual(first);
    expect(f.db.prepare("SELECT actor_id,faction_id,delta,reason FROM campaign_reputation_ledger_v28").all()).toEqual([{ actor_id: f.owner.actorId, faction_id: "guild", delta: 7, reason: "Saved the caravan" }]);
    expect(() => f.repo.changeReputation("local-owner", f.sessionId, { ...change, idempotencyKey: "stale" })).toThrow(WorldStaleError);
    f.db.close(); f.repo.close();
  });

  it("binds NPCs only to unbound Velvet personas with manual speech", async () => {
    const f = await fixture();
    const npcPersona = f.repo.createCharacter({ name: "Unbound persona", age: 42, archetype: "Bard", boundaries: "", fictionalConfirmed: true });
    expect(f.repo.createNpc("local-owner", { campaignId: f.campaignId, npcId: "npc", personaId: npcPersona.id, name: "NPC", speechControl: "manual" })).toEqual({ npcId: "npc", campaignId: f.campaignId });
    expect(() => f.repo.createNpc("local-owner", { campaignId: f.campaignId, npcId: "auto", personaId: npcPersona.id, name: "Auto", speechControl: "automated" })).toThrow(WorldUnavailableError);
    expect(() => f.repo.createNpc("local-owner", { campaignId: f.campaignId, npcId: "player-npc", personaId: f.owner.personaId, name: "Player", speechControl: "manual" })).toThrow(WorldConflictError);
    f.db.close(); f.repo.close();
  });
  it("creates and projects campaign NPCs with exact narrative retries",async()=>{
    const f=await fixture();
    const persona=f.repo.createCharacter({name:"Narrative NPC",age:42,archetype:"Merchant",boundaries:"",fictionalConfirmed:true});
    const command={personaId:persona.id,publicState:{name:"Marrow"},privateState:{goals:"Trade",gmNotes:"Secret",
      merchantState:{stock:3}},expectedRevision:0,idempotencyKey:"create-narrative-npc"};
    const first=f.repo.createCampaignNpc("local-owner",f.campaignId,command);
    expect(first).toMatchObject({campaignId:f.campaignId,npc:{personaId:persona.id,publicState:{name:"Marrow"},
      privateState:{gmNotes:"Secret"}},receipt:{revisionBefore:0,revisionAfter:1}});
    expect(f.repo.createCampaignNpc("local-owner",f.campaignId,command)).toEqual(first);
    expect(()=>f.repo.createCampaignNpc("local-owner",f.campaignId,{...command,idempotencyKey:"duplicate",expectedRevision:1})).toThrow(WorldConflictError);
    expect(()=>f.repo.createCampaignNpc("local-owner",f.campaignId,{...command,personaId:f.repo.createCharacter({name:"Other NPC",age:40,
      archetype:"Guide",boundaries:"",fictionalConfirmed:true}).id,idempotencyKey:"stale"})).toThrow(WorldStaleError);
    expect(f.db.prepare("SELECT count(*) count FROM world_narrative_commands_v32").get()).toEqual({count:1});
    const gm=f.repo.listCampaignNpcs("local-owner",f.campaignId)!;
    expect(gm).toMatchObject({revision:1,npcs:[{npcId:first.npc.npcId,personaId:persona.id,privateState:{gmNotes:"Secret"}}]});
    const player=f.repo.listCampaignNpcs("world-player",f.campaignId)!;
    expect(player.npcs).toEqual([{npcId:first.npc.npcId,publicState:{name:"Marrow"},createdAt:at}]);
    expect(JSON.stringify(player)).not.toContain("Secret");expect(player.relationships).toEqual([]);
    expect(f.repo.listCampaignNpcs("outsider",f.campaignId)).toBeNull();
    f.db.close();f.repo.close();
  });
  it("changes bounded NPC relationships once and filters player subjects",async()=>{
    const f=await fixture();const persona=f.repo.createCharacter({name:"Relationship NPC",age:38,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const created=f.repo.createCampaignNpc("local-owner",f.campaignId,{personaId:persona.id,publicState:{name:"Scout"},
      privateState:{goals:"",gmNotes:"",merchantState:null},expectedRevision:0,idempotencyKey:"relationship-npc"});
    const command={subjectActorId:f.player.actorId,affinityDelta:7,trustDelta:2,fearDelta:-1,reason:"Shared a route",
      expectedRevision:1,idempotencyKey:"player-relationship"};
    const first=f.repo.changeNpcRelationship("local-owner",created.npc.npcId,command);
    expect(first.relationship).toMatchObject({npcId:created.npc.npcId,subjectActorId:f.player.actorId,affinity:7,trust:2,fear:-1});
    expect(f.repo.changeNpcRelationship("local-owner",created.npc.npcId,command)).toEqual(first);
    expect(()=>f.repo.changeNpcRelationship("local-owner",created.npc.npcId,{...command,affinityDelta:8})).toThrow(WorldConflictError);
    expect(()=>f.repo.changeNpcRelationship("local-owner",created.npc.npcId,{...command,idempotencyKey:"stale"})).toThrow(WorldStaleError);
    const ownerCommand={subjectActorId:f.owner.actorId,affinityDelta:1,trustDelta:0,fearDelta:0,reason:"Met",
      expectedRevision:2,idempotencyKey:"owner-relationship"};
    f.repo.changeNpcRelationship("local-owner",created.npc.npcId,ownerCommand);
    expect(f.repo.listCampaignNpcs("local-owner",f.campaignId)!.relationships).toHaveLength(2);
    expect(f.repo.listCampaignNpcs("world-player",f.campaignId)!.relationships.map((value)=>value.subjectActorId)).toEqual([f.player.actorId]);
    f.db.close();f.repo.close();
  });
  it("preserves legacy disposition until a v32 relationship command supersedes it",async()=>{
    const f=await fixture(),persona=f.repo.createCharacter({name:"Legacy NPC",age:44,archetype:"Sage",boundaries:"",fictionalConfirmed:true});
    const legacy=f.repo.createNpc("local-owner",{campaignId:f.campaignId,npcId:"legacy-npc",personaId:persona.id,name:"Legacy",speechControl:"manual"});
    const provenance=f.repo.setActorLocation("local-owner",f.sessionId,{type:"set_actor_location",campaignId:f.campaignId,
      actorId:f.owner.actorId,locationId:"origin",expectedRevision:0,idempotencyKey:"legacy-provenance"});
    f.db.prepare("INSERT INTO campaign_npc_relationships_v28 VALUES(?,?,?,?,?,?,?)")
      .run(f.campaignId,f.sessionId,provenance.receipt.commandId,f.owner.actorId,legacy.npcId,12,at);
    expect(f.repo.listCampaignNpcs("local-owner",f.campaignId)!.relationships).toEqual([{npcId:legacy.npcId,
      subjectActorId:f.owner.actorId,affinity:12,trust:0,fear:0,updatedAt:at}]);
    const changed=f.repo.changeNpcRelationship("local-owner",legacy.npcId,{subjectActorId:f.owner.actorId,affinityDelta:3,
      trustDelta:1,fearDelta:0,reason:"Continued trust",expectedRevision:0,idempotencyKey:"upgrade-legacy"});
    expect(changed.relationship).toMatchObject({affinity:15,trust:1,fear:0});
    expect(f.repo.listCampaignNpcs("local-owner",f.campaignId)!.relationships).toEqual([changed.relationship]);
    f.db.close();f.repo.close();
  });
  it("creates factions and accumulates exact-retry reputation on the shared narrative stream",async()=>{
    const f=await fixture();const create={name:"Wayfarers",publicState:{description:"Road wardens"},
      privateState:{gmNotes:"Compromised",visibility:"public" as const},expectedRevision:0,idempotencyKey:"create-wayfarers"};
    const faction=f.repo.createCampaignFaction("local-owner",f.campaignId,create);expect(f.repo.createCampaignFaction("local-owner",f.campaignId,create)).toEqual(faction);
    const command={subjectActorId:f.player.actorId,delta:7,reason:"Saved caravan",expectedRevision:1,idempotencyKey:"rep-seven"};
    const first=f.repo.changeFactionReputation("local-owner",faction.faction.factionId,command);
    expect(first.standing.reputation).toBe(7);expect(f.repo.changeFactionReputation("local-owner",faction.faction.factionId,command)).toEqual(first);
    expect(()=>f.repo.changeFactionReputation("local-owner",faction.faction.factionId,{...command,delta:8})).toThrow(WorldConflictError);
    expect(f.repo.listCampaignFactions("local-owner",f.campaignId)).toMatchObject({revision:2,factions:[{privateState:{gmNotes:"Compromised"}}],standings:[{reputation:7}]});
    const player=f.repo.listCampaignFactions("world-player",f.campaignId)!;expect(player.factions[0]).not.toHaveProperty("privateState");
    expect(player.standings.map((standing)=>standing.subjectActorId)).toEqual([f.player.actorId]);
    const hidden=f.repo.createCampaignFaction("local-owner",f.campaignId,{...create,name:"Circle",privateState:{gmNotes:"Hidden",visibility:"gm"},expectedRevision:2,idempotencyKey:"hidden"});
    expect(f.repo.listCampaignFactions("world-player",f.campaignId)!.factions.map((value)=>value.factionId)).not.toContain(hidden.faction.factionId);
    f.db.close();f.repo.close();
  });
  it("enforces v32 faction reputation through the legacy travel command entry point",async()=>{
    const f=await fixture();const faction=f.repo.createCampaignFaction("local-owner",f.campaignId,{name:"Gatekeepers",
      publicState:{description:"Guard the road"},privateState:{gmNotes:"",visibility:"public"},expectedRevision:0,idempotencyKey:"gatekeepers"});
    f.db.prepare("UPDATE campaign_location_connections_v28 SET requirement_kind='faction_reputation',required_faction_id=?,minimum_reputation=5 WHERE campaign_id=? AND connection_id='road'")
      .run(faction.faction.factionId,f.campaignId);
    const travel:any={type:"travel",campaignId:f.campaignId,travelId:"gated",locationConnectionId:"road",selectedPartyActorIds:[f.owner.actorId],expectedRevision:0,idempotencyKey:"gated"};
    expect(()=>f.repo.travel("local-owner",f.sessionId,travel)).toThrow(WorldUnavailableError);
    f.repo.changeFactionReputation("local-owner",faction.faction.factionId,{subjectActorId:f.owner.actorId,delta:5,reason:"Earned passage",expectedRevision:1,idempotencyKey:"passage"});
    expect(f.repo.travel("local-owner",f.sessionId,travel)).toMatchObject({destinationLocationId:"destination"});f.db.close();f.repo.close();
  });
});
