// Approved tests from the round-5 and round-7 playtests.
// Mech turn 4 declared "I drink a healing potion." while holding potions of
// greater/superior/supreme healing. The provider never selected the advertised
// consume candidate; repair accepted stay-put narration ("flask resting
// unopened" / "Nothing has changed yet") and the inventory was unchanged.
// After #52, a live drink still settled as provider-accepted narration of a
// fabricated successful drink when the provider called an advertised
// non-consume tool (for example campaign_context.read) and never selected the
// consume row. A clear drink declaration with a matching held potion must
// propose consume in both cases instead of settling as a no-op. Adventure
// consume remains inventory-only (no invented healing effects).
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { adventureTurnStreamEventSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z",
  scores = Object.fromEntries(
    ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [
      key,
      CHARACTER_BUILDER_STANDARD_ARRAY[index],
    ]),
  ) as CharacterBuilderAttributeScores;
let key = 0;

function retargetWaylamp(
  db: DatabaseDriver.Database,
  name: string,
  category: "gear" | "consumable",
  slot: "hand" | null,
) {
  const reference = MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "item")!.reference;
  const definitionRow = db
    .prepare(
      "SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?",
    )
    .get(reference.packId, reference.packVersion, reference.definitionId) as { definition_json: string } | undefined;
  const publicRow = db
    .prepare(
      "SELECT public_definition_json FROM rpg_catalog_definition_visibility WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?",
    )
    .get(reference.packId, reference.packVersion, reference.definitionId) as
    { public_definition_json: string } | undefined;
  if (!definitionRow || !publicRow) return;
  const definition = JSON.parse(definitionRow.definition_json),
    publicDefinition = JSON.parse(publicRow.public_definition_json);
  definition.name = name;
  publicDefinition.name = name;
  definition.mechanics = { ...definition.mechanics, category, slot };
  publicDefinition.mechanics = { ...publicDefinition.mechanics, category, slot };
  db.exec(
    "DROP TRIGGER rpg_catalog_definitions_immutable_update; DROP TRIGGER rpg_catalog_visibility_immutable_update",
  );
  db.prepare(
    "UPDATE rpg_catalog_definitions SET definition_json=? WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?",
  ).run(JSON.stringify(definition), reference.packId, reference.packVersion, reference.definitionId);
  db.prepare(
    "UPDATE rpg_catalog_definition_visibility SET public_definition_json=? WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?",
  ).run(JSON.stringify(publicDefinition), reference.packId, reference.packVersion, reference.definitionId);
  db.exec(
    "CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END; CREATE TRIGGER rpg_catalog_visibility_immutable_update BEFORE UPDATE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;",
  );
}

function fixture() {
  let time = new Date(at);
  const sessionId = `potion-session-${++key}`,
    repo = createRepository({ clock: { now: () => time } }),
    campaign = repo.createCampaign("local-owner", { name: "Potion adventure" });
  const repair = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  retargetWaylamp(repair, "Waylamp", "gear", "hand");
  repair.close();
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, {
    expectedRevision: 0,
    idempotencyKey: `pins-${++key}`,
  });
  const actor = (name: string) => {
    const persona = repo.createCharacter({
      name,
      age: 25,
      archetype: "Warden",
      boundaries: "",
      fictionalConfirmed: true,
    });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, {
      personaId: persona.id,
      controllerPrincipalId: "local-owner",
      durability: "durable",
      allocation: { method: "standard-array", scores },
      idempotencyKey: `draft-${++key}`,
    });
    const definitions = MECHANICS_STARTER_CATALOG.definitions,
      selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
        expectedRevision: 0,
        idempotencyKey: `select-${++key}`,
        selections: {
          race: definitions.find((x) => x.reference.kind === "race")!.reference as any,
          background: definitions.find((x) => x.reference.kind === "background")!.reference as any,
          class: definitions.find((x) => x.reference.kind === "class")!.reference as any,
          starterGrant: "kit",
        },
      } as any);
    const result = repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: `final-${++key}`,
    });
    return { actorId: result.receipt.actorId, personaId: persona.id };
  };
  const source = actor("Aster"),
    recipient = actor("Briar"),
    db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  db.prepare(
    "INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)",
  ).run(sessionId, source.personaId, at);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0),(?,?,1)").run(
    sessionId,
    source.personaId,
    sessionId,
    recipient.personaId,
  );
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, at);
  retargetWaylamp(db, "Potion of Greater Healing", "consumable", "hand");
  db.close();
  return {
    repo,
    campaign,
    source,
    recipient,
    sessionId,
  };
}

const narration = (text: string): ProviderCompletionResult => ({
  message: {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: `narration-call-${++key}`,
        name: "submit_adventure_narration",
        arguments: JSON.stringify({ narration: text }),
      },
    ],
  },
  usage: null,
  model: { requestedModel: "fake", responseModel: "fake" },
});

const deps = (
  fn: (input: ProviderCompletionInput) => Promise<ProviderCompletionResult>,
  now = at,
): AdventureAgentDependencies => ({
  complete: fn,
  getProvider: async () => ({ ...defaultProviderSettings(), model: "fake" }),
  getHarness: async () => defaultHarnessSettings(),
  now: () => new Date(now),
});

function makeTurn(f: ReturnType<typeof fixture>, declaration: string) {
  return f.repo.createAdventureTurn("local-owner", {
    campaignId: f.campaign.id,
    timelineId: f.campaign.activeTimelineId,
    sessionId: f.sessionId,
    actorId: f.source.actorId,
    declaration,
    expectedCampaignRevision: 1,
    idempotencyKey: `turn-${++key}`,
  });
}

const STAY_PUT =
  "You stay where you are on the Slake-Head apron, the flask resting unopened in your hand. Nothing has changed yet. Whatever you meant to do is still ahead of you.";

describe("drinking a held healing potion consumes it", () => {
  it("proposes consume when the actor drinks a held healing potion even if the provider stays put", async () => {
    const f = fixture();
    const before = f.repo.getActorInventorySnapshot("local-owner", f.campaign.id, f.source.actorId)!;
    const waylampItems = (before.inventory.items || []).filter((item: any) =>
      String(item.item?.definitionId || "").includes("waylamp"),
    );
    expect(waylampItems.length).toBeGreaterThan(0);
    const quantityBefore = waylampItems.reduce((sum: number, item: any) => sum + (item.quantity ?? 1), 0);

    const turn = makeTurn(f, "I drink a healing potion.");
    const consume = f.repo
      .generateAdventureInventoryCandidates("local-owner", turn.turnId)
      .find((value) => value.action === "consume" && /potion of greater healing/i.test(value.itemLabel));
    expect(consume).toBeDefined();

    const result = await orchestrateAdventureTurn(
      f.repo,
      turn.turnId,
      deps(async () => narration(STAY_PUT)),
    );
    expect(result.outcome, JSON.stringify(result.turn)).toBe("awaiting-confirmation");
    expect(result.turn.receiptLinks).toHaveLength(0);
    const proposal = result.turn.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("inventory_item_consume");
    expect(JSON.stringify(proposal)).toMatch(/Potion of Greater Healing/);

    const decided = f.repo.decideToolProposals("local-owner", {
      turnId: turn.turnId,
      proposalIds: [proposal.proposalId],
      decision: "approved",
      expectedTurnRevision: result.turn.revision,
      expectedCampaignRevision: 1,
      idempotencyKey: `approve-${++key}`,
    });
    const resumed = await orchestrateAdventureTurn(
      f.repo,
      turn.turnId,
      deps(async () => {
        throw new Error("must not redispatch after consume approval");
      }),
    );
    expect(decided.state).toBe("confirmed");
    expect(resumed.outcome).toBe("completed");
    const receipt = f.repo.getAdventureInventoryPublicReceipt(
      "local-owner",
      f.campaign.id,
      resumed.turn.receiptLinks[0]!.commandId,
    )!;
    expect(receipt).toMatchObject({
      itemLabel: "Potion of Greater Healing",
      action: "consume",
      quantity: 1,
    });
    const after = f.repo.getActorInventorySnapshot("local-owner", f.campaign.id, f.source.actorId)!;
    const remaining = (after.inventory.items || []).filter((item: any) =>
      String(item.item?.definitionId || "").includes("waylamp"),
    );
    const quantityAfter = remaining.reduce((sum: number, item: any) => sum + (item.quantity ?? 1), 0);
    expect(quantityAfter).toBe(quantityBefore - 1);
    const text = JSON.stringify(resumed);
    expect(text).not.toMatch(/unopened/i);
    expect(text).not.toMatch(/nothing has changed yet/i);
    expect(text).not.toMatch(/\bhit points?\b/i);
    f.repo.close();
  });

  it("proposes consume when the provider fabricates a successful drink after selecting a non-consume tool", async () => {
    // Live miss after #52: the hook only injects consume when the planning complete() result
    // has no selected tool call at all. A real provider often calls an advertised read
    // (campaign_context.read / actor_inventory.read) and never selects the consume row;
    // planning then ends and performNarration accepts fabricated success prose, leaving
    // receipts empty and inventory unchanged. This case must still propose the advertised
    // consume candidate. Adventure consume stays inventory-only (no invented HP).
    const f = fixture();
    const before = f.repo.getActorInventorySnapshot("local-owner", f.campaign.id, f.source.actorId)!;
    const waylampItems = (before.inventory.items || []).filter((item: any) =>
      String(item.item?.definitionId || "").includes("waylamp"),
    );
    expect(waylampItems.length).toBeGreaterThan(0);
    const quantityBefore = waylampItems.reduce((sum: number, item: any) => sum + (item.quantity ?? 1), 0);

    const turn = makeTurn(f, "I drink a healing potion.");
    const consume = f.repo
      .generateAdventureInventoryCandidates("local-owner", turn.turnId)
      .find((value) => value.action === "consume" && /potion of greater healing/i.test(value.itemLabel));
    expect(consume).toBeDefined();

    const FABRICATED =
      "You work the stopper loose from a vial of greater healing and tip it back. Warmth spreads from your throat to your fingertips, the ache of old bruises thinning away; you are unhurt and whole as you were, the vial now one fewer in your satchel.";

    const result = await orchestrateAdventureTurn(
      f.repo,
      turn.turnId,
      deps(async () => ({
        message: {
          role: "assistant",
          content: FABRICATED,
          toolCalls: [
            {
              id: `read-call-${++key}`,
              name: "campaign_context.read",
              arguments: "{}",
            },
          ],
        },
        usage: null,
        model: { requestedModel: "fake", responseModel: "fake" },
      })),
    );
    expect(result.outcome, JSON.stringify(result.turn)).toBe("awaiting-confirmation");
    expect(result.turn.receiptLinks).toHaveLength(0);
    const proposal = result.turn.toolCalls[0]!.proposal;
    expect(proposal.toolName).toBe("inventory_item_consume");
    expect(JSON.stringify(proposal)).toMatch(/Potion of Greater Healing/);

    const decided = f.repo.decideToolProposals("local-owner", {
      turnId: turn.turnId,
      proposalIds: [proposal.proposalId],
      decision: "approved",
      expectedTurnRevision: result.turn.revision,
      expectedCampaignRevision: 1,
      idempotencyKey: `approve-${++key}`,
    });
    const resumed = await orchestrateAdventureTurn(
      f.repo,
      turn.turnId,
      deps(async () => {
        throw new Error("must not redispatch after consume approval");
      }),
    );
    expect(decided.state).toBe("confirmed");
    expect(resumed.outcome).toBe("completed");
    const receipt = f.repo.getAdventureInventoryPublicReceipt(
      "local-owner",
      f.campaign.id,
      resumed.turn.receiptLinks[0]!.commandId,
    )!;
    expect(receipt).toMatchObject({
      itemLabel: "Potion of Greater Healing",
      action: "consume",
      quantity: 1,
    });
    const after = f.repo.getActorInventorySnapshot("local-owner", f.campaign.id, f.source.actorId)!;
    const remaining = (after.inventory.items || []).filter((item: any) =>
      String(item.item?.definitionId || "").includes("waylamp"),
    );
    const quantityAfter = remaining.reduce((sum: number, item: any) => sum + (item.quantity ?? 1), 0);
    expect(quantityAfter).toBe(quantityBefore - 1);
    const text = JSON.stringify(resumed);
    expect(text).not.toMatch(/\bhit points?\b/i);
    f.repo.close();
  });

  it("commits the consume over HTTP after the player approves the proposal", async () => {
    // Live miss after #55 on a quick adventure: stream proposed inventory_item_consume
    // and POST confirm returned 200, but the turn stayed declared with no receipts;
    // resume then ended error/cancelled and the inventory was unchanged. Approve must
    // commit the consume (receipt + quantity-1) before or during resume narration.
    // Adventure consume stays inventory-only (no invented HP).
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";

    const FABRICATED =
      "You work the stopper loose from a vial of greater healing and tip it back. The vial is now one fewer in your satchel.";
    const AFTER = "The empty vial is stowed. You remain where you were, with no change to your wounds.";
    let planningCalls = 0;
    const liveDeps = deps(async () => {
      planningCalls += 1;
      if (planningCalls === 1)
        return {
          message: {
            role: "assistant",
            content: FABRICATED,
            toolCalls: [{ id: `read-call-${++key}`, name: "campaign_context.read", arguments: "{}" }],
          },
          usage: null,
          model: { requestedModel: "fake", responseModel: "fake" },
        };
      return narration(AFTER);
    });
    liveDeps.now = () => new Date();
    const app = buildApp({ adventureAgentDependencies: liveDeps });
    const streamEvents = (body: string) =>
      body
        .split("\n\n")
        .filter((frame) => frame.startsWith("event: "))
        .map((frame) => {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6);
          return adventureTurnStreamEventSchema.parse(JSON.parse(data));
        });
    const potionRows = (inv: any) =>
      (inv.entries || inv.inventory?.items || []).filter((entry: any) =>
        /potion/i.test(String(entry.item?.name || entry.item?.definitionId || entry.itemLabel || "")),
      );
    const potionQty = (inv: any) => potionRows(inv).reduce((sum: number, entry: any) => sum + (entry.quantity ?? 1), 0);
    const publicTurn = (body: any) => ({
      state: body.turn?.state,
      receiptCount: (body.receipts || []).length,
      confirmation: body.confirmation?.state,
      decisions: (body.confirmation?.decisions || []).map((decision: any) => decision.decision),
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/quick-adventures",
        payload: { idempotencyKey: `http-potion-qa-${++key}` },
      });
      expect(created.statusCode, created.body).toBe(201);
      const ids = created.json() as { campaignId: string; sessionId: string; actorId: string };
      const invUrl = `/api/rpg/v1/campaigns/${ids.campaignId}/actors/${ids.actorId}/inventory`;
      const before = (await app.inject({ method: "GET", url: invUrl })).json();
      expect(potionQty(before), JSON.stringify(before).slice(0, 800)).toBeGreaterThan(0);
      const quantityBefore = potionQty(before);

      const boot = await app.inject({
        method: "GET",
        url: `/api/rpg/v1/campaigns/${ids.campaignId}/rooms/${encodeURIComponent(ids.sessionId)}/play-bootstrap`,
      });
      expect(boot.statusCode, boot.body).toBe(200);

      const streamed = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/adventure-turns/stream",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        payload: {
          campaignId: ids.campaignId,
          sessionId: ids.sessionId,
          actorId: ids.actorId,
          declaration: "I drink a healing potion.",
          expectedRevision: boot.json().expectedRevision,
          idempotencyKey: `http-drink-${++key}`,
        },
      });
      expect(streamed.statusCode, streamed.body.slice(0, 1500)).toBe(200);
      const streamEv = streamEvents(streamed.body);
      expect(
        streamEv.map((event) => event.type),
        streamed.body.slice(0, 1500),
      ).toContain("confirmation_required");
      const proposed = streamEv.find((event) => event.type === "tool_proposed");
      expect(proposed && proposed.type === "tool_proposed" ? proposed.payload.proposal.toolName : "").toBe(
        "inventory_item_consume",
      );
      const pending = streamEv.find((event) => event.type === "confirmation_required");
      if (!pending || pending.type !== "confirmation_required") throw new Error("missing confirmation_required");
      const terminal = streamEv.at(-1);
      const turnId =
        (streamed.headers["x-adventure-turn-id"] as string) ||
        (terminal && terminal.type === "terminal" ? terminal.payload.turn.turnId : "");
      expect(turnId).toBeTruthy();
      const expectedRevision = terminal && terminal.type === "terminal" ? terminal.payload.turn.revision : 0;

      const confirmed = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/adventure-turns/${turnId}/confirm`,
        headers: { "content-type": "application/json" },
        payload: {
          proposalIds: pending.payload.proposalIds,
          decision: "approve",
          expectedRevision,
          idempotencyKey: `http-confirm-${++key}`,
        },
      });
      expect(confirmed.statusCode, `confirm status ${confirmed.statusCode}`).toBe(200);
      const token = confirmed.json().resumeToken as string | undefined;
      expect(Boolean(token), "confirm should return a resume token").toBe(true);

      if (token) {
        const resumed = await app.inject({
          method: "POST",
          url: "/api/rpg/v1/adventure-turns/stream",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          payload: { resumeToken: token },
        });
        expect(resumed.statusCode, resumed.body.slice(0, 1500)).toBe(200);
        const resumeEv = streamEvents(resumed.body);
        const resumeTerminal = resumeEv.at(-1);
        const resumeView = {
          types: resumeEv.map((event) => event.type),
          outcome: resumeTerminal && resumeTerminal.type === "terminal" ? resumeTerminal.payload.outcome : "",
          state: resumeTerminal && resumeTerminal.type === "terminal" ? resumeTerminal.payload.turn.state : "",
        };
        expect(resumeView.outcome, JSON.stringify(resumeView)).not.toBe("error");
        expect(resumeView.state, JSON.stringify(resumeView)).not.toBe("cancelled");
      }

      const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` });
      const body = read.json();
      const receipts = body.receipts || [];
      expect(receipts.length, JSON.stringify(publicTurn(body))).toBeGreaterThan(0);
      const commandId = receipts[0]?.commandId as string;
      expect(commandId, JSON.stringify(publicTurn(body))).toBeTruthy();
      const receipt = await app.inject({
        method: "GET",
        url: `/api/rpg/v1/campaigns/${ids.campaignId}/commands/${commandId}/receipt`,
      });
      expect(receipt.statusCode, receipt.body.slice(0, 800)).toBe(200);
      expect(receipt.json().receipt, receipt.body.slice(0, 800)).toMatchObject({
        kind: "inventory",
        action: "consume",
        quantity: 1,
      });
      const after = (await app.inject({ method: "GET", url: invUrl })).json();
      expect(potionQty(after), JSON.stringify({ quantityBefore, after: potionQty(after) })).toBe(quantityBefore - 1);
      const text = JSON.stringify(publicTurn(body)) + JSON.stringify(receipt.json()) + JSON.stringify(after);
      expect(text).not.toMatch(/\bhit points?\b/i);
    } finally {
      await app.close();
    }
  });
});
