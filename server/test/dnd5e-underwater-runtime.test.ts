import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { combatantTerrains, underwaterDamageAdjustment } from "../src/repo/encounter/combatEnvironment.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2040-01-01T00:00:00.000Z";
const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, i) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never;
const rng = { integer: (min: number, max: number) => max === 21 ? 20 : min };

function reachHero(repo: ReturnType<typeof createRepository>, combat: any, heroCombatant: string) {
  let current = combat;
  for (let step = 0; step < 20 && current.currentCombatant !== heroCombatant; step += 1) {
    const acting = current.combatants.find((entry: any) => entry.combatantId === current.currentCombatant)!;
    current = acting.kind === "enemy"
      ? repo.executeCombatEnemyTurn(OWNER, current.combatId, { expectedRevision: current.revision, idempotencyKey: `enemy-${step}` }).combat
      : repo.resolveCombatAction(OWNER, current.combatId, { legalActionId: "end-turn", targetIds: [], choices: [] as [], expectedRevision: current.revision, idempotencyKey: `end-${step}` }).combat;
  }
  if (current.currentCombatant !== heroCombatant) throw new Error("could not reach the hero's turn");
  return current;
}

function fixture() {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `underwater-${++sequence}` }, rng });
  const campaign = repo.createCampaign(OWNER, { name: "Underwater" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Fighter Hero", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:fighter")!.reference,
    starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("underwater-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("underwater-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("underwater-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "underwater-session", name: "Underwater",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  const combat = reachHero(repo, started, heroCombatant);
  return { repo, campaign, actorId, sessionId: "underwater-session", combatId: combat.combatId as string, heroCombatant, enemyCombatant };
}

function openCombatDb() {
  return new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
}

function attack(repo: ReturnType<typeof createRepository>, combatId: string, target: string, key: string) {
  const state = repo.getCombatState(OWNER, combatId)!;
  const action: any = state.legalActions.find((candidate) => candidate.kind === "attack")!;
  return repo.resolveCombatAction(OWNER, combatId, { legalActionId: action.legalActionId, targetIds: [target], choices: [] as [], expectedRevision: state.revision, idempotencyKey: key }) as any;
}

function generateUnderwaterMap(f: ReturnType<typeof fixture>, key: string) {
  return f.repo.generateTacticalMapForSession(OWNER, f.campaign.id, f.sessionId, {
    mode: "combat", encounterId: f.combatId, kind: "underwater", seed: "velvet-underwater", width: 8, height: 8,
    tokens: [
      { tokenId: "underwater-hero-token", actorId: f.actorId, combatantId: f.heroCombatant, label: "Fighter Hero",
        position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false },
      { tokenId: "underwater-enemy-token", actorId: null, combatantId: f.enemyCombatant, label: "Goblin",
        position: { x: 2, y: 2 }, footprint: { width: 1, height: 1 }, disposition: "hostile", hidden: false },
    ], idempotencyKey: key,
  });
}

describe("SRD underwater combat runtime", () => {
  it("folds underwater fire resistance into a resolved damage adjustment without downgrading explicit results", () => {
    expect(underwaterDamageAdjustment("none", "fire", "water")).toBe("resistance");
    expect(underwaterDamageAdjustment("none", "fire", "floor")).toBe("none");
    expect(underwaterDamageAdjustment("none", "cold", "water")).toBe("none");
    expect(underwaterDamageAdjustment("immunity", "fire", "water")).toBe("immunity");
    expect(underwaterDamageAdjustment("vulnerability", "fire", "water")).toBe("vulnerability");
  });

  it("reads combatant immersion from the persisted underwater tactical map", () => {
    const f = fixture();
    generateUnderwaterMap(f, "immersion-map");
    const db = openCombatDb();
    try {
      const terrains = combatantTerrains(db, f.combatId, [f.heroCombatant, f.enemyCombatant]);
      expect(terrains.get(f.heroCombatant)).toBe("water");
      expect(terrains.get(f.enemyCombatant)).toBe("water");
    } finally { db.close(); f.repo.close(); }
  });

  it("imposes underwater melee disadvantage on a player attack from the persisted map", () => {
    const f = fixture();
    generateUnderwaterMap(f, "attack-map");
    const result = attack(f.repo, f.combatId, f.enemyCombatant, "underwater-attack");
    expect(result.resolution.outcomes[0].disadvantage).toBe(true);
    f.repo.close();
  });

  it("leaves a dry attack unaffected by the underwater rules", () => {
    const f = fixture();
    const result = attack(f.repo, f.combatId, f.enemyCombatant, "dry-attack");
    expect(result.resolution.outcomes[0].disadvantage).toBe(false);
    f.repo.close();
  });
});
