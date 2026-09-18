import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepository, recordSystemOneDecision, type RecordSystemOneDecisionInput } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

function seed(rolls: number[] = [12]) {
  const first = createRepository(); const campaign = first.createCampaign("local-owner", { name: "Lane checks" }); first.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
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
  for (const [position, id, value] of [[0, "strength", 20], [1, "dexterity", 14], [2, "constitution", 12], [3, "intelligence", 16], [4, "wisdom", 14], [5, "charisma", 8]] as const)
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?,?,?,?,?)").run(campaign.id, "sheet", position, id, value);
  db.prepare("INSERT INTO rpg_character_classes VALUES (?,'sheet',0,'pack','1','class','wizard',5)").run(campaign.id);
  db.prepare("INSERT INTO rpg_character_proficiencies VALUES (?,'sheet',0,'skill','skill.perception')").run(campaign.id);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at); db.close();
  const queue = [...rolls], repo = createRepository({ clock: { now: () => new Date(at) },
    rng: { integer: () => { const value = queue.shift(); if (value === undefined) throw new Error("unexpected reroll"); return value; } } });
  return { campaign, repo, remaining: () => queue.length };
}

function turn(f: ReturnType<typeof seed>, key: string, declaration = "I carefully look for the hidden latch.") {
  return f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: "session", actorId: "actor", declaration, expectedCampaignRevision: 0, idempotencyKey: key });
}
function selected(f: ReturnType<typeof seed>, turnId: string, label: string) {
  const candidate = f.repo.generateAdventureCheckCandidates("local-owner", turnId).find((entry) => entry.label === label);
  expect(candidate).toBeDefined(); return candidate!;
}
function selection(candidate: { candidateId: string; digest: string }) {
  return { candidateId: candidate.candidateId, digest: candidate.digest };
}
function decision(f: ReturnType<typeof seed>, turnId: string, overrides: Partial<RecordSystemOneDecisionInput> = {}) {
  const input: RecordSystemOneDecisionInput = { decisionId: "lane-decision:1", lane: "adventure-selection", campaignId: f.campaign.id,
    sessionId: "session", turnId, provider: "typesafe", model: "fake", confidencePolicyVersion: "v1", state: { declaration: "look" },
    questions: { support: 0.9 }, answers: { support: 0.9 }, selection: { method: "act", selection: null }, confidenceBand: "act",
    fallbackUsed: false, shadow: false, usage: null, latencyMs: 1, createdAt: at, ...overrides };
  recordSystemOneDecision(input);
  return input;
}

describe("lane-origin SRD adventure checks", () => {
  it("commits one lane-origin execution and replays it without rerolling", () => {
    const f = seed([12]), created = turn(f, "lane"), candidate = selected(f, created.turnId, "Strength (Strength), Easy difficulty, normal");
    decision(f, created.turnId);
    const first = f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId,
      decisionId: "lane-decision:1", selection: selection(candidate) });
    expect(first.receipt).toMatchObject({ checkKind: "ability", ability: "Strength", skill: null, mode: "normal", difficulty: "Easy",
      rolls: [{ value: 12, kept: true }], abilityModifier: 5, proficiencyBonus: 0, modifier: 5, total: 17, dc: 10, outcome: "success",
      revisionBefore: 0, revisionAfter: 1, occurredAt: at });
    const replay = f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId,
      decisionId: "lane-decision:1", selection: selection(candidate) });
    expect(replay).toEqual(first);
    expect(f.repo.getAdventureCheckPublicReceipt("local-owner", f.campaign.id, first.commandId)).toEqual(first.receipt);
    expect(f.repo.getAdventureCheckNarrationReceipt("local-owner", created.turnId, first.commandId)).toEqual(first.receipt);
    expect(f.remaining()).toBe(0);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const row = db.prepare("SELECT * FROM adventure_check_executions_v54 WHERE turn_id=?").get(created.turnId) as any;
    expect(row).toMatchObject({ origin: "lane", system_one_decision_id: "lane-decision:1", provider_call_id: null, provider_tool_call_id: null,
      round_number: null, provider_request_digest: null, provider_response_digest: null });
    db.close(); f.repo.close();
  });

  it("rejects a conflicting selection or decision replay and a provider-call lane commit", () => {
    const f = seed([12]), created = turn(f, "conflict"), candidate = selected(f, created.turnId, "Strength (Strength), Easy difficulty, normal"),
      alternate = selected(f, created.turnId, "Dexterity (Dexterity), Easy difficulty, normal");
    decision(f, created.turnId); decision(f, created.turnId, { decisionId: "lane-decision:2" });
    f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:1", selection: selection(candidate) });
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:1",
      selection: selection(alternate) })).toThrow("adventure check replay changed");
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:2",
      selection: selection(candidate) })).toThrow("adventure check replay changed");
    expect(() => f.repo.executeAdventureCheckCandidate("local-owner", { turnId: created.turnId, providerCallId: "call:late",
      providerToolCallId: "tool:late", round: 1, selection: selection(candidate) })).toThrow("adventure check replay changed");
    expect(f.remaining()).toBe(0); f.repo.close();
  });

  it("rejects unavailable decisions, unadvertised candidates, and tampered digests without rolling", () => {
    const f = seed([12]), created = turn(f, "reject"), candidate = selected(f, created.turnId, "Strength (Strength), Easy difficulty, normal");
    decision(f, created.turnId);
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "missing-decision",
      selection: selection(candidate) })).toThrow("adventure check lane decision is unavailable");
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:1",
      selection: { candidateId: `check-candidate:${"0".repeat(48)}`, digest: candidate.digest } })).toThrow("adventure check candidate is unavailable");
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:1",
      selection: { candidateId: candidate.candidateId, digest: "0".repeat(64) } })).toThrow("adventure check candidate is unavailable");
    expect(f.remaining()).toBe(1); f.repo.close();
  });

  it("rejects a decision recorded for another turn or campaign", () => {
    const f = seed([12]), created = turn(f, "scope"), other = turn(f, "other"), candidate = selected(f, created.turnId, "Strength (Strength), Easy difficulty, normal");
    decision(f, other.turnId, { decisionId: "other-turn-decision" });
    decision(f, created.turnId, { decisionId: "other-campaign-decision", campaignId: "other-campaign" });
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "other-turn-decision",
      selection: selection(candidate) })).toThrow("adventure check lane decision is unavailable");
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "other-campaign-decision",
      selection: selection(candidate) })).toThrow("adventure check lane decision is unavailable");
    expect(f.remaining()).toBe(1); f.repo.close();
  });

  it("fails a stale sheet closed before rolling through the shared candidate rules", () => {
    const f = seed([12]), created = turn(f, "stale"), candidate = selected(f, created.turnId, "Perception (Wisdom), Medium difficulty, normal");
    decision(f, created.turnId);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("UPDATE rpg_character_attributes SET value=18 WHERE sheet_id='sheet' AND attribute_id='wisdom'").run(); db.close();
    expect(() => f.repo.executeAdventureCheckCandidateFromLane("local-owner", { turnId: created.turnId, decisionId: "lane-decision:1",
      selection: selection(candidate) })).toThrow("adventure check candidate is stale");
    expect(f.remaining()).toBe(1); f.repo.close();
  });
});
