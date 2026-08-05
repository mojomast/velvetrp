import {
  diceExpressionSchema,
  diceRollResultSchema,
  type DiceRollResult,
  type NormalizedDiceExpression,
} from "@velvet/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { evaluateDiceExpression, parseDiceExpression } from "../src/dice.js";
import type { RandomNumberGenerator } from "../src/runtime.js";

const validCorpus = [
  "1d2",
  "1d20+7",
  "2d8-1",
  "4d6kh3",
  "4d6kl2-10",
  "1d20adv+1",
  "1d20dis-1000",
  "100d1000kl100-1000",
  "100d1000kh100+1000",
] as const;

const invalidCorpus: readonly unknown[] = [
  undefined,
  null,
  20,
  true,
  [],
  {},
  "",
  "d20",
  "D20",
  "1D20",
  "01d20",
  "1d020",
  "1 d20",
  "1d 20",
  " 1d20",
  "1d20 ",
  "1d20\n",
  "1d20\0",
  "1d20+0",
  "1d20-0",
  "1d20+01",
  "1d20+-1",
  "1d20kh",
  "2d20kh0",
  "1d20kh01",
  "1d20k1",
  "1d20h1",
  "1d20keep1",
  "1d20a",
  "1d20Adv",
  "1d20advdis",
  "1d20kh1kl1",
  "1d20advkh1",
  "1d20disadv",
  "1d20+1adv",
  "1d20+1+2",
  "0d20",
  "-1d20",
  "+1d20",
  "1.5d20",
  "101d20",
  "1d0",
  "1d1",
  "1d-20",
  "1d20.5",
  "1d1001",
  "2d20adv",
  "2d20dis",
  "2d20kh3",
  "100d20kh101",
  "1d20kl2",
  "1d20+1001",
  "1d20-1001",
  "1d20garbage",
  "999999999999999999999999999999999999999999d999999999999999999999999999999999",
];

describe("pure bounded dice expression parser", () => {
  it("returns the exact shared normalized shape for every selection mode", () => {
    const cases: ReadonlyArray<readonly [string, NormalizedDiceExpression]> = [
      ["1d2", { count: 1, sides: 2, selection: { type: "all" }, modifier: 0 }],
      ["100d1000+1000", { count: 100, sides: 1_000, selection: { type: "all" }, modifier: 1_000 }],
      ["4d6kh3-2", { count: 4, sides: 6, selection: { type: "keep_highest", count: 3 }, modifier: -2 }],
      ["8d10kl1+9", { count: 8, sides: 10, selection: { type: "keep_lowest", count: 1 }, modifier: 9 }],
      ["1d20adv", { count: 1, sides: 20, selection: { type: "advantage" }, modifier: 0 }],
      ["1d20dis-1000", { count: 1, sides: 20, selection: { type: "disadvantage" }, modifier: -1_000 }],
    ];

    for (const [expression, expected] of cases) {
      expect(parseDiceExpression(expression)).toEqual(expected);
    }
  });

  it("has acceptance parity with diceExpressionSchema across the grammar corpus", () => {
    for (const input of [...validCorpus, ...invalidCorpus]) {
      const schemaAccepts = diceExpressionSchema.safeParse(input).success;
      let parserAccepts = true;
      try {
        parseDiceExpression(input);
      } catch {
        parserAccepts = false;
      }
      expect(parserAccepts, String(input)).toBe(schemaAccepts);
    }
  });

  it("rejects grammar, trailing input, bounds, keep, and incompatible-mode failures", () => {
    for (const input of invalidCorpus) {
      expect(() => parseDiceExpression(input), String(input)).toThrow();
    }
  });

  it("rejects oversized input before shared schema parsing", () => {
    const oversized = `1d20${"0".repeat(1_000_000)}`;
    expect(() => parseDiceExpression(oversized)).toThrow("invalid dice expression");
  });

  it("is deterministic and exposes only the shared normalized return type", () => {
    expect(parseDiceExpression("4d6kh3+2")).toEqual(parseDiceExpression("4d6kh3+2"));
    expect(Object.keys(parseDiceExpression("1d20"))).toEqual(["count", "sides", "selection", "modifier"]);
    expectTypeOf(parseDiceExpression).returns.toEqualTypeOf<NormalizedDiceExpression>();
  });
});

const recordingRng = (values: readonly number[]) => {
  const calls: Array<readonly [number, number]> = [];
  let index = 0;
  const rng: RandomNumberGenerator = {
    integer(minInclusive, maxExclusive) {
      calls.push([minInclusive, maxExclusive]);
      if (index >= values.length) throw new Error("unexpected RNG call");
      return values[index++]!;
    },
  };
  return { rng, calls, consumed: () => index };
};

describe("pure deterministic dice expression evaluator", () => {
  it("evaluates all selection modes, modifiers, and totals in RNG order", () => {
    const cases = [
      ["3d6+2", [1, 6, 3], [true, true, true], 12],
      ["4d8kh2-1", [8, 2, 7, 3], [true, false, true, false], 14],
      ["4d8kl2+4", [8, 2, 7, 3], [false, true, false, true], 9],
      ["1d20adv-2", [4, 17], [false, true], 15],
      ["1d20dis+3", [4, 17], [true, false], 7],
    ] as const;

    for (const [expression, values, kept, total] of cases) {
      const harness = recordingRng(values);
      const result = evaluateDiceExpression(expression, harness.rng);
      expect(result.expression).toBe(expression);
      expect(result.terms).toEqual(values.map((value, index) => ({ value, kept: kept[index] })));
      expect(result.total).toBe(total);
      expect(diceRollResultSchema.parse(result)).toEqual(result);
    }
  });

  it("uses exact exclusive RNG bounds and ordinary/keep physical call counts", () => {
    for (const expression of ["3d6", "3d6kh1", "3d6kl2"] as const) {
      const harness = recordingRng([1, 2, 6]);
      evaluateDiceExpression(expression, harness.rng);
      expect(harness.calls).toEqual([[1, 7], [1, 7], [1, 7]]);
      expect(harness.consumed()).toBe(3);
    }
  });

  it("rolls advantage and disadvantage exactly twice", () => {
    for (const expression of ["1d1000adv", "1d1000dis"] as const) {
      const harness = recordingRng([1, 1_000]);
      evaluateDiceExpression(expression, harness.rng);
      expect(harness.calls).toEqual([[1, 1_001], [1, 1_001]]);
      expect(harness.consumed()).toBe(2);
    }
  });

  it("supports the maximum 100d1000 roll and contract total bounds", () => {
    const values = Array.from({ length: 100 }, (_, index) => index === 0 ? 1 : 1_000);
    const harness = recordingRng(values);
    const result = evaluateDiceExpression("100d1000+1000", harness.rng);
    expect(result.terms).toHaveLength(100);
    expect(result.terms[0]).toEqual({ value: 1, kept: true });
    expect(result.total).toBe(100_001);
    expect(harness.calls).toHaveLength(100);
    expect(harness.calls.every(([min, max]) => min === 1 && max === 1_001)).toBe(true);
  });

  it("keeps earlier indexes for every high, low, advantage, and disadvantage tie", () => {
    const cases = [
      ["4d6kh2", [6, 4, 6, 6], [true, false, true, false]],
      ["4d6kl2", [1, 4, 1, 1], [true, false, true, false]],
      ["1d20adv", [9, 9], [true, false]],
      ["1d20dis", [9, 9], [true, false]],
    ] as const;
    for (const [expression, values, kept] of cases) {
      const result = evaluateDiceExpression(expression, recordingRng(values).rng);
      expect(result.terms.map((term) => term.kept)).toEqual(kept);
    }
  });

  it("parses and rejects invalid input before any RNG call", () => {
    for (const input of ["2d6adv", "1d1", "1d6 trailing", null] as const) {
      const harness = recordingRng([]);
      expect(() => evaluateDiceExpression(input, harness.rng)).toThrow();
      expect(harness.calls).toEqual([]);
    }
  });

  it("rejects every invalid RNG output immediately with no clamp or hidden retry", () => {
    for (const invalid of [0, 7, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const harness = recordingRng([3, invalid, 4]);
      expect(() => evaluateDiceExpression("3d6", harness.rng)).toThrow(
        "random number generator returned an invalid die value",
      );
      expect(harness.calls).toEqual([[1, 7], [1, 7]]);
      expect(harness.consumed()).toBe(2);
    }
  });

  it("propagates dependency failures unchanged and never retries", () => {
    const failure = new Error("rng unavailable");
    let calls = 0;
    const rng: RandomNumberGenerator = {
      integer() {
        calls += 1;
        if (calls === 2) throw failure;
        return 2;
      },
    };
    let caught: unknown;
    try {
      evaluateDiceExpression("4d6kh2", rng);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(calls).toBe(2);
  });

  it("exposes only the strict shared result type", () => {
    const result = evaluateDiceExpression("1d2", recordingRng([1]).rng);
    expect(Object.keys(result)).toEqual(["expression", "normalized", "terms", "modifier", "total"]);
    expectTypeOf(evaluateDiceExpression).returns.toEqualTypeOf<DiceRollResult>();
  });
});
