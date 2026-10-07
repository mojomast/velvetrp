import DatabaseDriver from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  MAX_ACTOR_JOURNEY_HOPS,
  resolveActorJourneyPath,
  type ActorJourneyPath,
} from "../src/repo/world/actorJourneyPath.js";

const CAMPAIGN = "campaign";
const SESSION = "session";
const ACTOR = "actor-1";
const PRINCIPAL = "principal-1";

type Visibility = "public" | "discovered" | "gm";
type EdgeInput = {
  id: string;
  from: string;
  to: string;
  visibility?: Visibility;
  state?: "open" | "closed";
  requirement?: "none" | "discovery" | "faction_reputation";
  factionId?: string;
  minimum?: number;
};

/** Minimal in-memory world carrying only the tables the shared policy reads. */
class Harness {
  readonly db = new DatabaseDriver(":memory:");
  constructor() {
    this.db.exec(`
      CREATE TABLE campaign_memberships(campaign_id TEXT, principal_id TEXT, role TEXT);
      CREATE TABLE sessions(id TEXT, state TEXT, stopped_at TEXT);
      CREATE TABLE campaign_sessions(campaign_id TEXT, session_id TEXT);
      CREATE TABLE campaign_actors(campaign_id TEXT, id TEXT);
      CREATE TABLE campaign_actor_private_state(campaign_id TEXT, actor_id TEXT, controller_principal_id TEXT);
      CREATE TABLE campaign_locations_v28(campaign_id TEXT, location_id TEXT, visibility TEXT);
      CREATE TABLE campaign_location_connections_v28(campaign_id TEXT, connection_id TEXT, from_location_id TEXT,
        to_location_id TEXT, visibility TEXT, route_state TEXT, requirement_kind TEXT, required_faction_id TEXT,
        minimum_reputation INTEGER);
      CREATE TABLE campaign_actor_locations_v28(campaign_id TEXT, session_id TEXT, actor_id TEXT, location_id TEXT, state_revision INTEGER);
      CREATE TABLE campaign_location_discoveries_v28(campaign_id TEXT, actor_id TEXT, location_id TEXT);
      CREATE TABLE campaign_reputation_ledger_v28(campaign_id TEXT, actor_id TEXT, faction_id TEXT, delta INTEGER);
      CREATE TABLE campaign_faction_reputation_v32(campaign_id TEXT, actor_id TEXT, faction_id TEXT, delta INTEGER);
    `);
    this.db.prepare("INSERT INTO campaign_memberships VALUES(?,?,?)").run(CAMPAIGN, PRINCIPAL, "player");
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(SESSION, "active", null);
    this.db.prepare("INSERT INTO campaign_sessions VALUES(?,?)").run(CAMPAIGN, SESSION);
    this.addLocation("A");
    this.addActor(ACTOR);
    this.setController(ACTOR, PRINCIPAL);
    this.place(ACTOR, "A");
  }

  addLocation(id: string, visibility: Visibility = "public"): this {
    if (!this.db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?").get(CAMPAIGN, id))
      this.db.prepare("INSERT INTO campaign_locations_v28 VALUES(?,?,?)").run(CAMPAIGN, id, visibility);
    return this;
  }

  addActor(id: string): this {
    if (!this.db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(CAMPAIGN, id))
      this.db.prepare("INSERT INTO campaign_actors VALUES(?,?)").run(CAMPAIGN, id);
    return this;
  }

  setController(actorId: string, principalId: string): this {
    this.db.prepare("INSERT INTO campaign_actor_private_state VALUES(?,?,?)").run(CAMPAIGN, actorId, principalId);
    return this;
  }

  place(actorId: string, locationId: string, revision = 0): this {
    this.addLocation(locationId);
    this.db.prepare("DELETE FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=? AND actor_id=?")
      .run(CAMPAIGN, SESSION, actorId);
    this.db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,?)").run(CAMPAIGN, SESSION, actorId, locationId, revision);
    return this;
  }

  addEdge(edge: EdgeInput): this {
    this.addLocation(edge.from);
    this.addLocation(edge.to);
    this.db.prepare("INSERT INTO campaign_location_connections_v28 VALUES(?,?,?,?,?,?,?,?,?)").run(
      CAMPAIGN, edge.id, edge.from, edge.to, edge.visibility ?? "public", edge.state ?? "open",
      edge.requirement ?? "none",
      edge.requirement === "faction_reputation" ? edge.factionId ?? "faction" : null,
      edge.requirement === "faction_reputation" ? edge.minimum ?? 0 : null,
    );
    return this;
  }

  discover(actorId: string, locationId: string): this {
    this.db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,?)").run(CAMPAIGN, actorId, locationId);
    return this;
  }

  repute(actorId: string, factionId: string, delta: number): this {
    this.db.prepare("INSERT INTO campaign_reputation_ledger_v28 VALUES(?,?,?,?)").run(CAMPAIGN, actorId, factionId, delta);
    return this;
  }

  setRole(role: string): this {
    this.db.prepare("UPDATE campaign_memberships SET role=? WHERE campaign_id=? AND principal_id=?").run(role, CAMPAIGN, PRINCIPAL);
    return this;
  }

  resolve(
    targetLocationId: string,
    override: Partial<{ actorId: string; principalId: string; partyActorIds: string[]; audienceMode: "principal" | "player" }> = {},
  ): ActorJourneyPath | null {
    return resolveActorJourneyPath(this.db, {
      campaignId: CAMPAIGN,
      sessionId: SESSION,
      actorId: override.actorId ?? ACTOR,
      principalId: override.principalId ?? PRINCIPAL,
      partyActorIds: override.partyActorIds ?? [ACTOR],
      targetLocationId,
      ...(override.audienceMode === undefined ? {} : { audienceMode: override.audienceMode }),
    });
  }
}

const stepIds = (path: ActorJourneyPath | null) => path?.steps.map((step) => step.connectionId) ?? null;

describe("resolveActorJourneyPath", () => {
  it("rejects a target that is the party's own current location", () => {
    const h = new Harness();
    expect(h.resolve("A")).toBeNull();
  });

  it("prefers the direct edge and otherwise returns the deterministic shortest path", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B" })
      .addEdge({ id: "bd", from: "B", to: "D" })
      .addEdge({ id: "ac", from: "A", to: "C" })
      .addEdge({ id: "cd", from: "C", to: "D" });
    // Two equal-length branches; the lower connection id ("ab" < "ac") wins.
    expect(stepIds(h.resolve("D"))).toEqual(["ab", "bd"]);
    h.addEdge({ id: "ad", from: "A", to: "D" });
    expect(stepIds(h.resolve("D"))).toEqual(["ad"]);
    expect(h.resolve("D")).toMatchObject({ originLocationId: "A", destinationLocationId: "D" });
  });

  it("never fabricates a reverse edge for a one-way connection", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B" });
    expect(stepIds(h.resolve("B"))).toEqual(["ab"]);
    h.place(ACTOR, "B");
    expect(h.resolve("A")).toBeNull();
    h.addEdge({ id: "ba", from: "B", to: "A" });
    expect(stepIds(h.resolve("A"))).toEqual(["ba"]);
  });

  it("terminates on cycles and still reaches the target", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B" })
      .addEdge({ id: "bc", from: "B", to: "C" })
      .addEdge({ id: "ca", from: "C", to: "A" })
      .addEdge({ id: "cd", from: "C", to: "D" });
    expect(stepIds(h.resolve("D"))).toEqual(["ab", "bc", "cd"]);
  });

  it("skips closed connections and fails closed when every route is closed", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B", state: "closed" })
      .addEdge({ id: "ac", from: "A", to: "C" })
      .addEdge({ id: "cb", from: "C", to: "B" });
    expect(stepIds(h.resolve("B"))).toEqual(["ac", "cb"]);
    const closed = new Harness();
    closed.addEdge({ id: "ab", from: "A", to: "B", state: "closed" });
    expect(closed.resolve("B")).toBeNull();
  });

  it("hides GM route and GM destination visibility from player audiences only", () => {
    const route = new Harness();
    route.addEdge({ id: "ab", from: "A", to: "B", visibility: "gm" });
    expect(route.resolve("B", { audienceMode: "player" })).toBeNull();
    route.setRole("gm");
    expect(stepIds(route.resolve("B"))).toEqual(["ab"]);

    const destination = new Harness();
    destination.addLocation("B", "gm");
    destination.addEdge({ id: "ab", from: "A", to: "B" });
    expect(destination.resolve("B", { audienceMode: "player" })).toBeNull();
    destination.setRole("gm");
    expect(stepIds(destination.resolve("B"))).toEqual(["ab"]);
  });

  it("requires discovery for discovered routes before allowing the step", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B", visibility: "discovered" });
    expect(h.resolve("B")).toBeNull();
    h.discover(ACTOR, "B");
    expect(stepIds(h.resolve("B"))).toEqual(["ab"]);
  });

  it("requires faction reputation for every party member", () => {
    const h = new Harness();
    h.addActor("actor-2").setController("actor-2", PRINCIPAL).place("actor-2", "A");
    h.addEdge({ id: "ab", from: "A", to: "B", requirement: "faction_reputation", factionId: "faction", minimum: 5 });
    const party = [ACTOR, "actor-2"];
    expect(h.resolve("B", { partyActorIds: party })).toBeNull();
    h.repute(ACTOR, "faction", 5);
    expect(h.resolve("B", { partyActorIds: party })).toBeNull();
    h.repute("actor-2", "faction", 5);
    expect(stepIds(h.resolve("B", { partyActorIds: party }))).toEqual(["ab"]);
  });

  it("requires the whole party to be co-located at the origin", () => {
    const h = new Harness();
    h.addActor("actor-2").setController("actor-2", PRINCIPAL).place("actor-2", "X");
    h.addEdge({ id: "ab", from: "A", to: "B" });
    const party = [ACTOR, "actor-2"];
    expect(h.resolve("B", { partyActorIds: party })).toBeNull();
    h.place("actor-2", "A");
    const path = h.resolve("B", { partyActorIds: party });
    expect(stepIds(path)).toEqual(["ab"]);
    expect(path?.positions.map((position) => position.actorId)).toEqual(party);
  });

  it("denies unauthorized principals, observers, and uncontrolled party members", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B" });
    expect(h.resolve("B", { principalId: "stranger" })).toBeNull();
    h.setRole("observer");
    expect(h.resolve("B")).toBeNull();
    h.setRole("player");
    h.addActor("actor-2").place("actor-2", "A");
    expect(h.resolve("B", { partyActorIds: [ACTOR, "actor-2"] })).toBeNull();
    expect(h.resolve("B", { actorId: ACTOR, partyActorIds: ["actor-2"] })).toBeNull();
  });

  it("bounds journeys at the hop limit", () => {
    const h = new Harness();
    let previous = "A";
    for (let index = 0; index <= MAX_ACTOR_JOURNEY_HOPS; index += 1) {
      const next = `N${index + 1}`;
      h.addEdge({ id: `e${String(index).padStart(2, "0")}`, from: previous, to: next });
      previous = next;
    }
    expect(stepIds(h.resolve(`N${MAX_ACTOR_JOURNEY_HOPS}`))?.length).toBe(MAX_ACTOR_JOURNEY_HOPS);
    expect(h.resolve(`N${MAX_ACTOR_JOURNEY_HOPS + 1}`)).toBeNull();
  });

  it("fails closed when the route graph exceeds the edge bound", () => {
    const h = new Harness();
    h.addEdge({ id: "ab", from: "A", to: "B" });
    const insert = h.db.prepare("INSERT INTO campaign_location_connections_v28 VALUES(?,?,?,?,?,?,?,?,?)");
    h.db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(CAMPAIGN, `x${String(index).padStart(5, "0")}`, "A", "Z", "public", "open", "none", null, null);
      }
    })();
    expect(h.resolve("B")).toBeNull();
  });
});
