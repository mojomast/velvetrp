import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository } from "../src/repo/index.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { ADVENTURE_CHECK_EXECUTION_PREDECESSOR_SQL, ensureCurrentSchema } from "../src/repo/db/schema.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

function seed() {
  const first = createRepository(); const campaign = first.createCampaign("local-owner", { name: "Check origin migration" }); first.close();
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
  const repo = createRepository({ clock: { now: () => new Date(at) }, rng: { integer: () => 12 } });
  return { campaign, repo };
}

const completion = (call: { id: string; name: string; arguments: string }): ProviderCompletionResult =>
  ({ message: { role: "assistant", content: null, toolCalls: [call] }, usage: null, model: { requestedModel: "fake", responseModel: "fake" } });
const deps = (complete: (input: ProviderCompletionInput) => Promise<ProviderCompletionResult>): AdventureAgentDependencies => ({ complete,
  getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }), getHarness: async () => defaultHarnessSettings(), now: () => new Date(at) });

const TABLE = "adventure_check_executions_v54";
const tableSql = (db: DatabaseDriver.Database) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE) as { sql: string }).sql;
const triggerNames = (db: DatabaseDriver.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(TABLE) as Array<{ name: string }>)
    .map((row) => row.name);

/** Rebuilds the execution table at its exact pre-origin shape, preserving rows and immutability triggers. */
function toPredecessor(db: DatabaseDriver.Database): void {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(TABLE) as Array<{ name: string; sql: string }>;
  db.exec(`CREATE TEMP TABLE ${TABLE}_upgrade AS SELECT command_id,candidate_id,campaign_id,turn_id,provider_call_id,provider_tool_call_id,
    round_number,selection_json,selection_digest,provider_request_digest,provider_response_digest,revision_before,revision_after,rolls_json,
    public_result_json,result_digest,occurred_at FROM ${TABLE}`);
  db.exec(`DROP TABLE ${TABLE}`);
  db.exec(ADVENTURE_CHECK_EXECUTION_PREDECESSOR_SQL);
  db.exec(`INSERT INTO ${TABLE} SELECT * FROM ${TABLE}_upgrade`);
  db.exec(`DROP TABLE ${TABLE}_upgrade`);
  for (const trigger of triggers) db.exec(trigger.sql);
}

describe("adventure check execution origin schema migration", () => {
  it("migrates provider executions to origin='provider' with their provenance preserved", async () => {
    const f = seed();
    const created = f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I carefully look for the hidden latch.", expectedCampaignRevision: 0, idempotencyKey: "origin" });
    const candidate = f.repo.generateAdventureCheckCandidates("local-owner", created.turnId)
      .find((entry) => entry.label === "Strength (Strength), Easy difficulty, normal")!;
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps(async (input) => {
      expect(input.tools?.some((tool) => tool.name === "exact_srd_check.select")).toBe(true);
      return completion({ id: "origin-call", name: "exact_srd_check.select", arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) });
    }));
    expect(result.outcome).toBe("mechanics-committed");
    const commandId = result.turn.receiptLinks[0]!.commandId;
    const receipt = f.repo.getAdventureCheckPublicReceipt("local-owner", f.campaign.id, commandId)!;
    f.repo.close();

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    const before = db.prepare(`SELECT * FROM ${TABLE}`).get() as any;
    expect(before.origin).toBe("provider");
    expect(before.system_one_decision_id).toBeNull();
    toPredecessor(db);
    expect(tableSql(db)).toBe(ADVENTURE_CHECK_EXECUTION_PREDECESSOR_SQL);
    expect((db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("origin");

    ensureCurrentSchema(db, ":memory:");
    const after = db.prepare(`SELECT * FROM ${TABLE}`).get() as any;
    expect(after).toMatchObject({ command_id: before.command_id, candidate_id: before.candidate_id, campaign_id: before.campaign_id,
      turn_id: before.turn_id, origin: "provider", provider_call_id: before.provider_call_id, provider_tool_call_id: before.provider_tool_call_id,
      round_number: before.round_number, provider_request_digest: before.provider_request_digest, provider_response_digest: before.provider_response_digest,
      system_one_decision_id: null, selection_json: before.selection_json, selection_digest: before.selection_digest,
      revision_before: before.revision_before, revision_after: before.revision_after, rolls_json: before.rolls_json,
      public_result_json: before.public_result_json, result_digest: before.result_digest, occurred_at: before.occurred_at });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(triggerNames(db)).toEqual([`${TABLE}_delete`, `${TABLE}_update`]);

    // The migrated row keeps rejecting a lane origin without a decision id, and a provider origin without provider call ids.
    db.pragma("foreign_keys=OFF");
    const laneInsert = db.prepare(`INSERT INTO ${TABLE} (command_id,candidate_id,campaign_id,turn_id,origin,selection_json,selection_digest,
      revision_before,revision_after,rolls_json,public_result_json,result_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => laneInsert.run("synthetic-lane", "synthetic-candidate", "synthetic-campaign", "synthetic-turn", "lane", before.selection_json,
      before.selection_digest, 0, 1, before.rolls_json, before.public_result_json, before.result_digest, before.occurred_at)).toThrow(/CHECK/i);
    const providerInsert = db.prepare(`INSERT INTO ${TABLE} (command_id,candidate_id,campaign_id,turn_id,origin,selection_json,selection_digest,
      revision_before,revision_after,rolls_json,public_result_json,result_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => providerInsert.run("synthetic-provider", "synthetic-candidate", "synthetic-campaign", "synthetic-turn", "provider", before.selection_json,
      before.selection_digest, 0, 1, before.rolls_json, before.public_result_json, before.result_digest, before.occurred_at)).toThrow(/CHECK/i);
    db.pragma("foreign_keys=ON");

    const migrated = tableSql(db);
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db)).toBe(migrated);
    db.close();

    const reopened = createRepository();
    expect(reopened.getAdventureCheckPublicReceipt("local-owner", f.campaign.id, commandId)).toEqual(receipt);
    reopened.close();
  });

  it("creates the origin-aware table in a fresh database and accepts an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    ensureCurrentSchema(db, ":memory:");
    const current = tableSql(db);
    expect(current).toContain("origin IN('provider','lane')");
    expect(current).toContain("system_one_decision_id");
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db)).toBe(current);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
