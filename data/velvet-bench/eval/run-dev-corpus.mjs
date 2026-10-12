#!/usr/bin/env node
/**
 * Run the frozen dev partition against one model, and record RAW responses only.
 *
 * Deliberately does no grading. Grading lives in grade-dev-corpus.mjs so that it stays
 * pure, deterministic and re-runnable against saved responses without re-querying the model.
 *
 * Usage: node run-dev-corpus.mjs --model <alias> --out <file.json> [--endpoint url]
 *
 * Controls held identical for every model (see REPORT):
 *   messages = [system: setup.systemPrompt] + setup.history + [user: setup.input]
 *   tools passed through byte-for-byte from the corpus
 *   tool_choice "auto"  -- never forced, so initiation vs abstention stays measurable
 *   temperature 0 (greedy), top_p 1, max_tokens 1024
 *   reasoning_effort "none" on BOTH models (Qwen3-8B needs it per-request; the
 *     Qwen3.5 server additionally runs --reasoning off, so both end with reasoning off)
 *
 * pass@1: exactly one request per case, no retries, ever.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const model = arg("--model");
const out = arg("--out");
const endpoint = arg("--endpoint", "http://127.0.0.1:8081/v1");
const limit = Number(arg("--limit", "0")) || 0;   // smoke-test escape hatch; 0 = all cases
if (!model || !out) { console.error("usage: --model <alias> --out <file>"); process.exit(2); }

const DIR = "data/velvet-bench/eval/dev-cases";
const sha = (v) => createHash("sha256").update(v).digest("hex");

/** Load every case, ordered by category then id so both models see the same sequence. */
const cases = [];
for (const f of readdirSync(DIR).sort()) {
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  for (const c of j.cases) cases.push({ ...c, _category: j.category ?? f.replace(".json", "") });
}
cases.sort((a, b) => (a._category === b._category ? a.id.localeCompare(b.id) : a._category.localeCompare(b._category)));

const queue = limit ? cases.slice(0, limit) : cases;

console.log(`model     : ${model}`);
console.log(`endpoint  : ${endpoint}`);
console.log(`cases     : ${cases.length}`);

const results = [];
if (existsSync(out)) {
  const prior = JSON.parse(readFileSync(out, "utf8"));
  if (prior.model === model) {
    results.push(...prior.results);
    console.log(`resuming  : ${results.length} already recorded`);
  }
}
const done = new Set(results.map((r) => r.id));

for (const c of queue) {
  if (done.has(c.id)) continue;

  const messages = [
    { role: "system", content: c.setup.systemPrompt },
    ...(c.setup.history ?? []),
    { role: "user", content: c.input },
  ];
  const tools = c.tools ?? [];
  const body = {
    model,
    messages,
    ...(tools.length ? { tools } : {}),
    tool_choice: "auto",
    temperature: 0,
    top_p: 1,
    max_tokens: 1024,
    reasoning_effort: "none",
    stream: false,
  };

  // Hash of everything the model sees EXCEPT the alias, so we can prove across the two
  // model runs that the prompts were byte-identical.
  const promptSha = sha(JSON.stringify({ messages, tools }));

  const t0 = performance.now();
  let rec;
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* leave null */ }
    const msg = j?.choices?.[0]?.message ?? null;
    rec = {
      id: c.id,
      category: c._category,
      promptSha256: promptSha,
      httpStatus: res.status,
      latencyMs: Math.round(performance.now() - t0),
      finishReason: j?.choices?.[0]?.finish_reason ?? null,
      content: msg?.content ?? null,
      reasoningContent: msg?.reasoning_content ?? null,
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({
        name: t.function?.name ?? null,
        argumentsRaw: t.function?.arguments ?? null,
      })),
      usage: j?.usage ?? null,
      error: j?.error ?? (j ? null : text.slice(0, 400)),
    };
  } catch (e) {
    rec = {
      id: c.id, category: c._category, promptSha256: promptSha, httpStatus: 0,
      latencyMs: Math.round(performance.now() - t0), finishReason: null,
      content: null, reasoningContent: null, toolCalls: [], usage: null,
      error: { message: String(e?.message ?? e) },
    };
  }

  results.push(rec);
  writeFileSync(out, JSON.stringify({ model, endpoint, caseCount: cases.length, results }, null, 1), "utf8");

  const n = results.length;
  const tc = rec.toolCalls?.length ?? 0;
  console.log(
    `[${String(n).padStart(3)}/${queue.length}] ${rec.id.padEnd(38)} http=${rec.httpStatus} ` +
    `finish=${String(rec.finishReason).padEnd(11)} calls=${tc} ${rec.latencyMs}ms`
  );
}

console.log(`\nwrote ${out} (${results.length} results)`);