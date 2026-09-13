import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { applyCombatCondition } from "../src/repo/encounter/combatConditionRuntime.js";
import { readRiderUsageThisTurn, resolveAttackRiders, type AttackRider } from "../src/repo/encounter/riders/index.js";
import { resolveSrdEquipment } from "../src/repo/srdEquipmentRuntime.js";
import { DND_5E_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner", AT = "2039-06-01T00:00:00.000Z";
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

function fixture(className: "Rogue" | "Paladin" | "Fighter") {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `rider-${++sequence}` }, rng });
  const campaign = repo.createCampaign(OWNER, { name: "Riders" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: `${className} Hero`, age: 30, archetype: className, boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const base = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
    background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
    class: definitions.find((entry) => entry.reference.definitionId === `srd-5.1:class:${className.toLowerCase()}`)!.reference,
    starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "final" }).receipt.actorId;
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("rider-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("rider-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("rider-session", campaign.id, AT);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "rider-session", name: "Riders",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const heroCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  const combat = reachHero(repo, started, heroCombatant);
  const commandDb = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  const firstCommandId = (commandDb.prepare("SELECT command_id FROM combat_commands_v27 WHERE encounter_id=? ORDER BY resulting_revision LIMIT 1").get(combat.combatId) as { command_id: string }).command_id;
  commandDb.close();
  return { repo, campaign, actorId, combatId: combat.combatId, heroCombatant, enemyCombatant, firstCommandId };
}

function grantKnownPower(campaignId: string, actorId: string, definitionId: string) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const character = db.prepare("SELECT campaign_character_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId, actorId) as { campaign_character_id: string };
  const definition = SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "ability" && entry.reference.definitionId === definitionId);
  const packId = definition?.reference.packId ?? SRD_5_1_STARTER_CATALOG.manifest.packId;
  const packVersion = definition?.reference.packVersion ?? SRD_5_1_STARTER_CATALOG.manifest.packVersion;
  db.prepare(`INSERT INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at)
    VALUES(?,?,?,?,?,?,NULL,NULL,?)`).run(character.campaign_character_id, "ability", packId, packVersion, definitionId, 1, AT);
  db.close();
}

function makeProne(combatId: string, enemyCombatant: string, commandId: string) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  applyCombatCondition(db, combatId, enemyCombatant, "prone", enemyCombatant, commandId, null, AT);
  db.close();
}

function baseRawDamage(campaignId: string, actorId: string, critical: boolean) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  const actor = db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId, actorId) as { sheet_id: string };
  const equipment = resolveSrdEquipment(db, campaignId, actorId);
  const weapon = equipment.weapon;
  const unarmed = weapon === null;
  const ability = unarmed ? "strength" : weapon.attackAbility;
  const score = (db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?").get(campaignId, actor.sheet_id, ability) as { value: number }).value;
  db.close();
  const die = unarmed ? { count: 0, sides: 4 } : weapon.damage.die;
  const modifier = Math.floor((score - 10) / 2) + (unarmed ? 1 : 0);
  return die.count * (critical ? 2 : 1) + modifier;
}

function attack(repo: ReturnType<typeof createRepository>, combatId: string, target: string, key: string) {
  const state = repo.getCombatState(OWNER, combatId)!;
  const action: any = state.legalActions.find((candidate) => candidate.kind === "attack")!;
  return repo.resolveCombatAction(OWNER, combatId, { legalActionId: action.legalActionId, targetIds: [target], choices: [] as [], expectedRevision: state.revision, idempotencyKey: key }) as any;
}

const damageRider: AttackRider = Object.freeze({
  riderId: "test-bonus", label: "Test Bonus",
  source: Object.freeze({ kind: "ability", packId: "p", packVersion: "1", definitionId: "test:bonus" }),
  limit: "once-per-attack",
  damage: Object.freeze({ damageType: "radiant", dice: Object.freeze([Object.freeze({ count: 1, sides: 6 })]) }),
});

describe("declarative on-hit riders", () => {
  it("advertises the rider extension through the damage capability", () => {
    expect(DND_5E_RULESET_DESCRIPTOR.capabilities?.find((capability) => capability.id === "damage"))
      .toEqual({ id: "damage", version: "1.3.0", status: "partial" });
  });

  it("only resolves on a hit and honors advantage and per-attack limits", () => {
    const riders: readonly AttackRider[] = [damageRider,
      { ...damageRider, riderId: "advantage-only", requiresAdvantage: true },
      { ...damageRider, riderId: "once-turn", limit: "once-per-turn" }];
    const base = { hit: true, critical: false, advantage: false, usedThisTurn: new Set<string>(), usedThisAttack: new Set<string>() };
    expect(resolveAttackRiders(riders, { ...base, hit: false }, rng)).toEqual([]);
    expect(resolveAttackRiders(riders, base, rng).map((rider) => rider.riderId)).toEqual(["test-bonus", "once-turn"]);
    expect(resolveAttackRiders(riders, { ...base, advantage: true }, rng).map((rider) => rider.riderId)).toEqual(["test-bonus", "advantage-only", "once-turn"]);
    expect(resolveAttackRiders(riders, { ...base, usedThisTurn: new Set(["once-turn"]) }, rng).map((rider) => rider.riderId)).toEqual(["test-bonus"]);
    expect(resolveAttackRiders(riders, { ...base, usedThisAttack: new Set(["test-bonus"]) }, rng).map((rider) => rider.riderId)).toEqual(["once-turn"]);
  });

  it("doubles rider dice on a critical hit only when the rider allows it", () => {
    const base = { hit: true, advantage: true, usedThisTurn: new Set<string>(), usedThisAttack: new Set<string>() };
    const critical = resolveAttackRiders([damageRider], { ...base, critical: true }, rng)[0]!;
    expect(critical.damage).toMatchObject({ damageType: "radiant", critical: true, damage: 2 });
    expect(critical.damage!.rolls).toEqual([1, 1]);
    const flat = resolveAttackRiders([{ ...damageRider, damage: { ...damageRider.damage!, doubling: "none" } }], { ...base, critical: true }, rng)[0]!;
    expect(flat.damage).toMatchObject({ critical: false, damage: 1 });
    expect(flat.damage!.rolls).toEqual([1]);
  });

  it("carries a resolved condition and triggered sub-effect on the rider resolution", () => {
    const conditionRider: AttackRider = Object.freeze({
      riderId: "knockdown", label: "Knockdown",
      source: Object.freeze({ kind: "ability", packId: "p", packVersion: "1", definitionId: "test:knockdown" }),
      condition: Object.freeze({ condition: "prone" }),
      effect: Object.freeze({ kind: "prone", label: "target knocked prone" }),
    });
    const resolved = resolveAttackRiders([conditionRider], { hit: true, critical: false, advantage: false, usedThisTurn: new Set(), usedThisAttack: new Set() }, rng)[0]!;
    expect(resolved.condition).toEqual({ condition: "prone" });
    expect(resolved.effect).toEqual({ kind: "prone", label: "target knocked prone" });
  });

  it("resolves Rogue Sneak Attack as a crit-doubled on-hit rider", () => {
    const f = fixture("Rogue");
    makeProne(f.combatId, f.enemyCombatant, f.firstCommandId);
    const result = attack(f.repo, f.combatId, f.enemyCombatant, "sneak");
    const outcome = result.resolution.outcomes[0];
    const rider = (result.riders ?? []).find((entry: any) => entry.riderId === "sneak-attack");
    expect(rider).toMatchObject({ label: "Sneak Attack", damage: { damageType: "physical", critical: true } });
    expect(rider.damage.dice).toEqual([{ count: 1, sides: 6 }]);
    expect(rider.damage.rolls).toEqual([1, 1]);
    expect(rider.damage.damage).toBe(2);
    expect(outcome.critical).toBe(true);
    expect(outcome.requested).toBe(baseRawDamage(f.campaign.id, f.actorId, true) + 2);
    expect(outcome.applied).toBe(Math.min(result.resolution.outcomes[0].hitPointsBefore, outcome.requested));
    expect(readRiderUsageThisTurn(new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")), f.combatId, f.heroCombatant).has("sneak-attack")).toBe(true);
    f.repo.close();
  });

  it("resolves a Divine Smite-style radiant rider and folds its damage into the outcome", () => {
    const f = fixture("Paladin");
    grantKnownPower(f.campaign.id, f.actorId, "srd-5.1:ability:paladin-divine-smite");
    const result = attack(f.repo, f.combatId, f.enemyCombatant, "smite");
    const outcome = result.resolution.outcomes[0];
    const rider = (result.riders ?? []).find((entry: any) => entry.riderId === "divine-smite");
    expect(rider).toMatchObject({ label: "Divine Smite", damage: { damageType: "radiant", critical: true } });
    expect(rider.damage.dice).toEqual([{ count: 2, sides: 8 }]);
    expect(rider.damage.rolls).toHaveLength(4);
    expect(rider.damage.damage).toBe(4);
    expect(outcome.requested).toBe(baseRawDamage(f.campaign.id, f.actorId, true) + 4);
    f.repo.close();
  });

  it("applies a rider condition with exact source attribution", () => {
    const f = fixture("Fighter");
    grantKnownPower(f.campaign.id, f.actorId, "srd-5.1:ability:wolf-knockdown");
    const result = attack(f.repo, f.combatId, f.enemyCombatant, "knockdown");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const condition = db.prepare(`SELECT condition,source_combatant_id,source_command_id FROM combat_conditions_v62
      WHERE encounter_id=? AND combatant_id=? AND condition='prone' AND source_combatant_id=?`)
      .get(f.combatId, f.enemyCombatant, f.heroCombatant) as { condition: string; source_combatant_id: string; source_command_id: string } | undefined;
    db.close();
    expect(condition).toMatchObject({ condition: "prone", source_combatant_id: f.heroCombatant, source_command_id: result.receipt.commandId });
    f.repo.close();
  });
});
