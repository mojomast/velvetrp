import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS } from "../src/repo/db/migrations/v35_adventure_generation.js";
import { restoreAdventureGenerationV35Guards } from "../src/repo/db/migrations/v36_adventure_hardening.js";
import { TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS } from "../src/repo/db/migrations/v37_tool_execution_bindings.js";
import { DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS } from "../src/repo/db/migrations/v38_durable_agent_execution.js";
import { removeFutureAgentSchema, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const AT = "2035-01-01T00:00:00.000Z";

function removeV36(db: DatabaseDriver.Database): void {
  removeFutureAgentSchema(db);
  const v38Names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
  const v38 = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${v38Names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...v38Names) as Array<{ type: string; name: string }>;
  for (const object of v38) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const object of v38) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  for (const table of ["durable_agent_execution_layout_attestation_v38", "agent_read_outcomes_v38",
    "agent_decision_batch_seals_v38", "agent_tool_calls_v38", "agent_decision_rounds_v38", "agent_provider_starts_v38",
    "agent_execution_operations_v38", "adventure_agent_executions_v38"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  const v37Names = TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([, name]) => name);
  const v37 = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${v37Names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...v37Names) as Array<{ type: string; name: string }>;
  for (const object of v37) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const object of v37) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  db.exec("DROP TABLE IF EXISTS tool_execution_binding_layout_attestation_v37; DROP TABLE IF EXISTS tool_proposal_execution_bindings_v37");
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v36*'").all() as Array<{ type: string; name: string }>;
  for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const table of ["adventure_hardening_layout_attestation_v36", "generation_draft_apply_receipts_v36", "turn_mechanics_links_v36",
    "adventure_coordination_receipts_v36", "adventure_coordination_events_v36", "adventure_coordination_commands_v36"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
  restoreAdventureGenerationV35Guards(db);
}

function createDraft() {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  const campaign = repo.createCampaign("local-owner", { name: "V36 hardening" });
  const draft = repo.createGenerationDraft("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    kind: "encounter", stagedContent: { title: "Ambush" }, validation: { valid: true, issues: [], validatedAt: AT },
    expectedCampaignRevision: 0, idempotencyKey: "draft" });
  repo.close(); return { campaign, draft };
}

function createTurnReceipt(): { turnId: string } {
  let repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  const campaign = repo.createCampaign("local-owner", { name: "Legacy receipt" }); repo.close();
  const db = new DatabaseDriver(file()); db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO principals VALUES ('player','Player',0)").run();
  db.prepare("INSERT INTO campaign_memberships VALUES (?,'player','player',?)").run(campaign.id, AT);
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','profile','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','hero',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'player','')").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(AT);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, AT); db.close();
  let sequence = 0; repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) },
    ids: { nextId: () => `legacy-${++sequence}` }, rng: { integer: (minimum) => minimum } });
  const turn = repo.createAdventureTurn("player", { campaignId: campaign.id, timelineId: campaign.activeTimelineId, sessionId: "session",
    actorId: "actor", declaration: "Roll", expectedCampaignRevision: 0, idempotencyKey: "turn" });
  const proposed = repo.appendToolProposal("player", { turnId: turn.turnId, expectedTurnRevision: 0, expectedCampaignRevision: 0,
    idempotencyKey: "proposal", toolName: "roll", arguments: {}, requiresConfirmation: false });
  repo.executeRollActorDice("local-owner", { commandId: "legacy-command", idempotencyKey: proposed.toolCalls[0]!.proposal.executionBinding.idempotencyKey, campaignId: campaign.id,
    timelineId: campaign.activeTimelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: turn.turnId,
    command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
  repo.linkFinalMechanicsReceipt("player", { turnId: turn.turnId, proposalId: proposed.toolCalls[0]!.proposal.proposalId,
    commandId: "legacy-command", expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "link" });
  repo.close(); return { turnId: turn.turnId };
}

describe("schema v36 adventure hardening", () => {
  it("migrates populated v35 additively and roots immutable coordination ledgers", () => {
    const { draft } = createDraft();
    const db = new DatabaseDriver(file()); removeV36(db); db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run(); db.close();
    const reopened = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    expect(reopened.getGenerationDraft("local-owner", draft.draftId)).toMatchObject({ draftId: draft.draftId, state: "staged" });
    reopened.close();
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT mutation_type,expected_revision,resulting_revision FROM adventure_coordination_commands_v36").get())
      .toMatchObject({ mutation_type: "migration-snapshot", expected_revision: -1 });
    verify.close();
  });

  it("rejects a modified v35 layout even when its mutable digest is maliciously resealed", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file());
    db.exec(`DROP TRIGGER provider_call_metadata_guard_insert_v35;
      CREATE TRIGGER provider_call_metadata_guard_insert_v35 BEFORE INSERT ON provider_call_metadata BEGIN SELECT 1; END;
      DROP TRIGGER adventure_generation_attestation_immutable_update_v35;`);
    const names = ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name);
    const digest = createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`).all(...names))).digest("hex");
    db.prepare("UPDATE adventure_generation_layout_attestation_v35 SET layout_digest=? WHERE singleton=1").run(digest);
    db.exec("CREATE TRIGGER adventure_generation_attestation_immutable_update_v35 BEFORE UPDATE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;");
    // Recompute after restoring the inventory trigger; the malicious provider SQL remains part of the digest.
    const resealed = createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`).all(...names))).digest("hex");
    db.exec("DROP TRIGGER adventure_generation_attestation_immutable_update_v35");
    db.prepare("UPDATE adventure_generation_layout_attestation_v35 SET layout_digest=? WHERE singleton=1").run(resealed);
    db.exec("CREATE TRIGGER adventure_generation_attestation_immutable_update_v35 BEFORE UPDATE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("hardened adventure/generation layout");
  });

  it("rejects malformed persisted shared-contract JSON at startup", () => {
    const { draft } = createDraft(); const db = new DatabaseDriver(file());
    db.pragma("ignore_check_constraints=ON");
    db.prepare("UPDATE generation_drafts SET staged_content_json='[]',revision=revision+1 WHERE id=?").run(draft.draftId);
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("generation draft JSON is malformed");
  });

  it("rejects malformed partial future v36 artifacts instead of silently cleaning them", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER provider_call_metadata_bound_v36"); db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("malformed partial future v36 artifacts");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_coordination_commands_v36'").get()).toEqual({ 1: 1 }); verify.close();
  });

  it("rolls back v35 migration instead of fabricating ambiguous proposal receipt ancestry", () => {
    const { turnId } = createTurnReceipt(); const db = new DatabaseDriver(file());
    removeV36(db); db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("turn receipt ancestry is ambiguous");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "35" });
    expect(verify.prepare("SELECT command_id FROM final_receipt_links WHERE turn_id=?").get(turnId)).toEqual({ command_id: "legacy-command" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='turn_mechanics_links_v36'").get()).toBeUndefined(); verify.close();
  });
});
