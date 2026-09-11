import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository, type Repository } from "../src/repo/index.js";
import {
  AgentObservationConflictError,
  AgentObservationUnavailableError,
  createAgentObservationRepository,
  type AgentObservationInput,
  type AgentObservationRepository,
} from "../src/repo/observations/agentObservationRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

type Campaign = ReturnType<Repository["createCampaign"]>;
type LedgerRepository = Repository & AgentObservationRepository;

const dataDir = () => process.env.VELVET_DATA_DIR as string;
const secondConnection = () => new DatabaseDriver(path.join(dataDir(), "velvet.sqlite"));

let sequence = 0;
function observation(campaign: Campaign, overrides: Partial<AgentObservationInput> = {}): AgentObservationInput {
  sequence += 1;
  return {
    campaignId: campaign.id,
    timelineId: campaign.activeTimelineId,
    agentKind: "npc",
    agentId: "npc-maren",
    sourceCommandId: `command-${sequence}`,
    observedRevision: 1,
    channel: "witnessed",
    hopCount: 0,
    text: "The hero won the bet.",
    authority: "verified",
    ...overrides,
  };
}

function setup() {
  const repo = createRepository({ dataDir: dataDir() });
  const campaign = repo.createCampaign("local-owner", { name: "Knowledge campaign" });
  const ledger = repo as unknown as LedgerRepository;
  const observe = (overrides: Partial<AgentObservationInput> = {}) => observation(campaign, overrides);
  return { repo, campaign, ledger, observe };
}

function addMember(db: DatabaseDriver.Database, campaignId: string, principalId: string, role: string): void {
  db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(principalId, principalId);
  db.prepare(`INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at)
    SELECT id,?,?,updated_at FROM campaigns WHERE id=?`).run(principalId, role, campaignId);
}

describe("agent observation repository", () => {
  it("records every agent kind through the authorized entry", () => {
    const { ledger, observe } = setup();
    for (const agentKind of ["npc", "faction", "companion", "town"] as const) {
      const row = ledger.recordAgentObservation("local-owner", observe({ agentKind, agentId: `agent-${agentKind}` }));
      expect(row).toMatchObject({ agentKind, channel: "witnessed", hopCount: 0, relayerAgentId: null, authority: "verified" });
    }
  });

  it("returns the recorded row for an identical replay and rejects conflicts", () => {
    const { campaign, ledger, observe } = setup();
    const first = ledger.recordAgentObservation("local-owner", observe({ text: "Original", authority: "verified", observedRevision: 4 }));
    expect(ledger.recordAgentObservation("local-owner", {
      campaignId: first.campaignId, timelineId: first.timelineId, agentKind: first.agentKind, agentId: first.agentId,
      sourceCommandId: first.sourceCommandId, observedRevision: first.observedRevision, channel: first.channel,
      hopCount: first.hopCount, text: first.text, authority: first.authority,
    })).toEqual(first);
    expect(ledger.getBySource(campaign.id, first.sourceCommandId)).toHaveLength(1);
    const conflicting = (overrides: Partial<AgentObservationInput>) => () => ledger.recordAgentObservation("local-owner", {
      campaignId: first.campaignId, timelineId: first.timelineId, agentKind: first.agentKind, agentId: first.agentId,
      sourceCommandId: first.sourceCommandId, observedRevision: first.observedRevision, channel: first.channel,
      hopCount: first.hopCount, text: first.text, authority: first.authority, ...overrides,
    });
    expect(conflicting({ text: "Changed" })).toThrow(AgentObservationConflictError);
    expect(conflicting({ authority: "rumor" })).toThrow(AgentObservationConflictError);
    expect(conflicting({ observedRevision: 5 })).toThrow(AgentObservationConflictError);
  });

  it("records many observations in one call", () => {
    const { campaign, ledger, observe } = setup();
    const inputs = [observe({ agentKind: "npc" }), observe({ agentKind: "town", channel: "told", hopCount: 1, relayerAgentId: "npc-maren" })];
    const rows = ledger.recordMany(inputs);
    expect(rows).toHaveLength(2);
    expect(ledger.getBySource(campaign.id, inputs[0]!.sourceCommandId)).toHaveLength(1);
  });

  it("rejects update, delete, and replacement writes at the storage layer", () => {
    const { ledger, observe } = setup();
    const row = ledger.recordAgentObservation("local-owner", observe({ agentKind: "npc" }));
    const db = secondConnection();
    expect(() => db.prepare("UPDATE agent_observations SET text='changed' WHERE observation_id=?").run(row.observationId)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM agent_observations WHERE observation_id=?").run(row.observationId)).toThrow(/immutable/);
    expect(() => db.prepare(`INSERT INTO agent_observations
      (observation_id,campaign_id,timeline_id,agent_kind,agent_id,source_command_id,observed_revision,channel,relayer_agent_id,hop_count,text,authority,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "replacement", row.campaignId, row.timelineId, row.agentKind, row.agentId, row.sourceCommandId,
      row.observedRevision, row.channel, row.relayerAgentId, row.hopCount, "other", row.authority, row.createdAt,
    )).toThrow(/replaced/);
    db.close();
  });

  it("authorizes owners and GMs but rejects non-members, players, and observers", () => {
    const { campaign, repo, ledger, observe } = setup();
    const db = secondConnection();
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('outsider','Outsider',0)").run();
    addMember(db, campaign.id, "gm-1", "gm");
    addMember(db, campaign.id, "player-1", "player");
    addMember(db, campaign.id, "observer-1", "observer");
    expect(ledger.recordAgentObservation("local-owner", observe({ agentKind: "npc" }))).toMatchObject({ agentKind: "npc" });
    expect(ledger.recordAgentObservation("gm-1", observe({ agentKind: "faction" }))).toMatchObject({ agentKind: "faction" });
    for (const principalId of ["outsider", "player-1", "observer-1"]) {
      expect(() => ledger.recordAgentObservation(principalId, observe({ agentKind: "npc" }))).toThrow(AgentObservationUnavailableError);
    }
    db.close();
    repo.close();
  });

  it("enforces the witnessed and relayed channel invariants", () => {
    const { ledger, observe } = setup();
    expect(() => ledger.recordAgentObservation("local-owner", observe({ channel: "witnessed", hopCount: 1 }))).toThrow(/witnessed/);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ channel: "witnessed", relayerAgentId: "npc-other" }))).toThrow(/witnessed/);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ channel: "told", hopCount: 0, relayerAgentId: "npc-maren" }))).toThrow(/relayed/);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ channel: "refuted", hopCount: 1 }))).toThrow(/relayed/);
    expect(ledger.recordAgentObservation("local-owner", observe({ channel: "told", hopCount: 1, relayerAgentId: "npc-maren" })))
      .toMatchObject({ channel: "told", hopCount: 1, relayerAgentId: "npc-maren" });
    expect(ledger.recordAgentObservation("local-owner", observe({ channel: "refuted", hopCount: 2, relayerAgentId: "npc-maren", authority: "rumor" })))
      .toMatchObject({ channel: "refuted", hopCount: 2, authority: "rumor" });
  });

  it("caps text at 2048 UTF-8 bytes and rejects empty text", () => {
    const { ledger, observe } = setup();
    const boundary = "a".repeat(2048);
    expect(ledger.recordAgentObservation("local-owner", observe({ text: boundary })).text).toBe(boundary);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ text: "a".repeat(2049) }))).toThrow(/budget/);
    const multibyte = "é".repeat(1025);
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(2050);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ text: multibyte }))).toThrow(/budget/);
    expect(() => ledger.recordAgentObservation("local-owner", observe({ text: "   " }))).toThrow(/required/);
  });

  it("rolls back observation writes when the surrounding transaction fails", () => {
    const { campaign, repo, ledger, observe } = setup();
    const first = observe({ agentKind: "companion" });
    const second = observe({ agentKind: "npc" });
    expect(() => repo.transaction(() => {
      ledger.recordAgentObservation("local-owner", first);
      ledger.recordAgentObservation("local-owner", second);
      throw new Error("forced rollback");
    })).toThrow("forced rollback");
    expect(ledger.getBySource(campaign.id, first.sourceCommandId)).toEqual([]);
    expect(ledger.getBySource(campaign.id, second.sourceCommandId)).toEqual([]);
  });

  it("leaves data_version unchanged after rejected mutations but advances on a write", () => {
    const { ledger, observe } = setup();
    const observer = secondConnection();
    const before = observer.pragma("data_version", { simple: true });
    expect(() => ledger.recordAgentObservation("outsider", observe({ agentKind: "npc" }))).toThrow(AgentObservationUnavailableError);
    expect(observer.pragma("data_version", { simple: true })).toBe(before);
    const raw = createAgentObservationRepository(observer, { ids: { nextId: () => "unused" }, clock: { now: () => new Date() } });
    const valid = ledger.recordAgentObservation("local-owner", observe({ agentKind: "town" }));
    const afterWrite = observer.pragma("data_version", { simple: true });
    expect(afterWrite).not.toBe(before);
    expect(() => raw.record({ ...observe({ agentKind: "npc" }), channel: "witnessed", hopCount: 3 })).toThrow();
    expect(() => observer.prepare("UPDATE agent_observations SET text='changed' WHERE observation_id=?").run(valid.observationId)).toThrow(/immutable/);
    expect(observer.pragma("data_version", { simple: true })).toBe(afterWrite);
    observer.close();
  });

  it("keeps rows and digests stable across close and reopen", () => {
    const { repo, campaign, ledger, observe } = setup();
    const sourceCommandId = "durable-command";
    const recorded = ledger.recordAgentObservation("local-owner", observe({
      sourceCommandId, text: "Durable observation", agentKind: "faction", authority: "belief",
    }));
    const digest = createHash("sha256").update(JSON.stringify(recorded)).digest("hex");
    repo.close();
    const reopened = createRepository({ dataDir: dataDir() });
    const rows = (reopened as unknown as AgentObservationRepository).getBySource(campaign.id, sourceCommandId);
    expect(rows).toEqual([recorded]);
    expect(createHash("sha256").update(JSON.stringify(rows[0])).digest("hex")).toBe(digest);
    reopened.close();
  });
});
