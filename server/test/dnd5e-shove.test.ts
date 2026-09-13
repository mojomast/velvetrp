import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, createSession, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";

describe("SRD 5.1 shove", () => {
  it("knocks a target prone on a successful Athletics contest", async () => {
    let sequence = 0;
    const repo = createRepository({ clock: { now: () => new Date("2037-02-01T00:00:00.000Z") }, ids: { nextId: () => `shove-${++sequence}` },
      rng: { integer: (min: number, max: number) => max === 21 ? 20 : min } });
    const campaign = repo.createCampaign(OWNER, { name: "Shove" });
    repo.installSrdStarterCatalog(OWNER);
    repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const persona = repo.createCharacter({ name: "Shover", age: 30, archetype: "Shover", boundaries: "", fictionalConfirmed: true });
    const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
      allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: "shover-draft" }).draft.id,
      { expectedRevision: 0, idempotencyKey: "shover-base", selections: {
        race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
        class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
    const actor = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "shover-final" }).receipt.actorId;
    repo.mutateInventoryForActor(OWNER, campaign.id, actor, { kind: "equip", entryId: grantSrdEquipment(campaign.id, actor), slot: "hand", expectedRevision: 0, idempotencyKey: "shover-equip" });
    const session = await createSession({ characterIds: [persona.id], title: "Shove combat" });
    repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as never);
    const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
    const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: session.id, name: "Shove fight",
      combatants: [{ kind: "actor", actorId: actor, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
    let combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
    const actorCombatant = combat.combatants.find((entry: any) => entry.actorId === actor)!.combatantId;
    const enemyCombatant = combat.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
    for (let step = 0; step < 10 && combat.currentCombatant !== actorCombatant; step += 1) {
      const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
      combat = acting.kind === "enemy"
        ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
        : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
    }
    expect(combat.currentCombatant).toBe(actorCombatant);
    const shove = combat.legalActions.find((action: any) => action.kind === "shove" && action.targetIds.includes(enemyCombatant))!;
    expect(shove).toBeTruthy();
    const result = repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: shove.legalActionId, targetIds: [enemyCombatant], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: "shove" });
    expect(result.resolution).toMatchObject({ kind: "shove", targetIds: [enemyCombatant] });
    expect(result.resolution.outcomes[0]).toMatchObject({ kind: "contest", contest: "shove", success: true, condition: "prone" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT 1 FROM combat_conditions_v62 WHERE encounter_id=? AND combatant_id=? AND condition='prone'").get(combat.combatId, enemyCombatant)).toBeTruthy();
    db.close();
    repo.close();
  });
});
