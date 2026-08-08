import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { WorldAuthorizationError, WorldConflictError, WorldStaleError, WorldUnavailableError, createRepository, createSession, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const scores: CharacterBuilderAttributeScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;

/** Builds finalized, controller-bound actors, then seeds only world state. */
async function fixture() {
  let sequence = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(at) },
    ids: { nextId: () => `m18-${++sequence}` },
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
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);

  for (const [locationId, name, visibility] of [["origin", "Origin", "public"], ["destination", "Destination", "public"], ["secret", "Secret", "gm"]] as const) {
    repo.createLocation("local-owner", { campaignId: campaign.id, locationId, name, visibility });
  }
  repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "road", fromLocationId: "origin", toLocationId: "destination", visibility: "public", routeState: "open" });
  repo.createLocationConnection("local-owner", { campaignId: campaign.id, locationConnectionId: "secret-road", fromLocationId: "origin", toLocationId: "secret", visibility: "hidden", routeState: "open" });
  for (const actorId of [owner.actorId, companion.actorId, player.actorId]) {
    db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id, actorId, "origin", session.id, at);
  }
  return { repo, db, campaignId: campaign.id, sessionId: session.id, owner, companion, player, actor };
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
});
