#!/usr/bin/env node
/** Ad-hoc probe: send one request and dump the RAW response JSON. */
import { readFileSync, existsSync } from "node:fs";
const endpoint = process.argv[2] ?? "http://127.0.0.1:8081/v1";
const raw = process.argv[3];
// Accept inline JSON or a path to a .json file, to avoid shell quoting problems.
const body = JSON.parse((existsSync(raw) ? readFileSync(raw, "utf8") : raw).replace(/^\uFEFF/, ""));

const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  const j = JSON.parse(text);
  console.log("finish_reason :", j.choices?.[0]?.finish_reason);
  console.log("usage         :", JSON.stringify(j.usage));
  const m = j.choices?.[0]?.message ?? {};
  console.log("keys          :", Object.keys(m).join(", "));
  console.log("content       :", JSON.stringify(m.content));
  if (m.reasoning_content) console.log("reasoning     :", JSON.stringify(m.reasoning_content).slice(0, 500));
  console.log("tool_calls    :", JSON.stringify(m.tool_calls));
  if (m.tool_calls) for (const c of m.tool_calls) console.log("   ->", c.function?.name, c.function?.arguments);
} catch {
  console.log("raw:", text.slice(0, 1200));
}