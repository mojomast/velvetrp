// Approved test from the round-5 playtest on a400fe7.
// After start-commands, with both sides still living and a current turn set,
// POST /combats/:id/end-commands returned 409 RPG_COMBAT_END_CONFLICT
// ("combat is not terminal"). A GM must be able to end a still-active fight
// so the encounter completes instead of staying stuck.
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { MECHANICS_STARTER_CATALOG, createRepository, createSession } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const scores: CharacterBuilderAttributeScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [
    key,
    CHARACTER_BUILDER_STANDARD_ARRAY[index],
  ]),
) as CharacterBuilderAttributeScores;

describe("GM can end a fight that is still active", () => {
  it("completes the encounter when endCombat is issued before either side is terminal", async () => {
    let sequence = 0;
    const repo = createRepository({
      dataDir: process.env.VELVET_DATA_DIR!,
      clock: { now: () => new Date(at) },
      ids: { nextId: () => `end-active-${++sequence}` },
      rng: { integer: (minimum) => minimum },
    });
    const campaign = repo.createCampaign("local-owner", { name: "End active combat" });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const persona = repo.createCharacter({
      name: "Aster",
      age: 31,
      archetype: "Warden",
      boundaries: "",
      fictionalConfirmed: true,
    });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, {
      personaId: persona.id,
      controllerPrincipalId: "local-owner",
      durability: "durable",
      allocation: { method: "standard-array", scores },
      idempotencyKey: "draft",
    });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: 0,
      idempotencyKey: "select",
      selections: {
        race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
        background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
        class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
        starterGrant: "kit",
      },
    } as any);
    const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: "final",
    }).receipt.actorId;
    const session = await createSession({ characterId: persona.id, title: "End active room" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const enemy = {
      kind: "enemy-template" as const,
      packId: MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
      definitionId: "velvet:mechanics:enemy-template:gloam-mite",
    };
    const created = repo.createEncounter("local-owner", campaign.id, {
      sessionId: session.id,
      name: "Mite ambush",
      combatants: [
        { kind: "actor", actorId, team: "allies" },
        { kind: "enemy", template: enemy, team: "enemies" },
      ],
      idempotencyKey: "prepare",
    });
    const combat = repo.startEncounter("local-owner", created.encounter.encounterId, {
      expectedRevision: 1,
      idempotencyKey: "start",
    }).combat;
    expect(combat.currentCombatant).not.toBeNull();
    const living = (combat.combatants ?? []).filter((c) => c.status === "active" || (c.hitPoints ?? 0) > 0);
    expect(living.some((c) => c.team === "allies" || c.kind === "actor")).toBe(true);
    expect(living.some((c) => c.team === "enemies" || c.kind === "enemy")).toBe(true);

    const ended = repo.endCombat("local-owner", combat.combatId, {
      expectedRevision: combat.revision,
      idempotencyKey: "end-early",
    });
    expect(ended.encounter).toMatchObject({ status: "completed", revision: combat.revision + 1 });
    expect(ended.encounter.campaignId).toBe(campaign.id);
    expect(
      repo.endCombat("local-owner", combat.combatId, {
        expectedRevision: combat.revision,
        idempotencyKey: "end-early",
      }),
    ).toEqual(ended);
  });
});
