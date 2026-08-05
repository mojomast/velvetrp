import { describe, expect, expectTypeOf, it } from "vitest";
import {
  diceExpressionSchema,
  diceResultTermSchema,
  diceRollResultSchema,
  diceSelectionSchema,
  MAX_DICE_COUNT,
  MAX_DICE_MODIFIER,
  MAX_DICE_SIDES,
  normalizedDiceExpressionSchema,
  type DiceRollResult,
  type DiceSelection,
  type NormalizedDiceExpression,
} from "../src/index.js";

const normalized = {
  count: 4,
  sides: 6,
  selection: { type: "keep_highest", count: 3 },
  modifier: 2,
} as const;

const result = {
  expression: "4d6kh3+2",
  normalized,
  terms: [
    { value: 2, kept: false },
    { value: 6, kept: true },
    { value: 4, kept: true },
    { value: 3, kept: true },
  ],
  modifier: 2,
  total: 15,
} as const;

describe("bounded RPG dice contracts", () => {
  it("accepts only the exact whole-input canonical grammar", () => {
    for (const expression of [
      "1d2", "1d20+7", "2d8-1", "4d6kh3", "4d6kl2-10", "1d20adv+1", "1d20dis-1000",
      "100d1000kh100+1000",
    ]) {
      expect(diceExpressionSchema.parse(expression)).toBe(expression);
    }

    for (const expression of [
      "d20", "D20", "1D20", "01d20", "1d020", "1 d20", "1d20 ", " 1d20", "1d20\n",
      "1d20+0", "1d20-0", "1d20+01", "1d20+-1", "1d20kh", "1d20kh01", "1d20k1",
      "1d20h1", "1d20keep1", "1d20a", "1d20Adv", "1d20advdis", "1d20+1adv", "1d20+1+2",
      "0d20", "101d20", "1d0", "1d1", "1d1001", "2d20adv", "2d20dis", "2d20kh3", "1d20kl2",
      "1d20+1001", "1d20-1001", "1d20garbage",
    ]) {
      expect(diceExpressionSchema.safeParse(expression).success, expression).toBe(false);
    }
  });

  it("publishes the reviewed hard limits", () => {
    expect(MAX_DICE_COUNT).toBe(100);
    expect(MAX_DICE_SIDES).toBe(1_000);
    expect(MAX_DICE_MODIFIER).toBe(1_000);
  });

  it("defines a strict discriminated normalized selection", () => {
    for (const selection of [
      { type: "all" },
      { type: "keep_highest", count: 1 },
      { type: "keep_lowest", count: 100 },
      { type: "advantage" },
      { type: "disadvantage" },
    ] as const) {
      expect(diceSelectionSchema.parse(selection)).toEqual(selection);
    }
    for (const selection of [
      { type: "none" }, { type: "kh", count: 1 }, { type: "keep_highest" },
      { type: "keep_lowest", count: 0 }, { type: "advantage", count: 1 },
      { type: "all", count: 1 }, { type: "disadvantage", alias: "dis" },
    ]) {
      expect(diceSelectionSchema.safeParse(selection).success).toBe(false);
    }
  });

  it("validates strict normalized values and relational selection rules", () => {
    expect(normalizedDiceExpressionSchema.parse(normalized)).toEqual(normalized);
    expect(normalizedDiceExpressionSchema.parse({
      count: 1, sides: 20, selection: { type: "all" }, modifier: 0,
    }).modifier).toBe(0);
    for (const invalid of [
      { ...normalized, count: 0 },
      { ...normalized, count: 101 },
      { ...normalized, sides: 0 },
      { ...normalized, sides: 1_001 },
      { ...normalized, modifier: 1_001 },
      { ...normalized, modifier: 0.5 },
      { ...normalized, selection: { type: "keep_highest", count: 5 } },
      { ...normalized, selection: { type: "keep_lowest", count: 0 } },
      { ...normalized, selection: { type: "advantage" } },
      { ...normalized, selection: { type: "disadvantage" } },
      { ...normalized, unknown: true },
    ]) {
      expect(normalizedDiceExpressionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires strict bounded structured terms", () => {
    expect(diceResultTermSchema.parse({ value: 1, kept: true })).toEqual({ value: 1, kept: true });
    expect(diceResultTermSchema.parse({ value: 1_000, kept: false })).toEqual({ value: 1_000, kept: false });
    for (const term of [
      { value: 0, kept: true }, { value: 1_001, kept: true }, { value: 1.5, kept: true },
      { value: 1, kept: 1 }, { value: 1 }, { value: 1, kept: true, index: 0 },
    ]) {
      expect(diceResultTermSchema.safeParse(term).success).toBe(false);
    }
  });

  it("keeps die-side and rolled-value lower bounds independent", () => {
    expect(normalizedDiceExpressionSchema.safeParse({
      count: 1, sides: 1, selection: { type: "all" }, modifier: 0,
    }).success).toBe(false);

    const rolledOne = {
      expression: "1d2",
      normalized: { count: 1, sides: 2, selection: { type: "all" }, modifier: 0 },
      terms: [{ value: 1, kept: true }],
      modifier: 0,
      total: 1,
    } as const;
    expect(diceRollResultSchema.parse(rolledOne)).toEqual(rolledOne);
    expect(diceRollResultSchema.safeParse({
      ...rolledOne,
      terms: [{ value: 0, kept: true }],
      total: 0,
    }).success).toBe(false);
  });

  it("accepts a fully consistent structured result", () => {
    expect(diceRollResultSchema.parse(result)).toEqual(result);
    expect(diceRollResultSchema.parse({
      expression: "1d20adv-2",
      normalized: { count: 1, sides: 20, selection: { type: "advantage" }, modifier: -2 },
      terms: [{ value: 14, kept: true }, { value: 8, kept: false }],
      modifier: -2,
      total: 12,
    }).total).toBe(12);
    expect(diceRollResultSchema.parse({
      expression: "1d20dis",
      normalized: { count: 1, sides: 20, selection: { type: "disadvantage" }, modifier: 0 },
      terms: [{ value: 14, kept: false }, { value: 8, kept: true }],
      modifier: 0,
      total: 8,
    }).total).toBe(8);
  });

  it("rejects expression, modifier, cardinality, side, selection, and total inconsistencies", () => {
    const invalidResults = [
      { ...result, expression: "4d6kh3+3" },
      { ...result, expression: "04d6kh3+2" },
      { ...result, modifier: 3, total: 16 },
      { ...result, terms: result.terms.slice(0, 3), total: 12 },
      { ...result, terms: result.terms.map((term, index) => index === 0 ? { ...term, value: 7 } : term) },
      { ...result, terms: result.terms.map((term) => ({ ...term, kept: true })), total: 17 },
      { ...result, terms: [
        { value: 6, kept: false }, { value: 5, kept: true }, { value: 4, kept: true }, { value: 3, kept: true },
      ] },
      { ...result, total: 14 },
      { ...result, narration: "rolled some dice" },
    ];
    for (const invalid of invalidResults) {
      expect(diceRollResultSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("allows boundary ties without imposing evaluator tie identity", () => {
    const tied = {
      expression: "3d6kh1",
      normalized: { count: 3, sides: 6, selection: { type: "keep_highest", count: 1 }, modifier: 0 },
      terms: [{ value: 6, kept: false }, { value: 6, kept: true }, { value: 2, kept: false }],
      modifier: 0,
      total: 6,
    } as const;
    expect(diceRollResultSchema.parse(tied)).toEqual(tied);
  });

  it("exports narrow normalized and result types", () => {
    expectTypeOf<NormalizedDiceExpression>().toEqualTypeOf<{
      count: number;
      sides: number;
      selection: DiceSelection;
      modifier: number;
    }>();
    expectTypeOf<DiceRollResult["terms"]>().toEqualTypeOf<Array<{ value: number; kept: boolean }>>();
  });
});
