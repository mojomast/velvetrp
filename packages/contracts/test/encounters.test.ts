import { describe, expect, expectTypeOf, it } from "vitest";
import {
  combatActionCommandSchema, combatLogEntrySchema, createEncounterCommandSchema, encounterCommandSchema,
  enemyInstanceSchema, legalCombatActionAllowlistSchema, rewardBundleSchema, type CombatActionCommand,
} from "../src/encounters.js";

const time = "2026-08-05T12:00:00.000Z";
const mutation = { campaignId: "campaign", encounterId: "encounter", expectedRevision: 0, idempotencyKey: "key-1" };

describe("M1.7 encounter contracts", () => {
  it("closes encounter mutations and requires concurrency keys and timestamps", () => {
    const create = {
      ...mutation,
      type: "create_encounter",
      sessionId: "session",
      kind: "improvised",
      enemySpawns: [],
      createdAt: time,
    } as const;
    expect(encounterCommandSchema.parse(create)).toEqual(create);
    for (const invalid of [
      { ...create, expectedRevision: -1 }, { ...create, idempotencyKey: "" },
      { ...create, createdAt: "tomorrow" }, { ...create, hp: 12 },
      { ...mutation, type: "resolve_initiative", resolvedAt: time, initiative: 20 },
    ]) expect(encounterCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires a session and kind, and accepts only catalog-pinned enemy spawn intents", () => {
    const spawn = {
      enemyInstanceId: "goblin-1",
      template: { kind: "enemy-template", packId: "starter", packVersion: "1.0.0", definitionId: "goblin" },
      tactic: { kind: "deterministic_fallback", tacticId: "focus-lowest-id" },
    } as const;
    const create = {
      ...mutation,
      type: "create_encounter",
      sessionId: "session",
      kind: "prepared",
      enemySpawns: [spawn],
      createdAt: time,
    } as const;
    expect(createEncounterCommandSchema.parse(create)).toEqual(create);
    for (const invalid of [
      { ...create, sessionId: "" },
      { ...create, kind: "generated" },
      { ...create, enemySpawns: [{ ...spawn, hp: 12 }] },
      { ...create, enemySpawns: [{ ...spawn, initiative: 20 }] },
      { ...create, enemySpawns: [{ ...spawn, resolvedAt: time }] },
      { ...create, enemySpawns: [spawn, spawn] },
    ]) expect(createEncounterCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts only the six strict action variants without caller mechanics", () => {
    const base = { ...mutation, actionId: "action", combatantId: "fighter", submittedAt: time };
    const actions = [
      { ...base, type: "attack", attackId: "sword", targetCombatantId: "goblin" },
      { ...base, type: "power", powerId: "smite", targetCombatantId: "goblin" },
      { ...base, type: "item", inventoryEntryId: "potion", targetCombatantId: null },
      { ...base, type: "defend" }, { ...base, type: "flee" }, { ...base, type: "end-turn" },
    ] as const;
    actions.forEach((action) => expect(combatActionCommandSchema.parse(action)).toEqual(action));
    for (const invalid of [
      { ...actions[0], type: "cast" }, { ...actions[0], damage: 10 }, { ...actions[0], modifiers: [] },
      { ...actions[0], legal: true }, { ...actions[0], initiative: 99 },
    ]) expect(combatActionCommandSchema.safeParse(invalid).success).toBe(false);
  });

  it("uses bounded, strict server projections for tactics, allowlists, logs, and rewards", () => {
    expect(enemyInstanceSchema.parse({
      campaignId: "campaign", encounterId: "encounter", enemyInstanceId: "goblin-1",
      template: { kind: "enemy-template", packId: "starter", packVersion: "1.0.0", definitionId: "goblin" },
      tactic: { kind: "deterministic_fallback", tacticId: "focus-lowest-id" }, spawnedAt: time,
    }).tactic.kind).toBe("deterministic_fallback");
    expect(enemyInstanceSchema.safeParse({ campaignId: "campaign", encounterId: "encounter", enemyInstanceId: "x", template: {}, tactic: { kind: "script", code: "x" }, spawnedAt: time }).success).toBe(false);
    expect(legalCombatActionAllowlistSchema.safeParse({ ...mutation, combatantId: "fighter", revision: 0, issuedAt: time, actions: [] }).success).toBe(false);
    expect(combatLogEntrySchema.safeParse({ logEntryId: "log", campaignId: "campaign", encounterId: "encounter", sequence: 0, occurredAt: time, event: { kind: "encounter_created" } }).success).toBe(false);
    expect(rewardBundleSchema.safeParse({ rewardBundleId: "rewards", campaignId: "campaign", encounterId: "encounter", createdAt: time, rewards: [{ kind: "experience", amount: 0 }] }).success).toBe(false);
    expect(rewardBundleSchema.safeParse({ rewardBundleId: "rewards", campaignId: "campaign", encounterId: "encounter", createdAt: time, rewards: [{ kind: "experience", amount: 10 }], rules: {} }).success).toBe(false);
  });

  it("publishes the closed action union", () => {
    expectTypeOf<CombatActionCommand["type"]>().toEqualTypeOf<"attack" | "power" | "item" | "defend" | "flee" | "end-turn">();
  });
});
