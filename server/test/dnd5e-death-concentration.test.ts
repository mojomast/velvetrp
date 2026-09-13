import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import {
  dnd5eStabilizationRollMode, planDnd5eConcentrationEnd, planDnd5eConcentrationEnvironment,
  planDnd5eDeathSave, planDnd5eDyingDamage, planDnd5eHealingEndsDying, planDnd5eMassiveDamage,
  planDnd5eStabilization,
} from "../src/rulesets/dnd5e.js";
import { applyCombatCondition } from "../src/repo/encounter/combatConditionRuntime.js";
import { dndDamageStatus } from "../src/repo/encounter/actionExecution/survival.js";
import { endConcentrationOnCondition, dropConcentration, resolveConcentrationEnvironmentSave } from "../src/repo/encounter/concentration/concentrationRuntime.js";
import { resolveDeathSave, resolveStabilization } from "../src/repo/encounter/death/dyingRuntime.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2036-03-01T00:00:00.000Z";
const SCORES = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
  .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
let sequence = 0;

describe("SRD 5.1 death and dying completion", () => {
  it("computes massive damage only when leftover damage reaches the hit point maximum", () => {
    expect(planDnd5eMassiveDamage({ hitPointsBefore: 10, hitPointDamage: 20, maximumHitPoints: 10 })).toBe(true);
    expect(planDnd5eMassiveDamage({ hitPointsBefore: 10, hitPointDamage: 19, maximumHitPoints: 10 })).toBe(false);
    expect(planDnd5eMassiveDamage({ hitPointsBefore: 10, hitPointDamage: 10, maximumHitPoints: 10 })).toBe(false);
    expect(planDnd5eMassiveDamage({ hitPointsBefore: 10, hitPointDamage: 5, maximumHitPoints: 10 })).toBe(false);
    expect(planDnd5eMassiveDamage({ hitPointsBefore: 0, hitPointDamage: 50, maximumHitPoints: 10 })).toBe(false);
  });

  it("resolves every death saving throw edge case deterministically", () => {
    expect(planDnd5eDeathSave({ roll: 20, successes: 2, failures: 1 }))
      .toMatchObject({ roll: 20, successes: 0, failures: 0, status: "active", regainsHitPoints: 1, stable: false });
    expect(planDnd5eDeathSave({ roll: 1, successes: 0, failures: 0 }))
      .toMatchObject({ failures: 2, successes: 0, status: "unconscious" });
    expect(planDnd5eDeathSave({ roll: 1, successes: 0, failures: 2 }))
      .toMatchObject({ failures: 3, status: "dead" });
    expect(planDnd5eDeathSave({ roll: 5, successes: 0, failures: 0 }))
      .toMatchObject({ failures: 1, status: "unconscious" });
    expect(planDnd5eDeathSave({ roll: 10, successes: 0, failures: 0 }))
      .toMatchObject({ successes: 1, status: "unconscious" });
    expect(planDnd5eDeathSave({ roll: 19, successes: 2, failures: 0 }))
      .toMatchObject({ successes: 3, status: "stable", stable: true });
    expect(() => planDnd5eDeathSave({ roll: 0, successes: 0, failures: 0 })).toThrow();
    expect(() => planDnd5eDeathSave({ roll: 21, successes: 0, failures: 0 })).toThrow();
    expect(() => planDnd5eDeathSave({ roll: 10.5, successes: 0, failures: 0 })).toThrow();
  });

  it("routes dropping to zero, massive damage, and at-zero damage through the dying plan", () => {
    expect(planDnd5eDyingDamage({ actorBacked: false, hitPointsBefore: 4, hitPointsAfter: 0, maximumHitPoints: 4,
      hitPointDamage: 4, currentStatus: "active" })).toMatchObject({ status: "defeated", massiveDamage: false });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 12, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 12, currentStatus: "active" })).toMatchObject({ status: "unconscious", massiveDamage: false, successes: 0, failures: 0 });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 12, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 24, currentStatus: "active" })).toMatchObject({ status: "dead", massiveDamage: true });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 0, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 1, currentStatus: "unconscious", failures: 0 })).toMatchObject({ status: "unconscious", failures: 1, failuresAdded: 1 });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 0, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 1, currentStatus: "unconscious", failures: 1, critical: true, withinFiveFeet: true }))
      .toMatchObject({ status: "dead", failures: 3, failuresAdded: 2, stable: false });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 0, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 1, currentStatus: "unconscious", failures: 0, critical: true, withinFiveFeet: false }))
      .toMatchObject({ failures: 1, failuresAdded: 1 });
    expect(planDnd5eDyingDamage({ actorBacked: true, hitPointsBefore: 0, hitPointsAfter: 0, maximumHitPoints: 12,
      hitPointDamage: 1, currentStatus: "stable", successes: 2, stable: true }))
      .toMatchObject({ status: "unconscious", failures: 1, stable: false });
  });

  it("ends the dying state on healing but never revives the dead", () => {
    expect(planDnd5eHealingEndsDying({ hitPointsBefore: 0, hitPointsAfter: 6, currentStatus: "unconscious" }))
      .toEqual({ status: "active", endsDying: true });
    expect(planDnd5eHealingEndsDying({ hitPointsBefore: 0, hitPointsAfter: 6, currentStatus: "dead" }))
      .toEqual({ status: "dead", endsDying: false });
    expect(planDnd5eHealingEndsDying({ hitPointsBefore: 5, hitPointsAfter: 9, currentStatus: "active" }))
      .toEqual({ status: "active", endsDying: false });
  });

  it("models stabilization as a bounded DC 10 Wisdom (Medicine) check with kit and assistance", () => {
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: false, targetStable: false }))
      .toMatchObject({ required: false, stabilized: false });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: true }))
      .toMatchObject({ required: false, stabilized: true });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false, healerKit: true }))
      .toMatchObject({ required: false, dc: null, stabilized: true, healerKit: true });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false }))
      .toMatchObject({ required: true, dc: 10, stabilized: false });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false,
      checkInput: { rolls: [20], wisdomScore: 14 } }))
      .toMatchObject({ required: true, dc: 10, stabilized: true, check: { kind: "skill-check", ability: "wisdom", skill: "medicine", total: 22 } });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false,
      checkInput: { rolls: [1], wisdomScore: 10 } })).toMatchObject({ stabilized: false, check: { total: 1 } });
  });

  it("applies assistance advantage and ranged disadvantage without stacking them", () => {
    expect(dnd5eStabilizationRollMode({ assisted: true })).toBe("advantage");
    expect(dnd5eStabilizationRollMode({ ranged: true })).toBe("disadvantage");
    expect(dnd5eStabilizationRollMode({ assisted: true, ranged: true })).toBe("normal");
    expect(dnd5eStabilizationRollMode({})).toBe("normal");
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false, assisted: true,
      checkInput: { rolls: [3, 18], wisdomScore: 14 } })).toMatchObject({ rollMode: "advantage", stabilized: true });
    expect(planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: false, ranged: true,
      checkInput: { rolls: [18, 3], wisdomScore: 14 } })).toMatchObject({ rollMode: "disadvantage", stabilized: false });
  });

  it("persists massive damage, at-zero failures, and injected death saves", () => {
    const f = encounterFixture(() => 1);
    const db = new DatabaseDriver(dbPath());
    const combatant = db.prepare("SELECT maximum_hit_points FROM combatant WHERE encounter_id=? AND combatant_id=?")
      .get(f.combatId, f.actorCombatant) as { maximum_hit_points: number };
    const target = { actor_id: f.actorId, encounter_id: f.combatId, combatant_id: f.actorCombatant,
      hit_points: combatant.maximum_hit_points, maximum_hit_points: combatant.maximum_hit_points, status: "active" };
    const survivalRow = () => db.prepare("SELECT successes,failures,stable FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?")
      .get(f.combatId, f.actorCombatant) as { successes: number; failures: number; stable: number } | undefined;
    expect(dndDamageStatus(db, target, 0, combatant.maximum_hit_points * 2)).toBe("dead");
    expect(survivalRow()).toMatchObject({ failures: 3 });
    db.prepare("DELETE FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").run(f.combatId, f.actorCombatant);
    expect(dndDamageStatus(db, { ...target, hit_points: 0, status: "unconscious" }, 0, 1, { critical: true, withinFiveFeet: true }))
      .toBe("unconscious");
    expect(survivalRow()).toMatchObject({ failures: 2 });
    expect(dndDamageStatus(db, { ...target, hit_points: 0, status: "unconscious" }, 0, 1)).toBe("dead");
    expect(survivalRow()).toMatchObject({ failures: 3 });
    db.close();

    const deps = { clock: { now: () => new Date(AT) }, ids: { nextId: () => `death-save-${++sequence}` }, rng: { integer: () => 20 } };
    const db2 = new DatabaseDriver(dbPath());
    const save = db2.transaction(() => resolveDeathSave(db2, deps, { encounterId: f.combatId, combatantId: f.actorCombatant,
      hitPoints: 0, status: "unconscious" }))();
    expect(save).toMatchObject({ roll: 20, statusAfter: "active", hitPointsAfter: 1 });
    db2.close();
    f.repo.close();
  });

  it("persists a stabilized check through the Medicine skill", () => {
    const f = encounterFixture(() => 20);
    const db = new DatabaseDriver(dbPath());
    const deps = { clock: { now: () => new Date(AT) }, ids: { nextId: () => `stabilize-${++sequence}` }, rng: { integer: () => 20 } };
    const result = db.transaction(() => resolveStabilization(db, deps, { campaignId: f.campaign.id, encounterId: f.combatId,
      stabilizerActorId: f.actorId, targetCombatantId: f.actorCombatant, targetStatus: "unconscious" }))();
    expect(result).toMatchObject({ stabilized: true, statusAfter: "stable", rollMode: "normal" });
    expect(db.prepare("SELECT stable FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?")
      .get(f.combatId, f.actorCombatant)).toEqual({ stable: 1 });
    db.close();
    f.repo.close();
  });
});

describe("SRD 5.1 concentration completion", () => {
  it("ends concentration for incapacitation, death, zero hit points, or a failed save", () => {
    expect(planDnd5eConcentrationEnd({ dropped: true })).toEqual({ ends: true, reason: "dropped", condition: null });
    expect(planDnd5eConcentrationEnd({ saveFailed: true })).toEqual({ ends: true, reason: "save-failed", condition: null });
    expect(planDnd5eConcentrationEnd({ status: "dead" })).toEqual({ ends: true, reason: "dead", condition: null });
    expect(planDnd5eConcentrationEnd({ hitPoints: 0 })).toEqual({ ends: true, reason: "zero-hit-points", condition: null });
    for (const condition of ["incapacitated", "stunned", "paralyzed", "petrified", "unconscious"] as const) {
      expect(planDnd5eConcentrationEnd({ conditions: [condition] }))
        .toEqual({ ends: true, reason: "incapacitated", condition });
    }
    expect(planDnd5eConcentrationEnd({ conditions: ["prone", "poisoned"], status: "active", hitPoints: 8 }))
      .toEqual({ ends: false, reason: null, condition: null });
  });

  it("resolves an explicit environmental DC through an injected Constitution save", () => {
    expect(planDnd5eConcentrationEnvironment(15, false)).toEqual({ required: false, dc: null, broken: false });
    expect(planDnd5eConcentrationEnvironment(15, true)).toEqual({ required: true, dc: 15, broken: false });
    expect(planDnd5eConcentrationEnvironment(15, true, { rolls: [20], constitutionScore: 10 }))
      .toMatchObject({ required: true, dc: 15, broken: false, check: { kind: "concentration-check", total: 20 } });
    expect(planDnd5eConcentrationEnvironment(25, true, { rolls: [1], constitutionScore: 10 }))
      .toMatchObject({ required: true, dc: 25, broken: true });
    expect(() => planDnd5eConcentrationEnvironment(0, true)).toThrow();
  });

  it("drops concentration as a bounded caster action and records the lifecycle", () => {
    const f = baseFixture(() => 1);
    applyConcentrationEffect(f, 0, "focus");
    const db = new DatabaseDriver(dbPath());
    const ended = db.transaction(() => dropConcentration(db, { nextId: () => `drop-${++sequence}` },
      { campaignId: f.campaign.id, actorId: f.actorId, at: AT }))();
    expect(ended).toMatchObject({ reason: "dropped" });
    expect(db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, f.actorId)).toEqual({ status: "removed" });
    expect(db.prepare("SELECT lifecycle_kind FROM rpg_effect_lifecycle_events_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, f.actorId)).toEqual({ lifecycle_kind: "removed" });
    db.close();
    f.repo.close();
  });

  it("keeps concentration on a successful explicit save and ends it on a failed one", () => {
    const f = baseFixture(() => 1);
    applyConcentrationEffect(f, 0, "focus");
    const db = new DatabaseDriver(dbPath());
    const kept = db.transaction(() => resolveConcentrationEnvironmentSave(db, { nextId: () => `save-${++sequence}` },
      { integer: () => 20 }, { campaignId: f.campaign.id, actorId: f.actorId, at: AT, dc: 15 }))();
    expect(kept).toMatchObject({ dc: 15, maintained: true, broken: false, total: 20 });
    expect(db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, f.actorId)).toEqual({ status: "active" });
    const broken = db.transaction(() => resolveConcentrationEnvironmentSave(db, { nextId: () => `save-${++sequence}` },
      { integer: () => 1 }, { campaignId: f.campaign.id, actorId: f.actorId, at: AT, dc: 15 }))();
    expect(broken).toMatchObject({ maintained: false, broken: true, total: 1 });
    expect(db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, f.actorId)).toEqual({ status: "removed" });
    db.close();
    f.repo.close();
  });

  it("ends concentration when an incapacitating condition lands on the concentrating combatant", () => {
    const f = encounterFixture(() => 1);
    applyConcentrationEffect(f, 0, "focus");
    const db = new DatabaseDriver(dbPath());
    db.prepare(`INSERT INTO combat_commands_v27(encounter_id,command_id,actor_id,command_type,idempotency_key,
      canonical_request_json,request_digest,expected_revision,resulting_revision,created_at)
      VALUES(?,?,NULL,'resolve_action',?,'{}',?,1000,1001,?)`)
      .run(f.combatId, "stun-command", "stun-command", "0".repeat(64), AT);
    applyCombatCondition(db, f.combatId, f.actorCombatant, "stunned", f.actorCombatant, "stun-command", null, AT);
    const round = (db.prepare("SELECT round_number FROM encounter WHERE encounter_id=?").get(f.combatId) as { round_number: number }).round_number;
    const ended = db.transaction(() => endConcentrationOnCondition(db, { nextId: () => `condition-${++sequence}` },
      { campaignId: f.campaign.id, actorId: f.actorId, encounterId: f.combatId, combatantId: f.actorCombatant, round, at: AT }))();
    expect(ended).toMatchObject({ reason: "incapacitated", condition: "stunned" });
    expect(db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=?")
      .get(f.campaign.id, f.actorId)).toEqual({ status: "removed" });
    db.close();
    f.repo.close();
  });
});

function baseFixture(integer: (min: number, max: number) => number) {
  const repo = createRepository({ clock: { now: () => new Date(AT) }, rng: { integer }, ids: { nextId: () => `dc-${++sequence}` } });
  const campaign = repo.createCampaign("local-owner", { name: "Death and concentration" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: `pins-${++sequence}` });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Dying Hero", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
    durability: "durable", allocation: { method: "standard-array", scores: SCORES }, idempotencyKey: `draft-${++sequence}` });
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `select-${++sequence}`,
    selections: { race: definitions.find((entry) => entry.reference.kind === "race")!.reference as never,
      background: definitions.find((entry) => entry.reference.kind === "background")!.reference as never,
      class: definitions.find((entry) => entry.reference.kind === "class")!.reference as never, starterGrant: "kit" } as never });
  const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `final-${++sequence}` }).receipt.actorId;
  const sessionId = `dc-session-${++sequence}`;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId, persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId, persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, AT);
  db.prepare("INSERT OR REPLACE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'health',12,12)").run(campaign.id, actorId);
  const sheet = (db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaign.id, actorId) as { sheet_id: string }).sheet_id;
  db.prepare("INSERT OR REPLACE INTO rpg_character_attributes(campaign_id,sheet_id,position,attribute_id,value) VALUES(?,?,60,'wisdom',14)").run(campaign.id, sheet);
  db.prepare("INSERT OR IGNORE INTO rpg_character_proficiencies(campaign_id,sheet_id,position,category,proficiency_id) VALUES(?,?,61,'skill','medicine')").run(campaign.id, sheet);
  db.close();
  return { repo, campaign, actorId, sessionId };
}

function encounterFixture(integer: (min: number, max: number) => number) {
  const f = baseFixture(integer);
  const template = MECHANICS_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "enemy-template")!.reference as never;
  const prepared = f.repo.createEncounter("local-owner", f.campaign.id, { sessionId: f.sessionId, name: "Dying",
    combatants: [{ kind: "actor", actorId: f.actorId, team: "allies" }, { kind: "enemy", template, team: "enemies" }],
    idempotencyKey: `encounter-${++sequence}` });
  const combat = f.repo.startEncounter("local-owner", prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: `start-${++sequence}` }).combat;
  return { ...f, combatId: combat.combatId, actorCombatant: combat.combatants.find((entry: any) => entry.actorId === f.actorId)!.combatantId };
}

function applyConcentrationEffect(f: ReturnType<typeof baseFixture>, revision: number, key: string) {
  return f.repo.mutateActorEffect("local-owner", f.actorId, { kind: "apply", effect: { source: null,
    modifiers: [{ kind: "flat", appliesToId: "defense", amount: 1 }], duration: { kind: "until_removed" }, recovery: "none",
    stacking: { kind: "concentration", concentrationId: "power-concentration" } }, expectedRevision: revision, idempotencyKey: key });
}
