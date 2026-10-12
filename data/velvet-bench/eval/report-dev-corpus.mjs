#!/usr/bin/env node
/**
 * Report the dev-partition results in the shape GRADING.md asks for, plus the Step 3
 * initiation/abstention split. Reads graded JSON only -- no model contact.
 *
 * Usage: node report-dev-corpus.mjs --graded <a.json> --graded <b.json>
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const paths = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--graded") paths.push(argv[i + 1]);
if (!paths.length) { console.error("usage: --graded <file.json> [--graded <file.json>]"); process.exit(2); }

const runs = paths.map((p) => JSON.parse(readFileSync(p, "utf8")));

/** Wilson score interval, so an aggregated rate is never read as a bare point estimate. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, ph = k / n;
  const d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt(ph * (1 - ph) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : "n/a");
const ci = (k, n) => { const w = wilson(k, n); return w ? ` [${(w[0] * 100).toFixed(0)}-${(w[1] * 100).toFixed(0)}]` : ""; };
const frac = (k, n) => `${k}/${n}`;

for (const run of runs) {
  const G = run.graded;
  const byCat = new Map();
  for (const g of G) {
    if (!byCat.has(g.category)) byCat.set(g.category, []);
    byCat.get(g.category).push(g);
  }

  console.log(`\n${"=".repeat(78)}\n${run.model}   (${G.length} cases)\n${"=".repeat(78)}`);

  console.log("\n### per category: n / valid / correct  (+ Wilson CI on correct)");
  console.log("  category".padEnd(28) + "n".padStart(4) + "valid".padStart(7) + "correct".padStart(9) + "   rate[95% CI]".padStart(20) + "  proto leak fab");
  for (const [cat, gs] of [...byCat].sort()) {
    const n = gs.length;
    const valid = gs.filter((g) => g.firstAttemptValid).length;
    const correct = gs.filter((g) => g.firstAttemptCorrect).length;
    const proto = gs.filter((g) => g.verdict === "invalid").length;
    const leak = gs.filter((g) => g.leaks?.length).length;
    const fab = gs.filter((g) => g.fabrication?.length).length;
    console.log(
      "  " + cat.padEnd(28) + String(n).padStart(4) + frac(valid, n).padStart(7) +
      frac(correct, n).padStart(9) + `   ${(pct(correct, n) + ci(correct, n)).padStart(18)}` +
      String(proto).padStart(6) + String(leak).padStart(5) + String(fab).padStart(4)
    );
  }

  const n = G.length;
  const valid = G.filter((g) => g.firstAttemptValid).length;
  const correct = G.filter((g) => g.firstAttemptCorrect).length;
  console.log(`  ${"ALL".padEnd(28)} ${String(n).padStart(4)} ${frac(valid, n).padStart(7)} ${frac(correct, n).padStart(9)}   ${(pct(correct, n) + ci(correct, n)).padStart(18)}`);

  // ---- Step 3: the split that decides the dataset
  // "called" must mean a tool call was EMITTED. A 43-call repetition loop is not an abstention.
  const emitted = (g) => (g.toolCallCount ?? 0) > 0;
  const produced = (g) => (g.toolCallCount ?? 0) === 1 && g.firstAttemptValid;

  console.log("\n### initiation vs abstention (never blended)");
  const tsWant = G.filter((g) => g.category === "tool-selection" && g.outcome === "tool-call");
  const tsCalled = tsWant.filter(emitted);
  const tsAbstain = tsWant.filter((g) => !emitted(g));
  const tsDegenerate = tsCalled.filter((g) => (g.toolCallCount ?? 0) > 1);
  const tsCorrect = tsCalled.filter((g) => g.firstAttemptCorrect);
  const tsWrongTool = tsCalled.filter((g) => g.verdict === "incorrect" && g.reasons?.some((r) => r.startsWith("wrong-tool")));
  const tsWrongArgs = tsCalled.filter((g) => g.verdict === "incorrect" && g.reasons?.some((r) => r.startsWith("wrong-arguments")));
  console.log(`  tool-selection (outcome=tool-call)  n=${tsWant.length}`);
  console.log(`    emitted a call (initiation)        ${frac(tsCalled.length, tsWant.length)}  ${pct(tsCalled.length, tsWant.length)}${ci(tsCalled.length, tsWant.length)}`);
  console.log(`    FALSE ABSTENTION (no call)         ${frac(tsAbstain.length, tsWant.length)}  ${pct(tsAbstain.length, tsWant.length)}${ci(tsAbstain.length, tsWant.length)}`);
  console.log(`      degenerate loops (>1 call)       ${frac(tsDegenerate.length, tsCalled.length)}`);
  console.log(`    of single calls: correct           ${frac(tsCorrect.length, tsCalled.length - tsDegenerate.length)}   wrong tool ${tsWrongTool.length}   wrong args ${tsWrongArgs.length}`);

  const ntWant = G.filter((g) => g.category === "no-tool-behavior" && g.outcome === "no-tool");
  const ntNoCall = ntWant.filter((g) => !emitted(g));
  const ntFalse = ntWant.filter(emitted);
  console.log(`  no-tool-behavior (outcome=no-tool)  n=${ntWant.length}`);
  console.log(`    correct abstention (no call)       ${frac(ntNoCall.length, ntWant.length)}  ${pct(ntNoCall.length, ntWant.length)}${ci(ntNoCall.length, ntWant.length)}`);
  console.log(`    FALSE CALL                         ${frac(ntFalse.length, ntWant.length)}  ${pct(ntFalse.length, ntWant.length)}${ci(ntFalse.length, ntWant.length)}`);
  for (const g of ntFalse) console.log(`      called ${g.calledTool} on ${g.id}`);

  // ---- initiation across EVERY tool-call case, not just the tool-selection category.
  // This is where a model that abstains on narration cases actually shows up.
  const allWant = G.filter((g) => g.outcome === "tool-call");
  const allNoCall = allWant.filter((g) => !emitted(g));
  console.log(`\n  ALL outcome=tool-call cases          n=${allWant.length}`);
  console.log(`    FALSE ABSTENTION (no call at all)  ${frac(allNoCall.length, allWant.length)}  ${pct(allNoCall.length, allWant.length)}${ci(allNoCall.length, allWant.length)}`);
  const abstainByCat = new Map();
  for (const g of allNoCall) abstainByCat.set(g.category, (abstainByCat.get(g.category) ?? 0) + 1);
  for (const [c, k] of [...abstainByCat].sort((a, b) => b[1] - a[1])) console.log(`      ${c.padEnd(30)}${k}`);

  // ---- grounding
  const gnd = G.filter((g) => g.category === "receipt-grounded-narration" || g.category === "narration-envelope");
  const gndProd = gnd.filter(produced);
  const gndClean = gndProd.filter((g) => !g.groundingViolations?.length && g.firstAttemptCorrect);
  const gndNoViol = gndProd.filter((g) => !g.groundingViolations?.length);
  console.log(`\n### grounding (stricter oracle, grounding-binding-v1)`);
  console.log(`  receipt-bearing cases              ${gnd.length}`);
  console.log(`  produced gradeable narration       ${frac(gndProd.length, gnd.length)}   <- the rest abstained and CANNOT be graded`);
  console.log(`  no binding violation (of graded)   ${frac(gndNoViol.length, gndProd.length)}  ${pct(gndNoViol.length, gndProd.length)}${ci(gndNoViol.length, gndProd.length)}`);
  console.log(`  fully correct (violation-free AND boundaries pass) ${frac(gndClean.length, gndProd.length)}  ${pct(gndClean.length, gndProd.length)}${ci(gndClean.length, gndProd.length)}`);
  const codes = new Map();
  for (const g of gndProd) for (const v of g.groundingViolations ?? []) codes.set(v.code, (codes.get(v.code) ?? 0) + 1);
  if (codes.size) {
    console.log("  violation codes (denominator = graded narrations):");
    for (const [c, k] of [...codes].sort((a, b) => b[1] - a[1])) console.log(`    ${c.padEnd(30)}${k}`);
  } else console.log("  violation codes: none");

  // ---- boundary
  const npc = G.filter((g) => g.category === "npc-knowledge-boundary");
  const npcProd = npc.filter(produced);
  const npcLeak = npcProd.filter((g) => g.leaks?.length);
  const npcFab = npcProd.filter((g) => (g.fabrication?.length ?? 0) > 0);
  console.log(`\n### boundary`);
  console.log(`  npc-knowledge-boundary              n=${npc.length}, produced gradeable output ${npcProd.length}`);
  console.log(`  GM-only fact LEAKAGE (of graded)    ${frac(npcLeak.length, npcProd.length)}  ${npcProd.length ? pct(npcLeak.length, npcProd.length) + ci(npcLeak.length, npcProd.length) : "n/a"}`);
  console.log(`  FABRICATED in-world content         ${frac(npcFab.length, npcProd.length)}  ${npcProd.length ? pct(npcFab.length, npcProd.length) + ci(npcFab.length, npcProd.length) : "n/a"}   <- distinct from leakage`);
  console.log(`  leakage (of all cases)              ${frac(npcLeak.length, npc.length)}  ${pct(npcLeak.length, npc.length)}${ci(npcLeak.length, npc.length)}   <- depressed by abstention, read with care`);
  for (const g of npcLeak) console.log(`    LEAK ${g.id}  ${(g.leaks ?? []).map((l) => (l.length > 60 ? l.slice(0, 60) + "…" : l)).join(" | ")}`);
  for (const g of npcFab) console.log(`    FAB  ${g.id}  ${(g.fabrication ?? []).join(" | ")}`);

  const ag = G.filter((g) => g.category === "player-agency");
  const agProd = ag.filter(produced);
  const agFail = agProd.filter((g) => !g.firstAttemptCorrect);
  // "fails the category" and "commits an agency violation" are DIFFERENT things and must not
  // be conflated. An agency violation is authored speech, feeling or decision for the player:
  // a mustNotInclude breach or a forbidden-fact leak. A missing required name is a coverage
  // miss, not the player losing agency.
  const agViol = agFail.filter((g) => (g.fabrication?.length ?? 0) + (g.leaks?.length ?? 0) > 0);
  const agMiss = agFail.filter((g) => !(g.fabrication?.length ?? 0) + !(g.leaks?.length ?? 0));
  console.log(`  player-agency                       n=${ag.length}, produced gradeable output ${agProd.length}`);
  console.log(`    category failures (of graded)      ${frac(agFail.length, agProd.length)}  ${agProd.length ? pct(agFail.length, agProd.length) + ci(agFail.length, agProd.length) : "n/a"}`);
  console.log(`    AGENCY VIOLATIONS only             ${frac(agViol.length, agProd.length)}  ${agProd.length ? pct(agViol.length, agProd.length) + ci(agViol.length, agProd.length) : "n/a"}   <- authored the player's action/speech`);
  console.log(`    required-anchor omissions only     ${frac(agMiss.length, agProd.length)}  ${agProd.length ? pct(agMiss.length, agProd.length) + ci(agMiss.length, agProd.length) : "n/a"}`);
  for (const g of agViol) console.log(`      VIOLATION ${g.id}  ${JSON.stringify([...(g.fabrication ?? []), ...(g.leaks ?? [])]).slice(0, 120)}`);

  // ---- failure-mode decomposition across the whole run.
  // The headline finding is that the dominant mode is not fabrication or boundary breach but
  // omission of a required anchor, usually a proper noun carried from the setup.
  console.log(`\n### failure-mode decomposition (all ${n} cases)`);
  const modes = new Map();
  const bump = (k) => modes.set(k, (modes.get(k) ?? 0) + 1);
  let omissionOnly = 0;
  for (const g of G) {
    if (g.firstAttemptCorrect) continue;
    const r = g.reasons ?? [];
    if (r.length === 1 && r[0].startsWith("missing:")) { omissionOnly++; bump("omitted required anchor (sole cause)"); continue; }
    for (const x of r) {
      if (x.startsWith("missing:")) bump("omitted required anchor (with another fault)");
      else if (x.startsWith("fabrication:")) bump("fabrication / asserted unearned content");
      else if (x.startsWith("leak:")) bump("boundary or structural leak");
      else if (x.startsWith("grounding:")) bump("grounding binding violation");
      else if (x.startsWith("missing-tool-call")) bump("abstained (emitted no tool call)");
      else if (x.startsWith("false-call")) bump("false call (called when it must not)");
      else if (x.startsWith("parallel-calls")) bump("degenerate multi-call loop");
      else if (x.startsWith("wrong-")) bump("wrong tool / wrong arguments");
      else if (x.startsWith("no-question")) bump("clarify without a question");
      else bump(`other: ${x}`);
    }
  }
  for (const [k, v] of [...modes].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(46)}${v}  ${pct(v, n)}`);
  console.log(`  ${"cases whose ONLY fault is a missing anchor".padEnd(46)}${omissionOnly}  ${pct(omissionOnly, n)}`);

  // ---- serving / protocol
  const inval = G.filter((g) => g.verdict === "invalid");
  console.log(`\n### serving / protocol (NOT capability)`);
  console.log(`  invalid envelopes                 ${frac(inval.length, n)}`);
  const why = new Map();
  for (const g of inval) for (const r of (g.reasons ?? [])) why.set(r, (why.get(r) ?? 0) + 1);
  for (const [k, v] of [...why].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(30)}${v}`);

  // ---- reasoning leak check (parity control)
  const reasoned = G.filter((g) => (g.reasoningBytes ?? 0) > 0);
  console.log(`\n### parity control`);
  console.log(`  cases emitting reasoning_content  ${frac(reasoned.length, n)}`);

  // ---- cost
  const pt = G.reduce((s, g) => s + (g.usage?.prompt_tokens ?? 0), 0);
  const ct = G.reduce((s, g) => s + (g.usage?.completion_tokens ?? 0), 0);
  const lat = G.filter((g) => g.latencyMs).map((g) => g.latencyMs).sort((a, b) => a - b);
  const mean = lat.reduce((a, b) => a + b, 0) / (lat.length || 1);
  console.log(`\n### cost`);
  console.log(`  prompt tokens ${pt}   completion tokens ${ct}   total ${pt + ct}`);
  console.log(`  latency mean ${Math.round(mean)}ms  p50 ${lat[Math.floor(lat.length / 2)]}ms  p95 ${lat[Math.floor(lat.length * 0.95)]}ms  max ${lat.at(-1)}ms`);
}

// ---- cross-run control
if (runs.length > 1) {
  console.log(`\n${"=".repeat(78)}\n### cross-model control checks\n${"=".repeat(78)}`);
  const [a, b] = runs;
  const mapOf = (r) => new Map(r.graded.map((g) => [g.id, g]));
  const A = mapOf(a), B = mapOf(b);
  let same = 0, diff = 0, missing = 0;
  for (const [id, ga] of A) {
    const gb = B.get(id);
    if (!gb) { missing++; continue; }
    if (ga.promptSha256 && ga.promptSha256 === gb.promptSha256) same++; else diff++;
  }
  console.log(`  identical case sets       ${A.size === B.size ? "yes" : `NO (${A.size} vs ${B.size})`}`);
  console.log(`  prompt payload identical  ${frac(same, same + diff)}   (diff ${diff}, missing ${missing})`);
  console.log(`  models                    ${a.model}  vs  ${b.model}`);
}