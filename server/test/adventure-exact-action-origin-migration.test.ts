import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository } from "../src/repo/index.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { ADVENTURE_EXACT_ACTION_BINDING_PREDECESSOR_SQL, ADVENTURE_EXACT_ACTION_EXECUTION_PREDECESSOR_SQL,
  ensureCurrentSchema } from "../src/repo/db/schema.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

const BINDINGS = "adventure_exact_action_proposal_bindings_v56";
const EXECUTIONS = "adventure_exact_action_executions_v56";
const tableSql = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
const triggerNames = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table) as Array<{ name: string }>)
    .map((row) => row.name);

/** Rebuilds both v56 tables at their exact pre-origin shapes, preserving rows and immutability triggers. */
function toPredecessor(db: DatabaseDriver.Database): void {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?)").all(BINDINGS, EXECUTIONS) as Array<{ name: string; sql: string }>;
  db.exec(`CREATE TEMP TABLE ${EXECUTIONS}_upgrade AS SELECT execution_id,candidate_id,campaign_id,turn_id,proposal_id,action_kind,
    provider_call_id,provider_tool_call_id,command_id,actor_id,revision_before,revision_after,source_result_digest,public_result_json,
    result_digest,occurred_at,linked_at FROM ${EXECUTIONS}`);
  db.exec(`CREATE TEMP TABLE ${BINDINGS}_upgrade AS SELECT proposal_id,campaign_id,turn_id,candidate_id,candidate_digest,action_kind,
    provider_call_id,provider_tool_call_id,execution_idempotency_key,bound_at FROM ${BINDINGS}`);
  db.exec(`DROP TABLE ${EXECUTIONS}`);
  db.exec(`DROP TABLE ${BINDINGS}`);
  db.exec(ADVENTURE_EXACT_ACTION_BINDING_PREDECESSOR_SQL);
  db.exec(ADVENTURE_EXACT_ACTION_EXECUTION_PREDECESSOR_SQL);
  db.exec(`INSERT INTO ${BINDINGS} SELECT * FROM ${BINDINGS}_upgrade`);
  db.exec(`INSERT INTO ${EXECUTIONS} SELECT * FROM ${EXECUTIONS}_upgrade`);
  db.exec(`DROP TABLE ${EXECUTIONS}_upgrade`);
  db.exec(`DROP TABLE ${BINDINGS}_upgrade`);
  for (const trigger of triggers) db.exec(trigger.sql);
}

/** Runs one provider-selected short rest through the normal confirmation flow and returns its receipt. */
async function commitProviderRest() {
  const f = await dmFixture(true);
  f.repo.changeActorResourceForActor(OWNER, f.campaign.id, f.actorId,
    { kind: "change", resourceName: "health", amount: -5, expectedRevision: 0, idempotencyKey: "origin-wound" });
  const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
    sessionId: f.session.id, actorId: f.actorId, declaration: "I take a short rest.",
    expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "origin-turn" });
  const candidate = f.repo.generateAdventureRestCandidates(OWNER, created.turnId).find((value) => value.restKind === "short");
  if (!candidate) throw new Error("short rest candidate is unavailable");
  const completion = (): ProviderCompletionResult => ({ message: { role: "assistant", content: null,
    toolCalls: [{ id: "origin-rest-call", name: "exact_rest.select", arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } });
  const deps: AdventureAgentDependencies = { complete: async () => completion(),
    getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }), getHarness: async () => defaultHarnessSettings(), now: f.options.clock.now };
  const pending = await orchestrateAdventureTurn(f.repo, created.turnId, deps);
  expect(pending.outcome).toBe("awaiting-confirmation");
  const proposal = pending.turn.toolCalls[0]!.proposal;
  f.repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposal.proposalId], decision: "approved",
    expectedTurnRevision: pending.turn.revision, expectedCampaignRevision: pending.turn.campaignRevision, idempotencyKey: "origin-approve" });
  const committed = await orchestrateAdventureTurn(f.repo, created.turnId,
    { ...deps, complete: async () => { throw new Error("must not redispatch"); } });
  const commandId = committed.turn.receiptLinks[0]!.commandId;
  const receipt = f.repo.getAdventureRestPublicReceipt(OWNER, f.campaign.id, commandId)!;
  f.repo.close();
  return { f, created, commandId, receipt };
}

describe("adventure exact action origin schema migration", () => {
  it("migrates provider bindings and executions to origin='provider' with their provenance preserved", async () => {
    const { f, created, commandId, receipt } = await commitProviderRest();

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    const bindingBefore = db.prepare(`SELECT * FROM ${BINDINGS}`).get() as any;
    const executionBefore = db.prepare(`SELECT * FROM ${EXECUTIONS}`).get() as any;
    expect(bindingBefore.origin).toBe("provider");
    expect(bindingBefore.system_one_decision_id).toBeNull();
    expect(executionBefore.origin).toBe("provider");
    expect(executionBefore.system_one_decision_id).toBeNull();
    toPredecessor(db);
    expect(tableSql(db, BINDINGS)).toBe(ADVENTURE_EXACT_ACTION_BINDING_PREDECESSOR_SQL);
    expect(tableSql(db, EXECUTIONS)).toBe(ADVENTURE_EXACT_ACTION_EXECUTION_PREDECESSOR_SQL);
    expect((db.prepare(`PRAGMA table_info(${BINDINGS})`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("origin");

    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare(`SELECT * FROM ${BINDINGS}`).get()).toMatchObject({ proposal_id: bindingBefore.proposal_id,
      candidate_id: bindingBefore.candidate_id, origin: "provider", provider_call_id: bindingBefore.provider_call_id,
      provider_tool_call_id: bindingBefore.provider_tool_call_id, system_one_decision_id: null,
      execution_idempotency_key: bindingBefore.execution_idempotency_key, bound_at: bindingBefore.bound_at });
    expect(db.prepare(`SELECT * FROM ${EXECUTIONS}`).get()).toMatchObject({ execution_id: executionBefore.execution_id,
      candidate_id: executionBefore.candidate_id, turn_id: executionBefore.turn_id, proposal_id: executionBefore.proposal_id,
      action_kind: executionBefore.action_kind, origin: "provider", provider_call_id: executionBefore.provider_call_id,
      provider_tool_call_id: executionBefore.provider_tool_call_id, system_one_decision_id: null, command_id: commandId,
      actor_id: executionBefore.actor_id, revision_before: executionBefore.revision_before, revision_after: executionBefore.revision_after,
      source_result_digest: executionBefore.source_result_digest, public_result_json: executionBefore.public_result_json,
      result_digest: executionBefore.result_digest, occurred_at: executionBefore.occurred_at, linked_at: executionBefore.linked_at });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(triggerNames(db, BINDINGS)).toEqual([`adventure_exact_action_bindings_v56_delete`, `adventure_exact_action_bindings_v56_update`]);
    expect(triggerNames(db, EXECUTIONS)).toEqual([`adventure_exact_action_executions_v56_delete`, `adventure_exact_action_executions_v56_update`]);

    // Both migrated tables keep rejecting an origin without its exact provenance shape.
    db.pragma("foreign_keys=OFF");
    const bindingInsert = db.prepare(`INSERT INTO ${BINDINGS} (proposal_id,campaign_id,turn_id,candidate_id,candidate_digest,action_kind,
      origin,provider_call_id,provider_tool_call_id,system_one_decision_id,execution_idempotency_key,bound_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => bindingInsert.run("synthetic-lane", "synthetic-campaign", "synthetic-turn", "synthetic-candidate", "0".repeat(64),
      "rest", "lane", null, null, null, "synthetic-key", bindingBefore.bound_at)).toThrow(/CHECK/i);
    expect(() => bindingInsert.run("synthetic-provider", "synthetic-campaign", "synthetic-turn", "synthetic-candidate", "0".repeat(64),
      "rest", "provider", null, null, null, "synthetic-key", bindingBefore.bound_at)).toThrow(/CHECK/i);
    const executionInsert = db.prepare(`INSERT INTO ${EXECUTIONS} (execution_id,candidate_id,campaign_id,turn_id,proposal_id,action_kind,origin,
      provider_call_id,provider_tool_call_id,system_one_decision_id,command_id,actor_id,revision_before,revision_after,source_result_digest,
      public_result_json,result_digest,occurred_at,linked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => executionInsert.run("synthetic-lane-execution", "synthetic-candidate", "synthetic-campaign", "synthetic-turn", "synthetic-proposal",
      "rest", "lane", null, null, null, "synthetic-command", "synthetic-actor", 0, 1, "0".repeat(64), executionBefore.public_result_json,
      executionBefore.result_digest, executionBefore.occurred_at, executionBefore.linked_at)).toThrow(/CHECK/i);
    expect(() => executionInsert.run("synthetic-provider-execution", "synthetic-candidate", "synthetic-campaign", "synthetic-turn", "synthetic-proposal",
      "rest", "provider", null, null, null, "synthetic-command", "synthetic-actor", 0, 1, "0".repeat(64), executionBefore.public_result_json,
      executionBefore.result_digest, executionBefore.occurred_at, executionBefore.linked_at)).toThrow(/CHECK/i);
    db.pragma("foreign_keys=ON");

    const migrated = tableSql(db, EXECUTIONS);
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db, EXECUTIONS)).toBe(migrated);
    db.close();

    const reopened = createRepository();
    expect(reopened.getAdventureRestPublicReceipt(OWNER, f.campaign.id, commandId)).toEqual(receipt);
    reopened.close();
  });

  it("creates the origin-aware tables in a fresh database and accepts an already current schema untouched", () => {
    const db = new DatabaseDriver(":memory:");
    ensureCurrentSchema(db, ":memory:");
    const binding = tableSql(db, BINDINGS), execution = tableSql(db, EXECUTIONS);
    expect(binding).toContain("origin IN('provider','lane')");
    expect(binding).toContain("system_one_decision_id");
    expect(execution).toContain("origin IN('provider','lane')");
    expect(execution).toContain("system_one_decision_id");
    ensureCurrentSchema(db, ":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db, BINDINGS)).toBe(binding);
    expect(tableSql(db, EXECUTIONS)).toBe(execution);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
