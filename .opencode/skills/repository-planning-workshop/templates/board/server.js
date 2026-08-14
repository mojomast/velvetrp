#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { parseJsonStrict, decodeUtf8Strict, validateManifest, loadState, persistState, computeReady, initialState } = require("./state.js");

const ROOT = __dirname;
const ASSETS = Object.freeze({
  "": ["public/index.html", "text/html; charset=utf-8"],
  "readiness.js": ["public/readiness.js", "text/javascript; charset=utf-8"],
  "ui-helpers.js": ["public/ui-helpers.js", "text/javascript; charset=utf-8"],
  "app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "app.css": ["public/app.css", "text/css; charset=utf-8"]
});
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
});
const MAX_BODY_BYTES = 262144;
const MAX_MUTATIONS = 4;

function isSafeBind(address) {
  if (typeof address !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const octets = address.split(".").map(Number);
  if (octets.some((part) => part > 255) || octets.join(".") !== address) return false;
  return octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}
function loadConfig(environment = process.env) {
  const bind = environment.REPOWORKSHOP_BIND || "127.0.0.1";
  if (!isSafeBind(bind)) throw new Error("REPOWORKSHOP_BIND must be one exact loopback or RFC1918 IPv4 address");
  const portText = environment.REPOWORKSHOP_PORT || "4173";
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error("REPOWORKSHOP_PORT is invalid");
  const capability = environment.REPOWORKSHOP_CAPABILITY;
  if (typeof capability !== "string" || capability.length < 32 || capability.length > 160 || !/^[A-Za-z0-9_-]+$/.test(capability)) throw new Error("REPOWORKSHOP_CAPABILITY must contain at least 32 safe characters");
  const manifestPath = path.resolve(environment.REPOWORKSHOP_MANIFEST || path.join(ROOT, "manifest.example.json"));
  const stateDir = path.resolve(environment.REPOWORKSHOP_STATE_DIR || path.join(process.cwd(), ".repoworkshop"));
  if (environment.REPOWORKSHOP_READ_ONLY !== undefined && environment.REPOWORKSHOP_READ_ONLY !== "1") throw new Error("REPOWORKSHOP_READ_ONLY must be 1 when set");
  if (environment.REPOWORKSHOP_READ_ONLY === "1" && bind !== "127.0.0.1") throw new Error("manual read-only mode must bind exact loopback 127.0.0.1");
  return { bind, port: Number(portText), capability, manifestPath, stateDir, readOnly: environment.REPOWORKSHOP_READ_ONLY === "1" };
}
function loadManifest(file) {
  let handle;
  try {
    handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(handle); if (!stat.isFile()) throw new Error("manifest must be a regular file");
    return validateManifest(parseJsonStrict(decodeUtf8Strict(fs.readFileSync(handle))));
  } finally { if (handle !== undefined) fs.closeSync(handle); }
}
function publicManifest(manifest) { return structuredClone(manifest); }
function json(response, status, value, extra = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra }); response.end(body);
}
function jsonThenStop(request, response, status, value, extra = {}) { response.once("finish", () => request.destroy()); json(response, status, value, extra); }
function empty(response, status, extra = {}) { response.writeHead(status, { ...SECURITY_HEADERS, ...extra }); response.end(); }
function hostFor(config) { return `${config.bind}:${config.port}`; }

function readBody(request, response) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let finished = false;
    function overflow() {
      if (finished) return; finished = true; request.pause();
      jsonThenStop(request, response, 413, { error: "Request body too large" }); resolve(null);
    }
    request.on("data", (chunk) => { if (finished) return; size += chunk.length; if (size > MAX_BODY_BYTES) overflow(); else chunks.push(chunk); });
    request.on("end", () => { if (!finished) { finished = true; resolve(Buffer.concat(chunks)); } });
    request.on("aborted", () => { if (!finished) { finished = true; reject(new Error("request aborted")); } });
    request.on("error", (error) => { if (!finished) { finished = true; reject(error); } });
  });
}

function createHandler(config, manifest) {
  const base = `/${config.capability}/`;
  const known = new Map([[base, ["GET"]], [`${base}readiness.js`, ["GET"]], [`${base}ui-helpers.js`, ["GET"]], [`${base}app.js`, ["GET"]], [`${base}app.css`, ["GET"]], [`${base}api/manifest`, ["GET"]], [`${base}api/state`, ["GET", "PUT"]]]);
  let activeMutations = 0;
  return async function handler(request, response) {
    let mutationSlot = false;
    try {
      if (request.headers.host !== hostFor(config)) return empty(response, 400);
      if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((name) => request.headers[name] !== undefined)) return empty(response, 400);
      let pathname; try { pathname = new URL(request.url, `http://${request.headers.host}`).pathname; } catch { return empty(response, 400); }
      if (!known.has(pathname)) return empty(response, 404);
      const methods = known.get(pathname);
      if (!methods.includes(request.method)) return empty(response, 405, { Allow: methods.join(", ") });
      if (request.method === "PUT") {
        if (config.readOnly) return jsonThenStop(request, response, 403, { error: "Board is in manual loopback read-only mode; persistence is disabled" });
        if (activeMutations >= MAX_MUTATIONS) return jsonThenStop(request, response, 503, { error: "Too many concurrent saves" }, { "Retry-After": "1" });
        activeMutations += 1; mutationSlot = true;
        if (request.headers.origin !== `http://${hostFor(config)}`) return empty(response, 403);
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] || "")) return empty(response, 415);
        if (request.headers["transfer-encoding"] !== undefined && request.headers["content-length"] !== undefined) return json(response, 400, { error: "Ambiguous request framing" });
        const length = request.headers["content-length"];
        if (length !== undefined && (!/^(?:0|[1-9]\d*)$/.test(length) || Number(length) > MAX_BODY_BYTES)) return jsonThenStop(request, response, 413, { error: "Request body too large" });
        const body = await readBody(request, response); if (body === null) return;
        let payload; try { payload = parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { return json(response, 400, { error: "Invalid request" }); }
        if (!payload || Object.keys(payload).sort().join(",") !== "expectedRevision,state") return json(response, 400, { error: "Invalid request" });
        try {
          const result = persistState(config.stateDir, manifest, payload.state, payload.expectedRevision);
          if (result.conflict) return json(response, 409, { error: "Revision conflict", state: result.state });
          return json(response, 200, { state: result.state, readinessFailures: computeReady(result.state, manifest).failures });
        } catch (error) {
          if (error.code === "REPOWORKSHOP_PERSISTENCE_UNSUPPORTED") return json(response, 503, { error: "Writable persistence is unavailable on this platform; restart on 127.0.0.1 with REPOWORKSHOP_READ_ONLY=1 for manual non-persisted review" });
          if (error.code === "REPOWORKSHOP_STATE_DIR_REPLACED") return json(response, 500, { error: "State directory pathname was replaced; state was written only to the opened original directory" });
          return json(response, error.code === "REPOWORKSHOP_PERSISTENCE" ? 500 : 400, { error: error.code === "REPOWORKSHOP_PERSISTENCE" ? "State could not be saved" : "Invalid state" });
        }
      }
       if (pathname === `${base}api/manifest`) return json(response, 200, { manifest: publicManifest(manifest) });
      if (pathname === `${base}api/state`) {
        try { const state = config.readOnly ? initialState(manifest) : loadState(config.stateDir, manifest); return json(response, 200, { state, readinessFailures: computeReady(state, manifest).failures, readOnly: Boolean(config.readOnly) }); }
        catch { return json(response, 500, { error: "State unavailable" }); }
      }
      const asset = ASSETS[pathname === base ? "" : pathname.slice(base.length)];
      const body = fs.readFileSync(path.join(ROOT, asset[0])); response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": asset[1], "Content-Length": body.length }); response.end(body);
    } catch { if (!response.headersSent) json(response, 500, { error: "Request failed" }); else response.destroy(); }
    finally { if (mutationSlot) activeMutations -= 1; }
  };
}

function createServer(config) {
  const manifest = loadManifest(config.manifestPath);
  const server = http.createServer(createHandler(config, manifest));
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 2000;
  server.maxRequestsPerSocket = 20;
  server.maxConnections = 32;
  return server;
}

if (require.main === module) {
  try {
    const config = loadConfig(); const server = createServer(config);
    server.listen(config.port, config.bind, () => console.log(`Planning board listening on ${config.bind}:${config.port}; use the private capability URL.`));
  } catch (error) { console.error(`Unable to start planning board: ${error.message}`); process.exitCode = 1; }
}

module.exports = { SECURITY_HEADERS, MAX_BODY_BYTES, MAX_MUTATIONS, isSafeBind, loadConfig, loadManifest, publicManifest, createHandler, createServer };
