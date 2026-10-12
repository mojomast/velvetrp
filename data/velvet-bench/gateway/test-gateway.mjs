#!/usr/bin/env node
/**
 * Unit tests for the gateway's request adaptation.
 *
 * These lock down the single behaviour the gateway exists for: turning OpenAI
 * named tool_choice into something llama.cpp actually honours, without touching
 * anything else in the request.
 *
 * Run: node test-gateway.mjs
 */
import { adaptRequestBody } from "./velvet-llm-gateway.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

console.log("\ngateway adaptation tests\n");

// 1. Named tool choice with several advertised tools -> single tool + required
{
  const body = {
    model: "m",
    tools: [
      { type: "function", function: { name: "propose_travel", parameters: { type: "object" } } },
      { type: "function", function: { name: "propose_commerce", parameters: { type: "object" } } },
      { type: "function", function: { name: "submit_adventure_narration", parameters: { type: "object" } } },
    ],
    tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
  };
  const { body: out } = adaptRequestBody(structuredClone(body));
  check("named choice filters tools to one", out.tools.length === 1, out.tools?.length);
  check("named choice keeps the named tool", out.tools[0].function.name === "submit_adventure_narration");
  check("named choice becomes required", out.tool_choice === "required", out.tool_choice);
  check("model untouched", out.model === "m");
}

// 2. Single advertised tool + named choice -> still required, tool list unchanged
{
  const body = {
    model: "m",
    tools: [{ type: "function", function: { name: "submit_adventure_narration", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
  };
  const { body: out } = adaptRequestBody(structuredClone(body));
  check("single-tool named choice -> required", out.tool_choice === "required");
  check("single-tool list preserved", out.tools.length === 1);
}

// 3. Named choice referencing an unknown tool must NOT silently pick a tool
{
  const body = {
    model: "m",
    tools: [{ type: "function", function: { name: "other", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "missing" } },
  };
  const { body: out, notes } = adaptRequestBody(structuredClone(body));
  const noted = notes.some((n) => n.kind === "named-tool-choice-unknown-tool");
  check("unknown named tool is recorded, not guessed", noted, notes);
  check("unknown named tool does not invent a tool", out.tools.every((t) => t.function.name === "other"));
}

// 4. tool_choice "required" / "auto" / "none" pass through untouched
for (const tc of ["required", "auto", "none"]) {
  const body = { model: "m", tools: [{ type: "function", function: { name: "t", parameters: {} } }], tool_choice: tc };
  const { body: out } = adaptRequestBody(structuredClone(body));
  check(`tool_choice '${tc}' unchanged`, out.tool_choice === tc, out.tool_choice);
}

// 5. Strict JSON schema is preserved verbatim (llama.cpp ignores `strict` but enforces the grammar)
{
  const schema = { type: "object", properties: { marker: { type: "string", const: "x" } }, required: ["marker"], additionalProperties: false };
  const body = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    response_format: { type: "json_schema", json_schema: { name: "n", schema, strict: true } },
    tool_choice: "none",
  };
  const { body: out, notes } = adaptRequestBody(structuredClone(body));
  check("json_schema preserved", JSON.stringify(out.response_format) === JSON.stringify(body.response_format));
  check("strict flag preserved", out.response_format.json_schema.strict === true);
  check("json_schema observed", notes.some((n) => n.kind === "json-schema"));
}

// 6. Messages, temperature, stream and other fields are never modified
{
  const body = {
    model: "m",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    temperature: 0.7, stream: true, max_tokens: 4096,
    tool_choice: { type: "function", function: { name: "t" } },
    tools: [{ type: "function", function: { name: "t", parameters: {} } }],
  };
  const { body: out } = adaptRequestBody(structuredClone(body));
  check("messages unchanged", JSON.stringify(out.messages) === JSON.stringify(body.messages));
  check("temperature unchanged", out.temperature === 0.7);
  check("stream unchanged", out.stream === true);
  check("max_tokens unchanged", out.max_tokens === 4096);
}

// 7. Non-object / malformed bodies are returned untouched
{
  check("null body survives", adaptRequestBody(null).body === null);
  check("string body survives", adaptRequestBody("x").body === "x");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);