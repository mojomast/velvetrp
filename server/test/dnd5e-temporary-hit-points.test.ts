import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { buildCombatPowerLegalActions } from "../src/repo/encounter/combatPowerRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2037-04-01T00:00:00.000Z";

function fixture(integer: (min: number, max: number) => number) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `templhp-${++sequence}` }, rng: { integer } });
  const campaign = repo.createCampaign(OWNER, { name: "Temporary HP" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Caster", age: 30, archetype: "Wizard", boundaries: "", fictionalConfirmed: true });
  const preparedSpells = ["srd-5.1:spell:magic-missile", "srd-5.1:spell:false-life"]
    .map((definitionId) => definitions.find((entry) => entry.reference.definitionId === definitionId)!.reference);
  const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: "caster-draft" }).draft.id,
    { expectedRevision: 0, idempotencyKey: "caster-base", selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:wizard")!.reference, starterGrant: "kit", preparedSpells } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "caster-final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("templhp-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("templhp-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("templhp-session", campaign.id, AT);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'health',12,12)").run(campaign.id, actorId);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'slot-1',2,2)").run(campaign.id, actorId);
  db.close();
  return { repo, campaign, actorId };
}

function reachCaster(repo: ReturnType<typeof createRepository>, combat: any, targetCombatantId: string) {
  let current = combat;
  for (let step = 0; step < 20 && current.currentCombatant !== targetCombatantId; step += 1) {
    const acting = current.combatants.find((entry: any) => entry.combatantId === current.currentCombatant)!;
    current = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (current.currentCombatant !== targetCombatantId) throw new Error("could not reach the caster's turn");
  return current;
}

function prepare(integer: (min: number, max: number) => number) {
  const { repo, campaign, actorId } = fixture(integer);
  const goblin = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "templhp-session", name: "Temp HP",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const casterCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  return { repo, campaign, actorId, started, casterCombatant, enemyCombatant, combat: reachCaster(repo, started, casterCombatant) };
}

function castFalseLife(integer: (min: number, max: number) => number) {
  const state = prepare(integer);
  const { repo, campaign, actorId, combat, casterCombatant, enemyCombatant } = state;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const action = buildCombatPowerLegalActions(db, OWNER, combat.combatId).find((candidate) => candidate.definition.name === "False Life")!;
  expect(action).toBeTruthy();
  expect(action.targetCombatantId).toBe(casterCombatant);
  const readRevision = (family: "m15" | "m16", actor: string) => (db.prepare(`SELECT revision FROM rpg_${family}_mutation_revisions_v${family === "m15" ? "25" : "26"} WHERE campaign_id=? AND actor_id=?`).get(campaign.id, actor) as any)?.revision ?? 0;
  const sourceM15 = readRevision("m15", actorId);
  const sourceM16 = readRevision("m16", actorId);
  const targetM15 = action.targetActorId ? readRevision("m15", action.targetActorId) : null;
  const targetM16 = action.targetActorId ? readRevision("m16", action.targetActorId) : null;
  db.close();
  const result = repo.useCombatPower(OWNER, { legalActionId: action.legalActionId, powerRef: action.powerRef, targetCombatantId: action.targetCombatantId,
    expectedCombatRevision: combat.revision, expectedSourceM15Revision: sourceM15, expectedSourceM16Revision: sourceM16,
    expectedTargetM15Revision: targetM15, expectedTargetM16Revision: targetM16, idempotencyKey: "cast-false-life" });
  return { ...state, result };
}

describe("SRD 5.1 temporary hit points", () => {
  it("grants a non-stacking pool from False Life and projects it on the combatant", () => {
    const { repo, result, combat, casterCombatant } = castFalseLife((min, max) => max === 21 ? 20 : min);
    const outcome = result.outcomes[0];
    expect(outcome).toMatchObject({ kind: "temporary-hit-points", requested: 5, granted: 5, before: 0, after: 5 });
    const state = repo.getCombatState(OWNER, combat.combatId)!;
    expect(state.combatants.find((entry: any) => entry.combatantId === casterCombatant)?.temporaryHitPoints).toBe(5);
    repo.close();
  });

  it("absorbs enemy damage with the pool before the caster's hit points", () => {
    const { repo, result, combat, casterCombatant, enemyCombatant } = castFalseLife((min, max) => max === 21 ? 20 : min);
    const pool = result.outcomes[0].after as number;
    const state = repo.getCombatState(OWNER, combat.combatId)!;
    let current = state;
    if (current.currentCombatant !== enemyCombatant) {
      current = repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "to-enemy" }).combat;
    }
    expect(current.currentCombatant).toBe(enemyCombatant);
    const beforeHp = current.combatants.find((entry: any) => entry.combatantId === casterCombatant)!.hitPoints;
    const after = repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: "enemy-turn" }).combat;
    const casterAfter = after.combatants.find((entry: any) => entry.combatantId === casterCombatant)!;
    expect(casterAfter.hitPoints).toBe(beforeHp);
    expect(casterAfter.temporaryHitPoints ?? 0).toBeLessThan(pool);
    repo.close();
  });
});
