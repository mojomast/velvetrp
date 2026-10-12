#!/usr/bin/env node
/**
 * RPG provider-contract conformance suite.
 *
 * WHY THIS EXISTS SEPARATELY FROM VELVET'S PREFLIGHT
 * --------------------------------------------------
 * Velvet's `POST /api/provider/preflight` runs two minimal probes. They establish
 * that a model can emit one forced tool call and one strict JSON object. They do
 * NOT establish the contracts the RPG lanes actually depend on:
 *
 *   - a NAMED forced tool call (narration) with an exactly-one-key argument object
 *   - correct tool SELECTION when several tools are advertised with tool_choice "auto"
 *     (adventure planning)
 *   - a valid tool-result round trip (the next turn must replay tool messages)
 *   - exact enum candidate arguments (DM decisions are closed enums, not free text)
 *   - abstention: declining to call a tool when no mechanic applies
 *
 * Each probe below is modelled on a real VelvetRP request shape (see
 * server/src/routes/rpg/v1/adventureTurns.ts and server/src/provider/*).
 * Results are pass/fail per probe with the observed evidence recorded, so a model
 * limitation is attributable to the model, the backend, or the adapter.
 *
 * Nothing here weakens or substitutes for VelvetRP's own validation; it only adds
 * evidence, and it runs against the live model through the configured endpoint.
 *
 * Usage:
 *   node run-conformance.mjs --config <bench.config.json> --model <id> --out <file.json>
 *                             [--endpoint http://127.0.0.1:8081/v1]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const configPath = arg("config");
const modelId = arg("model");
const outPath = arg("out");
const rawEndpoint = arg("endpoint", null);

if (!configPath || !modelId) {
  console.error("usage: node run-conformance.mjs --config <path> --model <id> --out <path> [--endpoint url]");
  process.exit(2);
}

// PowerShell's `Set-Content -Encoding UTF8` writes a BOM, which JSON.parse rejects.
const config = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
const model = config.models.find((m) => m.id === modelId);
if (!model) { console.error(`unknown model '${modelId}'`); process.exit(2); }

const endpoint = rawEndpoint ?? `http://${config.gateway.host}:${config.gateway.port}/v1`;
const modelName = model.alias;
const TIMEOUT_MS = Number(arg("timeout", "600")) * 1000;

/**
 * VelvetRP sends `reasoning_effort: "none"` on every RPG tool-call dispatch
 * (see openAiCompatibleCompletion.ts, where it is described as "the RPG tool-call
 * signal"). Its capability *preflight* deliberately does NOT send it.
 *
 * This distinction is load-bearing for hybrid reasoning models such as Qwen3, which
 * otherwise spend the entire token budget on thinking and never emit the tool call.
 * The probes below mirror which Velvet lane each one represents.
 */
const TOOL_CALL_SIGNAL = { reasoning_effort: "none" };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function chat(body, { stream = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.velvet.apiKey}` },
      body: JSON.stringify({ model: modelName, ...body }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { ok: res.ok, status: res.status, json, raw: text, ms: performance.now() - t0, stream };
  } finally {
    clearTimeout(timer);
  }
}

/** Streaming probe: measures TTFT and confirms incremental deltas. */
async function chatStream(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelName, ...body, stream: true }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, error: await res.text(), ttftMs: null, chunks: 0 };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", chunks = 0, ttftMs = null, firstContent = "", toolArgAcc = "", finishReason = null, sawToolCall = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let o; try { o = JSON.parse(payload); } catch { continue; }
        const d = o.choices?.[0]?.delta;
        if (!d) continue;
        chunks++;
        // Hybrid reasoning models emit `reasoning_content` deltas before any `content`.
        // Counting only content made TTFT look like it never happened.
        if (ttftMs === null && (d.content || d.tool_calls || d.reasoning_content)) ttftMs = performance.now() - t0;
        if (d.content) firstContent += d.content;
        if (Array.isArray(d.tool_calls)) {
          sawToolCall = true;
          for (const tc of d.tool_calls) if (tc.function?.arguments) toolArgAcc += tc.function.arguments;
        }
        if (o.choices?.[0]?.finish_reason) finishReason = o.choices[0].finish_reason;
      }
    }
    return {
      ok: true, status: res.status, chunks, ttftMs, totalMs: performance.now() - t0,
      content: firstContent, toolArguments: toolArgAcc, sawToolCall, finishReason,
    };
  } finally { clearTimeout(timer); }
}

const probes = [];
function record(id, requirement, passed, evidence) {
  probes.push({ id, requirement, passed, evidence });
  const tag = passed ? "PASS" : "FAIL";
  const color = passed ? "\x1b[32m" : "\x1b[31m";
  console.log(`  [${color}${tag}\x1b[0m] ${id} — ${requirement}`);
  if (!passed) console.log(`         evidence: ${JSON.stringify(evidence).slice(0, 400)}`);
}

/**
 * OpenAI tool_calls entries are { id, type, function: { name, arguments } }.
 * The arguments live under `function`, NOT at the top level of the call object.
 */
const parseArgs = (call) => {
  const args = call?.function?.arguments;
  if (typeof args !== "string") return { ok: false, error: `missing function.arguments (got ${typeof args})` };
  try { return { ok: true, value: JSON.parse(args) }; } catch (e) { return { ok: false, error: String(e) }; }
};

// ---------------------------------------------------------------------------------------------
// 1. Basic chat
// ---------------------------------------------------------------------------------------------
{
  const r = await chat({
    messages: [{ role: "user", content: "Reply with exactly the word: READY" }],
    max_tokens: 16, temperature: 0,
  });
  record("basic-chat", "OpenAI-compatible chat completion returns assistant content",
    r.ok && typeof r.json?.choices?.[0]?.message?.content === "string",
    { status: r.status, content: r.json?.choices?.[0]?.message?.content, ms: Math.round(r.ms) });
}

// ---------------------------------------------------------------------------------------------
// 2. Streaming
// ---------------------------------------------------------------------------------------------
{
  const r = await chatStream({
    messages: [{ role: "user", content: "Count slowly from one to five, separated by spaces." }],
    max_tokens: 48, temperature: 0.3,
  });
  record("streaming", "Streaming yields incremental deltas and a measurable TTFT",
    !!r.ok && r.chunks > 1 && r.ttftMs !== null,
    { chunks: r.chunks, ttftMs: r.ttftMs ? Math.round(r.ttftMs) : null, totalMs: r.totalMs ? Math.round(r.totalMs) : null, finishReason: r.finishReason });
}

// ---------------------------------------------------------------------------------------------
// 3. Forced tool call ("required") — the preflight function-tools shape
// ---------------------------------------------------------------------------------------------
const PROBE_NONCE = "velvet-capability-v1";
{
  const r = await chat({
    messages: [{ role: "user", content: `Return the exact marker ${PROBE_NONCE}.` }],
    tools: [{
      type: "function",
      function: {
        name: "velvet_capability_probe",
        parameters: { type: "object", properties: { marker: { type: "string", const: PROBE_NONCE } }, required: ["marker"], additionalProperties: false },
      },
    }],
    tool_choice: "required",
    // Velvet's preflight does not cap maxTokens this tightly. 64 is too small for a hybrid
    // reasoning model to finish thinking and still emit the call, which would report a
    // harness limitation as a model failure.
    max_tokens: 512, temperature: 0,
  });
  const calls = r.json?.choices?.[0]?.message?.tool_calls;
  const p = calls?.length === 1 ? parseArgs(calls[0]) : { ok: false };
  record("forced-tool-call", "tool_choice 'required' yields exactly one schema-bound tool call",
    r.ok && calls?.length === 1 && calls[0].function?.name === "velvet_capability_probe" && p.ok && p.value?.marker === PROBE_NONCE,
    { status: r.status, callCount: calls?.length, name: calls?.[0]?.function?.name, args: p.value ?? p.error,
      rawToolCalls: calls ? JSON.parse(JSON.stringify(calls)) : null,
      raw: r.raw?.slice(0, 500) });
}

// ---------------------------------------------------------------------------------------------
// 4. NAMED forced tool call — the narration contract
// ---------------------------------------------------------------------------------------------
{
  const narrationTool = {
    type: "function",
    function: {
      name: "submit_adventure_narration",
      description: "Return the public DM response.",
      parameters: { type: "object", properties: { narration: { type: "string", description: "1-3 short paragraphs." } }, required: ["narration"], additionalProperties: false },
    },
  };
  const r = await chat({
    messages: [
      { role: "system", content: "You are the DM. Return the response by calling submit_adventure_narration exactly once; do not answer with content alone." },
      { role: "user", content: "I look around the harbour market." },
    ],
    tools: [narrationTool],
    tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
    max_tokens: 400, temperature: 0.7,
    ...TOOL_CALL_SIGNAL,
  });
  const calls = r.json?.choices?.[0]?.message?.tool_calls;
  const p = calls?.length === 1 ? parseArgs(calls[0]) : { ok: false, error: `callCount=${calls?.length ?? 0}` };
  const keys = p.value && typeof p.value === "object" ? Object.keys(p.value) : [];
  const narration = p.value?.narration;
  record("named-tool-call-narration",
    "Named tool_choice is honoured: exactly one submit_adventure_narration call whose arguments are a one-key {narration:string}",
    r.ok && calls?.length === 1 && calls[0].function?.name === "submit_adventure_narration"
      && p.ok && keys.length === 1 && typeof narration === "string" && narration.trim().length > 0,
    {
      status: r.status,
      callCount: calls?.length,
      name: calls?.[0]?.function?.name,
      argumentKeys: keys,
      narrationChars: typeof narration === "string" ? narration.length : null,
      finishReason: r.json?.choices?.[0]?.finish_reason,
      error: p.error,
      rawToolCalls: calls ? JSON.parse(JSON.stringify(calls)) : null,
      raw: r.raw?.slice(0, 500),
    });
}

// ---------------------------------------------------------------------------------------------
// 5. Tool SELECTION with "auto" — the adventure planning contract
// ---------------------------------------------------------------------------------------------
{
  const tools = [
    { type: "function", function: { name: "propose_travel", parameters: { type: "object", properties: { destination: { type: "string", enum: ["market", "docks", "chapel"] } }, required: ["destination"], additionalProperties: false } } },
    { type: "function", function: { name: "propose_commerce", parameters: { type: "object", properties: { vendorId: { type: "string" } }, required: ["vendorId"], additionalProperties: false } } },
    { type: "function", function: { name: "submit_adventure_narration", parameters: { type: "object", properties: { narration: { type: "string" } }, required: ["narration"], additionalProperties: false } } },
  ];
  const r = await chat({
    messages: [
      { role: "system", content: "Plan exactly one supported action for the player's declaration. Choose the single best tool." },
      { role: "user", content: JSON.stringify({ declaration: "I travel to the Docks.", candidates: ["market", "docks", "chapel"] }) },
    ],
    tools,
    tool_choice: "auto",
    max_tokens: 300, temperature: 0,
    ...TOOL_CALL_SIGNAL,
  });
  const calls = r.json?.choices?.[0]?.message?.tool_calls;
  const p = calls?.length === 1 ? parseArgs(calls[0]) : { ok: false, error: `callCount=${calls?.length ?? 0}` };
  const name = calls?.[0]?.function?.name;
  const dest = p.value?.destination;
  record("tool-selection-exact-candidate",
    "With several tools and tool_choice 'auto', the model selects propose_travel and the exact enumerated candidate",
    r.ok && name === "propose_travel" && dest === "docks",
    { status: r.status, callCount: calls?.length, name, destination: dest ?? null, error: p.error, argumentKeys: p.value ? Object.keys(p.value) : null });
}

// ---------------------------------------------------------------------------------------------
// 6. Tool-result replay — the second decision round
// ---------------------------------------------------------------------------------------------
{
  const tool = { type: "function", function: { name: "propose_travel", parameters: { type: "object", properties: { destination: { type: "string", enum: ["market", "docks", "chapel"] } }, required: ["destination"], additionalProperties: false } } };
  const first = await chat({
    messages: [
      { role: "system", content: "Plan exactly one supported action." },
      { role: "user", content: JSON.stringify({ declaration: "I travel to the Docks.", candidates: ["market", "docks", "chapel"] }) },
    ],
    tools: [tool], tool_choice: "required", max_tokens: 200, temperature: 0, ...TOOL_CALL_SIGNAL,
  });
  const calls = first.json?.choices?.[0]?.message?.tool_calls;
  let replay = null;
  if (calls?.length === 1) {
    replay = await chat({
      messages: [
        { role: "system", content: "Plan exactly one supported action." },
        { role: "user", content: JSON.stringify({ declaration: "I travel to the Docks.", candidates: ["market", "docks", "chapel"] }) },
        { role: "assistant", content: null, tool_calls: calls },
        { role: "tool", tool_call_id: calls[0].id, content: JSON.stringify({ ok: true, commandId: "cmd_1", facts: ["actor moved to docks"] }) },
        { role: "user", content: "Now write the narration for that result." },
      ],
      tools: [{ type: "function", function: { name: "submit_adventure_narration", parameters: { type: "object", properties: { narration: { type: "string" } }, required: ["narration"], additionalProperties: false } } }],
      tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
      max_tokens: 400, temperature: 0.5, ...TOOL_CALL_SIGNAL,
    });
  }
  const rcalls = replay?.json?.choices?.[0]?.message?.tool_calls;
  const rp = rcalls?.length === 1 ? parseArgs(rcalls[0]) : { ok: false };
  record("tool-result-replay",
    "A tool-result transcript is accepted and the next forced narration call still succeeds",
    !!replay?.ok && rcalls?.length === 1 && rcalls[0].function?.name === "submit_adventure_narration" && rp.ok && typeof rp.value?.narration === "string",
    { firstOk: first.ok, replayStatus: replay?.status, replayCallCount: rcalls?.length, name: rcalls?.[0]?.function?.name, error: rp.error, raw: replay?.raw?.slice(0, 300) });
}

// ---------------------------------------------------------------------------------------------
// 7. Strict JSON Schema — the campaign generation contract
// ---------------------------------------------------------------------------------------------
{
  const schema = {
    type: "object",
    properties: { marker: { type: "string", const: PROBE_NONCE } },
    required: ["marker"],
    additionalProperties: false,
  };
  const r = await chat({
    messages: [{ role: "user", content: `Return the exact marker ${PROBE_NONCE}.` }],
    response_format: { type: "json_schema", json_schema: { name: "velvet_capability_probe", schema, strict: true } },
    tool_choice: "none",
    max_tokens: 512, temperature: 0,
  });
  const content = r.json?.choices?.[0]?.message?.content;
  let parsed = null, ok = false;
  try {
    parsed = JSON.parse(content);
    ok = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.marker === PROBE_NONCE && Object.keys(parsed).length === 1;
  } catch { /* leave false */ }
  const strayToolCalls = r.json?.choices?.[0]?.message?.tool_calls?.length ?? 0;
  record("strict-json-schema",
    "response_format json_schema returns exactly one conforming object and no tool calls",
    r.ok && ok && strayToolCalls === 0,
    { status: r.status, content, parsed, strayToolCalls, raw: r.raw?.slice(0, 300) });
}

// ---------------------------------------------------------------------------------------------
// 8. Abstention — no mechanic, so no mutation tool
// ---------------------------------------------------------------------------------------------
{
  const tools = [
    { type: "function", function: { name: "propose_travel", parameters: { type: "object", properties: { destination: { type: "string" } }, required: ["destination"], additionalProperties: false } } },
    { type: "function", function: { name: "propose_commerce", parameters: { type: "object", properties: { vendorId: { type: "string" } }, required: ["vendorId"], additionalProperties: false } } },
  ];
  const r = await chat({
    messages: [
      { role: "system", content: "If the player's declaration proposes no supported mechanical change, call NO tool." },
      { role: "user", content: "I smile at the vendor and say good morning." },
    ],
    tools, tool_choice: "auto", max_tokens: 200, temperature: 0, ...TOOL_CALL_SIGNAL,
  });
  const calls = r.json?.choices?.[0]?.message?.tool_calls ?? [];
  const mutationCalled = calls.some((c) => ["propose_travel", "propose_commerce"].includes(c.function?.name));
  record("abstention-no-mutation",
    "A purely social declaration does not select a world-mutation tool",
    r.ok && !mutationCalled,
    { status: r.status, toolCalls: calls.map((c) => c.function?.name), raw: r.raw?.slice(0, 300) });
}

// ---------------------------------------------------------------------------------------------
// 9. No fabricated mechanism in narration
// ---------------------------------------------------------------------------------------------
{
  const r = await chat({
    messages: [
      { role: "system", content: "The player asked what is around them. No mechanics are committed. Do not assert movement, items, transactions, damage, quests, or any campaign change." },
      { role: "user", content: "I look around." },
    ],
    tools: [{ type: "function", function: { name: "submit_adventure_narration", parameters: { type: "object", properties: { narration: { type: "string" } }, required: ["narration"], additionalProperties: false } } }],
    tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
    max_tokens: 400, temperature: 0.5, ...TOOL_CALL_SIGNAL,
  });
  const calls = r.json?.choices?.[0]?.message?.tool_calls;
  const p = calls?.length === 1 ? parseArgs(calls[0]) : { ok: false };
  const text = typeof p.value?.narration === "string" ? p.value.narration : "";
  const fabrication = /\b(you (?:pick up|gain|receive|find)|your (?:gold|coins?|inventory) (?:increases|now)|you (?:deal|roll|take) \d+|damage|you win|you have been awarded)\b/i;
  const hit = fabrication.test(text);
  record("narration-no-fabrication",
    "Narration for a mechanic-free turn asserts no unearned mechanical outcome",
    !!r.ok && p.ok && typeof text === "string" && text.length > 0 && !hit,
    { status: r.status, chars: text.length, matchedFabrication: hit, sample: text.slice(0, 240), error: p.error,
      rawToolCalls: calls ? JSON.parse(JSON.stringify(calls)) : null,
      raw: r.raw?.slice(0, 500) });
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------
const passed = probes.filter((p) => p.passed).length;
const result = {
  model: modelId,
  alias: modelName,
  file: model.file,
  endpoint,
  viaGateway: endpoint.includes(String(config.gateway.port)),
  capturedUtc: new Date().toISOString(),
  velvetCommit: config.velvetCommit,
  passed,
  total: probes.length,
  allPassed: passed === probes.length,
  probes,
};

if (outPath) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n  conformance: ${passed}/${probes.length} passed -> ${outPath}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}

process.exit(result.allPassed ? 0 : 1);