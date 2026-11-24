// Approved test (round-2 playtest kink 7): "I drop my rope here" was planned as a gift to a companion, and
// after the gift was approved its execution never committed, leaving the turn stuck in "declared" forever.
// A drop must be a discard, and a turn whose approved mechanics cannot commit must reach a terminal state.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adventureTurnStreamEventSchema,
  CHARACTER_BUILDER_STANDARD_ARRAY,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { buildApp } from "../src/app.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";

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
function setWaylampMechanics(db: DatabaseDriver.Database, category: "gear" | "consumable", slot: "hand" | null) {
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
  const sessionId = `inventory-session-${++key}`,
    repo = createRepository({ clock: { now: () => time } }),
    campaign = repo.createCampaign("local-owner", { name: "Inventory adventure" });
  const repair = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  setWaylampMechanics(repair, "gear", "hand");
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
  setWaylampMechanics(db, "consumable", "hand");
  db.close();
  return {
    repo,
    campaign,
    source,
    recipient,
    sessionId,
    setTime: (value: string) => {
      time = new Date(value);
    },
  };
}
const complete = (
  candidate: { candidateId: string; digest: string },
  patch: Record<string, unknown> = {},
): ProviderCompletionResult => ({
  message: {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: `inventory-call-${++key}`,
        name: "exact_inventory_action.select",
        arguments: JSON.stringify({ candidateId: candidate.candidateId, digest: candidate.digest, ...patch }),
      },
    ],
  },
  usage: null,
  model: { requestedModel: "fake", responseModel: "fake" },
});
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
const events = (body: string) =>
  body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) =>
      adventureTurnStreamEventSchema.parse(
        JSON.parse(
          frame
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6),
        ),
      ),
    );
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
async function select(f: ReturnType<typeof fixture>, action: string) {
  const turn = makeTurn(f, action),
    candidate = f.repo
      .generateAdventureInventoryCandidates("local-owner", turn.turnId)
      .find((value) => value.action === action)!;
  expect(candidate).toBeDefined();
  let tool: any;
  const result = await orchestrateAdventureTurn(
    f.repo,
    turn.turnId,
    deps(async (input) => {
      tool = input.tools?.find((value) => value.name === "exact_inventory_action.select");
      return complete(candidate);
    }),
  );
  expect(tool, JSON.stringify(result)).toBeDefined();
  expect(tool.parameters.required).toEqual(["candidateId", "digest"]);
  expect(JSON.stringify(tool.parameters)).not.toMatch(/entryId|itemId|revision|outcome/i);
  return { turn, candidate, result };
}

function withFeatures() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  return () => {
    delete process.env.FEATURE_RPG_CAMPAIGN;
    delete process.env.FEATURE_RPG_MECHANICS;
  };
}

describe("drop is a discard, and approved mechanics never strand a turn", () => {
  it.each(["I drop my Waylamp here.", "I leave the Waylamp on the floor and walk on", "Discard the Waylamp"])(
    "offers no gift candidate when the player drops an item: %s",
    (declaration) => {
      const f = fixture(),
        candidates = f.repo.generateAdventureInventoryCandidates("local-owner", makeTurn(f, declaration).turnId);
      expect(candidates.some((value) => value.action === "drop")).toBe(true);
      expect(candidates.some((value) => value.action === "gift")).toBe(false);
      f.repo.close();
    },
  );

  it("still offers a gift when the player gives the item to someone", () => {
    const f = fixture(),
      candidates = f.repo.generateAdventureInventoryCandidates(
        "local-owner",
        makeTurn(f, "I hand my Waylamp to Briar").turnId,
      );
    expect(candidates.some((value) => value.action === "gift")).toBe(true);
    f.repo.close();
  });

  it("never exposes a gift to the planner for a drop declaration", async () => {
    const f = fixture(),
      turn = makeTurn(f, "I drop my Waylamp here."),
      candidates = f.repo.generateAdventureInventoryCandidates("local-owner", turn.turnId),
      drop = candidates.find((value) => value.action === "drop")!;
    let tool: any;
    await orchestrateAdventureTurn(
      f.repo,
      turn.turnId,
      deps(async (input) => {
        tool ??= input.tools?.find((value) => value.name === "exact_inventory_action.select");
        return complete(drop);
      }),
    );
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool)).toContain(drop.candidateId);
    for (const gift of candidates.filter((value) => value.action === "gift"))
      expect(JSON.stringify(tool)).not.toContain(gift.candidateId);
    f.repo.close();
  });

  it("does not leave an approved turn in 'declared' when its mechanics can no longer commit", async () => {
    const restore = withFeatures();
    const f = fixture(),
      selected = await select(f, "drop"),
      proposal = selected.result.turn.toolCalls[0]!.proposal;
    // The item leaves the inventory while approval is pending, so the approved command can no longer execute.
    const mutator = f.repo;
    const snapshot = mutator.getActorInventorySnapshot("local-owner", f.campaign.id, f.source.actorId)!;
    const entry = snapshot.inventory.items[0]!;
    mutator.mutateInventoryForActor("local-owner", f.campaign.id, f.source.actorId, {
      kind: "drop",
      entryId: entry.entryId,
      item: entry.item,
      quantity: 1,
      expectedRevision: snapshot.revision,
      idempotencyKey: `stuck-remove-${++key}`,
    });
    const app = buildApp({ campaignRepositoryFactory: () => f.repo });
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/rpg/v1/adventure-turns/${selected.turn.turnId}/confirm`,
      headers: { "content-type": "application/json" },
      payload: {
        proposalIds: [proposal.proposalId],
        decision: "approve",
        expectedRevision: selected.result.turn.revision,
        idempotencyKey: `stuck-confirm-${++key}`,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    await app.close();
    const restarted = buildApp({
      campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(at) } }),
      adventureAgentDependencies: deps(async () => narration("You find your hands already empty.")),
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resumed = await restarted.inject({
        method: "POST",
        url: "/api/rpg/v1/adventure-turns/stream",
        headers: { "content-type": "application/json" },
        payload: { resumeToken: confirmed.json().resumeToken },
      });
      expect(events(resumed.body).at(-1)?.type).toBe("terminal");
    }
    const read = await restarted.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${selected.turn.turnId}` });
    expect(["completed", "failed", "cancelled"]).toContain(read.json().turn.state);
    expect(read.json().receipts).toHaveLength(0);
    await restarted.close();
    restore();
  });
});
