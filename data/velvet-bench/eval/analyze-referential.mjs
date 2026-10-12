/**
 * Is the deficit specifically NAMED REFERENTS, or is it generic mustInclude weakness?
 *
 * This matters because referential fidelity is now the highest-priority training target,
 * and the recommendation to add required proper-noun anchors rests entirely on it being a
 * true, separable behaviour rather than a by-product of strict grading.
 *
 * Classification of a mustInclude anchor:
 *   named   -- contains a capitalised token that is NOT the first token
 *              ("Ailsa", "Tallow Street", "The Bleeding Ledger")
 *   numeric -- contains a digit
 *   generic -- everything else ("You arrive", "Short rest", "misses")
 *
 * Usage: node analyze-referential.mjs <graded.json> [more graded.json]
 */
import { readFileSync, readdirSync } from "node:fs";

const DIR = "data/velvet-bench/eval/dev-cases";
const load = (c) => { const j = JSON.parse(readFileSync(`${DIR}/${c}.json`, "utf8")); return j.cases; };
const cases = new Map();
for (const f of readdirSync(DIR).sort()) for (const c of load(f.replace(".json", ""))) cases.set(c.id, c);

function classify(anchor) {
  if (/\d/.test(anchor)) return "numeric";
  const toks = anchor.split(/\s+/);
  // a capitalised token anywhere other than position 0 => a proper name
  const named = toks.some((t, i) => i > 0 && /^[A-Z][a-z'’-]/.test(t));
  if (named) return "named";
  // single-token anchors are named if capitalised and not a sentence-initial common word
  if (toks.length === 1 && /^[A-Z][a-z]{2,}/.test(anchor)) return "named";
  return "generic";
}

// strip markdown/punctuation the same way the grader does before looking for the needle
const norm = (s) => s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

const totals = { named: [0, 0], numeric: [0, 0], generic: [0, 0] };
const missedByModel = {};

for (const path of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(path, "utf8"));
  const hit = new Map(), tot = new Map();
  for (const g of run.graded) {
    const c = cases.get(g.id);
    if (!c) continue;
    const hay = norm(g.prose ?? "");
    for (const a of c.expected.mustInclude ?? []) {
      const k = classify(a);
      tot.set(k, (tot.get(k) ?? 0) + 1);
      if (!hay.includes(norm(a))) hit.set(k, (hit.get(k) ?? 0) + 1);
    }
  }
  missedByModel[run.model] = { hit, tot };
  console.log(`\n${run.model}  -- mustInclude anchor coverage (${g_n(run)} cases)`);
  for (const k of ["named", "numeric", "generic"]) {
    const t = tot.get(k) ?? 0, h = hit.get(k) ?? 0;
    console.log(`  ${k.padEnd(9)} anchors ${String(t).padStart(4)}   missed ${String(h).padStart(3)}   miss rate ${t ? ((100 * h) / t).toFixed(1) + "%" : "n/a"}`);
  }
}
function g_n(run) { return run.graded.length; }

if (Object.keys(missedByModel).length > 1) {
  console.log("\n=== which named anchors are missed, per model ===");
  for (const path of process.argv.slice(2)) {
    const run = JSON.parse(readFileSync(path, "utf8"));
    const missed = [];
    for (const g of run.graded) {
      const c = cases.get(g.id);
      if (!c) continue;
      const hay = norm(g.prose ?? "");
      for (const a of c.expected.mustInclude ?? []) {
        if (classify(a) === "named" && !hay.includes(norm(a))) missed.push(a);
      }
    }
    const counts = new Map();
    for (const m of missed) counts.set(m, (counts.get(m) ?? 0) + 1);
    console.log(`\n  ${run.model}: ${missed.length} missed named anchors`);
    console.log("    " + [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ").slice(0, 700));
  }
}