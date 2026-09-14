import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2038-07-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;

/** A durable encounter with a Wizard (knows Shield) and a Goblin, current turn = the Wizard. */
function fixture(integer: (min: number, max: number) => number = (min) => min) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `ready-${++sequence}` }, rng: { integer } });
  const campaign = repo.createCampaign(OWNER, { name: "Ready action" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Caster", age: 30, archetype: "Wizard", boundaries: "", fictionalConfirmed: true });
  const preparedSpells = ["srd-5.1:spell:magic-missile", "srd-5.1:spell:shield"]
    .map((definitionId) => definitions.find((entry) => entry.reference.definitionId === definitionId)!.reference);
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "ready-draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "ready-base", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:wizard")!.reference, starterGrant: "kit", preparedSpells } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "ready-final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("ready-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("ready-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("ready-session", campaign.id, AT);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'health',12,12)").run(campaign.id, actorId);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'slot-1',2,2)").run(campaign.id, actorId);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "ready-session", name: "Ready",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const casterCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  return { repo, campaign, actorId, combatId: started.combatId, casterCombatant, enemyCombatant, started };
}

function reach(repo: ReturnType<typeof createRepository>, combat: any, combatantId: string) {
  let current = combat;
  for (let step = 0; step < 20 && current.currentCombatant !== combatantId; step += 1) {
    const acting = current.combatants.find((entry: any) => entry.combatantId === current.currentCombatant)!;
    current = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (current.currentCombatant !== combatantId) throw new Error("could not reach the requested turn");
  return current;
}

describe("durable SRD ready action", () => {
  it("declares a bounded ready action, spends the action, and projects it", () => {
    const { repo, combatId, casterCombatant, started } = fixture();
    const combat = reach(repo, started, casterCombatant);
    const result = repo.resolveCombatAction(OWNER, combatId, { legalActionId: "ready", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: "ready-declare" });
    expect(result.resolution.kind).toBe("ready");
    const ready = (result.combat as any).readyActions;
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ combatantId: casterCombatant, responseKind: "spell", responseId: "srd-5.1:spell:shield",
      trigger: { event: "hit", subject: "self", requiresHit: true } });
    // The action is spent and the turn is kept.
    expect(result.combat.turnEconomy).toMatchObject({ combatantId: casterCombatant, action: { used: true } });
    expect(result.combat.currentCombatant).toBe(casterCombatant);
    repo.close();
  });

  it("fires the readied Shield at the true hit-time window and consumes it", () => {
    const { repo, campaign, actorId, combatId, casterCombatant, enemyCombatant, started } = fixture((min, max) => max === 21 ? 10 : min);
    const combat = reach(repo, started, casterCombatant);
    repo.resolveCombatAction(OWNER, combatId, { legalActionId: "ready", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: "ready-declare" });
    // End the caster turn so the Goblin attacks; the readied Shield fires on the hit.
    const toEnemy = repo.resolveCombatAction(OWNER, combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: repo.getCombatState(OWNER, combatId)!.revision, idempotencyKey: "to-enemy" }).combat;
    expect(toEnemy.currentCombatant).toBe(enemyCombatant);
    const enemy = repo.executeCombatEnemyTurn(OWNER, combatId, { expectedRevision: toEnemy.revision, idempotencyKey: "enemy-turn" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    try {
      // The readied declaration is consumed and the slot is spent.
      expect(db.prepare("SELECT count(*) count FROM combat_ready_actions_v66 WHERE encounter_id=?").get(combatId)).toEqual({ count: 0 });
      expect(db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'").get(campaign.id, actorId)).toEqual({ current: 1 });
    } finally { db.close(); }
    expect(enemy.resolution.kind).toBe("attack");
    repo.close();
  });

  it("expires an unused ready action at the start of the readying combatant's next turn", () => {
    const { repo, combatId, casterCombatant, enemyCombatant, started } = fixture();
    const combat = reach(repo, started, casterCombatant);
    repo.resolveCombatAction(OWNER, combatId, { legalActionId: "ready", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: "ready-declare" });
    // Cycle through the enemy and back to the caster; the ready action expires.
    let current = repo.getCombatState(OWNER, combatId)!;
    current = repo.resolveCombatAction(OWNER, combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: "to-enemy" }).combat;
    expect(current.currentCombatant).toBe(enemyCombatant);
    current = repo.executeCombatEnemyTurn(OWNER, combatId, { expectedRevision: current.revision, idempotencyKey: "enemy-turn" }).combat;
    expect(current.currentCombatant).toBe(casterCombatant);
    expect((current as any).readyActions).toEqual([]);
    repo.close();
  });
});
