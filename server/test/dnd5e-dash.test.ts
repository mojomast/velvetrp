import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2038-05-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;

function fixture() {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `dash-${++sequence}` } });
  const campaign = repo.createCampaign(OWNER, { name: "Dash" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Dashing Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "final" }).receipt.actorId;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("dash-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("dash-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("dash-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "dash-session", name: "Dash",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  let combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = combat.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  for (let step = 0; step < 20 && combat.currentCombatant !== heroCombatant; step += 1) {
    const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
  }
  expect(combat.currentCombatant).toBe(heroCombatant);
  return { repo, combatId: combat.combatId };
}

describe("SRD 5.1 Dash", () => {
  it("extends the persisted movement allowance by one speed and spends the action", () => {
    const { repo, combatId } = fixture();
    const state = repo.getCombatState(OWNER, combatId)!;
    const baseAllowance = state.turnEconomy!.movement.allowanceFeet;
    const dash = state.legalActions.find((action) => action.kind === "dash")!;
    expect(dash.targetIds).toEqual([]);
    const result = repo.resolveCombatAction(OWNER, combatId, { legalActionId: dash.legalActionId, targetIds: [], choices: [] as [],
      expectedRevision: state.revision, idempotencyKey: "dash" });
    expect(result.resolution.targetIds).toEqual([]);
    expect(result.resolution.outcomes).toEqual([]);
    expect(result.combat.turnEconomy).toMatchObject({ action: { used: true }, movement: { allowanceFeet: baseAllowance * 2, remainingFeet: baseAllowance * 2 } });
    expect(result.combat.currentCombatant).toBe(state.combatants.find((entry: any) => entry.combatantId === state.currentCombatant)!.combatantId);
    expect(result.combat.legalActions.some((action) => action.kind === "dash")).toBe(false);
    repo.close();
  });

  it("rejects a second dash in the same turn", () => {
    const { repo, combatId } = fixture();
    const state = repo.getCombatState(OWNER, combatId)!;
    const dash = state.legalActions.find((action) => action.kind === "dash")!;
    const first = repo.resolveCombatAction(OWNER, combatId, { legalActionId: dash.legalActionId, targetIds: [], choices: [] as [],
      expectedRevision: state.revision, idempotencyKey: "dash-one" });
    expect(() => repo.resolveCombatAction(OWNER, combatId, { legalActionId: dash.legalActionId, targetIds: [], choices: [] as [],
      expectedRevision: first.combat.revision, idempotencyKey: "dash-two" })).toThrow(/not legal/);
    repo.close();
  });
});
