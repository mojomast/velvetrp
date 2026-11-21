// Approved tests from the HAM-4 diagnosis on ed5f105.
// After starting a Quick beetle fight and resolving the enemy's turn, the current
// combatant was an actor (Orra Staple) and GET reported a fresh revision, but
// POST skip-turn-commands still returned 409 RPG_SKIP_TURN_CONFLICT
// "Turn cannot be skipped in its current state" — not the stale-revision problem.
// A GM must be able to skip that actor's turn.
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { getRepositoryDatabase } from "../src/repo/repoContext.js";
import { createCombatTurnClockRepository } from "../src/repo/encounter/combatTurnClock.js";
import { useTmpDataDir } from "./helpers.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";

useTmpDataDir();

describe("GM skip of a current actor turn", () => {
  it("skips the current actor after an enemy turn has already been resolved", async () => {
    let sequence = 0;
    const options = {
      clock: { now: () => new Date("2036-01-01T00:00:00.000Z") },
      ids: { nextId: () => `skip-${++sequence}` },
      rng: {
        integer: (min: number, max: number) => (max === 21 ? 20 : min),
      },
    };
    const repo = createRepository(options);
    const campaign = repo.createCampaign("local-owner", { name: "Skip turn" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const persona = repo.createCharacter({
      name: "Hero",
      age: 30,
      archetype: "Fighter",
      boundaries: "",
      fictionalConfirmed: true,
    });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, {
      personaId: persona.id,
      controllerPrincipalId: "local-owner",
      durability: "durable",
      allocation: {
        method: "standard-array",
        scores: Object.fromEntries(
          SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]]),
        ) as any,
      },
      idempotencyKey: "draft",
    });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: 0,
      idempotencyKey: "select",
      selections: {
        race: definitions.find((d) => d.reference.kind === "race")!.reference,
        background: definitions.find((d) => d.reference.kind === "background")!.reference,
        class: definitions.find((d) => d.reference.kind === "class")!.reference,
        starterGrant: "kit",
      },
    } as any);
    const actor = repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: "final",
    }).receipt.actorId;
    repo.mutateInventoryForActor("local-owner", campaign.id, actor, {
      kind: "equip",
      entryId: grantSrdEquipment(campaign.id, actor),
      slot: "hand",
      expectedRevision: 0,
      idempotencyKey: "equip",
    });
    const session = await createSession({ characterId: persona.id, title: "Combat" });
    repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
    const template = definitions.find((d) => d.reference.definitionId === "srd-5.1:enemy-template:goblin")!
      .reference as any;
    const prepared = repo.createEncounter("local-owner", campaign.id, {
      sessionId: session.id,
      name: "Fight",
      combatants: [
        { kind: "actor", actorId: actor, team: "allies" },
        { kind: "enemy", template, team: "enemies" },
      ],
      idempotencyKey: "prepare",
    });
    let combat = repo.startEncounter("local-owner", prepared.encounter.encounterId, {
      expectedRevision: 1,
      idempotencyKey: "start",
    }).combat;

    for (let step = 0; step < 6; step += 1) {
      const current = combat.combatants.find((c) => c.combatantId === combat.currentCombatant);
      if (current?.kind === "actor") break;
      combat = repo.executeCombatEnemyTurn("local-owner", combat.combatId, {
        expectedRevision: combat.revision,
        idempotencyKey: `enemy-${step}`,
      }).combat;
    }
    const current = combat.combatants.find((c) => c.combatantId === combat.currentCombatant);
    expect(current?.kind).toBe("actor");

    const clock = createCombatTurnClockRepository(getRepositoryDatabase(), options);
    const skipped = clock.skipCurrentTurn("local-owner", combat.combatId, {
      expectedRevision: combat.revision,
      idempotencyKey: "skip-actor",
    });
    expect(skipped.revision).toBe(combat.revision + 1);
    expect(skipped.currentCombatant).not.toBe(combat.currentCombatant);
    repo.close();
  });
});
