"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { readState, saveState } = require("./state");

const ROOT = path.resolve(__dirname, "..");
const STATE_PATH = process.env.PLANNING_BOARD_STATE || path.join(ROOT, ".velvet", "planning-board.json");
const PORT = Number(process.env.PLANNING_BOARD_PORT || 8789);
const UI_PATH = path.join(__dirname, "public", "index.html");
const APP_PATH = path.join(__dirname, "public", "app.js");
const MAX_BODY = 128 * 1024;
const ui = fs.readFileSync(UI_PATH);
const app = fs.readFileSync(APP_PATH);
function reply(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}
function requestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let overflowed = false;
    req.on("data", (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        overflowed = true;
        chunks.length = 0;
        const error = new Error("Request body is too large.");
        error.code = "REQUEST_BODY_TOO_LARGE";
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!overflowed) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}
function createServer(statePath = STATE_PATH) {
  return http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") return reply(res, 200, ui, "text/html; charset=utf-8");
  if (req.method === "GET" && req.url === "/app.js") return reply(res, 200, app, "text/javascript; charset=utf-8");
  if (req.method === "GET" && req.url === "/api/state") {
    try {
      return reply(res, 200, readState(statePath));
    } catch {
      return reply(res, 500, { error: "Unable to load board state." });
    }
  }
  if ((req.method === "POST" || req.method === "PUT") && req.url === "/api/state") {
    try {
      const payload = JSON.parse(await requestBody(req));
      const state = saveState(statePath, payload.state, payload.expectedRevision);
      return reply(res, 200, state);
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return reply(res, 409, { error: error.message, state: error.current });
      if (error.code === "REQUEST_BODY_TOO_LARGE") return reply(res, 413, { error: "Invalid board request." });
      if (error instanceof SyntaxError || error.code === "STATE_VALIDATION") return reply(res, 400, { error: "Invalid board request." });
      return reply(res, 500, { error: "Unable to save board state." });
    }
  }
  return reply(res, 404, { error: "Not found." });
  });
}
if (require.main === module) {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => console.log(`Planning board: http://127.0.0.1:${PORT}`));
  server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { MAX_BODY, createServer };
