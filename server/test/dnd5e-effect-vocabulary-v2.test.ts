import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { resolveEffect, tickOngoingEffect } from "../src/repo/encounter/effectHandlers/index.js";
import type { CombatPowerLegalAction, EffectContext, Row } from "../src/repo/encounter/effectHandlers/types.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2038-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

type Integer = (min: number, max: number) => number;

const utility = (effectId: string, label: string) => ({ type: "utility", effectId, label }) as const;
const failRider = utility("velvet:utility:fail", "Fail rider");
const successRider = utility("velvet:utility:success", "Success rider");

function fixture(integer: Integer) {
  let sequence = 0;
  const deps = { clock: { now: () => new Date(AT) }, ids: { nextId: () => `v2-${++sequence}` }, rng: { integer } };
  const repo = createRepository(deps);
  const campaign = repo.createCampaign(OWNER, { name: "Effect vocabulary v2" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const persona = repo.createCharacter({ name: "Caster", age: 30, archetype: "Wizard", boundaries: "", fictionalConfirmed: true });
  const base = repo.updateCharacterDraft(OWNER, repo.createCharacterDraft(OWNER, campaign.id, {
    personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as never },
    idempotencyKey: "caster-draft" }).draft.id,
    { expectedRevision: 0, idempotencyKey: "caster-base", selections: {
      race: definitions.find((entry) => entry.reference.kind === "race")!.reference,
      background: definitions.find((entry) => entry.reference.kind === "background")!.reference,
      class: definitions.find((entry) => entry.reference.definitionId === "srd-5.1:class:wizard")!.reference, starterGrant: "kit" } } as never);
  const actorId = repo.finalizeCharacterDraft(OWNER, base.draft.id, { expectedRevision: base.draft.revision, idempotencyKey: "caster-final" }).receipt.actorId;
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  const spell = definitions.find((entry) => entry.reference.kind === "spell")!.reference;
  return { repo, campaign, actorId, deps, db, spell };
}

function target(combatantId: string, actorId: string | null): Row {
  return { combatant_id: combatantId, actor_id: actorId, team: "allies", hit_points: 10, maximum_hit_points: 10, status: "active", state_revision: 0 };
}

function context(f: ReturnType<typeof fixture>, primary: Row): EffectContext {
  const quote = f.spell as { kind: "ability" | "spell"; packId: string; packVersion: string; definitionId: string };
  const definition = { reference: f.spell, name: "Synthetic Wave", description: "A synthetic v2 power.", tags: [],
    mechanics: { level: 0, actionCost: "action", range: 60, target: "enemy", concentration: false, effects: [] } } as never;
  const action: CombatPowerLegalAction = { legalActionId: "v2-action", encounterId: "v2-encounter", campaignId: f.campaign.id,
    actingCombatantId: primary.combatant_id, sourceActorId: f.actorId, targetCombatantId: primary.combatant_id,
    targetActorId: primary.actor_id, powerRef: quote, definition, cost: null };
  return { db: f.db, deps: f.deps, action, target: primary, dnd: true, at: AT, hp: primary.hit_points,
    outcomes: [], tempHitPointGrants: [], effects: [], rage: false, layOnHands: false };
}

const d20 = (value: number): Integer => (min, max) => max === 21 ? value : min;

describe("SRD 5.1 effect vocabulary v2 execution", () => {
  it("executes a utility no-op with an effectId and label outcome", () => {
    const f = fixture(d20(10));
    const ctx = context(f, target("v2-caster", f.actorId));
    resolveEffect(ctx, { type: "utility", effectId: "velvet:utility:dash", label: "Dash" }, "v2-power", [ctx.target]);
    expect(ctx.outcomes[0]).toMatchObject({ kind: "utility", effectId: "velvet:utility:dash", label: "Dash", applied: false });
    expect(ctx.outcomes[0].targetCombatantId).toBe("v2-caster");
    f.repo.close(); f.db.close();
  });

  it("computes push, pull, and teleport displacement as data without touching the map", () => {
    const f = fixture(d20(10));
    const ctx = context(f, target("v2-caster", f.actorId));
    resolveEffect(ctx, { type: "forced-movement", mode: "push", distanceFeet: 15 }, "v2-power", [ctx.target]);
    resolveEffect(ctx, { type: "forced-movement", mode: "pull", distanceFeet: 5 }, "v2-power", [ctx.target]);
    resolveEffect(ctx, { type: "forced-movement", mode: "teleport", distanceFeet: 30 }, "v2-power", [ctx.target]);
    expect(ctx.outcomes).toEqual([
      expect.objectContaining({ kind: "forced-movement", mode: "push", direction: "away-from-source", distanceFeet: 15, mutatesMap: false }),
      expect.objectContaining({ kind: "forced-movement", mode: "pull", direction: "toward-source", distanceFeet: 5, mutatesMap: false }),
      expect.objectContaining({ kind: "forced-movement", mode: "teleport", direction: "destination", distanceFeet: 30, mutatesMap: false }),
    ]);
    f.repo.close(); f.db.close();
  });

  it("resolves area-targeting against exactly the bounded provided target set", () => {
    const f = fixture(d20(10));
    const first = target("v2-a", f.actorId), second = target("v2-b", null);
    const ctx = context(f, first);
    const area = { type: "area-targeting", shape: "sphere", sizeFeet: 20, origin: "point", effects: [utility("velvet:utility:mark", "Mark")] } as const;
    resolveEffect(ctx, area, "v2-power", [second, first, second]);
    const marker = ctx.outcomes[0];
    expect(marker).toMatchObject({ kind: "area-targeting", shape: "sphere", sizeFeet: 20, origin: "point", targetCombatantIds: ["v2-b", "v2-a"] });
    expect(marker.outcomes).toHaveLength(2);
    expect(marker.outcomes[0].outcomes[0]).toMatchObject({ kind: "utility", effectId: "velvet:utility:mark", targetCombatantId: "v2-b" });
    expect(ctx.target).toBe(first);
    f.repo.close(); f.db.close();
  });

  it("rolls a save via injected dice and applies the onSuccess rider when it succeeds", () => {
    const f = fixture(d20(20));
    const ctx = context(f, target("v2-caster", f.actorId));
    resolveEffect(ctx, { type: "save-with-rider", ability: "dexterity", dc: 15, onFail: [failRider], onSuccess: [successRider] }, "v2-power", [ctx.target]);
    expect(ctx.outcomes[0]).toMatchObject({ kind: "save-with-rider", ability: "dexterity", dc: 15, saveRoll: 20, saveSuccess: true, applied: "onSuccess" });
    expect(ctx.outcomes[1]).toMatchObject({ kind: "utility", effectId: "velvet:utility:success" });
    f.repo.close(); f.db.close();
  });

  it("applies the onFail rider when the injected save fails", () => {
    const f = fixture(d20(1));
    const ctx = context(f, target("v2-caster", f.actorId));
    resolveEffect(ctx, { type: "save-with-rider", ability: "dexterity", dc: 15, onFail: [failRider], onSuccess: [successRider] }, "v2-power", [ctx.target]);
    expect(ctx.outcomes[0]).toMatchObject({ kind: "save-with-rider", saveRoll: 1, saveSuccess: false, applied: "onFail" });
    expect(ctx.outcomes[1]).toMatchObject({ kind: "utility", effectId: "velvet:utility:fail" });
    f.repo.close(); f.db.close();
  });

  it("applies onFail when no onSuccess rider is declared", () => {
    const f = fixture(d20(20));
    const ctx = context(f, target("v2-caster", f.actorId));
    resolveEffect(ctx, { type: "save-with-rider", ability: "wisdom", dc: 5, onFail: [failRider] }, "v2-power", [ctx.target]);
    expect(ctx.outcomes[0]).toMatchObject({ saveSuccess: true, applied: "onSuccess" });
    expect(ctx.outcomes).toHaveLength(1);
    f.repo.close(); f.db.close();
  });

  it("composes nested save-with-rider inside area-targeting recursively", () => {
    const f = fixture(d20(20));
    const first = target("v2-a", f.actorId), second = target("v2-b", f.actorId);
    const ctx = context(f, first);
    const area = { type: "area-targeting", shape: "cone", sizeFeet: 30, origin: "self",
      effects: [{ type: "save-with-rider", ability: "wisdom", dc: 14, onFail: [failRider], onSuccess: [successRider] }] } as const;
    resolveEffect(ctx, area, "v2-power", [first, second]);
    const marker = ctx.outcomes[0];
    expect(marker.targetCombatantIds).toEqual(["v2-a", "v2-b"]);
    expect(marker.outcomes[1].outcomes[0]).toMatchObject({ kind: "save-with-rider", saveSuccess: true, applied: "onSuccess" });
    expect(marker.outcomes[1].outcomes[1]).toMatchObject({ kind: "utility", effectId: "velvet:utility:success" });
    f.repo.close(); f.db.close();
  });

  it("persists an ongoing entry, applies its inner effect now, and ticks it deterministically", () => {
    const f = fixture(d20(1));
    const ctx = context(f, target("v2-caster", f.actorId));
    const ongoing = { type: "ongoing-effect", effect: utility("velvet:utility:burn", "Burn"), durationRounds: 2,
      timing: "start-of-turn", repeatSave: { ability: "constitution", dc: 10 } } as const;
    resolveEffect(ctx, ongoing, "v2-power", [ctx.target]);
    const created = ctx.outcomes[0];
    expect(created).toMatchObject({ kind: "ongoing-effect", timing: "start-of-turn", durationRounds: 2, remainingRounds: 2, appliedNow: true });
    expect(created.outcomes[0]).toMatchObject({ kind: "utility", effectId: "velvet:utility:burn" });
    const row = f.db.prepare("SELECT status,remaining_rounds FROM rpg_active_effects_v26 WHERE effect_id=?").get(created.ongoingId) as { status: string; remaining_rounds: number };
    expect(row).toEqual({ status: "active", remaining_rounds: 2 });

    const notDue = tickOngoingEffect(ctx, created.ongoingId, "end-of-turn");
    expect(notDue).toMatchObject({ applied: false, reason: "not-due", remainingBefore: 2, remainingAfter: 2, ended: false });

    const first = tickOngoingEffect(ctx, created.ongoingId, "start-of-turn");
    expect(first).toMatchObject({ applied: true, repeatSaveRoll: 1, repeatSaveSuccess: false, remainingBefore: 2, remainingAfter: 1, ended: false });
    expect(first.outcomes[0]).toMatchObject({ kind: "utility", effectId: "velvet:utility:burn" });

    const second = tickOngoingEffect(ctx, created.ongoingId, "start-of-turn");
    expect(second).toMatchObject({ applied: true, remainingBefore: 1, remainingAfter: 0, ended: true });
    expect(f.db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE effect_id=?").get(created.ongoingId)).toEqual({ status: "removed" });

    expect(() => tickOngoingEffect(ctx, created.ongoingId, "start-of-turn")).toThrow("ongoing effect is unavailable");
    f.repo.close(); f.db.close();
  });

  it("ends an ongoing entry early when the repeat save succeeds", () => {
    const f = fixture(d20(20));
    const ctx = context(f, target("v2-caster", f.actorId));
    const ongoing = { type: "ongoing-effect", effect: utility("velvet:utility:bind", "Bind"), durationRounds: 5,
      timing: "end-of-turn", repeatSave: { ability: "strength", dc: 12 } } as const;
    resolveEffect(ctx, ongoing, "v2-power", [ctx.target]);
    const created = ctx.outcomes[0];
    const tick = tickOngoingEffect(ctx, created.ongoingId, "end-of-turn");
    expect(tick).toMatchObject({ applied: true, repeatSaveSuccess: true, ended: true, remainingAfter: 0 });
    expect(f.db.prepare("SELECT status FROM rpg_active_effects_v26 WHERE effect_id=?").get(created.ongoingId)).toEqual({ status: "removed" });
    f.repo.close(); f.db.close();
  });

  it("requires an actor-backed target for ongoing effects", () => {
    const f = fixture(d20(10));
    const ctx = context(f, target("v2-enemy", null));
    expect(() => resolveEffect(ctx, { type: "ongoing-effect", effect: utility("velvet:utility:burn", "Burn"), durationRounds: 1, timing: "start-of-turn" }, "v2-power", [ctx.target]))
      .toThrow("ongoing effects require an actor-backed target");
    f.repo.close(); f.db.close();
  });

  it("rejects malformed input for every v2 kind before mutating state", () => {
    const f = fixture(d20(10));
    const ctx = context(f, target("v2-caster", f.actorId));
    const malformed = [
      { type: "utility", effectId: "bad id", label: "Dash" },
      { type: "forced-movement", mode: "push" },
      { type: "area-targeting", shape: "sphere", sizeFeet: 20, origin: "point", effects: [] },
      { type: "save-with-rider", ability: "dexterity", dc: 41, onFail: [failRider] },
      { type: "ongoing-effect", effect: utility("velvet:utility:burn", "Burn"), durationRounds: 101, timing: "start-of-turn" },
      { type: "telekinesis" },
    ];
    for (const effect of malformed) {
      expect(() => resolveEffect(ctx, effect, "v2-power", [ctx.target])).toThrow("effect definition is malformed");
    }
    expect(ctx.outcomes).toEqual([]);
    f.repo.close(); f.db.close();
  });
});
