import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2038-06-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;

/** Builds a durable encounter whose current turn is the Goblin, with a chosen RNG. */
function fixture(integer: (min: number, max: number) => number) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `multi-${++sequence}` }, rng: { integer } });
  const campaign = repo.createCampaign(OWNER, { name: "Monster multiattack" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Target", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "multi-draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "multi-base", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "multi-final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("multi-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("multi-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("multi-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "multi-session", name: "Multiattack",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const actorCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  return { repo, campaign, actorId, combatId: started.combatId, actorCombatant, enemyCombatant, started };
}

function reachEnemyTurn(repo: ReturnType<typeof createRepository>, started: any, enemyCombatant: string) {
  let combat = started;
  for (let step = 0; step < 20 && combat.currentCombatant !== enemyCombatant; step += 1) {
    const acting = combat.combatants.find((entry: any) => entry.combatantId === combat.currentCombatant)!;
    combat = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, combat.combatId, { expectedRevision: combat.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (combat.currentCombatant !== enemyCombatant) throw new Error("could not reach the enemy turn");
  return combat;
}

describe("durable SRD monster multiattack", () => {
  it("resolves the Goblin's two-scimitar multiattack as one ordered outcome per step", () => {
    // Every d20 is a natural 20 and every damage die is a 1, so both steps hit and crit.
    const { repo, combatId, actorCombatant, enemyCombatant, started } = fixture((min, max) => max === 21 ? 20 : min);
    const combat = reachEnemyTurn(repo, started, enemyCombatant);
    const result = repo.executeCombatEnemyTurn(OWNER, combatId, { expectedRevision: combat.revision, idempotencyKey: "multi-enemy" });
    const outcomes = (result.resolution as any).outcomes;
    expect(result.resolution.kind).toBe("attack");
    expect(result.resolution.targetIds).toEqual([actorCombatant]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome: any) => outcome.kind === "damage" && outcome.hit && outcome.critical)).toBe(true);
    // Two crits of 2d6+2 each: the second outcome continues from the first's hit points.
    expect(outcomes[0].hitPointsBefore).toBeGreaterThan(outcomes[1].hitPointsBefore);
    expect(outcomes[1].hitPointsBefore).toBe(outcomes[0].hitPointsAfter);
    expect(outcomes[1].applied).toBe(outcomes[0].hitPointsAfter - outcomes[1].hitPointsAfter);
    repo.close();
  });

  it("stops the sequence once the target is defeated and is idempotent on replay", () => {
    // Natural 20 to hit, maximum damage dice, so the first attack already kills.
    const { repo, combatId, enemyCombatant, started } = fixture((min, max) => max === 21 ? 20 : max - 1);
    const combat = reachEnemyTurn(repo, started, enemyCombatant);
    const result = repo.executeCombatEnemyTurn(OWNER, combatId, { expectedRevision: combat.revision, idempotencyKey: "multi-replay" });
    const outcomes = (result.resolution as any).outcomes;
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes.length).toBeLessThanOrEqual(2);
    const final = outcomes[outcomes.length - 1];
    expect(["unconscious", "dead", "defeated"]).toContain(final.statusAfter);
    const replay = repo.executeCombatEnemyTurn(OWNER, combatId, { expectedRevision: combat.revision, idempotencyKey: "multi-replay" });
    expect(replay).toEqual(result);
    repo.close();
  });
});
