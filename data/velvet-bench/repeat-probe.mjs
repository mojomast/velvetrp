#!/usr/bin/env node
/**
 * Repeat one request N times and report the raw response each time.
 * Used to distinguish an intermittent backend behaviour from a deterministic one.
 *
 * Usage: node repeat-probe.mjs <body.json> <n> [endpoint] [--model <alias>]
 *
 * --model replaces ONLY the `model` field, so the prompt payload stays byte-identical
 * across models. That is what makes a cross-model adherence comparison valid.
 */
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const raw = argv[0];
const n = Number(argv[1] ?? 5);
const endpoint = argv[2]?.startsWith("--") ? "http://127.0.0.1:8081/v1" : (argv[2] ?? "http://127.0.0.1:8081/v1");
const mi = argv.indexOf("--model");
const modelOverride = mi >= 0 ? argv[mi + 1] : null;

const body = JSON.parse((existsSync(raw) ? readFileSync(raw, "utf8") : raw).replace(/^\uFEFF/, ""));
if (modelOverride) body.model = modelOverride;

for (let i = 1; i <= n; i++) {
  const t0 = performance.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  const m = j?.choices?.[0]?.message ?? {};
  const tc = Array.isArray(m.tool_calls) ? m.tool_calls : null;
  const ms = Math.round(performance.now() - t0);
  const argPreview = tc?.[0] ? (tc[0].function?.arguments === undefined ? "<<UNDEFINED>>" : String(tc[0].function.arguments).slice(0, 90)) : null;
  console.log(
    `#${i} http=${res.status} ${ms}ms finish=${j?.choices?.[0]?.finish_reason} ` +
    `toolCalls=${tc ? tc.length : 0} name=${tc?.[0]?.function?.name ?? "-"} args=${argPreview ?? "-"} ` +
    `completion=${j?.usage?.completion_tokens} reasoning=${Boolean(m.reasoning_content)}`
  );
}