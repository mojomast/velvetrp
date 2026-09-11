import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../src/repo/index.js";
import {
  AgentObservationUnavailableError,
  type AgentObservationInput,
} from "../src/repo/observations/agentObservationRepo.js";
import { MAX_AGENT_KNOWLEDGE_LIMIT } from "../src/repo/observations/agentObservationReadRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const BASE = Date.parse(at);
let tick = 0;
let sequence = 0;

const dataDir = () => process.env.VELVET_DATA_DIR as string;
const clock = { now: () => new Date(BASE + (tick++) * 1_000) };

function rawConnection(): DatabaseDriver.Database {
  const db = new DatabaseDriver(path.join(dataDir(), "velvet.sqlite"));
  db.pragma("foreign_keys = OFF");
  return db;
}

type Campaign = ReturnType<Repository["createCampaign"]>;

function setup() {
  const repo = createRepository({ dataDir: dataDir(), clock });
  const campaign = repo.createCampaign("local-owner", { name: "Knowledge read campaign" });
  const observe = (overrides: Partial<AgentObservationInput> = {}) => repo.recordAgentObservation("local-owner", {
    campaignId: campaign.id,
    timelineId: campaign.activeTimelineId,
    agentKind: "npc",
    agentId: "npc-maren",
    sourceCommandId: `command-${++sequence}`,
    observedRevision: 1,
    channel: "witnessed",
    hopCount: 0,
    text: "The hero won the bet.",
    authority: "verified",
    ...overrides,
  });
  return { repo, campaign, observe };
}

function addMember(db: DatabaseDriver.Database, campaignId: string, principalId: string, role: string): void {
  db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principalId, principalId);
  db.prepare(`INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at)
    SELECT id,?,?,updated_at FROM campaigns WHERE id=?`).run(principalId, role, campaignId);
}

function relationship(db: DatabaseDriver.Database, campaignId: string, npcId: string, actorId: string, trust: number): void {
  db.prepare(`INSERT INTO campaign_npc_relationships_v32
    (campaign_id,npc_id,actor_id,affinity,trust,fear,last_command_id,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(campaignId, npcId, actorId, 0, trust, 0, `relationship-command-${npcId}`, at);
}

const query = (campaign: Campaign, agentKind: "npc" | "faction" | "companion" | "town", agentId: string) =>
  ({ campaignId: campaign.id, agentKind, agentId });

describe("agent observation read repository", () => {
  it("rejects non-members, players, and observers and leaves data_version unchanged", () => {
    const { repo, campaign, observe } = setup();
    observe({ agentKind: "npc" });
    const db = rawConnection();
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('outsider','Outsider',0)").run();
    addMember(db, campaign.id, "player-1", "player");
    addMember(db, campaign.id, "observer-1", "observer");
    const before = db.pragma("data_version", { simple: true });
    for (const principalId of ["outsider", "player-1", "observer-1"]) {
      expect(() => repo.listAgentKnowledge(principalId, query(campaign, "npc", "npc-maren")))
        .toThrow(AgentObservationUnavailableError);
    }
    expect(db.pragma("data_version", { simple: true })).toBe(before);
    db.close();
    repo.close();
  });

  it("authorizes owners and GMs", () => {
    const { repo, campaign, observe } = setup();
    const recorded = observe({ agentKind: "npc" });
    const db = rawConnection();
    addMember(db, campaign.id, "gm-1", "gm");
    db.close();
    for (const principalId of ["local-owner", "gm-1"]) {
      const rows = repo.listAgentKnowledge(principalId, query(campaign, "npc", "npc-maren"));
      expect(rows.map((entry) => entry.observationId)).toEqual([recorded.observationId]);
    }
    repo.close();
  });

  it("scopes by campaign, agent, and the active timeline", () => {
    const { repo, campaign, observe } = setup();
    const active = observe({ agentId: "npc-maren", text: "Active timeline fact" });
    observe({ agentId: "npc-other", text: "Other agent fact" });
    const otherCampaign = repo.createCampaign("local-owner", { name: "Other knowledge campaign" });
    const foreign = repo.recordAgentObservation("local-owner", {
      campaignId: otherCampaign.id, timelineId: otherCampaign.activeTimelineId, agentKind: "npc",
      agentId: "npc-maren", sourceCommandId: "other-campaign-command", observedRevision: 1,
      channel: "witnessed", hopCount: 0, text: "Other campaign fact", authority: "verified",
    });
    const db = rawConnection();
    db.prepare(`INSERT INTO agent_observations
      (observation_id,campaign_id,timeline_id,agent_kind,agent_id,source_command_id,observed_revision,channel,relayer_agent_id,hop_count,text,authority,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("obs-other-timeline", campaign.id, "timeline-other", "npc",
      "npc-maren", "other-timeline-command", 1, "witnessed", null, 0, "Other timeline fact", "verified", at);
    db.close();
    const rows = repo.listAgentKnowledge("local-owner", query(campaign, "npc", "npc-maren"));
    expect(rows.map((entry) => entry.observationId)).toEqual([active.observationId]);
    const ids = rows.map((entry) => entry.observationId);
    expect(ids).not.toContain(foreign.observationId);
    expect(ids).not.toContain("obs-other-timeline");
    repo.close();
  });

  it("ranks matching observations by score and applies the contiguous phrase bonus", () => {
    const { repo, campaign, observe } = setup();
    const phrase = observe({ text: "The alpha beta appeared", authority: "rumor" });
    const separate = observe({ text: "The alpha then beta appeared", authority: "verified" });
    const gossip = observe({ text: "Unrelated market gossip", authority: "verified" });
    const ranked = repo.listAgentKnowledge("local-owner", {
      ...query(campaign, "npc", "npc-maren"), query: "alpha beta",
    });
    expect(ranked.map((entry) => entry.observationId)).toEqual([phrase.observationId, separate.observationId]);
    const single = repo.listAgentKnowledge("local-owner", {
      ...query(campaign, "npc", "npc-maren"), query: "market",
    });
    expect(single.map((entry) => entry.observationId)).toEqual([gossip.observationId]);
    repo.close();
  });

  it("returns newest first and respects the requested limit without a query", () => {
    const { repo, campaign, observe } = setup();
    const first = observe({ text: "First fact" });
    const second = observe({ text: "Second fact" });
    const third = observe({ text: "Third fact" });
    const base = query(campaign, "npc", "npc-maren");
    expect(repo.listAgentKnowledge("local-owner", base).map((entry) => entry.observationId))
      .toEqual([third.observationId, second.observationId, first.observationId]);
    expect(repo.listAgentKnowledge("local-owner", { ...base, limit: 2 }).map((entry) => entry.observationId))
      .toEqual([third.observationId, second.observationId]);
    repo.close();
  });

  it("clamps the requested limit into the bounded read window", () => {
    const { repo, campaign, observe } = setup();
    for (let index = 0; index < MAX_AGENT_KNOWLEDGE_LIMIT + 2; index += 1) {
      observe({ text: `Clamped fact ${index}` });
    }
    const base = query(campaign, "npc", "npc-maren");
    expect(repo.listAgentKnowledge("local-owner", { ...base, limit: 100 }))
      .toHaveLength(MAX_AGENT_KNOWLEDGE_LIMIT);
    expect(repo.listAgentKnowledge("local-owner", { ...base, limit: 0 })).toHaveLength(1);
    expect(repo.listAgentKnowledge("local-owner", { ...base, limit: -5 })).toHaveLength(1);
    repo.close();
  });

  it("classifies disclosure from authority and NPC trust", () => {
    const { repo, campaign, observe } = setup();
    const verified = observe({ agentId: "npc-verified", authority: "verified" });
    const rumorTrusted = observe({ agentId: "npc-trusted", authority: "rumor" });
    const beliefTrusted = observe({ agentId: "npc-trusted", authority: "belief" });
    const rumorNegative = observe({ agentId: "npc-negative", authority: "rumor" });
    const beliefNegative = observe({ agentId: "npc-negative", authority: "belief" });
    const rumorMissing = observe({ agentId: "npc-missing", authority: "rumor" });
    const faction = observe({ agentKind: "faction", agentId: "faction-1", authority: "rumor" });
    const town = observe({ agentKind: "town", agentId: "town-1", authority: "rumor" });
    const db = rawConnection();
    relationship(db, campaign.id, "npc-trusted", "listener-actor", 5);
    relationship(db, campaign.id, "npc-negative", "listener-actor", -5);
    db.close();

    const find = (agentKind: "npc" | "faction" | "town", agentId: string, observationId: string, listenerActorId?: string) =>
      repo.listAgentKnowledge("local-owner", {
        ...query(campaign, agentKind, agentId),
        ...(listenerActorId === undefined ? {} : { listenerActorId }),
      }).find((entry) => entry.observationId === observationId)!;

    expect(find("npc", "npc-verified", verified.observationId, "listener-actor").disclosable).toBe(true);
    expect(find("npc", "npc-trusted", rumorTrusted.observationId, "listener-actor").disclosable).toBe(true);
    expect(find("npc", "npc-trusted", beliefTrusted.observationId, "listener-actor").disclosable).toBe(true);
    expect(find("npc", "npc-negative", rumorNegative.observationId, "listener-actor").disclosable).toBe(false);
    expect(find("npc", "npc-negative", beliefNegative.observationId, "listener-actor").disclosable).toBe(false);
    expect(find("npc", "npc-missing", rumorMissing.observationId, "listener-actor").disclosable).toBe(false);
    expect(find("npc", "npc-trusted", rumorTrusted.observationId).disclosable).toBe(false);
    expect(find("npc", "npc-verified", verified.observationId).disclosable).toBe(true);
    expect(find("faction", "faction-1", faction.observationId, "listener-actor").disclosable).toBe(false);
    expect(find("town", "town-1", town.observationId, "listener-actor").disclosable).toBe(false);
    repo.close();
  });

  it("leaves data_version unchanged after a successful read", () => {
    const { repo, campaign, observe } = setup();
    observe({ agentId: "npc-trusted", authority: "rumor", text: "A rumor worth reading" });
    const db = rawConnection();
    relationship(db, campaign.id, "npc-trusted", "listener-actor", 2);
    const before = db.pragma("data_version", { simple: true });
    const rows = repo.listAgentKnowledge("local-owner", {
      ...query(campaign, "npc", "npc-trusted"), listenerActorId: "listener-actor", query: "rumor",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.disclosable).toBe(true);
    expect(db.pragma("data_version", { simple: true })).toBe(before);
    db.close();
    repo.close();
  });

  it("excludes private trust material from the returned entry shape", () => {
    const { repo, campaign, observe } = setup();
    const recorded = observe({ agentId: "npc-trusted", authority: "rumor" });
    const db = rawConnection();
    relationship(db, campaign.id, "npc-trusted", "listener-actor", 3);
    db.close();
    const [entry] = repo.listAgentKnowledge("local-owner", {
      ...query(campaign, "npc", "npc-trusted"), listenerActorId: "listener-actor",
    });
    expect(entry).toEqual({ ...recorded, disclosable: true });
    repo.close();
  });
});
