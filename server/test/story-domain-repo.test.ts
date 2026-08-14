import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StoryAuthorizationError, StoryConflictError, StoryStaleError, StoryUnavailableError, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const graph = { storylineId: "story", title: "Gate", summary: "Public", nodes: [
  { nodeId: "entry", title: "Entry", description: "Visible", gmNotes: "GM entry", revealThreshold: 0 },
  { nodeId: "vault", title: "Vault", description: null, gmNotes: "GM vault", revealThreshold: 0 },
], edges: [{ edgeId: "dependency", kind: "requires" as const, fromNodeId: "entry", toNodeId: "vault" }],
plotPoints: [{ plotPointId: "riddle", nodeId: "entry", question: "Speak", answer: "Friend", gmNotes: "Answer note" }],
clues: [{ clueId: "mark", title: "Mark", content: "A mark", truth: "Secret truth", gmNotes: "Secret note", revealThreshold: 2,
  sources: [{ sourceId: "entry-source", kind: "node" as const, targetId: "entry" }, { sourceId: "riddle-source", kind: "plot-point" as const, targetId: "riddle" }] }] };

describe("M2.10 story repository", () => {
  it("enforces graph gates, exact replay, ancestry, and player-safe reads", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) } });
    const campaign = repo.createCampaign("local-owner", { name: "Story" });
    const other = repo.createCampaign("local-owner", { name: "Other" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('player','Player',0)").run();
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('story-gm','Story GM',0),('other-gm','Other GM',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "player", role: "player" });
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "story-gm", role: "gm" });
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "other-gm", role: "gm" });
    const request = { storyline: graph, expectedRevision: 0, idempotencyKey: "create-story" };
    const created = repo.createCampaignStorylineGraph("local-owner", campaign.id, request);
    expect(repo.createCampaignStorylineGraph("local-owner", campaign.id, request)).toEqual(created);
    expect(() => repo.createCampaignStorylineGraph("local-owner", campaign.id, { ...request, expectedRevision: 1 })).toThrow(StoryConflictError);
    const gm = repo.getCampaignStory("local-owner", campaign.id)?.story as any;
    expect(gm.storylines[0]).toMatchObject({ storylineId: "story" }); expect(gm.nodes[0]).toMatchObject({ gmNotes: "GM entry" });
    expect(repo.getCampaignStory("player", campaign.id)?.story).toEqual({ visibleNodes: [], discoveredClues: [] });
    const reveal = { kind: "reveal-node" as const, targetId: "entry", data: {}, expectedRevision: 1, idempotencyKey: "reveal-entry" };
    const revealed = repo.executeStorylineCommand("story-gm", "story", reveal);
    expect(repo.executeStorylineCommand("story-gm", "story", reveal)).toEqual(revealed);
    expect(() => repo.executeStorylineCommand("other-gm", "story", reveal)).toThrow(StoryConflictError);
    db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id='story-gm'").run(campaign.id);
    expect(() => repo.executeStorylineCommand("story-gm", "story", reveal)).toThrow(StoryAuthorizationError);
    expect(() => repo.executeStorylineCommand("local-owner", "story", { kind: "reveal-node", targetId: "vault", data: {}, expectedRevision: 2, idempotencyKey: "early" })).toThrow(StoryConflictError);
    expect(() => repo.executeStorylineCommand("local-owner", "story", { kind: "reveal-clue", targetId: "mark", data: {}, expectedRevision: 1, idempotencyKey: "stale" })).toThrow(StoryStaleError);
    repo.executeStorylineCommand("local-owner", "story", { kind: "resolve-node", targetId: "entry", data: {}, expectedRevision: 2, idempotencyKey: "resolve-entry" });
    repo.executeStorylineCommand("local-owner", "story", { kind: "answer-plot-point", targetId: "riddle", data: { answer: "Friend" }, expectedRevision: 3, idempotencyKey: "answer" });
    repo.executeStorylineCommand("local-owner", "story", { kind: "reveal-clue", targetId: "mark", data: {}, expectedRevision: 4, idempotencyKey: "reveal-clue" });
    const player = repo.getCampaignStory("player", campaign.id)?.story; expect(player).toEqual({ visibleNodes: [{ nodeId: "entry", title: "Entry", description: "Visible", status: "resolved", updatedAt: at }],
      discoveredClues: [{ clueId: "mark", title: "Mark", content: "A mark", discoveredAt: at }] });
    expect(JSON.stringify(player)).not.toMatch(/GM|truth|riddle|source|storyline/);
    expect(() => repo.executeStorylineCommand("local-owner", "story", { kind: "reveal-node", targetId: "missing", data: {}, expectedRevision: 5, idempotencyKey: "cross" })).toThrow(StoryUnavailableError);
    expect(repo.getCampaignStory("local-owner", other.id)?.story).toEqual({ storylines: [], nodes: [], edges: [], plotPoints: [], clues: [] });
    expect(db.prepare("SELECT count(*) count FROM story_events_v34").get()).toEqual({ count: 5 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("UPDATE quest_storylines SET title='tampered' WHERE id='story'").run()).toThrow("v34 storyline roots are immutable");
    expect(() => db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,status,created_at) VALUES('bypass',?,'Bypass','active',?)").run(campaign.id, at))
      .toThrow("v34 storyline roots require a create command");
    expect(() => db.prepare("UPDATE story_nodes_v34 SET gm_notes='tampered' WHERE node_id='entry'").run()).toThrow("story nodes are immutable");
    const createCommand = (db.prepare("SELECT command_id FROM story_commands_v34 WHERE command_type='create-storyline' AND storyline_id='story'").get() as any).command_id;
    expect(() => db.prepare("INSERT INTO story_nodes_v34 VALUES(?,?,?,?,?,?,?,?,?)").run(campaign.id, "story", "late-node", "Late", null, null, 0, 99, createCommand))
      .toThrow("story node provenance is invalid");
    expect(() => db.prepare("INSERT INTO story_clue_sources_v34 VALUES(?,?,?,?,?,?)").run(campaign.id, "story", "mark", "bad-source", "node", "missing-node"))
      .toThrow(/story clue source/);
    const badDigestRequest = JSON.stringify({ data: {}, expectedRevision: 5, idempotencyKey: "bad-digest", kind: "reveal-node", storylineId: "story", targetId: "entry" });
    expect(() => db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaign.id, "bad-digest", "story", "local-owner",
      "reveal-node", "bad-digest", badDigestRequest, "A".repeat(64), 5, 6, at)).toThrow(/CHECK constraint/);
    const badRevisionRequest = JSON.stringify({ data: {}, expectedRevision: -1, idempotencyKey: "bad-revision", kind: "reveal-node", storylineId: "story", targetId: "entry" });
    expect(() => db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaign.id, "bad-revision", "story", "local-owner",
      "reveal-node", "bad-revision", badRevisionRequest, "a".repeat(64), -1, 0, at)).toThrow(/CHECK constraint/);
    db.pragma("recursive_triggers=OFF");
    const replaceAttempts = [
      "INSERT OR REPLACE INTO story_campaign_revisions_v34 SELECT * FROM story_campaign_revisions_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_commands_v34 SELECT * FROM story_commands_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_receipts_v34 SELECT * FROM story_receipts_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_events_v34 SELECT * FROM story_events_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_metadata_v34 SELECT * FROM story_metadata_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_nodes_v34 SELECT * FROM story_nodes_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_node_state_v34 SELECT * FROM story_node_state_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_edges_v34 SELECT * FROM story_edges_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_plot_points_v34 SELECT * FROM story_plot_points_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_plot_point_answers_v34 SELECT * FROM story_plot_point_answers_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_clues_v34 SELECT * FROM story_clues_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_clue_sources_v34 SELECT * FROM story_clue_sources_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_discoveries_v34 SELECT * FROM story_discoveries_v34 LIMIT 1",
      "INSERT OR REPLACE INTO story_layout_attestation_v34 SELECT * FROM story_layout_attestation_v34 LIMIT 1",
      "INSERT OR REPLACE INTO quest_storylines SELECT * FROM quest_storylines WHERE id='story'",
    ];
    for (const sql of replaceAttempts) expect(() => db.exec(sql)).toThrow();
    expect(db.prepare("SELECT count(*) count FROM story_commands_v34").get()).toEqual({ count: 5 });
    expect(() => db.prepare("DELETE FROM story_events_v34").run()).toThrow("story events are immutable"); db.close(); repo.close();
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
  });
  it("enforces SQL authorization and dependency gates", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) } });
    const campaign = repo.createCampaign("local-owner", { name: "SQL guards" });
    const otherCampaign = repo.createCampaign("local-owner", { name: "Scalar guards" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('sql-player','SQL Player',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "sql-player", role: "player" });
    repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { ...graph,
      nodes: [...graph.nodes, { nodeId: "threshold", title: "Threshold", description: null, gmNotes: null, revealThreshold: 1 }],
      edges: [...graph.edges, { edgeId: "sequence", kind: "sequence", fromNodeId: "entry", toNodeId: "threshold" }] },
      expectedRevision: 0, idempotencyKey: "sql-story" });
    const request = JSON.stringify({ data: {}, expectedRevision: 1, idempotencyKey: "sql-reveal", kind: "reveal-node", storylineId: "story", targetId: "vault" });
    expect(() => db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaign.id, "player-command", "story", "sql-player",
      "reveal-node", "sql-reveal", request, "a".repeat(64), 1, 2, at)).toThrow("story command authorization or payload is invalid");
    const malformedCreate = JSON.stringify({ campaignId: campaign.id, expectedRevision: 1, idempotencyKey: "malformed-create",
      storyline: { storylineId: "bad-story", title: "", summary: null, nodes: [], edges: [], plotPoints: [], clues: [] } });
    expect(() => db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaign.id, "malformed-create", "bad-story", "local-owner",
      "create-storyline", "malformed-create", malformedCreate, "a".repeat(64), 1, 2, at)).toThrow("story command authorization or payload is invalid");
    expect(() => db.prepare("INSERT INTO story_campaign_revisions_v34 VALUES(?,0,?)").run(otherCampaign.id, "2035-99-99T99:99:99.999Z"))
      .toThrow(/CHECK constraint/);
    const insertAndReveal = db.transaction((targetId: string, commandId: string, key: string) => {
      const payload = JSON.stringify({ data: {}, expectedRevision: 1, idempotencyKey: key, kind: "reveal-node", storylineId: "story", targetId });
      db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaign.id, commandId, "story", "local-owner",
        "reveal-node", key, payload, "a".repeat(64), 1, 2, at);
      db.prepare("UPDATE story_node_state_v34 SET status='revealed',last_command_id=?,updated_at=? WHERE campaign_id=? AND storyline_id='story' AND node_id=?")
        .run(commandId, at, campaign.id, targetId);
    });
    expect(() => insertAndReveal("vault", "hard-command", "hard-reveal")).toThrow("story node state transition provenance is invalid");
    expect(() => insertAndReveal("threshold", "threshold-command", "threshold-reveal")).toThrow("story node state transition provenance is invalid");
    db.close(); repo.close();
  });
});
