#!/usr/bin/env node
/**
 * velvet-llm-gateway — a minimal OpenAI-compatible pass-through proxy for llama.cpp.
 *
 * WHY THIS EXISTS
 * ---------------
 * VelvetRP's RPG provider contract requires OpenAI *named* tool choice:
 *
 *   tool_choice: { "type": "function", "function": { "name": "submit_adventure_narration" } }
 *
 * llama.cpp's `/v1/chat/completions` reads `tool_choice` with a helper that only
 * accepts a JSON *string*. An object throws inside a try/catch, logs
 * "Wrong type supplied for parameter 'tool_choice'", and silently falls back to
 * "auto". The request is accepted, so this failure is invisible unless you check
 * the server log or measure forced-vs-auto behaviour.
 *
 * This gateway closes that gap WITHOUT weakening any VelvetRP validation:
 *   - Velvet still sends the named tool_choice it always sent.
 *   - We translate "force function X" into the pair llama.cpp does honour:
 *       tools = [X only]  +  tool_choice = "required"
 *     which is exactly the OpenAI semantics of named selection, for the single
 *     tool that OpenAI named selection would have permitted anyway.
 *   - Nothing else about the request is altered, and responses (including SSE
 *     streaming deltas) are forwarded byte-for-byte.
 *
 * What it deliberately does NOT do:
 *   - It does not repair malformed arguments or invent missing tool calls.
 *   - It does not relax the provider preflight or any local validator.
 *   - It never injects a tool call the model did not produce.
 *
 * If the model declines to call the (single, filtered) tool, llama.cpp's
 * "required" mode constrains generation to a tool call; if it still fails,
 * the failure surfaces to Velvet unchanged.
 */

import http from "node:http";
import { appendFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[i + 1] ?? "true");
}

const LISTEN_PORT = Number(args.get("port") ?? process.env.GATEWAY_PORT ?? 8081);
const LISTEN_HOST = args.get("host") ?? process.env.GATEWAY_HOST ?? "127.0.0.1";
const UPSTREAM = args.get("upstream") ?? process.env.GATEWAY_UPSTREAM ?? "http://127.0.0.1:9931";

const LOG = args.get("log") ?? process.env.GATEWAY_LOG ?? "";
const upstreamUrl = new URL(UPSTREAM.replace(/\/+$/, "") + "/");

/** Counters so the benchmark can prove whether the compatibility path was exercised. */
const stats = { requests: 0, namedToolChoiceRewrites: 0, toolChoiceNoneWithSchema: 0, streamed: 0, errors: 0 };

function log(obj) {
  if (!LOG) return;
  const line = `[${new Date().toISOString()}] ${JSON.stringify(obj)}\n`;
  appendFileSync(LOG, line);
}

/**
 * Rewrites one OpenAI chat-completions request body for llama.cpp.
 * Returns { body, notes } describing every change so evidence is never implicit.
 */
export function adaptRequestBody(body) {
  const notes = [];
  if (!body || typeof body !== "object") return { body, notes };

  const tc = body.tool_choice;

  // Named function selection -> single advertised tool + "required".
  if (tc && typeof tc === "object" && !Array.isArray(tc) && tc.type === "function") {
    const name = tc.function?.name;
    if (typeof name === "string" && name) {
      if (!Array.isArray(body.tools)) {
        notes.push({ kind: "named-tool-choice-without-tools", name });
        body.tool_choice = "required";
        stats.namedToolChoiceRewrites++;
        return { body, notes };
      }
      const match = body.tools.filter((t) => t?.function?.name === name);
      if (match.length === 0) {
        // Velvet validates this before dispatch; surface it rather than guessing.
        notes.push({ kind: "named-tool-choice-unknown-tool", name });
        body.tool_choice = "required";
        stats.namedToolChoiceRewrites++;
        return { body, notes };
      }
      if (body.tools.length !== 1) {
        notes.push({ kind: "named-tool-choice", name, toolsBefore: body.tools.length, toolsAfter: 1 });
        body.tools = [match[0]];
      } else {
        notes.push({ kind: "named-tool-choice", name, toolsBefore: 1, toolsAfter: 1 });
      }
      body.tool_choice = "required";
      stats.namedToolChoiceRewrites++;
    }
  }

  // llama.cpp ignores OpenAI's `strict` flag but enforces the schema as a grammar.
  // Velvet always sends strict:true; we keep it (harmless) and record that we saw it.
  const rf = body.response_format;
  if (rf && typeof rf === "object" && rf.type === "json_schema") {
    if (body.tool_choice === "none") stats.toolChoiceNoneWithSchema++;
    notes.push({ kind: "json-schema", strictRequested: rf.json_schema?.strict === true });
  }

  return { body, notes };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forward(req, res, method, pathname, rawBody) {
  const target = new URL(pathname + (req.url.includes("?") ? "?" + req.url.split("?")[1] : ""), upstreamUrl);
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers.connection;
  if (rawBody) headers["content-length"] = String(Buffer.byteLength(rawBody));

  const upstreamReq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
      up.on("error", () => { stats.errors++; res.destroy(); });
    },
  );
  upstreamReq.on("error", (e) => {
    stats.errors++;
    log({ event: "upstream-error", path: pathname, message: String(e?.message ?? e) });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `upstream unreachable: ${e?.message ?? e}`, type: "upstream_error" } }));
    } else res.destroy();
  });
  if (rawBody) upstreamReq.write(rawBody);
  upstreamReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];

  if (pathname === "/gateway/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ upstream: UPSTREAM, ...stats }, null, 2));
    return;
  }

  if (method_is(req, "POST") && pathname === "/v1/chat/completions") {
    stats.requests++;
    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      // Not our business: forward untouched so llama.cpp reports the real error.
      await forward(req, res, "POST", pathname, raw);
      return;
    }
    const { body: adapted, notes } = adaptRequestBody(body);
    if (adapted.stream) stats.streamed++;
    if (notes.length) {
      log({
        event: "adapt",
        model: adapted.model,
        stream: !!adapted.stream,
        notes,
        toolNames: Array.isArray(adapted.tools) ? adapted.tools.map((t) => t?.function?.name) : null,
        toolChoice: typeof adapted.tool_choice === "object" ? "named" : adapted.tool_choice ?? null,
      });
    }
    await forward(req, res, "POST", pathname, Buffer.from(JSON.stringify(adapted)));
    return;
  }

  await forward(req, res, req.method ?? "GET", pathname, null);
});

function method_is(req, m) {
  return (req.method ?? "GET").toUpperCase() === m;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain) {
  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    process.stderr.write(`velvet-llm-gateway listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM}\n`);
    if (LOG) process.stderr.write(`request log: ${LOG}\n`);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
}