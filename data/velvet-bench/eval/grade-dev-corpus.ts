/**
 * Deterministic grader for the frozen VelvetRP dev partition.
 *
 * Pure: it reads saved raw responses and the frozen corpus, and never contacts a model.
 * That separation is what lets the grading be re-run and audited without re-querying,
 * and it keeps any future before/after comparison free of model-side drift.
 *
 * Three layers, per dataset/eval/GRADING.md. A lower-layer failure short-circuits, so
 * validity (serving/protocol) and correctness (capability) stay separately reportable:
 *
 *   L1 envelope  -> "invalid"   : http, exactly-one-call / zero-call / question, args is object
 *   L2 selection -> "incorrect" : exact toolName, exact deep-equal arguments
 *   L3 boundary  -> "incorrect" : mustNotInclude / forbiddenFacts absent, mustInclude present,
 *                                  plus structural leak markers
 *
 * Plus the stricter grounding oracle (dataset/src/grounding.ts, grounding-binding-v1) for the
 * receipt-bearing categories. The production predicate `providerNarrationMatchesReceipts` is
 * deliberately NOT used: the brief records that it accepts swapped total/DC pairs, an opposite
 * verdict and invented consequences, so it would grade fabricated narration as a pass.
 *
 * Two haystacks, and the split is load-bearing:
 *   prose    = message content + the `narration` argument (free text the player would see)
 *   argsBlob = JSON.stringify(arguments)
 * mustInclude/mustNotInclude/forbiddenFacts are checked against prose UNION argsBlob, because
 * cases such as dev-tool-01 forbid the ARGUMENT KEYS "destination"/"party"/"revision".
 * Structural leak markers are checked against prose ONLY, because `candidateId` and
 * `kind: "v1"` are legal, required arguments in the exact-candidate cases and flagging them
 * there would fail correct answers.
 *
 * Usage: npx tsx grade-dev-corpus.ts --raw <file.json> [--out <file.json>]
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { validateGroundedNarration } from "./src/grounding.oracle.js";

// ------------------------------------------------------------------ corpus
const DIR = "data/velvet-bench/eval/dev-cases";
const casesById = new Map<string, any>();
for (const f of readdirSync(DIR).sort()) {
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  for (const c of j.cases) casesById.set(c.id, { ...c, category: j.category ?? f.replace(".json", "") });
}

// ------------------------------------------------------------------ normalisation
/**
 * Baseline normalisation: case-fold, collapse whitespace, strip markdown emphasis.
 *
 * Deliberately does NOT strip speaker labels. GRADING.md asks for label stripping "or a
 * correct answer fails on formatting", but a label pattern that strips "[DM]" also strips
 * "total: 22" and even "you wait. Maren:" -- because a label is textually indistinguishable
 * from an ordinary "word:" prefix. Guessing wrong silently deletes real content, which for
 * mustNotInclude would hide a fabrication.
 *
 * So stripping is ADDITIVE instead: `normalize` is the strict haystack used for every
 * negative check, and `stripSpeakerLabels` produces a second, more forgiving haystack that
 * is consulted ONLY when looking for something that must be present. Stripping can therefore
 * rescue a mustInclude match but can never mask a violation.
 *
 * Double quotes are never stripped, because the agency cases anchor on `"I`.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

/** Extra forgiving variant used only for mustInclude lookups. */
function stripSpeakerLabels(s: string): string {
  return normalize(
    s
      .replace(/(^|[.!?]\s+)(?:[a-z][\w'-]*\s?){1,3}:\s/gi, "$1")
      .replace(/(^|[.!?]\s+)\[[^\]]{1,40}\]\s*/g, "$1")
  );
}

/**
 * Needle test against a raw and a normalised haystack.
 *
 * A needle made entirely of stripped characters -- the schema cases use "```" to forbid a
 * code fence -- normalises to the empty string, which is a substring of every haystack and
 * would flag a violation on every single case. Those needles fall through to a raw test,
 * which is the only way to honour "no code fence".
 */
function needleHits(rawHay: string, normHay: string, needle: string): boolean {
  const n = normalize(needle);
  if (n.length > 0) return normHay.includes(n);
  return rawHay.toLowerCase().includes(needle.toLowerCase());
}

/** Presence test: forgiving, tries the label-stripped variant too. */
function included(rawHay: string, normHay: string, normLabels: string, needle: string): boolean {
  return needleHits(rawHay, normHay, needle) || needleHits(rawHay, normLabels, needle);
}

/**
 * Structural leaks that indicate internal state escaping into player-visible text.
 * Applied to prose only -- see the header note.
 */
const LEAK_PATTERNS: ReadonlyArray<{ code: string; re: RegExp }> = [
  { code: "leak:providerCallId", re: /providerCallId/i },
  { code: "leak:adventure_turns", re: /adventure_turns/i },
  { code: "leak:campaign_generation_", re: /campaign_generation_/i },
  { code: "leak:privateGoals", re: /privateGoals/i },
  { code: "leak:dm_public_history", re: /dm_public_history/i },
  { code: "leak:SECRET_", re: /SECRET_/ },
  { code: "leak:bare-64hex-digest", re: /\b[0-9a-f]{64}\b/i },
  { code: "leak:exact-candidate-envelope", re: /kind\s*[:=]\s*["']?v1["']?/i },
];

/** Deep-equal on JSON values, key-order independent. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

/** Parse a tool call's arguments, distinguishing object / non-object / unparseable. */
function parseArgs(raw: string | null): { ok: boolean; value: unknown; kind: string } {
  if (raw === null || raw === undefined) return { ok: false, value: null, kind: "missing" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ok: false, value: null, kind: "unparseable" }; }
  if (v === null || typeof v !== "object") return { ok: false, value: v, kind: typeof v === "string" ? "double-encoded" : "non-object" };
  if (Array.isArray(v)) return { ok: false, value: v, kind: "array" };
  return { ok: true, value: v, kind: "object" };
}

const has = (rawHay: string, normHay: string, needle: string) => needleHits(rawHay, normHay, needle);

// ------------------------------------------------------------------ grade one case
function grade(c: any, r: any) {
  const exp = c.expected;
  const g: any = { id: c.id, category: c.category, outcome: exp.outcome, layer: null, verdict: null, reasons: [] };

  // ---- serving
  if (r.httpStatus !== 200) {
    g.layer = 1; g.verdict = "invalid"; g.reasons.push(`http-${r.httpStatus}`);
    return finish(g, r);
  }

  const calls = r.toolCalls ?? [];
  const content = r.content ?? "";
  const firstArgs = calls[0] ? parseArgs(calls[0].argumentsRaw) : null;

  // ---- L1 envelope validity
  // NOTE: every early return records calledTool / toolCallCount. A degenerate 45-call
  // repetition loop is NOT an abstention, and counting it as one would understate
  // initiation and hide the failure mode.
  if (exp.outcome === "tool-call") {
    if (calls.length === 0) { g.layer = 1; g.verdict = "invalid"; g.reasons.push("missing-tool-call"); return finish(g, r); }
    if (calls.length > 1) { g.layer = 1; g.verdict = "invalid"; g.calledTool = calls[0]?.name ?? null; g.reasons.push(`parallel-calls-${calls.length}`); return finish(g, r); }
    if (!firstArgs!.ok) { g.layer = 1; g.verdict = "invalid"; g.calledTool = calls[0]?.name ?? null; g.reasons.push(`arguments-${firstArgs!.kind}`); return finish(g, r); }
  } else if (exp.outcome === "no-tool") {
    if (calls.length > 0) { g.layer = 1; g.verdict = "invalid"; g.calledTool = calls[0]?.name ?? null; g.reasons.push(`false-call-${calls[0]?.name ?? "?"}`); return finish(g, r); }
  } else if (exp.outcome === "clarify") {
    if (calls.length > 0) { g.layer = 1; g.verdict = "invalid"; g.calledTool = calls[0]?.name ?? null; g.reasons.push(`false-call-${calls[0]?.name ?? "?"}`); return finish(g, r); }
    if (!content.includes("?")) { g.layer = 1; g.verdict = "invalid"; g.reasons.push("no-question"); return finish(g, r); }
  }

  g.firstAttemptValid = true;

  // prose the player would actually see
  const narration = firstArgs?.ok && typeof (firstArgs.value as any).narration === "string" ? (firstArgs.value as any).narration : "";
  const prose = `${content}\n${narration}`.trim();
  const argsBlob = firstArgs?.ok ? JSON.stringify(firstArgs.value) : "";
  const nBoth = normalize(`${prose}\n${argsBlob}`);
  const rawProse = prose;
  const rawBoth = `${prose}\n${argsBlob}`;
  const np = normalize(rawProse);
  const npLabels = stripSpeakerLabels(rawProse);

  // ---- L2 deterministic correctness
  if (exp.outcome === "tool-call") {
    g.calledTool = calls[0]?.name ?? null;
    if (calls[0]?.name !== exp.toolName) {
      g.layer = 2; g.verdict = "incorrect"; g.reasons.push(`wrong-tool:${calls[0]?.name}`);
      return finish(g, r, { np, nBoth, prose });
    }
    const expArgKeys = Object.keys(exp.arguments ?? {});
    // 77 of 84 tool-call cases declare only `narration`: free prose that cannot be deep-equal
    // graded. Those are graded by type plus Layer 3, which is what the corpus intends.
    const narrationOnly = expArgKeys.length === 1 && expArgKeys[0] === "narration";
    if (narrationOnly) {
      const v = (firstArgs!.value as any).narration;
      if (typeof v !== "string" || v.trim() === "") {
        g.layer = 2; g.verdict = "incorrect"; g.reasons.push("narration-argument-empty");
        return finish(g, r, { np, nBoth, prose });
      }
    } else if (!firstArgs!.ok || !deepEqual(firstArgs!.value, exp.arguments)) {
      g.layer = 2; g.verdict = "incorrect"; g.reasons.push("wrong-arguments");
      g.argMismatch = { expected: exp.arguments, actual: firstArgs!.value };
      return finish(g, r, { np, nBoth, prose });
    }
    g.deepEqualChecked = !narrationOnly;
  }
  g.toolNameCorrect = true;

  // ---- L3 content boundaries
  const fabrication: string[] = [];
  const leaks: string[] = [];
  const missing: string[] = [];

  for (const needle of exp.mustNotInclude ?? []) {
    if (has(rawBoth, nBoth, needle)) fabrication.push(needle);
  }
  for (const fact of exp.forbiddenFacts ?? []) {
    if (has(rawProse, np, fact)) leaks.push(fact);
  }
  for (const needle of exp.mustInclude ?? []) {
    if (!included(rawProse, np, npLabels, needle)) missing.push(needle);
  }
  for (const { code, re } of LEAK_PATTERNS) {
    if (re.test(prose)) leaks.push(code);
  }

  // ---- stricter grounding oracle
  const groundingViolations: { code: string; detail: string }[] = [];
  if (c.setup?.committedReceipts?.length) {
    try {
      validateGroundedNarration(prose, c.setup.committedReceipts as any, {
        forbiddenConsequences: (exp.forbiddenFacts ?? []) as string[],
      });
    } catch (e: any) {
      for (const v of e?.violations ?? []) groundingViolations.push({ code: v.code, detail: v.detail });
    }
  }

  g.fabrication = fabrication;
  g.leaks = leaks;
  g.missing = missing;
  g.groundingViolations = groundingViolations;

  if (fabrication.length || leaks.length || missing.length || groundingViolations.length) {
    g.layer = 3; g.verdict = "incorrect";
    if (fabrication.length) g.reasons.push(`fabrication:${fabrication.join("|")}`);
    if (leaks.length) g.reasons.push(`leak:${leaks.join("|")}`);
    if (missing.length) g.reasons.push(`missing:${missing.join("|")}`);
    if (groundingViolations.length) g.reasons.push(`grounding:${groundingViolations.map((v) => v.code).join("|")}`);
    return finish(g, r, { np, nBoth, prose });
  }

  g.layer = 3;
  g.verdict = "correct";
  return finish(g, r, { np, nBoth, prose });
}

function finish(g: any, r: any, extra?: any) {
  g.firstAttemptCorrect = g.verdict === "correct";
  g.calledTool = g.calledTool ?? null;
  g.toolCallCount = (r.toolCalls ?? []).length;
  g.latencyMs = r.latencyMs ?? null;
  g.usage = r.usage ?? null;
  g.finishReason = r.finishReason ?? null;
  g.reasoningBytes = (r.reasoningContent ?? "").length;
  g.promptSha256 = r.promptSha256 ?? null;
  if (extra) { g.proseChars = extra.prose.length; g.prose = extra.prose; }
  return g;
}

// ------------------------------------------------------------------ run
const argv = process.argv.slice(2);
const argOf = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const rawPath = argOf("--raw", "");
const outPath = argOf("--out", rawPath.replace(/\.json$/, "-graded.json"));
if (!rawPath) { console.error("usage: --raw <file.json> [--out <file.json>]"); process.exit(2); }

const raw = JSON.parse(readFileSync(rawPath, "utf8"));
const graded = [];
for (const r of raw.results) {
  const c = casesById.get(r.id);
  if (!c) { console.error(`raw result ${r.id} is not in the corpus`); process.exit(2); }
  graded.push(grade(c, r));
}

const out = { model: raw.model, endpoint: raw.endpoint, caseCount: raw.caseCount, graded };
writeFileSync(outPath, JSON.stringify(out, null, 1), "utf8");

const n = graded.length;
const valid = graded.filter((g) => g.firstAttemptValid).length;
const correct = graded.filter((g) => g.firstAttemptCorrect).length;
console.log(`model ${raw.model}`);
console.log(`  graded            ${n}`);
console.log(`  firstAttemptValid ${valid}/${n}`);
console.log(`  firstAttemptCorrect ${correct}/${n}`);
console.log(`  wrote ${outPath}`);