import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentObservationConflictError,
  createAgentObservationRepository,
  type AgentObservationInput,
} from "../src/repo/observations/agentObservationRepo.js";
import {
  MAX_FACTION_WITNESS_FANOUT,
  MAX_GOSSIP_PER_NPC,
  MAX_GOSSIP_SOURCE_ITEMS,
  MAX_TELL_PER_ARRIVAL,
  MAX_WITNESS_FANOUT,
  TOWN_GOSSIP_AGENT_ID,
  gossipSampleIncluded,
  propagateFactionWitnessObservations,
  propagateGossipToPresentNpcs,
  propagateToldOnArrival,
  propagateTownGossipObservations,
  propagateWitnessObservations,
  type PropagationDependencies,
} from "../src/repo/observations/agentObservationPropagation.js";
import { createRepository, createSession } from "../src/repo/index.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function checkSeed() {
  const first = createRepository();
  const campaign = first.createCampaign("local-owner", { name: "Check witnesses" });
  first.close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  const profile = "dnd-5e";
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES (?,?,?,?)").run(profile, profile, "Rules", "[]");
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1',?,'Pack','Pack','[]',0)").run(profile);
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','sage','Sage','Background','[]'),('pack','1','class','wizard','Wizard','Class','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,?)").run(campaign.id, profile);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1',?)").run(campaign.id, profile);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','sage',?,?)").run(campaign.id, at, at);
  for (const [position, id, value] of [[0, "strength", 20], [1, "dexterity", 14], [2, "constitution", 12],
    [3, "intelligence", 16], [4, "wisdom", 14], [5, "charisma", 8]] as const) {
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?,?,?,?,?)").run(campaign.id, "sheet", position, id, value);
  }
  db.prepare("INSERT INTO rpg_character_classes VALUES (?,'sheet',0,'pack','1','class','wizard',5)").run(campaign.id);
  db.prepare("INSERT INTO rpg_character_proficiencies VALUES (?,'sheet',0,'skill','skill.perception')").run(campaign.id);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.close();
  const repo = createRepository({ clock: { now: () => new Date(at) }, rng: { integer: () => 12 } });
  return { repo, campaign };
}

interface ObservationRow {
  observation_id: string;
  agent_id: string;
  source_command_id: string;
  channel: string;
  hop_count: number;
  relayer_agent_id: string | null;
  text: string;
  authority: string;
}

async function fixture(npcCount = 3) {
  const repo = createRepository({ clock: { now: () => new Date(at) } });
  const campaign = repo.createCampaign("local-owner", { name: "Propagation" });
  const npcs: string[] = [];
  for (let index = 0; index < npcCount; index += 1) {
    const persona = repo.createCharacter({ name: `Persona ${index}`, age: 30, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = repo.createCampaignNpc("local-owner", campaign.id, {
      personaId: persona.id, publicState: { name: `NPC ${index}` },
      privateState: { goals: "Goals", gmNotes: "Notes", merchantState: null },
      expectedRevision: index, idempotencyKey: `npc-${index}`,
    }).npc;
    npcs.push(npc.npcId);
  }
  const sessionPersona = repo.createCharacter({ name: "Session", age: 30, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
  const session = await createSession({ characterId: sessionPersona.id, title: "Propagation session" });
  await repo.transitionSession(session.id, "active", "start");
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
  const otherSession = await createSession({ characterId: sessionPersona.id, title: "Other propagation session" });
  await repo.transitionSession(otherSession.id, "active", "start");
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: otherSession.id } as any);

  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  let idc = 0;
  const dependencies: PropagationDependencies = { clock: { now: () => new Date(at) }, ids: { nextId: () => `prop-${++idc}` } };
  const rootRevision = (sessionId: string) =>
    (db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
      .get(campaign.id, sessionId) as { revision: number } | undefined)?.revision ?? 0;
  const placeIn = (sessionId: string, npcId: string) => repo.mutateNpcPresence("local-owner", {
    campaignId: campaign.id, sessionId, npcId, expectedRevision: rootRevision(sessionId),
    idempotencyKey: `place-${sessionId}-${npcId}-${rootRevision(sessionId)}`, mutation: { kind: "place", locationId: null },
  });
  const place = (npcId: string) => placeIn(session.id, npcId);
  const observations = (agentId: string) => db.prepare(`SELECT observation_id,agent_id,source_command_id,channel,hop_count,
    relayer_agent_id,text,authority FROM agent_observations WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?
    ORDER BY observation_id`).all(campaign.id, agentId) as ObservationRow[];
  const factionObservations = (agentId: string) => db.prepare(`SELECT observation_id,agent_id,source_command_id,channel,hop_count,
    relayer_agent_id,text,authority FROM agent_observations WHERE campaign_id=? AND agent_kind='faction' AND agent_id=?
    ORDER BY observation_id`).all(campaign.id, agentId) as ObservationRow[];
  const townObservations = () => db.prepare(`SELECT observation_id,agent_id,source_command_id,channel,hop_count,
    relayer_agent_id,text,authority FROM agent_observations WHERE campaign_id=? AND agent_kind='town' AND agent_id=?
    ORDER BY observation_id`).all(campaign.id, TOWN_GOSSIP_AGENT_ID) as ObservationRow[];
  const addFaction = (factionId: string, memberships: Array<{ npcId: string; role?: string }>) => {
    db.prepare("INSERT INTO campaign_factions_v28 VALUES(?,?,?,?,?)").run(factionId, campaign.id, factionId, "public", at);
    for (const { npcId, role } of memberships) {
      db.prepare("INSERT INTO campaign_npc_faction_memberships_v28 VALUES(?,?,?,?,?)")
        .run(campaign.id, factionId, npcId, role ?? "member", at);
    }
  };
  const allObservations = () => db.prepare(`SELECT observation_id,agent_id,source_command_id,channel,hop_count,
    relayer_agent_id,text,authority FROM agent_observations WHERE campaign_id=? ORDER BY observation_id`)
    .all(campaign.id) as ObservationRow[];
  const row = (agentId: string, sourceCommandId: string, text: string, observedRevision: number, overrides: Partial<AgentObservationInput> = {}): AgentObservationInput => ({
    campaignId: campaign.id, timelineId: campaign.activeTimelineId, agentKind: "npc", agentId, sourceCommandId,
    observedRevision, channel: "witnessed", hopCount: 0, text, authority: "verified", ...overrides,
  });
  return { repo, db, campaign, session, otherSession, npcs, dependencies, place, placeIn, rootRevision, observations,
    factionObservations, townObservations, addFaction, allObservations, row };
}

describe("agent observation propagation", () => {
  it("writes one witnessed hop-0 row per present NPC and never for absent NPCs", async () => {
    const f = await fixture(3);
    f.place(f.npcs[0]!);
    f.place(f.npcs[1]!);
    const summary = "A Strength check ended in success.";
    const rows = propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:one", observedRevision: 7, summary,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(({ agentId }) => agentId).sort()).toEqual([f.npcs[0]!, f.npcs[1]!].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ channel: "witnessed", hopCount: 0, relayerAgentId: null, authority: "verified", text: summary, observedRevision: 7 });
    }
    expect(f.observations(f.npcs[2]!)).toEqual([]);
    f.repo.close();
  });

  it("writes no rows when no NPC is present", async () => {
    const f = await fixture(2);
    expect(propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:none", observedRevision: 1, summary: "Nobody is watching.",
    })).toEqual([]);
    expect(f.allObservations()).toEqual([]);
    f.repo.close();
  });

  it("isolates witnesses by session", async () => {
    const f = await fixture(2);
    f.placeIn(f.otherSession.id, f.npcs[0]!);
    expect(propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:isolation", observedRevision: 1, summary: "Only the other room sees this.",
    })).toEqual([]);
    const other = propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.otherSession.id,
      sourceCommandId: "check-command:isolation", observedRevision: 1, summary: "Only the other room sees this.",
    });
    expect(other.map(({ agentId }) => agentId)).toEqual([f.npcs[0]!]);
    f.repo.close();
  });

  it("bounds witness fan-out by MAX_WITNESS_FANOUT", async () => {
    const f = await fixture(MAX_WITNESS_FANOUT + 1);
    for (const npcId of f.npcs) f.place(npcId);
    const rows = propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:fanout", observedRevision: 1, summary: "A crowd watches.",
    });
    expect(rows).toHaveLength(MAX_WITNESS_FANOUT);
    f.repo.close();
  });

  it("derives faction knowledge from a present member NPC witness", async () => {
    const f = await fixture(2);
    const [member] = f.npcs as [string, string];
    f.addFaction("faction-fellowship", [{ npcId: member }]);
    f.place(member);
    const summary = "A Perception check ended in failure.";
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:faction", observedRevision: 4, summary,
    });
    const rows = propagateFactionWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:faction", observedRevision: 4, summary,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentKind: "faction", agentId: "faction-fellowship", channel: "witnessed",
      hopCount: 0, relayerAgentId: null, authority: "verified", text: summary, observedRevision: 4 });
    expect(f.factionObservations("faction-fellowship")).toHaveLength(1);
    f.repo.close();
  });

  it("does not leak to a faction when the witness is absent or an enemy", async () => {
    const f = await fixture(2);
    const [present, absent] = f.npcs as [string, string];
    f.addFaction("faction-absent", [{ npcId: absent }]);
    f.addFaction("faction-enemy", [{ npcId: present, role: "enemy" }]);
    f.place(present);
    const rows = propagateFactionWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:secret", observedRevision: 2, summary: "A quiet check.",
    });
    expect(rows).toEqual([]);
    expect(f.factionObservations("faction-absent")).toEqual([]);
    expect(f.factionObservations("faction-enemy")).toEqual([]);
    f.repo.close();
  });

  it("bounds faction fan-out by MAX_FACTION_WITNESS_FANOUT", async () => {
    const f = await fixture(1);
    const [npc] = f.npcs as [string];
    f.place(npc);
    for (let index = 0; index <= MAX_FACTION_WITNESS_FANOUT; index += 1) {
      f.addFaction(`faction-${index}`, [{ npcId: npc }]);
    }
    const rows = propagateFactionWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:many", observedRevision: 1, summary: "Many factions listen.",
    });
    expect(rows).toHaveLength(MAX_FACTION_WITNESS_FANOUT);
    f.repo.close();
  });

  it("returns identical faction rows on idempotent replay", async () => {
    const f = await fixture(1);
    const [npc] = f.npcs as [string];
    f.addFaction("faction-replay", [{ npcId: npc }]);
    f.place(npc);
    const input = { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "replay-faction", observedRevision: 6, summary: "A repeatable faction fact." };
    const first = propagateFactionWitnessObservations(f.db, f.dependencies, input);
    const second = propagateFactionWitnessObservations(f.db, f.dependencies, input);
    expect(second).toEqual(first);
    expect(f.factionObservations("faction-replay")).toHaveLength(1);
    f.repo.close();
  });

  it("records one campaign gossip row per public receipt and replays idempotently", async () => {
    const f = await fixture(1);
    const input = {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:town", observedRevision: 2, summary: "The hero won a bet at the docks.",
    };
    const first = propagateTownGossipObservations(f.db, f.dependencies, input);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ agentKind: "town", agentId: TOWN_GOSSIP_AGENT_ID, channel: "witnessed",
      hopCount: 0, relayerAgentId: null, authority: "rumor", text: "The hero won a bet at the docks." });
    expect(propagateTownGossipObservations(f.db, f.dependencies, input)).toEqual([]);
    expect(f.townObservations()).toHaveLength(1);
    f.repo.close();
  });

  it("samples gossip to present NPCs with town attribution without claiming everyone knows", async () => {
    const f = await fixture(12);
    for (const npcId of f.npcs) f.place(npcId);
    propagateTownGossipObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:gossip", observedRevision: 3, summary: "A brawl broke out in the square.",
    });
    const rows = propagateGossipToPresentNpcs(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
    });
    const expected = f.npcs.filter((npcId) => gossipSampleIncluded(npcId, "check-command:gossip")).sort();
    expect(rows.map(({ agentId }) => agentId).sort()).toEqual(expected);
    for (const row of rows) {
      expect(row).toMatchObject({ agentKind: "npc", channel: "told", hopCount: 1,
        relayerAgentId: TOWN_GOSSIP_AGENT_ID, authority: "rumor", sourceCommandId: "check-command:gossip" });
    }
    const synthetic = Array.from({ length: 100 }, (_, index) => `npc-${index}`);
    const included = synthetic.filter((npcId) => gossipSampleIncluded(npcId, "check-command:gossip"));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(synthetic.length);
    expect(propagateGossipToPresentNpcs(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
    })).toEqual([]);
    f.repo.close();
  });

  it("does not tell gossip to an NPC that witnessed the event", async () => {
    const f = await fixture(12);
    for (const npcId of f.npcs) f.place(npcId);
    const source = "check-command:witnessed-gossip";
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: source, observedRevision: 1, summary: "Everyone in the room saw this.",
    });
    propagateTownGossipObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: source, observedRevision: 1, summary: "Everyone in the room saw this.",
    });
    expect(propagateGossipToPresentNpcs(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
    })).toEqual([]);
    f.repo.close();
  });

  it("bounds gossip sampled per NPC by MAX_GOSSIP_PER_NPC", async () => {
    const f = await fixture(12);
    for (const npcId of f.npcs) f.place(npcId);
    const pool: string[] = [];
    for (let index = 0; index < MAX_GOSSIP_SOURCE_ITEMS; index += 1) {
      pool.push(`gossip-${index}`);
      propagateTownGossipObservations(f.db, f.dependencies, {
        campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
        sourceCommandId: `gossip-${index}`, observedRevision: index + 1, summary: `Rumor ${index}`,
      });
    }
    const rows = propagateGossipToPresentNpcs(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
    });
    const perNpc = new Map<string, number>();
    for (const row of rows) perNpc.set(row.agentId, (perNpc.get(row.agentId) ?? 0) + 1);
    for (const npcId of f.npcs) {
      const sampled = pool.filter((source) => gossipSampleIncluded(npcId, source)).length;
      expect(perNpc.get(npcId) ?? 0).toBe(Math.min(sampled, MAX_GOSSIP_PER_NPC));
    }
    f.repo.close();
  });

  it("spreads a witnessed observation as a told hop-1 row", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:origin", observedRevision: 3, summary: "The hero won the bet.",
    });
    const told = propagateToldOnArrival(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      arrivingNpcId: arriving, observedRevision: 5,
    });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ channel: "told", hopCount: 1, relayerAgentId: knower, agentId: arriving,
      sourceCommandId: "check-command:origin", authority: "rumor", text: "The hero won the bet.", observedRevision: 3 });
    f.repo.close();
  });

  it("chains a second hop and refuses a third", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    const ledger = createAgentObservationRepository(f.db, f.dependencies);
    ledger.record(f.row(knower, "hop-source:1", "One hop away", 1,
      { channel: "told", hopCount: 1, relayerAgentId: "npc-origin", authority: "rumor" }));
    const second = propagateToldOnArrival(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      arrivingNpcId: arriving, observedRevision: 9,
    });
    expect(second.filter(({ hopCount, relayerAgentId }) => hopCount === 2 && relayerAgentId === knower)).toHaveLength(1);

    ledger.record(f.row(knower, "hop-source:2", "Two hops away", 1,
      { channel: "told", hopCount: 2, relayerAgentId: "npc-origin", authority: "rumor" }));
    const third = propagateToldOnArrival(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      arrivingNpcId: arriving, observedRevision: 9,
    });
    expect(third.some(({ hopCount }) => hopCount > 2)).toBe(false);
    expect(third.some(({ sourceCommandId }) => sourceCommandId === "hop-source:2")).toBe(false);
    f.repo.close();
  });

  it("bounds told rows per arrival by MAX_TELL_PER_ARRIVAL", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    const ledger = createAgentObservationRepository(f.db, f.dependencies);
    for (let index = 0; index < MAX_TELL_PER_ARRIVAL + 2; index += 1) {
      ledger.record(f.row(knower, `source-${index}`, `Fact ${index}`, 1));
    }
    const told = propagateToldOnArrival(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      arrivingNpcId: arriving, observedRevision: 2,
    });
    expect(told).toHaveLength(MAX_TELL_PER_ARRIVAL);
    f.repo.close();
  });

  it("skips an agent already at the per-agent cap without deleting rows", async () => {
    const f = await fixture(1);
    const [npc] = f.npcs as [string];
    f.place(npc);
    const ledger = createAgentObservationRepository(f.db, f.dependencies);
    for (let index = 0; index < 256; index += 1) ledger.record(f.row(npc, `cap-source-${index}`, `Archived fact ${index}`, 1));
    expect(f.observations(npc)).toHaveLength(256);
    expect(propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "cap-source:new", observedRevision: 1, summary: "One fact too many.",
    })).toEqual([]);
    expect(f.observations(npc)).toHaveLength(256);
    f.repo.close();
  });

  it("returns identical rows on idempotent replay and never mutates existing rows", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    const input = {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "replay-command", observedRevision: 4, summary: "A replayable fact.",
    };
    const firstWitnesses = propagateWitnessObservations(f.db, f.dependencies, input);
    const snapshot = f.allObservations();
    expect(propagateWitnessObservations(f.db, f.dependencies, input)).toEqual(firstWitnesses);
    const toldInput = {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      arrivingNpcId: arriving, observedRevision: 4,
    };
    const firstTold = propagateToldOnArrival(f.db, f.dependencies, toldInput);
    expect(propagateToldOnArrival(f.db, f.dependencies, toldInput)).toEqual(firstTold);
    expect(f.allObservations().map((entry) => entry.observation_id)).toEqual(
      [...snapshot.map((entry) => entry.observation_id), ...firstTold.map((entry) => entry.observationId)].sort(),
    );
    f.repo.close();
  });

  it("records observations through the repository presence-arrival path", async () => {    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "check-command:wired", observedRevision: 1, summary: "A Perception check ended in failure.",
    });
    f.place(arriving);
    const rows = f.observations(arriving);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "told", hop_count: 1, relayer_agent_id: knower,
      source_command_id: "check-command:wired", authority: "rumor", text: "A Perception check ended in failure." });
    f.repo.close();
  });

  it("re-arrival is idempotent and never blocks the presence change", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "re-arrival-source", observedRevision: 2, summary: "The hero lost the bet.",
    });
    f.place(arriving);
    expect(f.observations(arriving)).toHaveLength(1);
    const removeRevision = f.rootRevision(f.session.id);
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaign.id, sessionId: f.session.id, npcId: arriving,
      expectedRevision: removeRevision, idempotencyKey: `remove-${removeRevision}`, mutation: { kind: "remove" } });
    expect(f.observations(arriving)).toHaveLength(1);
    f.place(arriving);
    const rows = f.observations(arriving);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "told", hop_count: 1, relayer_agent_id: knower,
      source_command_id: "re-arrival-source" });
    f.repo.close();
  });

  it("rolls back propagation rows with the surrounding transaction", async () => {
    const f = await fixture(2);
    f.place(f.npcs[0]!);
    f.place(f.npcs[1]!);
    const before = f.allObservations();
    const transaction = f.db.transaction(() => {
      propagateWitnessObservations(f.db, f.dependencies, {
        campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
        sourceCommandId: "rollback-command", observedRevision: 1, summary: "Should not survive.",
      });
      throw new Error("forced rollback");
    });
    expect(() => transaction.immediate()).toThrow("forced rollback");
    expect(f.allObservations()).toEqual(before);
    f.repo.close();
  });

  it("rolls back a presence arrival when propagation conflicts", async () => {
    const f = await fixture(2);
    const [knower, arriving] = f.npcs as [string, string];
    f.place(knower);
    propagateWitnessObservations(f.db, f.dependencies, {
      campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.session.id,
      sourceCommandId: "conflict-source", observedRevision: 1, summary: "The committed fact.",
    });
    createAgentObservationRepository(f.db, f.dependencies).record(f.row(arriving, "conflict-source", "A contradicting rumor", 1,
      { channel: "told", hopCount: 1, relayerAgentId: knower, authority: "rumor" }));
    expect(() => f.place(arriving)).toThrow(AgentObservationConflictError);
    expect(f.db.prepare(`SELECT count(*) count FROM campaign_npc_presence_v43
      WHERE campaign_id=? AND session_id=? AND npc_id=?`).get(f.campaign.id, f.session.id, arriving)).toEqual({ count: 0 });
    expect(f.observations(arriving)).toHaveLength(1);
    f.repo.close();
  });

  it("records a witnessed observation when a committed check runs with an NPC present", async () => {
    const { repo, campaign } = checkSeed();
    const persona = repo.createCharacter({ name: "Watcher", age: 40, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = repo.createCampaignNpc("local-owner", campaign.id, {
      personaId: persona.id, publicState: { name: "Watcher" },
      privateState: { goals: "Watch", gmNotes: "Notes", merchantState: null },
      expectedRevision: 0, idempotencyKey: "watcher",
    }).npc;
    repo.mutateNpcPresence("local-owner", { campaignId: campaign.id, sessionId: "session", npcId: npc.npcId,
      expectedRevision: 0, idempotencyKey: "watcher-place", mutation: { kind: "place", locationId: null } });
    const created = repo.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I make a strength check.", expectedCampaignRevision: 0, idempotencyKey: "witness-check" });
    const candidate = repo.generateAdventureCheckCandidates("local-owner", created.turnId)
      .find((entry) => entry.label === "Strength (Strength), Easy difficulty, normal")!;
    const deps: AdventureAgentDependencies = {
      complete: async (input) => {
        if (!input.tools?.some((tool) => tool.name === "exact_srd_check.select")) throw new Error("check tool was not advertised");
        return { message: { role: "assistant", content: null, toolCalls: [{ id: "witness-call", name: "exact_srd_check.select",
          arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] },
          usage: null, model: { requestedModel: "fake", responseModel: "fake" } };
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
      getHarness: async () => defaultHarnessSettings(), now: () => new Date(at),
    };
    const result = await orchestrateAdventureTurn(repo, created.turnId, deps);
    expect(result.outcome).toBe("mechanics-committed");
    const commandId = result.turn.receiptLinks[0]!.commandId;
    const db = new DatabaseDriver(dbPath());
    const rows = db.prepare(`SELECT agent_id,channel,hop_count,text,authority FROM agent_observations
      WHERE campaign_id=? AND agent_kind='npc' AND source_command_id=?`).all(campaign.id, commandId) as Array<{ agent_id: string; channel: string; hop_count: number; text: string; authority: string }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ agent_id: npc.npcId, channel: "witnessed", hop_count: 0,
      text: "A Strength check ended in success.", authority: "verified" });
    repo.close();
  });
});
