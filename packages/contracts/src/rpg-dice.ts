import { z } from "zod";

export const MAX_DICE_COUNT = 100;
export const MAX_DICE_SIDES = 1_000;
export const MAX_DICE_MODIFIER = 1_000;

const diceCountSchema = z.number().int().min(1).max(MAX_DICE_COUNT);
const diceSidesSchema = z.number().int().min(2).max(MAX_DICE_SIDES);
// A die result may be one even though a valid die must have at least two sides.
const diceResultValueSchema = z.number().int().min(1).max(MAX_DICE_SIDES);
const diceModifierSchema = z.number().int().min(-MAX_DICE_MODIFIER).max(MAX_DICE_MODIFIER);
const keepCountSchema = z.number().int().min(1).max(MAX_DICE_COUNT);

// Captures only the canonical surface syntax. Numeric and relational bounds are
// checked below without transforming the expression into a parsed value.
const CANONICAL_DICE_EXPRESSION =
  /^([1-9][0-9]{0,2})d([1-9][0-9]{0,3})(?:(kh|kl)([1-9][0-9]{0,2})|(adv|dis))?([+-][1-9][0-9]{0,3})?$/;

export const diceExpressionSchema = z.string().max(24).superRefine((expression, context) => {
  const match = CANONICAL_DICE_EXPRESSION.exec(expression);
  if (match === null) {
    context.addIssue({ code: "custom", message: "must use canonical dice grammar" });
    return;
  }

  const count = Number(match[1]);
  const sides = Number(match[2]);
  const keepCount = match[4] === undefined ? undefined : Number(match[4]);
  const advantageMode = match[5];
  const modifier = match[6] === undefined ? 0 : Number(match[6]);

  if (count > MAX_DICE_COUNT) {
    context.addIssue({ code: "custom", message: `dice count must not exceed ${MAX_DICE_COUNT}` });
  }
  if (sides > MAX_DICE_SIDES) {
    context.addIssue({ code: "custom", message: `dice sides must not exceed ${MAX_DICE_SIDES}` });
  }
  if (sides < 2) {
    context.addIssue({ code: "custom", message: "dice sides must be at least 2" });
  }
  if (keepCount !== undefined && keepCount > count) {
    context.addIssue({ code: "custom", message: "keep count must not exceed dice count" });
  }
  if (advantageMode !== undefined && count !== 1) {
    context.addIssue({ code: "custom", message: "advantage and disadvantage require a base count of one" });
  }
  if (Math.abs(modifier) > MAX_DICE_MODIFIER) {
    context.addIssue({ code: "custom", message: `modifier magnitude must not exceed ${MAX_DICE_MODIFIER}` });
  }
});

export const diceSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({ type: z.literal("keep_highest"), count: keepCountSchema }).strict(),
  z.object({ type: z.literal("keep_lowest"), count: keepCountSchema }).strict(),
  z.object({ type: z.literal("advantage") }).strict(),
  z.object({ type: z.literal("disadvantage") }).strict(),
]);

export const normalizedDiceExpressionSchema = z.object({
  count: diceCountSchema,
  sides: diceSidesSchema,
  selection: diceSelectionSchema,
  modifier: diceModifierSchema,
}).strict().superRefine((value, context) => {
  if ((value.selection.type === "keep_highest" || value.selection.type === "keep_lowest")
      && value.selection.count > value.count) {
    context.addIssue({
      code: "custom",
      message: "keep count must not exceed dice count",
      path: ["selection", "count"],
    });
  }
  if ((value.selection.type === "advantage" || value.selection.type === "disadvantage")
      && value.count !== 1) {
    context.addIssue({
      code: "custom",
      message: "advantage and disadvantage require a base count of one",
      path: ["count"],
    });
  }
});

export const diceResultTermSchema = z.object({
  value: diceResultValueSchema,
  kept: z.boolean(),
}).strict();

const canonicalExpressionFor = (value: z.infer<typeof normalizedDiceExpressionSchema>): string => {
  let selection = "";
  switch (value.selection.type) {
    case "keep_highest":
      selection = `kh${value.selection.count}`;
      break;
    case "keep_lowest":
      selection = `kl${value.selection.count}`;
      break;
    case "advantage":
      selection = "adv";
      break;
    case "disadvantage":
      selection = "dis";
      break;
    case "all":
      break;
  }
  const modifier = value.modifier === 0
    ? ""
    : `${value.modifier > 0 ? "+" : ""}${value.modifier}`;
  return `${value.count}d${value.sides}${selection}${modifier}`;
};

export const diceRollResultSchema = z.object({
  expression: diceExpressionSchema,
  normalized: normalizedDiceExpressionSchema,
  terms: z.array(diceResultTermSchema).min(1).max(MAX_DICE_COUNT),
  modifier: diceModifierSchema,
  total: z.number().int().min(-MAX_DICE_MODIFIER).max(MAX_DICE_COUNT * MAX_DICE_SIDES + MAX_DICE_MODIFIER),
}).strict().superRefine((result, context) => {
  if (result.expression !== canonicalExpressionFor(result.normalized)) {
    context.addIssue({
      code: "custom",
      message: "expression must exactly represent the normalized value",
      path: ["expression"],
    });
  }
  if (result.modifier !== result.normalized.modifier) {
    context.addIssue({
      code: "custom",
      message: "result modifier must match the normalized modifier",
      path: ["modifier"],
    });
  }

  const expectedTermCount = result.normalized.selection.type === "advantage"
    || result.normalized.selection.type === "disadvantage"
    ? 2
    : result.normalized.count;
  if (result.terms.length !== expectedTermCount) {
    context.addIssue({
      code: "custom",
      message: "term count must match the normalized roll",
      path: ["terms"],
    });
  }

  result.terms.forEach((term, index) => {
    if (term.value > result.normalized.sides) {
      context.addIssue({
        code: "custom",
        message: "term value must not exceed the die sides",
        path: ["terms", index, "value"],
      });
    }
  });

  const kept = result.terms.filter((term) => term.kept);
  const discarded = result.terms.filter((term) => !term.kept);
  const selection = result.normalized.selection;
  let expectedKeptCount = result.normalized.count;
  if (selection.type === "keep_highest" || selection.type === "keep_lowest") {
    expectedKeptCount = selection.count;
  } else if (selection.type === "advantage" || selection.type === "disadvantage") {
    expectedKeptCount = 1;
  }
  if (kept.length !== expectedKeptCount) {
    context.addIssue({ code: "custom", message: "kept term count must match the selection", path: ["terms"] });
  }

  const keepsHighest = selection.type === "keep_highest" || selection.type === "advantage";
  const keepsLowest = selection.type === "keep_lowest" || selection.type === "disadvantage";
  if (kept.length > 0 && discarded.length > 0 && keepsHighest
      && Math.min(...kept.map((term) => term.value)) < Math.max(...discarded.map((term) => term.value))) {
    context.addIssue({ code: "custom", message: "kept terms must be the highest values", path: ["terms"] });
  }
  if (kept.length > 0 && discarded.length > 0 && keepsLowest
      && Math.max(...kept.map((term) => term.value)) > Math.min(...discarded.map((term) => term.value))) {
    context.addIssue({ code: "custom", message: "kept terms must be the lowest values", path: ["terms"] });
  }

  const expectedTotal = kept.reduce((sum, term) => sum + term.value, result.modifier);
  if (result.total !== expectedTotal) {
    context.addIssue({ code: "custom", message: "total must equal kept terms plus modifier", path: ["total"] });
  }
});

export type DiceExpression = z.infer<typeof diceExpressionSchema>;
export type DiceSelection = z.infer<typeof diceSelectionSchema>;
export type NormalizedDiceExpression = z.infer<typeof normalizedDiceExpressionSchema>;
export type DiceResultTerm = z.infer<typeof diceResultTermSchema>;
export type DiceRollResult = z.infer<typeof diceRollResultSchema>;
