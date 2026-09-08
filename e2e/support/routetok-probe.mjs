import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787/v1";
const DEFAULT_MODEL = "openrouter:qwen/qwen3.7-flash";

const objectSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export function buildProbePayload(scenario, model = DEFAULT_MODEL) {
  if (scenario === "planning-travel") {
    const candidates = [
      { candidateId: "candidate-place", description: "Travel from Parc des Pionniers to Place La Salle." },
      { candidateId: "candidate-gilles", description: "Travel from Parc des Pionniers to Pointe-Saint-Gilles." },
    ];
    return {
      model,
      messages: [
        { role: "system", content: "Select exactly one advertised legal travel candidate matching the player intent. Return no prose." },
        { role: "user", content: "From Parc des Pionniers, travel specifically to Place La Salle, not Pointe-Saint-Gilles." },
      ],
      tools: [{ type: "function", function: {
        name: "exact_actor_travel.select",
        description: "Select one exact labeled travel route.",
        parameters: {
          ...objectSchema({
            candidateId: { type: "string", enum: candidates.map(({ candidateId }) => candidateId) },
            kind: { type: "string", enum: ["actor.travel"] },
            version: { type: "string", enum: ["v1"] },
            choices: { type: "array", maxItems: 0 },
          }, ["candidateId", "kind", "version", "choices"]),
          oneOf: candidates.map(({ candidateId, description }) => ({
            ...objectSchema({
              candidateId: { type: "string", const: candidateId },
              kind: { type: "string", const: "actor.travel" },
              version: { type: "string", const: "v1" },
              choices: { type: "array", maxItems: 0 },
            }, ["candidateId", "kind", "version", "choices"]),
            description,
          })),
        },
      } }],
      tool_choice: "auto",
      stream: false,
      max_tokens: 512,
    };
  }

  if (scenario === "planning-inventory") {
    const candidates = [
      { candidateId: "candidate-unequip", digest: "a".repeat(64), description: "Unequip one Waylamp from the hand slot and retain it." },
      { candidateId: "candidate-drop", digest: "b".repeat(64), description: "Drop one Waylamp and remove it from inventory." },
    ];
    return {
      model,
      messages: [
        { role: "system", content: "Select exactly one advertised inventory candidate matching the player intent. Return no prose." },
        { role: "user", content: "Unequip the Waylamp from my hand. Do not drop it." },
      ],
      tools: [{ type: "function", function: {
        name: "exact_inventory_action.select",
        description: "Select one exact labeled inventory action.",
        parameters: {
          ...objectSchema({
            candidateId: { type: "string", enum: candidates.map(({ candidateId }) => candidateId) },
            digest: { type: "string", enum: candidates.map(({ digest }) => digest) },
          }, ["candidateId", "digest"]),
          oneOf: candidates.map(({ candidateId, digest, description }) => ({
            ...objectSchema({
              candidateId: { type: "string", const: candidateId },
              digest: { type: "string", const: digest },
            }, ["candidateId", "digest"]),
            description,
          })),
        },
      } }],
      tool_choice: "auto",
      stream: false,
      max_tokens: 512,
    };
  }

  if (scenario === "narration") {
    return {
      model,
      messages: [
        { role: "system", content: "Call submit_adventure_narration exactly once. The verified travel receipt establishes arrival at Place La Salle." },
        { role: "user", content: "Write concise second-person narration grounded only in that receipt." },
      ],
      tools: [{ type: "function", function: {
        name: "submit_adventure_narration",
        description: "Submit final grounded narration.",
        parameters: objectSchema({ narration: { type: "string", minLength: 1, maxLength: 8_000 } }, ["narration"]),
      } }],
      tool_choice: { type: "function", function: { name: "submit_adventure_narration" } },
      stream: false,
      max_tokens: 768,
    };
  }

  throw new Error(`unknown probe scenario: ${scenario}`);
}

export function validateProbeResponse(scenario, payload) {
  const call = payload?.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (!call || typeof call.arguments !== "string") return { valid: false, selected: null };
  let args;
  try { args = JSON.parse(call.arguments); } catch { return { valid: false, selected: null }; }
  if (scenario === "planning-travel") {
    return { valid: call.name === "exact_actor_travel.select" && args.candidateId === "candidate-place", selected: args.candidateId ?? null };
  }
  if (scenario === "planning-inventory") {
    return { valid: call.name === "exact_inventory_action.select" && args.candidateId === "candidate-unequip" && args.digest === "a".repeat(64), selected: args.candidateId ?? null };
  }
  return { valid: call.name === "submit_adventure_narration" && typeof args.narration === "string" && args.narration.includes("Place La Salle"), selected: null };
}

function parseArgs(argv) {
  const scenario = argv[0];
  if (!["planning-travel", "planning-inventory", "narration"].includes(scenario)) {
    throw new Error("usage: node e2e/support/routetok-probe.mjs <planning-travel|planning-inventory|narration> [--model <id>]");
  }
  let model = DEFAULT_MODEL;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== "--model" || !argv[index + 1]) throw new Error(`unknown argument: ${argv[index]}`);
    model = argv[++index];
  }
  return { scenario, model };
}

async function main() {
  const { scenario, model } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.PROXY_API_KEY?.trim();
  if (!apiKey) throw new Error("PROXY_API_KEY is required");
  const baseUrl = (process.env.ROUTETOK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "X-Source": "opencode",
      "User-Agent": process.env.OPENROUTER_USER_AGENT?.trim() || "opencode/1.15.13",
    },
    body: JSON.stringify(buildProbePayload(scenario, model)),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* invalid responses remain safely summarized */ }
  const validation = response.ok ? validateProbeResponse(scenario, payload) : { valid: false, selected: null };
  const result = {
    scenario,
    requestedModel: model,
    status: response.status,
    elapsedMs: Math.round(performance.now() - startedAt),
    routerModel: response.headers.get("x-router-model"),
    routerRoute: response.headers.get("x-router-route"),
    routerProvider: response.headers.get("x-router-provider"),
    routerAttempts: response.headers.get("x-router-attempts"),
    valid: validation.valid,
    selected: validation.selected,
    errorCode: payload?.error?.code ?? null,
    usage: payload?.usage ? {
      promptTokens: payload.usage.prompt_tokens ?? null,
      completionTokens: payload.usage.completion_tokens ?? null,
      totalTokens: payload.usage.total_tokens ?? null,
      cost: payload.usage.cost ?? null,
    } : null,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!response.ok || !validation.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "probe failed"}\n`);
    process.exitCode = 1;
  });
}
