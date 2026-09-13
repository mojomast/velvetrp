import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import type { EncounterDependencies } from "../src/repo/encounter/encounterWriteRepo.js";
import { resolveCombatArmorClassBonus } from "../src/repo/encounter/combatConditionRuntime.js";
import {
  claimReactionBudget,
  planDnd5eReadyAction,
  planHitTimeShield,
  readReactionBudget,
  readyActionFires,
  resolveHitTimeShield,
  selectReactionWindow,
  type BoundedReactionTrigger,
  type ReactionCandidate,
  type ReactionEvent,
} from "../src/repo/encounter/reaction/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2038-04-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function fixture(integer: (min: number, max: number) => number = (min) => min) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `window-${++sequence}` }, rng: { integer } });
  const campaign = repo.createCampaign(OWNER, { name: "Reaction Window" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Window Caster", age: 30, archetype: "Wizard", boundaries: "", fictionalConfirmed: true });
  const preparedSpells = ["srd-5.1:spell:magic-missile", "srd-5.1:spell:false-life", "srd-5.1:spell:shield"]
    .map((definitionId) => definitions.find((entry) => entry.reference.definitionId === definitionId)!.reference);
  const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: "caster-draft" }).draft.id,
    { expectedRevision: 0, idempotencyKey: "caster-base", selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference, background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:wizard")!.reference, starterGrant: "kit", preparedSpells } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "caster-final" }).receipt.actorId;
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run("window-session", persona.id, AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run("window-session", persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run("window-session", campaign.id, AT);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'health',12,12)").run(campaign.id, actorId);
  db.prepare("INSERT OR IGNORE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,'slot-1',2,2)").run(campaign.id, actorId);
  db.close();
  const goblin = definitions.find((entry) => entry.reference.definitionId === "srd-5.1:enemy-template:goblin")!.reference as never;
  const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId: "window-session", name: "Window",
    combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: goblin, team: "enemies" }], idempotencyKey: "prepare" });
  const started = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start" }).combat;
  const casterCombatant = started.combatants.find((entry: any) => entry.actorId === actorId)!.combatantId;
  const enemyCombatant = started.combatants.find((entry: any) => entry.kind === "enemy")!.combatantId;
  return { repo, campaign, actorId, combatId: started.combatId, casterCombatant, enemyCombatant };
}

function deps(sequenceStart = 0): EncounterDependencies {
  let sequence = sequenceStart;
  return { clock: { now: () => new Date(AT) }, ids: { nextId: () => `reaction-${++sequence}` }, rng: { integer: (min: number) => min } };
}

describe("generalized reaction trigger windows", () => {
  it("matches only the declared event, subject relation, hit guard, and reach bound", () => {
    const enemyTrigger: BoundedReactionTrigger = Object.freeze({ event: "leaves-reach", subject: "enemy" });
    const allyHit: BoundedReactionTrigger = Object.freeze({ event: "hit", subject: "ally", requiresHit: true });
    const selfHitReach: BoundedReactionTrigger = Object.freeze({ event: "hit", subject: "self", maxDistanceFeet: 30, requiresHit: true });
    const targeted: BoundedReactionTrigger = Object.freeze({ event: "targeted", subject: "self" });
    const candidates: ReactionCandidate[] = [
      { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies", source: "declared", responseKind: "maneuver", responseId: "opportunity-attack", trigger: enemyTrigger },
      { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies", source: "declared", responseKind: "maneuver", responseId: "protect-ally", trigger: allyHit },
      { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies", distanceFeet: 5, source: "declared", responseKind: "spell", responseId: "srd-5.1:spell:shield", trigger: selfHitReach },
      { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies", source: "declared", responseKind: "maneuver", responseId: "reactive-strike", trigger: targeted },
    ];
    const leavesReach: ReactionEvent = { kind: "leaves-reach", encounterId: "e", campaignId: "c", round: 1, occurredAt: AT, subjectCombatantId: "mover", sourceCombatantId: null };
    expect(selectReactionWindow(leavesReach, candidates).map((entry) => entry.responseId)).toEqual(["opportunity-attack"]);
    const hitOnSelf: ReactionEvent = { kind: "hit", encounterId: "e", campaignId: "c", round: 1, occurredAt: AT, subjectCombatantId: "reactor", sourceCombatantId: "attacker", hit: true };
    expect(selectReactionWindow(hitOnSelf, candidates).map((entry) => entry.responseId)).toEqual(["srd-5.1:spell:shield"]);
    const missedOnSelf: ReactionEvent = { ...hitOnSelf, hit: false };
    expect(selectReactionWindow(missedOnSelf, candidates)).toEqual([]);
    const turnStart: ReactionEvent = { kind: "turn-start", encounterId: "e", campaignId: "c", round: 1, occurredAt: AT, subjectCombatantId: "reactor", sourceCombatantId: null };
    expect(selectReactionWindow(turnStart, candidates)).toEqual([]);
    const targetedOnSelf: ReactionEvent = { kind: "targeted", encounterId: "e", campaignId: "c", round: 1, occurredAt: AT, subjectCombatantId: "reactor", sourceCombatantId: "caster" };
    expect(selectReactionWindow(targetedOnSelf, candidates).map((entry) => entry.responseId)).toEqual(["reactive-strike"]);
    const outOfReach: ReactionCandidate = { ...candidates[2]!, distanceFeet: 60 };
    expect(selectReactionWindow(hitOnSelf, [outOfReach])).toEqual([]);
    const readyPlan = planDnd5eReadyAction({ readyId: "ready-1", reactorCombatantId: "reactor", responseKind: "spell",
      responseId: "srd-5.1:spell:shield", trigger: { event: "hit", subject: "self", requiresHit: true }, round: 1, expiresAtRound: 2 });
    const readyCandidate: ReactionCandidate = { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies",
      distanceFeet: 5, source: "ready", readyId: readyPlan.ready!.readyId, responseKind: readyPlan.ready!.responseKind,
      responseId: readyPlan.ready!.responseId, trigger: readyPlan.ready!.trigger };
    expect(selectReactionWindow(hitOnSelf, [readyCandidate])[0]).toMatchObject({ source: "ready", readyId: "ready-1", responseId: "srd-5.1:spell:shield" });
  });

  it("bounds and expires a Ready action before it can fire as a reaction", () => {
    const legal = planDnd5eReadyAction({ readyId: "ready-1", reactorCombatantId: "reactor", responseKind: "spell",
      responseId: "srd-5.1:spell:shield", trigger: { event: "hit", subject: "self", maxDistanceFeet: 30 }, round: 2, expiresAtRound: 3 });
    expect(legal.legal).toBe(true);
    expect(legal.ready).not.toBeNull();
    expect(Object.isFrozen(legal.ready)).toBe(true);
    const unbounded = planDnd5eReadyAction({ readyId: "ready-2", reactorCombatantId: "reactor", responseKind: "spell",
      responseId: "srd-5.1:spell:shield", trigger: { event: "hit", subject: "self" }, round: 2, expiresAtRound: 99 });
    expect(unbounded.legal).toBe(false);
    expect(unbounded.ready).toBeNull();
    const trigger: BoundedReactionTrigger = legal.ready!.trigger;
    const event: ReactionEvent = { kind: "hit", encounterId: "e", campaignId: "c", round: 2, occurredAt: AT, subjectCombatantId: "reactor", sourceCombatantId: "attacker", hit: true };
    const context = { reactorCombatantId: "reactor", reactorTeam: "allies", subjectTeam: "enemies", distanceFeet: 5, round: 2 };
    expect(readyActionFires(legal.ready!, event, context, 2)).toBe(true);
    expect(readyActionFires(legal.ready!, event, context, 3)).toBe(true);
    expect(readyActionFires(legal.ready!, event, context, 4)).toBe(false);
    expect(trigger.event).toBe("hit");
  });

  it("applies the true hit-time Shield plan before a hit is finalized", () => {
    const converted = planHitTimeShield({ hit: true, critical: false, attackTotal: 15, armorClass: 13, reactionAvailable: true, slotAvailable: true });
    expect(converted).toMatchObject({ applies: true, reason: "applied", armorClass: 18, hit: false, critical: false });
    const stillHits = planHitTimeShield({ hit: true, critical: false, attackTotal: 18, armorClass: 13, reactionAvailable: true, slotAvailable: true });
    expect(stillHits).toMatchObject({ applies: true, armorClass: 18, hit: true });
    const critical = planHitTimeShield({ hit: true, critical: true, attackTotal: 15, armorClass: 13, reactionAvailable: true, slotAvailable: true });
    expect(critical).toMatchObject({ applies: true, hit: true, critical: true });
    const missed = planHitTimeShield({ hit: false, critical: false, attackTotal: 5, armorClass: 13, reactionAvailable: true, slotAvailable: true });
    expect(missed).toMatchObject({ applies: false, reason: "not-hit", hit: false });
    const unavailable = planHitTimeShield({ hit: true, critical: false, attackTotal: 15, armorClass: 13, reactionAvailable: false, slotAvailable: true });
    expect(unavailable).toMatchObject({ applies: false, reason: "unavailable", hit: true });
  });
});

describe("reaction budget and DB-backed reactions", () => {
  it("claims exactly one reaction per round and shares the marker across trigger kinds", () => {
    const { repo, combatId, casterCombatant } = fixture();
    try {
      const db = new DatabaseDriver(dbPath());
      expect(readReactionBudget(db, combatId, casterCombatant, 1).available).toBe(true);
      expect(claimReactionBudget(db, combatId, casterCombatant, 1, AT)).toBe(true);
      expect(claimReactionBudget(db, combatId, casterCombatant, 1, AT)).toBe(false);
      expect(readReactionBudget(db, combatId, casterCombatant, 1)).toMatchObject({ used: true, available: false, usedAt: AT });
      expect(claimReactionBudget(db, combatId, casterCombatant, 2, AT)).toBe(true);
      db.close();
    } finally {
      repo.close();
    }
  });

  it("spends reaction and slot for true hit-time Shield, raising AC against the triggering hit", () => {
    const { repo, campaign, actorId, combatId, casterCombatant } = fixture();
    try {
      const db = new DatabaseDriver(dbPath());
      const resolution = resolveHitTimeShield(db, deps(100), {
        encounterId: combatId, campaignId: campaign.id, round: 1, reactorCombatantId: casterCombatant,
        sourceCombatantId: "attacker", attackTotal: 15, armorClass: 13, hit: true, critical: false, occurredAt: AT,
      });
      expect(resolution).not.toBeNull();
      expect(resolution!.plan).toMatchObject({ applies: true, armorClass: 18, hit: false });
      expect(resolution!.receipt).toMatchObject({ event: "hit", reactorCombatantId: casterCombatant, responseKind: "spell", responseId: "srd-5.1:spell:shield", readiness: "declared" });
      expect(resolution!.receipt.outcome).toMatchObject({ hitBefore: true, hitAfter: false, attackTotal: 15, armorClassBefore: 13, armorClassAfter: 18, defenseBonus: 5 });
      expect(db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'").get(campaign.id, actorId)).toEqual({ current: 1 });
      expect(readReactionBudget(db, combatId, casterCombatant, 1).used).toBe(true);
      expect(resolveCombatArmorClassBonus(db, campaign.id, actorId, AT)).toBe(5);
      expect(resolveHitTimeShield(db, deps(200), {
        encounterId: combatId, campaignId: campaign.id, round: 1, reactorCombatantId: casterCombatant,
        sourceCombatantId: "attacker", attackTotal: 15, armorClass: 13, hit: true, critical: false, occurredAt: AT,
      })).toBeNull();
      db.close();
    } finally {
      repo.close();
    }
  });

  it("never spends a reaction or slot when the attack already missed", () => {
    const { repo, campaign, actorId, combatId, casterCombatant } = fixture();
    try {
      const db = new DatabaseDriver(dbPath());
      expect(resolveHitTimeShield(db, deps(300), {
        encounterId: combatId, campaignId: campaign.id, round: 1, reactorCombatantId: casterCombatant,
        sourceCombatantId: "attacker", attackTotal: 5, armorClass: 13, hit: false, critical: false, occurredAt: AT,
      })).toBeNull();
      expect(readReactionBudget(db, combatId, casterCombatant, 1).available).toBe(true);
      expect(db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='slot-1'").get(campaign.id, actorId)).toEqual({ current: 2 });
      db.close();
    } finally {
      repo.close();
    }
  });
});
