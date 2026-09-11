import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentObservationRepository,
  type AgentObservationAuthority,
} from "../src/repo/observations/agentObservationRepo.js";
import { dmNarrationMessages } from "../src/agent/dmNarration.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const BASE = Date.parse("2035-01-01T00:00:00.000Z");
let tick = 0;
let sequence = 0;
const clock = { now: () => new Date(BASE + (tick++) * 1_000) };
const ids = { nextId: () => `knowledge-id-${++sequence}` };
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

type Fixture = Awaited<ReturnType<typeof dmFixture>>;
type KnowledgeContext = {
  npcKnowledge: Array<{
    npcId: string;
    npcName: string;
    entries: Array<{ text: string; channel: string; authority: string; relayerNpcId: string | null }>;
  }>;
};

const openDb = (foreignKeys = true) => {
  const db = new DatabaseDriver(dbPath());
  if (!foreignKeys) db.pragma("foreign_keys = OFF");
  return db;
};

const currentRevision = (db: DatabaseDriver.Database, campaignId: string): number =>
  (db.prepare("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?")
    .get(campaignId) as { revision: number } | undefined)?.revision ?? 0;

const presenceRevision = (db: DatabaseDriver.Database, campaignId: string, sessionId: string): number =>
  (db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
    .get(campaignId, sessionId) as { revision: number } | undefined)?.revision ?? 0;

function createNpc(f: Fixture, db: DatabaseDriver.Database, index: number, present: boolean): string {
  const persona = f.repo.createCharacter({
    name: `Knowledge ${index}`, age: 30, archetype: "Guide", boundaries: "", fictionalConfirmed: true,
  });
  const created = f.repo.createCampaignNpc("local-owner", f.campaign.id, {
    personaId: persona.id, publicState: { name: `NPC ${index}` },
    privateState: { goals: "Goals", gmNotes: "Notes", merchantState: null },
    expectedRevision: currentRevision(db, f.campaign.id), idempotencyKey: `knowledge-npc-${index}`,
  });
  if (present) {
    const root = presenceRevision(db, f.campaign.id, f.session.id);
    f.repo.mutateNpcPresence("local-owner", {
      campaignId: f.campaign.id, sessionId: f.session.id, npcId: created.npc.npcId,
      expectedRevision: root, idempotencyKey: `knowledge-place-${index}-${root}`,
      mutation: { kind: "place", locationId: null },
    });
  }
  return created.npc.npcId;
}

function observe(
  ledger: ReturnType<typeof createAgentObservationRepository>,
  f: Fixture, agentId: string, text: string, authority: AgentObservationAuthority,
): void {
  ledger.record({
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, agentKind: "npc", agentId,
    sourceCommandId: `knowledge-command-${++sequence}`, observedRevision: 1,
    channel: "witnessed", hopCount: 0, text, authority,
  });
}

function runBeat(f: Fixture): string {
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "knowledge-auto" });
  const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, {
    intent: "open", expectedModeRevision: 1, idempotencyKey: "knowledge-open",
  });
  const work = f.repo.claimDmPlanning("local-owner", run.runId, "fake", "fake")!;
  const candidate = work.candidates[0]!;
  f.repo.settleDmPlanning("local-owner", run.runId, work.claimId,
    { candidateId: candidate.candidateId, digest: candidate.digest }, { promptTokens: 10, completionTokens: 10 });
  f.repo.executeDmBeat("local-owner", run.runId);
  return run.runId;
}

function knowledgeContext(runId: string): KnowledgeContext {
  const db = openDb();
  const job = db.prepare("SELECT public_context_json FROM dm_narration_jobs WHERE run_id=?")
    .get(runId) as { public_context_json: string } | undefined;
  db.close();
  if (!job) throw new Error("narration job was not queued");
  return JSON.parse(job.public_context_json) as KnowledgeContext;
}

describe("director narration knowledge channel", () => {
  it("labels present public NPCs, excludes absent NPCs, and gates hearsay on an explicit trust relationship", async () => {
    const f = await dmFixture();
    f.graph();
    f.advance();
    const db = openDb();
    const verified = createNpc(f, db, 0, true);
    const rumor = createNpc(f, db, 1, true);
    const trusted = createNpc(f, db, 2, true);
    const absent = createNpc(f, db, 3, false);
    const relation = openDb(false);
    relation.prepare(`INSERT INTO campaign_npc_relationships_v32
      (campaign_id,npc_id,actor_id,affinity,trust,fear,last_command_id,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(f.campaign.id, trusted, f.actorId, 0, 0, 0, "knowledge-relationship", new Date(BASE).toISOString());
    relation.close();
    const ledgerDb = openDb();
    const ledger = createAgentObservationRepository(ledgerDb, { clock, ids });
    observe(ledger, f, verified, "The hero won the bet.", "verified");
    observe(ledger, f, rumor, "The hero cheated at cards.", "rumor");
    observe(ledger, f, trusted, "The hero cheated at cards.", "rumor");
    observe(ledger, f, absent, "Absent witnesses saw the wrong thing.", "verified");
    const runId = runBeat(f);
    const { npcKnowledge } = knowledgeContext(runId);
    const byId = new Map(npcKnowledge.map((value) => [value.npcId, value]));
    expect(byId.get(verified)!.entries).toEqual([
      { text: "The hero won the bet.", channel: "witnessed", authority: "verified", relayerNpcId: null },
    ]);
    expect(byId.has(absent)).toBe(false);
    expect(byId.has(rumor)).toBe(false);
    expect(byId.get(trusted)!.entries).toEqual([
      { text: "The hero cheated at cards.", channel: "witnessed", authority: "rumor", relayerNpcId: null },
    ]);
    ledgerDb.close();
    db.close();
    f.repo.close();
  });

  it("bounds the channel to four NPCs, four entries each, and 300-character text", async () => {
    const f = await dmFixture();
    f.graph();
    f.advance();
    const db = openDb();
    const npcs = Array.from({ length: 5 }, (_, index) => createNpc(f, db, index, true));
    const ledgerDb = openDb();
    const ledger = createAgentObservationRepository(ledgerDb, { clock, ids });
    const long = "w".repeat(400);
    for (const npcId of npcs) {
      for (let index = 0; index < 6; index += 1) observe(ledger, f, npcId, `${long} ${index}`, "verified");
    }
    const runId = runBeat(f);
    const { npcKnowledge } = knowledgeContext(runId);
    expect(npcKnowledge.length).toBeLessThanOrEqual(4);
    expect(npcKnowledge.length).toBeGreaterThan(0);
    for (const npc of npcKnowledge) {
      expect(npc.entries.length).toBeLessThanOrEqual(4);
      for (const entry of npc.entries) expect(entry.text.length).toBeLessThanOrEqual(300);
    }
    ledgerDb.close();
    db.close();
    f.repo.close();
  });

  it("teaches the attribution rule and carries the labeled knowledge into the user message", () => {
    const context = {
      cast: [{ name: "Mara", description: "A cautious guide." }],
      players: [{ name: "Hero" }],
      npcKnowledge: [{
        npcId: "npc-mara", npcName: "Mara",
        entries: [{ text: "The hero won the bet.", channel: "witnessed", authority: "verified", relayerNpcId: null }],
      }],
    };
    const messages = dmNarrationMessages(context, "Committed result.");
    expect(messages[0]!.content).toContain("npcKnowledge lists what present public NPCs witnessed or were told");
    expect(messages[0]!.content).toContain("Never assert a rumor as fact");
    expect(messages[0]!.content).toContain("prefer verified outcomes over hearsay");
    const user = JSON.parse(messages[1]!.content as string) as { publicScene: typeof context };
    expect(user.publicScene.npcKnowledge[0]!.entries[0]!.text).toBe("The hero won the bet.");
  });
});
