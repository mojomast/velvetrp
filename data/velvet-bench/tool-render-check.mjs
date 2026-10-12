#!/usr/bin/env node
/**
 * Tool-rendering sanity check.
 *
 * WHY
 * ---
 * RPMax v1.3 failed SILENTLY: a request carrying a full tool schema reported
 * prompt_tokens: 20, because its 348-character chat template never renders `tools`.
 * llama.cpp emitted no warning and returned HTTP 200. The failure only surfaced
 * downstream as a `protocol` classification.
 *
 * So before trusting ANY tool-adherence number we must prove the tools actually
 * reached the template. This sends the SAME conversation twice — once with a
 * multi-tool schema, once with no tools — and compares prompt_tokens.
 *
 * Pass condition: prompt_tokens(with tools) must be substantially greater than
 * prompt_tokens(no tools). A near-identical count means the tools were dropped.
 *
 * A second pass then requires an actual parseable tool call under the named parser.
 *
 * Usage: node tool-render-check.mjs <config.json> <modelId> [endpoint]
 * Exit:  0 = tools render + tool call parses
 *        2 = tools do NOT render  (STOP, do not report adherence)
 *        1 = tools render but no tool call parsed
 */
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const cfgPath = argv[0], modelId = argv[1];
const cfg = JSON.parse((existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : cfgPath).replace(/^\uFEFF/, ""));
const model = cfg.models.find(m => m.id === modelId);
if (!model) { console.error(`unknown model ${modelId}`); process.exit(2); }
const endpoint = argv[2] ?? `http://${cfg.gateway.host}:${cfg.gateway.port}/v1`;

const MESSAGES = [
  { role: "system", content: "You are a planning assistant. Choose the single best tool, or none." },
  { role: "user", content: '{"declaration":"I travel to the Docks.","candidates":["market","docks","chapel"]}' },
];
const TOOLS = [
  { type: "function", function: { name: "propose_travel", description: "Propose travel to a mapped destination.",
      parameters: { type: "object", properties: { destination: { type: "string", enum: ["market", "docks", "chapel"] } },
                    required: ["destination"], additionalProperties: false } } },
  { type: "function", function: { name: "propose_check", description: "Propose a skill check.",
      parameters: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"], additionalProperties: false } } },
  { type: "function", function: { name: "submit_adventure_narration", description: "Return the public DM response.",
      parameters: { type: "object", properties: { narration: { type: "string" } }, required: ["narration"], additionalProperties: false } } },
];

async function chat(body) {
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: model.alias, ...body }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  return { ok: res.ok, status: res.status, json: j, raw: text };
}

console.log(`\n=== tool-rendering sanity check: ${modelId} ===`);
console.log(`endpoint : ${endpoint}`);

// --- 1. prompt_tokens with vs without tools -----------------------------------------------------
const withTools = await chat({ messages: MESSAGES, tools: TOOLS, tool_choice: "auto",
                               max_tokens: 1, temperature: 0 });
const noTools   = await chat({ messages: MESSAGES, max_tokens: 1, temperature: 0 });

const pWith = withTools.json?.usage?.prompt_tokens ?? -1;
const pNone = noTools.json?.usage?.prompt_tokens ?? -1;
const delta = pWith - pNone;
const ratio = pNone > 0 ? pWith / pNone : NaN;

console.log(`\nprompt_tokens WITH tools    : ${pWith}`);
console.log(`prompt_tokens WITHOUT tools : ${pNone}`);
console.log(`delta                       : ${delta}  (x${isFinite(ratio) ? ratio.toFixed(2) : "?"})`);

const renders = pWith > 0 && pNone > 0 && delta >= 50;
console.log(`\ntools rendered into prompt   : ${renders ? "YES" : "NO — STOP, this is an unusable comparison"}`);

if (!renders) {
  console.log(`\nwith-tools raw : ${(withTools.raw ?? "").slice(0, 400)}`);
  console.log(`\nA near-zero delta means the chat template ignores the tools array, exactly as RPMax did.`);
  console.log(`Do NOT report an adherence number from this model.`);
  process.exit(2);
}

// --- 2. does a tool call actually parse? -------------------------------------------------------
const forced = await chat({ messages: MESSAGES, tools: TOOLS, tool_choice: "required",
                            max_tokens: 512, temperature: 0 });
const calls = forced.json?.choices?.[0]?.message?.tool_calls;
let parsed = null, parseOk = false;
if (calls?.length) {
  const a = calls[0]?.function?.arguments;
  try { parsed = JSON.parse(a); parseOk = !!parsed && typeof parsed === "object"; }
  catch { parseOk = false; }
}
console.log(`\nforced tool_choice -> callCount : ${calls?.length ?? 0}`);
console.log(`name                            : ${calls?.[0]?.function?.name ?? "-"}`);
console.log(`arguments                       : ${calls?.[0]?.function?.arguments?.slice(0, 120) ?? "-"}`);
console.log(`arguments parse to object       : ${parseOk}`);
if (!parseOk) console.log(`raw : ${(forced.raw ?? "").slice(0, 400)}`);

console.log(`\nRESULT: tools render=${renders}  tool call parses=${parseOk}`);
process.exit(parseOk ? 0 : 1);