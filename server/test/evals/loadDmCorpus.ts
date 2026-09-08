import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DM_EVAL_CATEGORIES, type DmEvalCorpus } from "./dmEvalTypes.js";

const corpusPath = fileURLToPath(new URL("../fixtures/dm-evals/corpus.v1.json", import.meta.url));

export function loadDmEvalCorpus(): DmEvalCorpus {
  const value = JSON.parse(readFileSync(corpusPath, "utf8")) as DmEvalCorpus;
  if (value.version !== "v1" || !Array.isArray(value.cases) || value.cases.length === 0) throw new Error("invalid DM evaluation corpus");
  const ids = new Set<string>();
  for (const item of value.cases) {
    if (!item.id || ids.has(item.id)) throw new Error(`duplicate or empty DM evaluation ID: ${item.id}`);
    ids.add(item.id);
    if (!item.categories.length || item.categories.some((category) => !DM_EVAL_CATEGORIES.includes(category))) throw new Error(`invalid categories for ${item.id}`);
    if (!item.expected?.allowedOutcomes?.length || !item.baseline?.metrics) throw new Error(`incomplete DM evaluation case: ${item.id}`);
  }
  return value;
}
