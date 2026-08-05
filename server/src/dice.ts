import {
  diceExpressionSchema,
  diceRollResultSchema,
  normalizedDiceExpressionSchema,
  type DiceRollResult,
  type NormalizedDiceExpression,
} from "@velvet/contracts";
import type { RandomNumberGenerator } from "./runtime.js";

// This matches the shared expression schema's hard input cap. Check it before
// running grammar validation so hostile input cannot make parsing unbounded.
const MAX_DICE_EXPRESSION_INPUT_LENGTH = 24;

const PARSED_DICE_EXPRESSION =
  /^([1-9][0-9]{0,2})d([1-9][0-9]{0,3})(?:(kh|kl)([1-9][0-9]{0,2})|(adv|dis))?([+-][1-9][0-9]{0,3})?$/;

/**
 * Parses one complete canonical dice expression without evaluating it or
 * consulting runtime dependencies.
 */
export function parseDiceExpression(input: unknown): NormalizedDiceExpression {
  if (typeof input !== "string" || input.length > MAX_DICE_EXPRESSION_INPUT_LENGTH) {
    throw new Error("invalid dice expression");
  }

  // Keep acceptance owned by the shared wire contract. The local match below
  // only projects contract-valid source text into its normalized form.
  const expression = diceExpressionSchema.parse(input);
  const match = PARSED_DICE_EXPRESSION.exec(expression);
  if (match === null) {
    // Defensive invariant if the shared canonical grammar changes.
    throw new Error("invalid dice expression");
  }

  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[6] === undefined ? 0 : Number(match[6]);

  let selection: NormalizedDiceExpression["selection"] = { type: "all" };
  if (match[3] === "kh") {
    selection = { type: "keep_highest", count: Number(match[4]) };
  } else if (match[3] === "kl") {
    selection = { type: "keep_lowest", count: Number(match[4]) };
  } else if (match[5] === "adv") {
    selection = { type: "advantage" };
  } else if (match[5] === "dis") {
    selection = { type: "disadvantage" };
  }

  // This is also a defensive overflow and relational-bound check. It ensures
  // this module can return only the shared normalized contract.
  return normalizedDiceExpressionSchema.parse({ count, sides, selection, modifier });
}

/**
 * Evaluates canonical dice notation using only the supplied RNG. Source parsing
 * completes before the first dependency call, and each result is accepted or
 * rejected immediately without clamping or retrying.
 */
export function evaluateDiceExpression(
  input: unknown,
  rng: RandomNumberGenerator,
): DiceRollResult {
  const normalized = parseDiceExpression(input);
  const physicalCount = normalized.selection.type === "advantage"
    || normalized.selection.type === "disadvantage"
    ? 2
    : normalized.count;
  const values: number[] = [];

  for (let index = 0; index < physicalCount; index += 1) {
    const value = rng.integer(1, normalized.sides + 1);
    if (!Number.isInteger(value) || value < 1 || value > normalized.sides) {
      throw new Error("random number generator returned an invalid die value");
    }
    values.push(value);
  }

  const keptIndexes = new Set<number>();
  const selection = normalized.selection;
  if (selection.type === "all") {
    values.forEach((_, index) => keptIndexes.add(index));
  } else {
    const keepCount = selection.type === "keep_highest" || selection.type === "keep_lowest"
      ? selection.count
      : 1;
    const keepHigh = selection.type === "keep_highest" || selection.type === "advantage";
    const indexes = values.map((_, index) => index);
    indexes.sort((left, right) => {
      const valueOrder = keepHigh
        ? values[right]! - values[left]!
        : values[left]! - values[right]!;
      // Stable selection is explicit rather than relying on engine sort stability.
      return valueOrder === 0 ? left - right : valueOrder;
    });
    indexes.slice(0, keepCount).forEach((index) => keptIndexes.add(index));
  }

  const terms = values.map((value, index) => ({ value, kept: keptIndexes.has(index) }));
  const total = terms.reduce(
    (sum, term) => sum + (term.kept ? term.value : 0),
    normalized.modifier,
  );

  return diceRollResultSchema.parse({
    expression: input as string, // parseDiceExpression proved the exact source type and grammar.
    normalized,
    terms,
    modifier: normalized.modifier,
    total,
  });
}
