import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository, WorldAuthorizationError, WorldConflictError } from "../src/repo/index.js";
import { parseJourneyDeclaration, type ActorJourneyResult } from "../src/repo/world/actorJourneyRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";

type ConnectionSeed = { id: string; from: string; to: string; visibility?: "public" | "gm"; routeState?: "open" | "closed" };
type ProfileSeed = { connectionId: string; environment: "urban" | "road" | "wilderness" | "water"; risk: "safe" | "watched" | "dangerous"; chancePercent: number };

/**
 * Full-repository seed mirroring the lane-check style: raw catalog/actor/session rows,
 * a public A -> B -> C world with a named "Place La Salle" destination, and an actor
 * standing at A with no prior world revision.
 */
function seed(options: { principal?: string; connections?: ConnectionSeed[]; profiles?: ProfileSeed[]; rolls?: number[] } = {}) {
  const principal = options.principal ?? "local-owner";
  const connections = options.connections ?? [
    { id: "A-B", from: "A", to: "B" },
    { id: "B-C", from: "B", to: "C" },
  ];
  const first = createRepository();
  const campaign = first.createCampaign("local-owner", { name: "Journey integration" });
  first.close();

  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('dnd-5e','dnd-5e','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','dnd-5e','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','sage','Sage','Background','[]'),('pack','1','class','wizard','Wizard','Class','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'dnd-5e')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','dnd-5e')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?, 'persona', ?, ?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','sage',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_character_attributes VALUES (?,?,?,?,?)").run(campaign.id, "sheet", 0, "strength", 10);
  db.prepare("INSERT INTO rpg_character_classes VALUES (?,'sheet',0,'pack','1','class','wizard',1)").run(campaign.id);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  if (principal !== "local-owner") {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principal, "Journey player");
    db.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(campaign.id, principal, "player", at);
  }
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,?,NULL)").run(campaign.id, principal);
  for (const [id, name] of [["A", "Old Gate"], ["B", "Waystation"], ["C", "Place La Salle"]] as const) {
    db.prepare(`INSERT INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,public_name,public_description,visibility,created_at)
      VALUES(?,?,NULL,?,'','public',?)`).run(id, campaign.id, name, at);
  }
  for (const connection of connections) {
    db.prepare(`INSERT INTO campaign_location_connections_v28(connection_id,campaign_id,from_location_id,to_location_id,
      visibility,route_state,requirement_kind,required_faction_id,minimum_reputation,created_at) VALUES(?,?,?,?,?,?,'none',NULL,NULL,?)`)
      .run(connection.id, campaign.id, connection.from, connection.to, connection.visibility ?? "public", connection.routeState ?? "open", at);
  }
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id, "actor", "A", "session", at);
  for (const profile of options.profiles ?? []) {
    db.prepare("INSERT INTO world_route_event_profiles_v1 VALUES(?,?,?,?,?)")
      .run(campaign.id, profile.connectionId, profile.environment, profile.risk, profile.chancePercent);
  }
  db.close();

  const queue = [...(options.rolls ?? [])];
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(at) },
    rng: { integer: () => { const value = queue.shift(); if (value === undefined) throw new Error("unexpected reroll"); return value; } },
  });
  return { campaign, repo, principal, remaining: () => queue.length };
}

function turn(f: ReturnType<typeof seed>, key: string, declaration: string) {
  return f.repo.createAdventureTurn(f.principal, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: "session", actorId: "actor", declaration, expectedCampaignRevision: 0, idempotencyKey: key });
}

const committed = (result: ActorJourneyResult | null): ActorJourneyResult => {
  if (!result) throw new Error("journey was not committed");
  return result;
};
const rawDb = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

describe("journey declaration parsing", () => {
  it("accepts one explicit named move and an explicit continuation", () => {
    expect(parseJourneyDeclaration("i move to place lasalle")).toEqual({ destination: "place lasalle", resume: false });
    expect(parseJourneyDeclaration("I walk towards Place La Salle.")).toEqual({ destination: "Place La Salle", resume: false });
    expect(parseJourneyDeclaration("continue journey")).toEqual({ destination: null, resume: true });
    expect(parseJourneyDeclaration("I continue my journey")).toEqual({ destination: null, resume: true });
  });

  it("rejects questions, negations, compounds, and non-travel declarations", () => {
    for (const text of [
      "I move to Place La Salle?",
      "Should I move to Place La Salle?",
      "I don't move to Place La Salle",
      "I move to Place La Salle and then rest",
      "I move to Place La Salle; then rest",
      "I look around the gate",
      "",
    ]) expect(parseJourneyDeclaration(text), text).toBeNull();
  });
});

describe("declared actor journey repository", () => {
  it("resolves a primary place name without requiring its descriptive display suffix", () => {
    const f = seed(); const db = rawDb();
    db.prepare("UPDATE campaign_locations_v28 SET public_name='Place La Salle · horloge des neuf minutes (fiction)' WHERE location_id='C'").run();
    const created = turn(f, "decorated-name", "i move to place lasalle");
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toMatchObject({ status: "completed", currentLocationId: "C" });
    db.close(); f.repo.close();
  });
  it("records a missed risk check once per watched journey and replays without new draws", () => {
    const f = seed({ profiles: ["A-B", "B-C"].map(connectionId => ({ connectionId, environment: "road", risk: "watched", chancePercent: 10 })), rolls: [100] });
    const created = turn(f, "missed-check", "Travel to Place La Salle");
    const result = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    expect(result.status).toBe("completed");
    expect(result.eventChecks).toEqual([{ connectionId: "A-B", route: { environment: "road", risk: "watched", chancePercent: 10 },
      elapsedMinutes: 0, partyInjured: false, triggerRoll: 100, eventRoll: null, eventId: null }]);
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toEqual(result);
    expect(f.remaining()).toBe(0); f.repo.close();
  });

  it("persists a departure interruption without moving, then resumes even a direct risky route", () => {
    const f = seed({ connections: [{ id: "A-C", from: "A", to: "C" }], profiles: [{ connectionId: "A-C", environment: "road", risk: "dangerous", chancePercent: 100 }], rolls: [1, 1] });
    const created = turn(f, "departure-stop", "Travel to Place La Salle");
    const stopped = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    expect(stopped).toMatchObject({ status: "interrupted", currentLocationId: "A", elapsedMinutes: 0, path: [], revisionBefore: 0, revisionAfter: 0 });
    expect(f.repo.getAdventureTurn(f.principal, created.turnId)?.receiptLinks).toHaveLength(1);
    const resume = turn(f, "departure-resume", "Travel to Place La Salle");
    expect(f.repo.executeDeclaredActorJourney(f.principal, resume.turnId)).toMatchObject({ status: "completed", journeyId: stopped.journeyId, currentLocationId: "C", elapsedMinutes: 60 });
    expect(f.remaining()).toBe(0); f.repo.close();
  });

  it("keeps an interrupted journey at its stop when its remaining route closes", () => {
    const f = seed({ profiles: [{ connectionId: "B-C", environment: "road", risk: "dangerous", chancePercent: 100 }], rolls: [1, 1] });
    const created = turn(f, "stop-before-closure", "Travel to Place La Salle");
    const stopped = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    const db = rawDb(); db.prepare("UPDATE campaign_location_connections_v28 SET route_state='closed' WHERE connection_id='B-C'").run();
    const resume = turn(f, "closed-resume", "Continue journey");
    expect(f.repo.executeDeclaredActorJourney(f.principal, resume.turnId)).toBeNull();
    expect(db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE actor_id='actor'").get()).toEqual({ location_id: "B" });
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 1 });
    expect(f.repo.getActorJourneyNarrationReceipt(f.principal, created.turnId, stopped.commandId)).toEqual(stopped);
    db.close(); f.repo.close();
  });

  it("omits closed connections from the browser's world route projection", () => {
    const f = seed({ connections: [{ id: "A-B", from: "A", to: "B" }, { id: "B-C", from: "B", to: "C", routeState: "closed" }] });
    expect(f.repo.getCampaignWorld(f.principal, f.campaign.id, "session")?.visibleConnections.map(connection => connection.connectionId)).toEqual(["A-B"]);
    f.repo.close();
  });
  it("settles a two-leg journey to a nonadjacent named destination and links one receipt", () => {
    const f = seed();
    const created = turn(f, "journey-1", "i move to place lasalle");
    const result = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    expect(result).toMatchObject({
      status: "completed", originLocationId: "A", requestedDestinationLocationId: "C", currentLocationId: "C",
      origin: "Old Gate", destination: "Place La Salle", currentLocation: "Place La Salle",
      elapsedMinutes: 120, revisionBefore: 0, revisionAfter: 2, interruption: null,
    });
    expect(result.path.map((step) => step.connectionId)).toEqual(["A-B", "B-C"]);
    expect(result.path.map((step) => step.fromLocationId)).toEqual(["A", "B"]);
    expect(result.path.map((step) => step.toLocationId)).toEqual(["B", "C"]);

    const db = rawDb();
    expect(db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id='session'").get(f.campaign.id))
      .toEqual({ revision: 2 });
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28 WHERE campaign_id=? AND command_type='travel'").get(f.campaign.id))
      .toEqual({ count: 2 });
    expect(db.prepare("SELECT location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id='actor'").get(f.campaign.id))
      .toEqual({ location_id: "C", state_revision: 2 });
    expect(db.prepare("SELECT location_id FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id='actor' ORDER BY location_id").all(f.campaign.id))
      .toEqual([{ location_id: "B" }, { location_id: "C" }]);
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id='session'").get(f.campaign.id))
      .toEqual({ elapsed_minutes: 120 });
    db.close();

    const projection = f.repo.getAdventureTurn(f.principal, created.turnId)!;
    expect(projection.state).toBe("mechanics-committed");
    expect(projection.narrationStatus).toBe("pending");
    expect(projection.receiptLinks.some((link) => link.linkId === `journey-${result.commandId}`)).toBe(true);
    expect(f.repo.getActorJourneyNarrationReceipt(f.principal, created.turnId, result.commandId)).toEqual(result);
    expect(f.remaining()).toBe(0);
    f.repo.close();
  });

  it("replays a committed journey across a restart without rerolling or duplicating legs", () => {
    const f = seed();
    const created = turn(f, "restart", "i move to place lasalle");
    const first = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    f.repo.close();

    const restarted = createRepository({
      dataDir: process.env.VELVET_DATA_DIR!,
      clock: { now: () => new Date(at) },
      rng: { integer: () => { throw new Error("unexpected reroll"); } },
    });
    expect(restarted.executeDeclaredActorJourney(f.principal, created.turnId)).toEqual(first);
    const db = rawDb();
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28 WHERE campaign_id=? AND command_type='travel'").get(f.campaign.id))
      .toEqual({ count: 2 });
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 1 });
    db.close();
    restarted.close();
  });

  it("interrupts on a risky leg and resumes the same journey without rerolling", () => {
    const f = seed({ profiles: [{ connectionId: "B-C", environment: "wilderness", risk: "dangerous", chancePercent: 100 }], rolls: [1, 1] });
    const created = turn(f, "interrupt-1", "i move to place lasalle");
    const first = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));
    expect(first).toMatchObject({
      status: "interrupted", originLocationId: "A", requestedDestinationLocationId: "C", currentLocationId: "B",
      elapsedMinutes: 60, revisionBefore: 0, revisionAfter: 1,
    });
    expect(first.interruption?.event.id).toBe("weather-squall");
    expect(first.path.map((step) => step.connectionId)).toEqual(["A-B"]);
    expect(f.remaining()).toBe(0);

    // Repeating the original declaration replays the interrupted tranche without rerolling.
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toEqual(first);
    const projection = f.repo.getAdventureTurn(f.principal, created.turnId)!;
    expect(projection.receiptLinks.some((link) => link.linkId === `journey-${first.commandId}`)).toBe(true);

    const continued = turn(f, "interrupt-2", "continue journey");
    const second = committed(f.repo.executeDeclaredActorJourney(f.principal, continued.turnId));
    expect(second).toMatchObject({
      status: "completed", originLocationId: "B", requestedDestinationLocationId: "C", currentLocationId: "C",
      journeyId: first.journeyId, elapsedMinutes: 60, revisionBefore: 1, revisionAfter: 2,
    });
    expect(second.path.map((step) => step.connectionId)).toEqual(["B-C"]);
    expect(f.remaining()).toBe(0);
    f.repo.close();
  });

  it("does not write or roll when the intermediate route is closed", () => {
    const f = seed({ connections: [{ id: "A-B", from: "A", to: "B" }, { id: "B-C", from: "B", to: "C", routeState: "closed" }] });
    const created = turn(f, "blocked-closed", "i move to place lasalle");
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toBeNull();
    const db = rawDb();
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 0 });
    db.close();
    f.repo.close();
  });

  it("does not write or roll when the intermediate route is hidden from the player", () => {
    const f = seed({ connections: [{ id: "A-B", from: "A", to: "B", visibility: "gm" }, { id: "B-C", from: "B", to: "C" }] });
    const created = turn(f, "blocked-hidden", "i move to place lasalle");
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toBeNull();
    const db = rawDb();
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 0 });
    db.close();
    f.repo.close();
  });

  it("does not resolve a journey while an encounter is active", () => {
    const f = seed();
    const created = turn(f, "combat", "i move to place lasalle");
    const db = rawDb();
    db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,created_at,updated_at)
      VALUES('encounter',?,'session','improvised','active',?,?)`).run(f.campaign.id, at, at);
    db.close();

    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toBeNull();
    const audit = rawDb();
    expect(audit.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    expect(audit.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 0 });
    audit.close();
    f.repo.close();
  });

  it("leaves a compound declaration to planning without committing", () => {
    const f = seed();
    const created = turn(f, "compound", "I move to Place La Salle and then rest");
    expect(f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toBeNull();
    const db = rawDb();
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    db.close();
    f.repo.close();
  });

  it("rolls back every leg and the world clock when the final journey insert fails", () => {
    const f = seed();
    const created = turn(f, "rollback", "i move to place lasalle");
    const db = rawDb();
    db.exec("CREATE TRIGGER test_force_journey_failure BEFORE INSERT ON world_actor_journey_executions_v1 BEGIN SELECT RAISE(ABORT,'forced journey failure'); END;");
    expect(() => f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toThrow();
    db.exec("DROP TRIGGER test_force_journey_failure");

    expect(db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_receipts_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id='session'").get(f.campaign.id)).toBeUndefined();
    expect(db.prepare("SELECT location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id='actor'").get(f.campaign.id))
      .toEqual({ location_id: "A", state_revision: 0 });
    expect(db.prepare("SELECT count(*) count FROM campaign_location_discoveries_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id='session'").get(f.campaign.id)).toBeUndefined();
    expect(db.prepare("SELECT count(*) count FROM world_actor_journey_executions_v1").get()).toEqual({ count: 0 });
    db.close();
    f.repo.close();
  });

  it("denies replay and receipt reads after actor control is lost", () => {
    const f = seed({ principal: "journey-player" });
    const created = turn(f, "control", "i move to place lasalle");
    const result = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));

    const db = rawDb();
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='local-owner' WHERE campaign_id=? AND actor_id='actor'").run(f.campaign.id);
    db.close();

    expect(() => f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toThrow(WorldAuthorizationError);
    expect(() => f.repo.getActorJourneyNarrationReceipt(f.principal, created.turnId, result.commandId)).toThrow(WorldAuthorizationError);
    f.repo.close();
  });

  it("fails closed when a persisted journey sidecar digest is corrupted", () => {
    const f = seed();
    const created = turn(f, "corrupt", "i move to place lasalle");
    const result = committed(f.repo.executeDeclaredActorJourney(f.principal, created.turnId));

    const db = rawDb();
    db.exec("DROP TRIGGER world_actor_journey_executions_v1_immutable_update");
    db.prepare("UPDATE world_actor_journey_executions_v1 SET result_json=? WHERE command_id=?").run(JSON.stringify({ tampered: true }), result.commandId);
    db.close();

    expect(() => f.repo.executeDeclaredActorJourney(f.principal, created.turnId)).toThrow(WorldConflictError);
    f.repo.close();
  });
});
