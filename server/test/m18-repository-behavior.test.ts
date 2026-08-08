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
});
