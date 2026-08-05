import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2030-01-01T00:00:00.000Z";
const databasePrepare = DatabaseDriver.prototype.prepare;
afterEach(() => vi.restoreAllMocks());

function seed(): void {
  const directory = process.env.VELVET_DATA_DIR as string;
  const repository = createRepository({ dataDir: directory });
  repository.close();
  const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare("INSERT INTO characters VALUES ('persona', ?, 30, 'private', 'private', 'private', 1, 0, ?)")
      .run(`${"A".repeat(199)}😀tail`, at);
    for (const [id, title, state, stopped] of [
      [" room/attached ", "  Attached  ", "closed", at],
      ["room/eligible", "", "active", null],
      ["room/stopped", "Stopped", "closed", at],
    ] as const) {
      db.prepare("INSERT INTO sessions VALUES (?, 'persona', ?, ?, 'private', NULL, ?, ?, ?)")
        .run(id, title, state, at, stopped, stopped ? "private" : null);
      db.prepare("INSERT INTO session_characters VALUES (?, 'persona', 0)").run(id);
    }
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign', 'Campaign', 'timeline', 'local-owner', ?, ?)`).run(at, at);
    db.prepare("INSERT INTO campaign_timelines VALUES ('timeline', 'campaign', ?, 0)").run(at);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign', 'local-owner', 'owner', ?)").run(at);
    db.prepare("INSERT INTO campaign_sessions VALUES (' room/attached ', 'campaign', ?)").run(at);
  }).immediate();
  db.close();
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

function matchingOwnerIdMutation(ownerIdExpression: string): string {
  return `INSERT INTO principals VALUES ('gm', 'GM', 0);
    INSERT INTO campaign_memberships VALUES ('campaign', 'gm', 'gm', '${at}');
    UPDATE principals SET id = ${ownerIdExpression} WHERE id = 'local-owner';
    UPDATE campaign_memberships SET principal_id = ${ownerIdExpression} WHERE principal_id = 'local-owner';
    UPDATE campaigns SET owner_principal_id = ${ownerIdExpression} WHERE id = 'campaign'`;
}

describe("campaign room linking snapshot", () => {
  it("returns one safe path-bound snapshot and retains stopped attachments", () => {
    seed();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const snapshot = repository.getCampaignRoomLinkingSnapshot("local-owner", "campaign");
    expect(snapshot).toEqual({
      campaignId: "campaign",
      attached: [{
        sessionId: " room/attached ", title: "  Attached  ", participantNames: ["A".repeat(199)],
        createdAt: at, attachedAt: at, stopped: true,
      }],
      eligible: [{ sessionId: "room/eligible", title: null, participantNames: ["A".repeat(199)], createdAt: at }],
    });
    expect(repository.getCampaignRoomLinkingSnapshot("missing", "campaign")).toBeNull();
    repository.close();
  });

  it("uses one explicit read statement without private room columns", () => {
    seed();
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    expect(repository.getCampaignRoomLinkingSnapshot("local-owner", "campaign")?.attached).toHaveLength(1);
    expect(prepare).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    for (const privateField of ["boundaries", "safe_word", "messages", "session_context", "preset_id"]) {
      expect(sql).not.toContain(privateField);
    }
    // Only a null/non-empty provenance classification is selected, never the reason value.
    expect(sql).not.toMatch(/session\.stop_reason\s+AS/i);
    expect(sql).toMatch(/authorized AS MATERIALIZED/i);
    expect(sql).toMatch(/FROM authorized\s+JOIN campaign_sessions/i);
    expect(sql).toMatch(/FROM authorized\s+JOIN sessions/i);
    expect(sql).toMatch(/FROM selected CROSS JOIN authorized AS authority/i);
    expect(sql).toMatch(/actor_parent_id = \$actorId[\s\S]*actor_role IN \('owner', 'gm', 'player', 'observer'\)/i);
    expect(sql).toMatch(/owner_count = 1[\s\S]*owner_membership_principal_id COLLATE BINARY = owner_principal_id COLLATE BINARY[\s\S]*owner_parent_id COLLATE BINARY = owner_principal_id COLLATE BINARY/i);
    for (const ownerId of ["owner_principal_id", "owner_membership_principal_id", "owner_parent_id"]) {
      expect(sql).toContain(`typeof(${ownerId}) = 'text'`);
      expect(sql).toContain(`length(CAST(${ownerId} AS BLOB)) BETWEEN 1 AND 128`);
      expect(sql).toContain(`instr(${ownerId}, char(0)) = 0`);
      expect(sql).toContain(`${ownerId} NOT GLOB '*[^A-Za-z0-9._:-]*'`);
    }
    expect(sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%fZ', actor_created_at\) = actor_created_at/i);
    expect(sql).toMatch(/strftime\('%Y-%m-%dT%H:%M:%fZ', owner_created_at\) = owner_created_at/i);
    prepare.mockRestore();
    repository.close();
  });

  it.each([
    ["outsider", "INSERT INTO principals VALUES ('outsider', 'Outsider', 0)", "outsider", "null"],
    ["unknown role", "UPDATE campaign_memberships SET role = 'future-role' WHERE campaign_id = 'campaign'", "local-owner", "null"],
    ["stale owner pointer", "UPDATE campaigns SET owner_principal_id = 'stale-owner' WHERE id = 'campaign'", "local-owner", "null"],
    ["missing canonical owner parent", "DELETE FROM principals WHERE id = 'local-owner'", "local-owner", "null"],
    ["malformed actor timestamp", "UPDATE campaign_memberships SET created_at = 'invalid'", "local-owner", "throw"],
    ["malformed canonical owner timestamp", `INSERT INTO principals VALUES ('gm', 'GM', 0);
      INSERT INTO campaign_memberships VALUES ('campaign', 'gm', 'gm', '${at}');
      UPDATE campaign_memberships SET created_at = 'invalid' WHERE principal_id = 'local-owner'`, "gm", "throw"],
    ["empty matching owner IDs", matchingOwnerIdMutation("''"), "gm", "throw"],
    ["overlong matching owner IDs", matchingOwnerIdMutation(`'${"x".repeat(129)}'`), "gm", "throw"],
    ["whitespace matching owner IDs", matchingOwnerIdMutation("'owner id'"), "gm", "throw"],
    ["invalid-character matching owner IDs", matchingOwnerIdMutation("'owner/id'"), "gm", "throw"],
    ["NUL-containing matching owner IDs", matchingOwnerIdMutation("'owner' || char(0) || 'id'"), "gm", "throw"],
    ["BLOB matching owner IDs", matchingOwnerIdMutation("CAST('owner' AS BLOB)"), "gm", "throw"],
  ])("does not evaluate poisoned title or participant presentation for %s", (_label, mutation, _actor, _outcome) => {
    seed();
    corrupt(`${mutation};
      ALTER TABLE sessions RENAME TO poisoned_sessions;
      CREATE VIEW sessions AS SELECT id, character_id, poison(title) AS title, state, preset_id, active_leaf_id,
        created_at, stopped_at, stop_reason FROM poisoned_sessions;
      ALTER TABLE characters RENAME TO poisoned_characters;
      CREATE VIEW characters AS SELECT id, poison(name) AS name, age, archetype, boundaries, safe_word,
        fictional_confirmed, is_real_person, created_at FROM poisoned_characters`);
    const poison = vi.fn(() => { throw new Error("private presentation evaluated"); });
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR as string }))
      .toThrow("schema v22 builder canonical SQL is incompatible");
    expect(poison).not.toHaveBeenCalled();
  });

  it.each([
    ["one character", "x"],
    ["128 characters", "x".repeat(128)],
  ])("accepts %s matching owner IDs for GM room reads", (_label, ownerId) => {
    seed();
    corrupt(matchingOwnerIdMutation(`'${ownerId}'`));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.getCampaignRoomLinkingSnapshot("gm", "campaign")).toMatchObject({
      campaignId: "campaign",
      attached: [{ sessionId: " room/attached " }],
      eligible: [],
    });
    repository.close();
  });

  it.each([
    ["missing actor principal", "DELETE FROM principals WHERE id = 'local-owner'"],
    ["unknown actor role", "UPDATE campaign_memberships SET role = 'future-role' WHERE campaign_id = 'campaign'"],
    ["stale owner pointer", `UPDATE campaign_memberships SET created_at = 'invalid';
      UPDATE campaigns SET owner_principal_id = 'stale-owner' WHERE id = 'campaign'`],
  ])("masks non-authorizing snapshot state before attributable parsing: %s", (_label, mutation) => {
    seed();
    corrupt(mutation);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(repository.getCampaignRoomLinkingSnapshot("local-owner", "campaign")).toBeNull();
    repository.close();
  });

  it("fails loudly after a recognized membership authorizes a malformed graph", () => {
    seed();
    corrupt(`INSERT INTO principals VALUES ('gm', 'GM', 0);
      INSERT INTO campaign_memberships VALUES ('campaign', 'gm', 'gm', '${at}');
      UPDATE campaign_memberships SET created_at = 'invalid' WHERE campaign_id = 'campaign' AND principal_id = 'gm'`);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    expect(() => repository.getCampaignRoomLinkingSnapshot("gm", "campaign"))
      .toThrow("campaign room linking authority is malformed");
    repository.close();
  });
});
