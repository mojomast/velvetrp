import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { applyCombatCondition } from "../src/repo/encounter/combatConditionRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2038-06-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;
let sequence = 0;

function fixture(integer: (min: number, max: number) => number = (min) => min) {
  const repo = createRepository({ clock: { now: () => new Date(AT) }, rng: { integer }, ids: { nextId: () => `action-${++sequence}` } });
  const campaign = repo.createCampaign(OWNER, { name: "Combat actions" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const makeActor = (name: string) => {
    const persona = repo.createCharacter({ name, age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: `${name}-draft` });
    const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: `${name}-base`, selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
      background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
    return { personaId: persona.id, actorId: repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: `${name}-final` }).receipt.actorId };
  };
  const hero = makeActor("Hero"), ally = makeActor("Ally");
  const sessionId = `action-session-${campaign.id}`;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId, hero.personaId, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0),(?,?,1)").run(sessionId, hero.personaId, sessionId, ally.personaId);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId, name: "Actions",
    combatants: [{ kind: "actor", actorId: hero.actorId, team: "allies" }, { kind: "actor", actorId: ally.actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  let combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = combat.combatants.find((entry: any) => entry.actorId === hero.actorId)!.combatantId;
  const allyCombatant = combat.combatants.find((entry: any) => entry.actorId === ally.actorId)!.combatantId;
  const enemyCombatant = combat.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  for (let step = 0; step < 20 && combat.currentCombatant !== heroCombatant; step += 1) {
    const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
  }
  expect(combat.currentCombatant).toBe(heroCombatant);
  return { repo, combatId: combat.combatId, heroCombatant, allyCombatant, enemyCombatant };
}

function resolve(repo: ReturnType<typeof createRepository>, combatId: string, kind: string, targetIds: string[], key: string) {
  const state = repo.getCombatState(OWNER, combatId)!;
  const plan = state.legalActions.find((action) => action.kind === kind)!;
  return repo.resolveCombatAction(OWNER, combatId, { legalActionId: plan.legalActionId, targetIds,
    choices: [] as [], expectedRevision: state.revision, idempotencyKey: key });
}

function applyGrappled(combatId: string, heroCombatant: string, enemyCombatant: string) {
  const db = new DatabaseDriver(dbPath());
  const commandId = (db.prepare("SELECT command_id FROM combat_commands_v27 WHERE encounter_id=? ORDER BY command_id LIMIT 1").get(combatId) as { command_id: string }).command_id;
  applyCombatCondition(db, combatId, heroCombatant, "grappled", enemyCombatant, commandId, null, AT);
  db.close();
}

describe("SRD 5.1 caller-planned combat actions", () => {
  it("resolves dash as a targetless, outcome-free action that keeps the turn", () => {
    const { repo, combatId, heroCombatant } = fixture();
    const before = repo.getCombatState(OWNER, combatId)!;
    const result = resolve(repo, combatId, "dash", [], "dash");
    expect(result.resolution).toMatchObject({ kind: "dash", targetIds: [], outcomes: [] });
    expect(result.combat.currentCombatant).toBe(heroCombatant);
    expect(result.combat.turnEconomy).toMatchObject({ action: { used: true },
      movement: { allowanceFeet: before.turnEconomy!.movement.allowanceFeet * 2 } });
    repo.close();
  });

  it("resolves disengage and hide as outcome-free actions", () => {
    const disengage = fixture();
    expect(resolve(disengage.repo, disengage.combatId, "disengage", [], "disengage").resolution)
      .toMatchObject({ kind: "disengage", targetIds: [], outcomes: [] });
    disengage.repo.close();
    const hide = fixture();
    expect(resolve(hide.repo, hide.combatId, "hide", [], "hide").resolution)
      .toMatchObject({ kind: "hide", targetIds: [], outcomes: [] });
    hide.repo.close();
  });

  it("resolves ready as an outcome-free action", () => {
    const { repo, combatId, heroCombatant } = fixture();
    const result = resolve(repo, combatId, "ready", [], "ready");
    expect(result.resolution).toMatchObject({ kind: "ready", targetIds: [], outcomes: [] });
    expect(result.combat.currentCombatant).toBe(heroCombatant);
    repo.close();
  });

  it("resolves help against an ally as a target-bound, outcome-free action", () => {
    const { repo, combatId, allyCombatant, heroCombatant } = fixture();
    const result = resolve(repo, combatId, "help", [allyCombatant], "help");
    expect(result.resolution).toMatchObject({ kind: "help", targetIds: [allyCombatant], outcomes: [] });
    expect(result.combat.currentCombatant).toBe(heroCombatant);
    repo.close();
  });

  it("resolves grapple and shove as bounded contests against the enemy", () => {
    const grapple = fixture();
    const grappleResult = resolve(grapple.repo, grapple.combatId, "grapple", [grapple.enemyCombatant], "grapple");
    expect(grappleResult.resolution).toMatchObject({ kind: "grapple", targetIds: [grapple.enemyCombatant] });
    expect(grappleResult.resolution.outcomes[0]).toMatchObject({ kind: "contest", contest: "grapple", targetId: grapple.enemyCombatant });
    grapple.repo.close();
    const shove = fixture();
    const shoveResult = resolve(shove.repo, shove.combatId, "shove", [shove.enemyCombatant], "shove");
    expect(shoveResult.resolution).toMatchObject({ kind: "shove", targetIds: [shove.enemyCombatant] });
    expect(shoveResult.resolution.outcomes[0]).toMatchObject({ kind: "contest", contest: "shove", targetId: shove.enemyCombatant });
    shove.repo.close();
  });

  it("resolves a failed grapple as a bounded contest instead of crashing", () => {
    const forced: number[] = [];
    const { repo, combatId, enemyCombatant } = fixture((min) => (forced.length ? forced.shift()! : min));
    forced.push(1, 20);
    const result = resolve(repo, combatId, "grapple", [enemyCombatant], "grapple-fail");
    expect(result.resolution.outcomes[0]).toMatchObject({ kind: "contest", contest: "grapple", success: false, targetId: enemyCombatant });
    repo.close();
  });

  it("resolves escape-grapple against the acting combatant while grappled", () => {
    const { repo, combatId, heroCombatant, enemyCombatant } = fixture();
    applyGrappled(combatId, heroCombatant, enemyCombatant);
    const result = resolve(repo, combatId, "escape-grapple", [heroCombatant], "escape");
    expect(result.resolution).toMatchObject({ kind: "escape-grapple", targetIds: [heroCombatant] });
    expect(result.resolution.outcomes[0]).toMatchObject({ kind: "contest", contest: "escape-grapple", targetId: heroCombatant });
    expect(result.combat.currentCombatant).toBe(heroCombatant);
    repo.close();
  });
});
