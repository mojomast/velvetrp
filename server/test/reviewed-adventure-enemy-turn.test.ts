import { afterEach, describe, expect, it } from "vitest";
import type { PrivateAdventureTurn } from "@velvet/contracts";
import { executeDeterministicEnemyFallback } from "../src/agent/adventureOrchestrator.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { createReviewedAdventure } from "./fixtures/reviewedAdventure.js";
import { cleanupTmpDataDirs, makeTmpDataDir } from "./helpers.js";

const OWNER = "local-owner";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  cleanupTmpDataDirs();
});

describe("reviewed adventure enemy-first combat", () => {
  it("resolves the D&D enemy turn instead of failing the enemy-owned adventure turn", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    process.env.FEATURE_RPG_COMBAT = "true";
    // The repo RNG is a queue: fixture creation drains nothing (minimum fallback), then the
    // initiative rolls/tiebreakers put the goblin first and the attack roll/damage land a hit.
    const draws: number[] = [];
    const rng = { integer: (minimum: number) => draws.shift() ?? minimum };
    const fixture = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false, rng });
    const repo = fixture.repo;
    try {
      const enemy = SRD_5_1_STARTER_CATALOG.definitions.find((definition) =>
        definition.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as {
          kind: "enemy-template"; packId: string; packVersion: string; definitionId: string;
        };
      draws.push(5, 0, 15, 0);
      const created = repo.createEncounter(OWNER, fixture.campaignId, { sessionId: fixture.sessionId, name: "Goblin Ambush",
        combatants: [{ kind: "actor", actorId: fixture.actorId, team: "allies" },
          { kind: "enemy", template: enemy, team: "enemies" }], idempotencyKey: "goblin-ambush-create" });
      const encounterId = created.encounter.encounterId;
      repo.startEncounter(OWNER, encounterId, { expectedRevision: created.receipt.revisionAfter, idempotencyKey: "goblin-ambush-start" });
      const started = repo.getCombatState(OWNER, encounterId)!;
      const goblinId = started.currentCombatant!;
      expect(started.combatants.find((combatant) => combatant.combatantId === goblinId)).toMatchObject({ kind: "enemy" });
      const actorCombatantId = started.combatants.find((combatant) => combatant.kind === "actor")!.combatantId;

      const campaign = repo.getCampaign(OWNER, fixture.campaignId)!;
      const administration = repo.getCampaignAdministration(OWNER, fixture.campaignId)!;
      const turn = repo.createAdventureTurn(OWNER, { campaignId: fixture.campaignId, timelineId: campaign.activeTimelineId,
        sessionId: fixture.sessionId, actorId: fixture.actorId, declaration: "I raise my longsword against the goblin.",
        expectedCampaignRevision: administration.revision, idempotencyKey: "enemy-first-turn" });
      const snapshot = repo.getCampaignAgentContextSnapshot(OWNER, fixture.campaignId, fixture.sessionId,
        { kind: "enemy", combatantId: goblinId });
      expect(snapshot?.ruleset?.id).toBe("dnd-5e");
      expect(snapshot?.encounter).toMatchObject({ currentCombatantId: goblinId, currentCombatantKind: "enemy" });

      draws.push(19, 3);
      executeDeterministicEnemyFallback(repo, snapshot!, turn.turnId);

      const after = repo.getCombatState(OWNER, encounterId)!;
      expect(after.revision).toBe(started.revision + 1);
      expect(after.currentCombatant).toBe(actorCombatantId);
      expect(after.combatants.find((combatant) => combatant.combatantId === actorCombatantId)?.hitPoints).toBe(7);

      const settled = repo.getAdventureTurn(OWNER, turn.turnId) as PrivateAdventureTurn;
      expect(settled.state).not.toBe("failed");
      expect(settled.narrationStatus).not.toBe("failed");
      expect(settled.receiptLinks).toHaveLength(1);
      const receipt = repo.getAgentCombatReceipt(OWNER, fixture.campaignId, settled.receiptLinks[0]!.commandId);
      expect(receipt?.resolution).toMatchObject({ kind: "attack", actingCombatantId: goblinId });
      const outcomes = (receipt?.resolution.outcomes ?? []) as Array<Record<string, unknown>>;
      expect(outcomes[0]).toMatchObject({ kind: "damage", applied: 5, hitPointsAfter: 7 });

      // The revision-independent fallback key makes a replay idempotent instead of failing the turn.
      executeDeterministicEnemyFallback(repo, snapshot!, turn.turnId);
      expect(repo.getCombatState(OWNER, encounterId)!.revision).toBe(after.revision);
    } finally {
      repo.close();
    }
  });
});
