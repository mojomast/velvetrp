import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { applyCombatCondition } from "../src/repo/encounter/combatConditionRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2038-04-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;

function fixture() {
  let sequence = 0;
  // Pin the RNG: the default crypto RNG can let the goblin win initiative and drop the hero
  // before their turn, which replaces the action set with a lone death save and removes stand-up.
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `stand-${++sequence}` }, rng: { integer: (minimum: number) => minimum } });
  const campaign = repo.createCampaign(OWNER, { name: "Stand up" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Standing Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "final" }).receipt.actorId;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("stand-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("stand-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("stand-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "stand-session", name: "Stand",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  let combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = combat.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = combat.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  for (let step = 0; step < 20 && combat.currentCombatant !== heroCombatant; step += 1) {
    const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
  }
  expect(combat.currentCombatant).toBe(heroCombatant);
  return { repo, actorId, combatId: combat.combatId, heroCombatant, enemyCombatant };
}

function knockProne(combatId: string, heroCombatant: string, enemyCombatant: string) {
  const db = new DatabaseDriver(dbPath());
  const commandId = (db.prepare("SELECT command_id FROM combat_commands_v27 WHERE encounter_id=? ORDER BY command_id LIMIT 1").get(combatId) as { command_id: string }).command_id;
  applyCombatCondition(db, combatId, heroCombatant, "prone", enemyCombatant, commandId, 1_000_000, AT);
  db.close();
}

describe("SRD 5.1 standing up from prone", () => {
  it("spends half speed, keeps the turn, and clears prone without using an action", () => {
    const { repo, combatId, heroCombatant, enemyCombatant } = fixture();
    let state = repo.getCombatState(OWNER, combatId)!;
    expect(state.legalActions.some((action) => action.kind === "stand-up")).toBe(false);
    knockProne(combatId, heroCombatant, enemyCombatant);
    state = repo.getCombatState(OWNER, combatId)!;
    const standUp = state.legalActions.find((action) => action.kind === "stand-up")!;
    expect(standUp).toMatchObject({ targetIds: [heroCombatant] });
    const allowance = state.turnEconomy!.movement.allowanceFeet;
    const cost = Math.floor(allowance / 2);
    const result = repo.resolveCombatAction(OWNER, combatId, { legalActionId: standUp.legalActionId, targetIds: [heroCombatant],
      choices: [] as [], expectedRevision: state.revision, idempotencyKey: "stand-up" });
    expect(result.resolution.outcomes).toEqual([{ kind: "stand-up", targetId: heroCombatant, movementCostFeet: cost }]);
    const after = result.combat;
    expect(after.currentCombatant).toBe(heroCombatant);
    expect(after.turnEconomy).toMatchObject({ action: { available: true }, movement: { usedFeet: cost } });
    expect((after.combatants.find((entry: any) => entry.combatantId === heroCombatant)!.conditions ?? []).some((condition: any) => condition.condition === "prone")).toBe(false);
    expect(after.legalActions.some((action) => action.kind === "stand-up")).toBe(false);
    repo.close();
  });

  it("rejects standing up without the prone condition", () => {
    const { repo, combatId, heroCombatant } = fixture();
    expect(() => repo.resolveCombatAction(OWNER, combatId, { legalActionId: "stand-up", targetIds: [heroCombatant], choices: [] as [],
      expectedRevision: repo.getCombatState(OWNER, combatId)!.revision, idempotencyKey: "illegal-stand-up" })).toThrow(/not legal/);
    repo.close();
  });
});
