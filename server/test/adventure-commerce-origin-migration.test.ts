import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { ADVENTURE_COMMERCE_BINDING_PREDECESSOR_SQL, ADVENTURE_COMMERCE_EXECUTION_PREDECESSOR_SQL,
  ensureCurrentSchema } from "../src/repo/db/schema.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const at = "2035-01-01T00:00:00.000Z";
const BINDINGS = "adventure_commerce_bindings_v57";
const EXECUTIONS = "adventure_commerce_executions_v57";
const item = { kind: "item" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:item:waylamp" };
const currency = { kind: "currency" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:currency:glimmer" };
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
let sequence = 0;

const tableSql = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;
const triggerNames = (db: DatabaseDriver.Database, table: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table) as Array<{ name: string }>)
    .map((row) => row.name);

/** Rebuilds both v57 commerce tables at their exact pre-origin shapes, preserving rows and immutability triggers. */
function toPredecessor(db: DatabaseDriver.Database): void {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?)").all(BINDINGS, EXECUTIONS) as Array<{ name: string; sql: string }>;
  db.exec(`CREATE TEMP TABLE ${EXECUTIONS}_upgrade AS SELECT execution_id,candidate_id,campaign_id,turn_id,proposal_id,
    provider_call_id,provider_tool_call_id,command_id,actor_id,revision_before,revision_after,source_result_digest,
    public_result_json,result_digest,occurred_at FROM ${EXECUTIONS}`);
  db.exec(`CREATE TEMP TABLE ${BINDINGS}_upgrade AS SELECT proposal_id,campaign_id,turn_id,candidate_id,candidate_digest,
    provider_call_id,provider_tool_call_id,execution_idempotency_key,bound_at FROM ${BINDINGS}`);
  db.exec(`DROP TABLE ${EXECUTIONS}`);
  db.exec(`DROP TABLE ${BINDINGS}`);
  db.exec(ADVENTURE_COMMERCE_BINDING_PREDECESSOR_SQL);
  db.exec(ADVENTURE_COMMERCE_EXECUTION_PREDECESSOR_SQL);
  db.exec(`INSERT INTO ${BINDINGS} SELECT * FROM ${BINDINGS}_upgrade`);
  db.exec(`INSERT INTO ${EXECUTIONS} SELECT * FROM ${EXECUTIONS}_upgrade`);
  db.exec(`DROP TABLE ${EXECUTIONS}_upgrade`);
  db.exec(`DROP TABLE ${BINDINGS}_upgrade`);
  for (const trigger of triggers) db.exec(trigger.sql);
}

/** Runs one provider-selected purchase through the normal confirmation flow and returns its receipt. */
async function commitProviderCommerce() {
  const repo = createRepository({ clock: { now: () => new Date(at) } });
  const campaign = repo.createCampaign(OWNER, { name: "Commerce origin" });
  repo.installMechanicsStarterCatalog(OWNER);
  repo.configureMechanicsStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: `pins-${++sequence}` });
  const actorPersona = repo.createCharacter({ name: "Aster", age: 25, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const vendorPersona = repo.createCharacter({ name: "Mara", age: 40, archetype: "Merchant", boundaries: "", fictionalConfirmed: true });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: actorPersona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `draft-${++sequence}` });
  const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: `select-${++sequence}`, selections: { race: definitions.find((x) => x.reference.kind === "race")!.reference as any, background: definitions.find((x) => x.reference.kind === "background")!.reference as any, class: definitions.find((x) => x.reference.kind === "class")!.reference as any, starterGrant: "kit" } as any });
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `final-${++sequence}` }).receipt.actorId;
  const sessionId = `origin-session-${++sequence}`;
  repo.createLocation(OWNER, { campaignId: campaign.id, locationId: "market", name: "Market", description: "Open stalls" });
  repo.createNpc(OWNER, { campaignId: campaign.id, npcId: "mara", personaId: vendorPersona.id, name: "Mara", speechControl: "manual" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId, actorPersona.id, at);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId, actorPersona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, at);
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(campaign.id, actorId, "market", sessionId, at);
  for (const reference of [item, currency]) db.prepare("INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25 VALUES(?,?,?,?,?)").run(campaign.id, reference.packId, reference.packVersion, reference.kind, reference.definitionId);
  db.prepare("INSERT INTO rpg_currency_references_v25 VALUES(?,?,?,?,?,?)").run(campaign.id, "GLM", currency.packId, currency.packVersion, "currency", currency.definitionId);
  db.prepare("INSERT INTO rpg_wallets_v25 VALUES(?,?,?,?,?)").run(campaign.id, actorId, "GLM", 30, at);
  db.prepare("INSERT INTO rpg_shop_definitions_v25 VALUES('shop',?,?,?)").run(campaign.id, "Mara's Goods", at);
  db.prepare("INSERT INTO rpg_shop_stock_v25 VALUES('stock',?,'shop',?,?, 'item',?,3,10,'GLM')").run(campaign.id, item.packId, item.packVersion, item.definitionId);
  db.close();
  repo.mutateNpcPresence(OWNER, { campaignId: campaign.id, sessionId, npcId: "mara", expectedRevision: 0, idempotencyKey: `presence-${++sequence}`, mutation: { kind: "place", locationId: "market" } });
  repo.associateNpcShop(OWNER, campaign.id, "mara", "shop");
  repo.setShopBuyPolicy(OWNER, campaign.id, "shop", "stock", 4);

  const created = repo.createAdventureTurn(OWNER, { campaignId: campaign.id, timelineId: campaign.activeTimelineId, sessionId,
    actorId, declaration: "buy a waylamp from Mara", expectedCampaignRevision: 1, idempotencyKey: `origin-turn-${++sequence}` });
  const candidate = repo.generateAdventureCommerceCandidates(OWNER, created.turnId).find((value) => value.action === "buy")!;
  const completion = (): ProviderCompletionResult => ({ message: { role: "assistant", content: null,
    toolCalls: [{ id: `origin-commerce-call-${++sequence}`, name: "exact_vendor_commerce.select", arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest }) }] },
    usage: null, model: { requestedModel: "fake", responseModel: "fake" } });
  const deps: AdventureAgentDependencies = { complete: async () => completion(), getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
    getHarness: async () => defaultHarnessSettings(), now: () => new Date(at) };
  const pending = await orchestrateAdventureTurn(repo, created.turnId, deps);
  expect(pending.outcome).toBe("awaiting-confirmation");
  const proposal = pending.turn.toolCalls[0]!.proposal;
  repo.decideToolProposals(OWNER, { turnId: created.turnId, proposalIds: [proposal.proposalId], decision: "approved",
    expectedTurnRevision: pending.turn.revision, expectedCampaignRevision: pending.turn.campaignRevision, idempotencyKey: "origin-approve" });
  const committed = await orchestrateAdventureTurn(repo, created.turnId, { ...deps, complete: async () => { throw new Error("must not redispatch"); } });
  const commandId = committed.turn.receiptLinks[0]!.commandId;
  const receipt = repo.getAdventureCommercePublicReceipt(OWNER, campaign.id, commandId)!;
  repo.close();
  return { campaignId: campaign.id, created, commandId, receipt };
}

describe("adventure commerce origin schema migration", () => {
  it("migrates provider bindings and executions to origin='provider' with their provenance preserved", async () => {
    const { campaignId, created, commandId, receipt } = await commitProviderCommerce();

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    const bindingBefore = db.prepare(`SELECT * FROM ${BINDINGS}`).get() as any;
    const executionBefore = db.prepare(`SELECT * FROM ${EXECUTIONS}`).get() as any;
    expect(bindingBefore.origin).toBe("provider");
    expect(bindingBefore.system_one_decision_id).toBeNull();
    expect(executionBefore.origin).toBe("provider");
    expect(executionBefore.system_one_decision_id).toBeNull();
    toPredecessor(db);
    expect(tableSql(db, BINDINGS)).toBe(ADVENTURE_COMMERCE_BINDING_PREDECESSOR_SQL);
    expect(tableSql(db, EXECUTIONS)).toBe(ADVENTURE_COMMERCE_EXECUTION_PREDECESSOR_SQL);
    expect((db.prepare(`PRAGMA table_info(${BINDINGS})`).all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("origin");

    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare(`SELECT * FROM ${BINDINGS}`).get()).toMatchObject({ proposal_id: bindingBefore.proposal_id,
      candidate_id: bindingBefore.candidate_id, origin: "provider", provider_call_id: bindingBefore.provider_call_id,
      provider_tool_call_id: bindingBefore.provider_tool_call_id, system_one_decision_id: null,
      execution_idempotency_key: bindingBefore.execution_idempotency_key, bound_at: bindingBefore.bound_at });
    expect(db.prepare(`SELECT * FROM ${EXECUTIONS}`).get()).toMatchObject({ execution_id: executionBefore.execution_id,
      candidate_id: executionBefore.candidate_id, turn_id: executionBefore.turn_id, proposal_id: executionBefore.proposal_id,
      origin: "provider", provider_call_id: executionBefore.provider_call_id, provider_tool_call_id: executionBefore.provider_tool_call_id,
      system_one_decision_id: null, command_id: commandId, actor_id: executionBefore.actor_id,
      revision_before: executionBefore.revision_before, revision_after: executionBefore.revision_after,
      source_result_digest: executionBefore.source_result_digest, public_result_json: executionBefore.public_result_json,
      result_digest: executionBefore.result_digest, occurred_at: executionBefore.occurred_at });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(triggerNames(db, BINDINGS)).toEqual([`adventure_commerce_bindings_v57_update`]);
    expect(triggerNames(db, EXECUTIONS)).toEqual([`adventure_commerce_executions_v57_update`]);

    // Both migrated tables keep rejecting an origin without its exact provenance shape.
    db.pragma("foreign_keys=OFF");
    const bindingInsert = db.prepare(`INSERT INTO ${BINDINGS} (proposal_id,campaign_id,turn_id,candidate_id,candidate_digest,origin,
      provider_call_id,provider_tool_call_id,system_one_decision_id,execution_idempotency_key,bound_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => bindingInsert.run("synthetic-lane", "synthetic-campaign", "synthetic-turn", "synthetic-candidate", "0".repeat(64),
      "lane", null, null, null, "synthetic-key", bindingBefore.bound_at)).toThrow(/CHECK/i);
    expect(() => bindingInsert.run("synthetic-provider", "synthetic-campaign", "synthetic-turn", "synthetic-candidate", "0".repeat(64),
      "provider", null, null, null, "synthetic-key", bindingBefore.bound_at)).toThrow(/CHECK/i);
    const executionInsert = db.prepare(`INSERT INTO ${EXECUTIONS} (execution_id,candidate_id,campaign_id,turn_id,proposal_id,origin,
      provider_call_id,provider_tool_call_id,system_one_decision_id,command_id,actor_id,revision_before,revision_after,source_result_digest,
      public_result_json,result_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    expect(() => executionInsert.run("synthetic-lane-execution", "synthetic-candidate", "synthetic-campaign", "synthetic-turn", "synthetic-proposal",
      "lane", null, null, null, "synthetic-command", "synthetic-actor", 0, 1, "0".repeat(64), executionBefore.public_result_json,
      executionBefore.result_digest, executionBefore.occurred_at)).toThrow(/CHECK/i);
    db.pragma("foreign_keys=ON");

    const migrated = tableSql(db, EXECUTIONS);
    ensureCurrentSchema(db, ":memory:");
    expect(tableSql(db, EXECUTIONS)).toBe(migrated);
    db.close();

    const reopened = createRepository();
    expect(reopened.getAdventureCommercePublicReceipt(OWNER, campaignId, commandId)).toEqual(receipt);
    reopened.close();
    void created;
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
