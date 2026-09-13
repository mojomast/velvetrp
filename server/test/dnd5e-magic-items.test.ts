import { describe, expect, it } from "vitest";
import {
  MAGIC_ITEM_ATTUNEMENT_LIMIT,
  attuneItem,
  attunementKeys,
  createAttunementState,
  createChargeState,
  dropAttunement,
  evaluateMagicItemAction,
  isAttuned,
  planDerivedValues,
  planGrantedPowers,
  rechargeCharges,
  resolveGrantedPower,
  rollChargeRecharge,
  serializeAttunementState,
  spendCharges,
  type MagicItemDefinition,
  type MagicItemDice,
  type MagicPassiveModifier,
} from "../src/repo/encounter/magicItem/index.js";

const AT = "2038-01-01T00:00:00.000Z";

function definition(definitionId: string, overrides: Partial<Omit<MagicItemDefinition, "reference">> = {}): MagicItemDefinition {
  return {
    reference: { packId: "velvet:test-fixture", packVersion: "1", definitionId },
    name: definitionId,
    attunement: null,
    charges: null,
    passiveModifiers: [],
    grantedPowers: [],
    ...overrides,
  };
}

function scriptedDice(...values: number[]): MagicItemDice {
  let index = 0;
  return {
    integer: (min, max) => {
      if (index >= values.length) throw new Error("scripted dice exhausted");
      const value = values[index++]!;
      if (value < min || value >= max) throw new Error(`scripted roll ${value} is outside [${min}, ${max})`);
      return value;
    },
  };
}

const noDice: MagicItemDice = { integer: () => { throw new Error("dice must not be drawn"); } };

const flat = (modifier: MagicPassiveModifier, requireAttunement = true) => ({ modifier, requireAttunement });

describe("magic-item attunement engine", () => {
  it("attunes after a bounded short rest and returns a receipt", () => {
    const state = createAttunementState("actor-1");
    const result = attuneItem({ state, key: "ring-instance-1",
      definition: definition("velvet:test-fixture:item:ring-of-protection", { attunement: { prerequisite: "short-rest" } }),
      prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt).toMatchObject({ operation: "attune", key: "ring-instance-1", changed: true, prerequisiteSatisfied: "short-rest", attunementCountBefore: 0, attunementCountAfter: 1 });
    expect(isAttuned(result.state, "ring-instance-1")).toBe(true);
    expect(state.entries).toHaveLength(0);
  });

  it("is idempotent by key: re-attuning changes nothing", () => {
    const item = definition("velvet:test-fixture:item:cloak", { attunement: { prerequisite: "short-rest" } });
    const first = attuneItem({ state: createAttunementState("actor-1"), key: "cloak-1", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!first.ok) throw new Error("first attunement must succeed");
    const second = attuneItem({ state: first.state, key: "cloak-1", definition: item, prerequisite: { satisfiedRest: null }, occurredAt: AT });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.receipt.changed).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  it("rejects attunement beyond the three-item limit", () => {
    const item = definition("velvet:test-fixture:item:attunable", { attunement: { prerequisite: "short-rest" } });
    let state = createAttunementState("actor-1");
    for (const key of ["a", "b", "c"]) {
      const result = attuneItem({ state, key, definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
      if (!result.ok) throw new Error(`attunement ${key} must succeed`);
      state = result.state;
    }
    expect(state.entries).toHaveLength(MAGIC_ITEM_ATTUNEMENT_LIMIT);
    const rejected = attuneItem({ state, key: "d", definition: item, prerequisite: { satisfiedRest: "long-rest" }, occurredAt: AT });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("capacity-exceeded");
    expect(rejected.state).toBe(state);
  });

  it("requires a satisfied prerequisite and lets a long rest satisfy a short-rest requirement", () => {
    const item = definition("velvet:test-fixture:item:boots", { attunement: { prerequisite: "short-rest" } });
    const missing = attuneItem({ state: createAttunementState("actor-1"), key: "boots-1", definition: item, prerequisite: { satisfiedRest: null }, occurredAt: AT });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("prerequisite-missing");
    const long = attuneItem({ state: createAttunementState("actor-1"), key: "boots-1", definition: item, prerequisite: { satisfiedRest: "long-rest" }, occurredAt: AT });
    expect(long.ok).toBe(true);

    const longRequired = definition("velvet:test-fixture:item:long-rest-tool", { attunement: { prerequisite: "long-rest" } });
    const shortOnly = attuneItem({ state: createAttunementState("actor-1"), key: "tool-1", definition: longRequired, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    expect(shortOnly.ok).toBe(false);
  });

  it("rejects non-attunable items and key conflicts", () => {
    const plain = definition("velvet:test-fixture:item:mundane");
    const notAttunable = attuneItem({ state: createAttunementState("actor-1"), key: "plain-1", definition: plain, prerequisite: { satisfiedRest: "long-rest" }, occurredAt: AT });
    expect(notAttunable.ok).toBe(false);
    if (!notAttunable.ok) expect(notAttunable.code).toBe("not-attunable");

    const ring = definition("velvet:test-fixture:item:ring", { attunement: { prerequisite: "short-rest" } });
    const first = attuneItem({ state: createAttunementState("actor-1"), key: "shared-key", definition: ring, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!first.ok) throw new Error("attunement must succeed");
    const other = definition("velvet:test-fixture:item:other-ring", { attunement: { prerequisite: "short-rest" } });
    const conflict = attuneItem({ state: first.state, key: "shared-key", definition: other, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("key-conflict");
  });

  it("drops attunement and treats a repeated drop as an idempotent no-op", () => {
    const item = definition("velvet:test-fixture:item:ring", { attunement: { prerequisite: "short-rest" } });
    const first = attuneItem({ state: createAttunementState("actor-1"), key: "ring-1", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!first.ok) throw new Error("attunement must succeed");
    const dropped = dropAttunement({ state: first.state, key: "ring-1", occurredAt: AT });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.receipt.changed).toBe(true);
    expect(attunementKeys(dropped.state)).toEqual([]);
    const again = dropAttunement({ state: dropped.state, key: "ring-1", occurredAt: AT });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.receipt.changed).toBe(false);
    expect(again.state).toEqual(dropped.state);
  });

  it("serializes the attunement set deterministically regardless of insertion order", () => {
    const item = definition("velvet:test-fixture:item:ring", { attunement: { prerequisite: "short-rest" } });
    const forward = createAttunementState("actor-1");
    const a = attuneItem({ state: forward, key: "a", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!a.ok) throw new Error("must attune a");
    const b = attuneItem({ state: a.state, key: "b", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!b.ok) throw new Error("must attune b");
    const reverse = createAttunementState("actor-1");
    const bFirst = attuneItem({ state: reverse, key: "b", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!bFirst.ok) throw new Error("must attune b");
    const aSecond = attuneItem({ state: bFirst.state, key: "a", definition: item, prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!aSecond.ok) throw new Error("must attune a");
    expect(serializeAttunementState(b.state)).toBe(serializeAttunementState(aSecond.state));
  });
});

describe("magic-item charge engine", () => {
  it("bounded spend accepts exact and partial spends and rejects over-spend", () => {
    const state = createChargeState("wand-1", 3);
    expect(spendCharges(state, 1, AT)).toMatchObject({ ok: true, state: { current: 2, maximum: 3 }, receipt: { applied: 1, before: 3, after: 2 } });
    const over = spendCharges(state, 4, AT);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("over-spend");
    expect(over.state).toEqual(state);
    const invalid = spendCharges(state, 0, AT);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe("out-of-range");
  });

  it("restores on the matching event, capped at the maximum, and ignores other events", () => {
    const state = Object.freeze({ itemKey: "wand-1", current: 0, maximum: 3 });
    const dawn = rechargeCharges(state, { kind: "event", event: "dawn", amount: 2 }, { kind: "event", event: "dawn" }, AT);
    expect(dawn).toMatchObject({ ok: true, state: { current: 2 }, receipt: { applied: 2 } });
    if (!dawn.ok) return;
    const capped = rechargeCharges(dawn.state, { kind: "event", event: "dawn", amount: 5 }, { kind: "event", event: "dawn" }, AT);
    expect(capped).toMatchObject({ ok: true, state: { current: 3 }, receipt: { applied: 1 } });
    const shortRest = rechargeCharges(state, { kind: "event", event: "short-rest", amount: 1 }, { kind: "event", event: "dawn" }, AT);
    expect(shortRest).toMatchObject({ ok: true, state: { current: 0 }, receipt: { applied: 0, reason: "event-mismatch" } });
  });

  it("resolves a roll recharge from injected dice and only restores at or above the minimum", () => {
    const state = Object.freeze({ itemKey: "wand-1", current: 0, maximum: 5 });
    const plan = { kind: "roll" as const, dieSides: 6, minimum: 5, amount: 5 };
    const hit = rollChargeRecharge(state, plan, scriptedDice(5), AT);
    expect(hit).toMatchObject({ ok: true, state: { current: 5 }, receipt: { applied: 5 } });
    const miss = rollChargeRecharge(state, plan, scriptedDice(2), AT);
    expect(miss).toMatchObject({ ok: true, state: { current: 0 }, receipt: { applied: 0, reason: "roll-missed:2" } });
  });

  it("rejects incompatible triggers and out-of-range rolls", () => {
    const state = Object.freeze({ itemKey: "wand-1", current: 0, maximum: 5 });
    const eventAgainstRoll = rechargeCharges(state, { kind: "roll", dieSides: 6, minimum: 5, amount: 1 }, { kind: "event", event: "dawn" }, AT);
    expect(eventAgainstRoll.ok).toBe(false);
    if (!eventAgainstRoll.ok) expect(eventAgainstRoll.code).toBe("incompatible-trigger");
    const rollAgainstEvent = rechargeCharges(state, { kind: "event", event: "dawn", amount: 1 }, { kind: "roll", roll: 3 }, AT);
    expect(rollAgainstEvent.ok).toBe(false);
    if (!rollAgainstEvent.ok) expect(rollAgainstEvent.code).toBe("incompatible-trigger");
    const badRoll = rechargeCharges(state, { kind: "roll", dieSides: 6, minimum: 5, amount: 1 }, { kind: "roll", roll: 7 }, AT);
    expect(badRoll.ok).toBe(false);
    if (!badRoll.ok) expect(badRoll.code).toBe("out-of-range");
    const noRecharge = rechargeCharges(state, { kind: "none" }, { kind: "event", event: "dawn" }, AT);
    expect(noRecharge).toMatchObject({ ok: true, state: { current: 0 }, receipt: { applied: 0, reason: "no-recharge" } });
  });
});

describe("magic-item passive modifiers and derived-values plan", () => {
  const attuned = (() => {
    const state = createAttunementState("actor-1");
    const result = attuneItem({ state, key: "ring-1",
      definition: definition("velvet:test-fixture:item:ring-of-protection", { attunement: { prerequisite: "short-rest" } }),
      prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT });
    if (!result.ok) throw new Error("attunement must succeed");
    return result.state;
  })();

  const ring = definition("velvet:test-fixture:item:ring-of-protection", {
    attunement: { prerequisite: "short-rest" },
    passiveModifiers: [
      flat({ kind: "flat", amount: 1, target: { kind: "armor-class" } }),
      flat({ kind: "flat", amount: 1, target: { kind: "saving-throw", ability: "dexterity" } }),
    ],
  });

  const cloak = definition("velvet:test-fixture:item:cloak-of-elvenkind", {
    passiveModifiers: [
      flat({ kind: "advantage", target: { kind: "saving-throw", ability: "dexterity" } }, false),
      flat({ kind: "resistance", damageType: "necrotic" }, false),
      flat({ kind: "resistance", damageType: "necrotic" }, false),
    ],
  });

  it("sums AC, saves, attack, and damage contributions and collects typed advantages and resistances", () => {
    const weapon = definition("velvet:test-fixture:item:sword-plus-one", {
      passiveModifiers: [
        flat({ kind: "flat", amount: 1, target: { kind: "attack-roll" } }, false),
        flat({ kind: "flat", amount: 1, target: { kind: "damage-roll" } }, false),
        flat({ kind: "resistance", damageType: "fire" }, false),
      ],
    });
    const plan = planDerivedValues({ attunement: attuned, items: [
      { key: "ring-1", definition: ring, equipped: true },
      { key: "cloak-1", definition: cloak, equipped: true },
      { key: "sword-1", definition: weapon, equipped: true },
    ] });
    expect(plan.armorClass).toBe(1);
    expect(plan.savingThrows.dexterity).toBe(1);
    expect(plan.attackRoll).toBe(1);
    expect(plan.damageRoll).toBe(1);
    expect(plan.advantages).toEqual([{ kind: "saving-throw", ability: "dexterity" }]);
    expect(plan.resistances).toEqual(["fire", "necrotic"]);
    expect(plan.immunities).toEqual([]);
    expect(plan.contributions).toHaveLength(8);
  });

  it("gates requireAttunement modifiers on attunement and requires equipment", () => {
    const gated = planDerivedValues({ attunement: createAttunementState("actor-1"), items: [{ key: "ring-1", definition: ring, equipped: true }] });
    expect(gated.armorClass).toBe(0);
    expect(gated.contributions).toEqual([]);
    const ungated = planDerivedValues({ attunement: attuned, items: [{ key: "cloak-1", definition: cloak, equipped: true }] });
    expect(ungated.resistances).toEqual(["necrotic"]);
    const unequipped = planDerivedValues({ attunement: attuned, items: [{ key: "ring-1", definition: ring, equipped: false }] });
    expect(unequipped.armorClass).toBe(0);
  });

  it("does not mutate its inputs and is deterministic", () => {
    const items = [{ key: "ring-1", definition: ring, equipped: true }];
    const before = JSON.stringify(items);
    const first = planDerivedValues({ attunement: attuned, items });
    const second = planDerivedValues({ attunement: attuned, items });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(items)).toBe(before);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("magic-item granted-power planning", () => {
  const attuned = (() => {
    const state = createAttunementState("actor-1");
    const result = attuneItem({ state, key: "staff-1",
      definition: definition("velvet:test-fixture:item:staff", { attunement: { prerequisite: "long-rest" } }),
      prerequisite: { satisfiedRest: "long-rest" }, occurredAt: AT });
    if (!result.ok) throw new Error("attunement must succeed");
    return result.state;
  })();

  const staff = definition("velvet:test-fixture:item:staff", {
    attunement: { prerequisite: "long-rest" },
    charges: { maximum: 3, recharge: { kind: "event", event: "dawn", amount: 1 } },
    grantedPowers: [
      { key: "staff-fireball", power: { kind: "spell", packId: "velvet:test-fixture", packVersion: "1", definitionId: "velvet:test-fixture:spell:fireball" },
        requireAttunement: true, actionCost: "action", cost: 1 },
      { key: "staff-light", power: { kind: "spell", packId: "velvet:test-fixture", packVersion: "1", definitionId: "velvet:test-fixture:spell:light" },
        requireAttunement: false, actionCost: "action", cost: 0 },
    ],
  });

  it("resolves a bounded plan referencing the granted power without executing it", () => {
    const plan = resolveGrantedPower({ key: "staff-1", definition: staff, equipped: true }, staff.grantedPowers[0]!, attuned);
    expect(plan).toMatchObject({ kind: "granted-power", sourceItemKey: "staff-1", powerKey: "staff-fireball", executed: false, actionCost: "action", chargeCost: 1,
      power: { kind: "spell", definitionId: "velvet:test-fixture:spell:fireball" } });
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("gates attunement-required powers and aggregates the available plans", () => {
    expect(resolveGrantedPower({ key: "staff-1", definition: staff, equipped: true }, staff.grantedPowers[0]!, createAttunementState("actor-1"))).toBeNull();
    const plans = planGrantedPowers({ attunement: attuned, items: [{ key: "staff-1", definition: staff, equipped: true }] });
    expect(plans.map((plan) => plan.powerKey)).toEqual(["staff-fireball", "staff-light"]);
    const unequipped = planGrantedPowers({ attunement: attuned, items: [{ key: "staff-1", definition: staff, equipped: false }] });
    expect(unequipped).toEqual([]);
  });
});

describe("magic-item engine entry point", () => {
  const item = definition("velvet:test-fixture:item:wand", {
    attunement: { prerequisite: "short-rest" },
    charges: { maximum: 3, recharge: { kind: "roll", dieSides: 6, minimum: 5, amount: 3 } },
    passiveModifiers: [flat({ kind: "flat", amount: 1, target: { kind: "armor-class" } })],
    grantedPowers: [{ key: "wand-bolt", power: { kind: "ability", packId: "velvet:test-fixture", packVersion: "1", definitionId: "velvet:test-fixture:ability:bolt" },
      requireAttunement: true, actionCost: "reaction", cost: 1 }],
  });

  it("dispatches every capability and draws recharge dice only through the injected seam", () => {
    const attuned = evaluateMagicItemAction(noDice, { kind: "attune", input: { state: createAttunementState("actor-1"), key: "wand-1", definition: item,
      prerequisite: { satisfiedRest: "short-rest" }, occurredAt: AT } });
    expect(attuned).toMatchObject({ kind: "attunement", result: { ok: true, receipt: { changed: true } } });
    if (attuned.kind !== "attunement" || !attuned.result.ok) throw new Error("attunement must succeed");
    const state = attuned.result.state;

    const spent = evaluateMagicItemAction(noDice, { kind: "spend-charges", state: createChargeState("wand-1", 3), amount: 2, occurredAt: AT });
    expect(spent).toMatchObject({ kind: "charges", result: { ok: true, state: { current: 1 } } });

    const recharged = evaluateMagicItemAction(scriptedDice(6), { kind: "roll-charge-recharge", state: Object.freeze({ itemKey: "wand-1", current: 0, maximum: 3 }),
      recharge: { kind: "roll", dieSides: 6, minimum: 5, amount: 3 }, occurredAt: AT });
    expect(recharged).toMatchObject({ kind: "charges", result: { ok: true, state: { current: 3 } } });

    const plan = evaluateMagicItemAction(noDice, { kind: "plan-derived-values", input: { attunement: state, items: [{ key: "wand-1", definition: item, equipped: true }] } });
    expect(plan).toMatchObject({ kind: "derived-values", plan: { armorClass: 1 } });

    const powers = evaluateMagicItemAction(noDice, { kind: "plan-granted-powers", input: { attunement: state, items: [{ key: "wand-1", definition: item, equipped: true }] } });
    expect(powers).toMatchObject({ kind: "granted-powers", plans: [{ powerKey: "wand-bolt", executed: false }] });
  });

  it("reproduces identical outcomes for identical dice and inputs", () => {
    const run = () => evaluateMagicItemAction(scriptedDice(5), { kind: "roll-charge-recharge", state: Object.freeze({ itemKey: "wand-1", current: 0, maximum: 3 }),
      recharge: { kind: "roll", dieSides: 6, minimum: 5, amount: 3 }, occurredAt: AT });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
