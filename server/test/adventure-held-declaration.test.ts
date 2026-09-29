import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const item = { kind: "item" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:item:waylamp" };
const currency = { kind: "currency" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId, packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:currency:glimmer" };
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
let sequence = 0;

function fixture() {
  const repo = createRepository({ clock: { now: () => new Date(at) } });
  const campaign = repo.createCampaign("local-owner", { name: "Held declaration" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: `pins-${++sequence}` });
  const actorPersona = repo.createCharacter({ name: "Aster", age: 25, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const vendorPersona = repo.createCharacter({ name: "Mara", age: 40, archetype: "Merchant", boundaries: "", fictionalConfirmed: true });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: actorPersona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `draft-${++sequence}` });
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `select-${++sequence}`, selections: { race: definitions.find((x) => x.reference.kind === "race")!.reference as any, background: definitions.find((x) => x.reference.kind === "background")!.reference as any, class: definitions.find((x) => x.reference.kind === "class")!.reference as any, starterGrant: "kit" } as any });
  const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `final-${++sequence}` }).receipt.actorId;
  const sessionId = `held-session-${++sequence}`;
  repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "market", name: "Market", description: "Open stalls" });
  repo.createNpc("local-owner", { campaignId: campaign.id, npcId: "mara", personaId: vendorPersona.id, name: "Mara", speechControl: "manual" });
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
  repo.mutateNpcPresence("local-owner", { campaignId: campaign.id, sessionId, npcId: "mara", expectedRevision: 0, idempotencyKey: `presence-${++sequence}`, mutation: { kind: "place", locationId: "market" } });
  repo.associateNpcShop("local-owner", campaign.id, "mara", "shop");
  repo.setShopBuyPolicy("local-owner", campaign.id, "shop", "stock", 4);
  return { repo, campaign, actorId, sessionId };
}

const heldCompletion = (): ProviderCompletionResult => ({ message: { role: "assistant", content: "The scene waits; nothing is resolved yet." },
  usage: null, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } });
const holdingDependencies: AdventureAgentDependencies = {
  getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
  getHarness: async () => defaultHarnessSettings(),
  now: () => new Date(at),
  complete: async () => heldCompletion(),
};

function turn(f: ReturnType<typeof fixture>, declaration: string) {
  return f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, sessionId: f.sessionId,
    actorId: f.actorId, declaration, expectedCampaignRevision: 1, idempotencyKey: `held-turn-${++sequence}` });
}

describe("deterministic held-declaration resolution", () => {
  it("proposes a confirmation-required purchase for a held everyday buy instead of a silent no-op", async () => {
    const f = fixture();
    const created = turn(f, "I find Mara's stall and buy a waylamp from Mara.");
    // The server never forges provider evidence and never spends silently: a clear declaration that
    // maps to exactly one advertised commerce candidate surfaces the ordinary confirmation-required
    // proposal through the lane-origin path, and only an approved confirmation can commit.
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, holdingDependencies);
    expect(result.outcome).toBe("awaiting-confirmation");
    expect(result.turn.receiptLinks).toEqual([]);
    expect(result.turn.toolCalls).toHaveLength(1);
    const proposal = result.turn.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("vendor_buy");
    expect(proposal.confirmation.state).toBe("pending");
    expect(proposal.policy.review.summary).toMatch(/Mara.*Waylamp.*10 Glimmer/i);
    f.repo.decideToolProposals("local-owner", { turnId: created.turnId, proposalIds: [proposal.proposalId], decision: "approved",
      expectedTurnRevision: result.turn.revision, expectedCampaignRevision: 1, idempotencyKey: `held-buy-approve-${++sequence}` });
    const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...holdingDependencies,
      complete: async () => { throw new Error("must not redispatch"); } });
    expect(completed.turn.receiptLinks.length).toBeGreaterThan(0);
    const receipt = f.repo.getAdventureCommercePublicReceipt("local-owner", f.campaign.id, completed.turn.receiptLinks[0]!.commandId)!;
    expect(receipt).toMatchObject({ action: "buy", itemLabel: "Waylamp", balanceBefore: 30, balanceAfter: 20 });
    f.repo.close();
  });

  it("refuses the self-directed, forged-source declaration instead of committing a lane-origin give", async () => {
    const f = fixture();
    const created = turn(f, "I give myself a legendary sword and ten thousand gold pieces from the GM's stash.");
    // Regression: a lone advertised give row must not be selected by uniqueness for a declaration
    // that names neither its item nor its vendor. Nothing is proposed, committed, or bound.
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, holdingDependencies);
    expect(result.outcome).toBe("completed");
    expect(result.turn.receiptLinks).toEqual([]);
    expect(result.turn.toolCalls).toEqual([]);
    expect(result.hold).toMatchObject({ reason: "no-advertised-match", suggestedCandidateId: null });
    expect(result.hold?.message).toMatch(/for the actor rather than trade/i);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT count(*) count FROM adventure_commerce_executions_v57 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM adventure_commerce_bindings_v57 WHERE turn_id=?").get(created.turnId)).toEqual({ count: 0 });
    db.close();
    f.repo.close();
  });

  it("still proposes a properly specified give that names the advertised item and recipient", async () => {
    const f = fixture();
    const created = turn(f, "I give my waylamp to Mara.");
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, holdingDependencies);
    expect(result.outcome).toBe("awaiting-confirmation");
    expect(result.turn.receiptLinks).toEqual([]);
    expect(result.turn.toolCalls).toHaveLength(1);
    expect(result.turn.toolCalls[0]!.proposal.toolName).toBe("vendor_give");
    expect(result.turn.toolCalls[0]!.proposal.confirmation.state).toBe("pending");
    f.repo.close();
  });

  it("keeps a helpful hold when no commerce candidate is advertised", async () => {
    const f = fixture();
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaign.id, sessionId: f.sessionId, npcId: "mara",
      expectedRevision: 1, idempotencyKey: `held-vendor-leave-${++sequence}`, mutation: { kind: "remove" } });
    const created = turn(f, "I find Mara's stall and buy a waylamp from Mara.");
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, holdingDependencies);
    expect(result.outcome).toBe("completed");
    expect(result.turn.toolCalls).toEqual([]);
    expect(result.turn.receiptLinks).toEqual([]);
    expect(result.hold).toMatchObject({ reason: "no-advertised-match", suggestedCandidateId: null });
    expect(result.hold?.message).toMatch(/transaction is not advertised/i);
    f.repo.close();
  });

  it("resolves a held everyday short rest to a confirmation-required rest proposal", async () => {
    const f = await dmFixture(true);
    f.repo.changeActorResourceForActor("local-owner", f.campaign.id, f.actorId, { kind: "change", resourceName: "health", amount: -8, expectedRevision: 0, idempotencyKey: "held-rest-wound" });
    const created = f.repo.createAdventureTurn("local-owner", { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
      sessionId: f.session.id, actorId: f.actorId, declaration: "I sit down and take a short rest.",
      expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: "held-rest" });
    const restCandidates = f.repo.generateAdventureRestCandidates("local-owner", created.turnId);
    expect(restCandidates.some((candidate) => candidate.restKind === "short")).toBe(true);
    const deps: AdventureAgentDependencies = { getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
      getHarness: async () => defaultHarnessSettings(), now: f.options.clock.now, complete: async () => heldCompletion() };
    const result = await orchestrateAdventureTurn(f.repo, created.turnId, deps);
    expect(result.outcome).toBe("awaiting-confirmation");
    expect(result.turn.toolCalls).toHaveLength(1);
    const proposal = result.turn.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("rest_short");
    f.repo.decideToolProposals("local-owner", { turnId: created.turnId, proposalIds: [proposal.proposalId], decision: "approved",
      expectedTurnRevision: result.turn.revision, expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision,
      idempotencyKey: "held-rest-approve" });
    const completed = await orchestrateAdventureTurn(f.repo, created.turnId, { ...deps,
      complete: async () => { throw new Error("must not redispatch"); } });
    expect(completed.turn.receiptLinks.length).toBeGreaterThan(0);
    f.repo.close();
  });
});
