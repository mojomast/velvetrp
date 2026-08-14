"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { CARD_IDS, DECISION_IDS, PRIORITY_BY_CARD, defaultState, readState, saveState, validateState } = require("../state");
const { MAX_BODY, createServer } = require("../server");

function request(server, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1", port: server.address().port, path: requestPath, method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (result) => {
      const chunks = [];
      result.on("data", (chunk) => chunks.push(chunk));
      result.on("end", () => resolve({ status: result.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("state validates only the fixed board shape", () => {
  const state = defaultState();
  assert.equal(validateState(state), true);
  assert.equal(state.cards.length, CARD_IDS.length);
  assert.equal(state.decisions.length, DECISION_IDS.length);
  assert.ok(state.cards.every((card) => card.enabled && card.choice === "Build" && card.priority === PRIORITY_BY_CARD[card.id]));
  state.cards[0].enabled = "yes";
  assert.equal(validateState(state), false);
  state.cards.pop();
  assert.equal(validateState(state), false);
});
test("legacy state gains enabled cards and expanded decisions only in memory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-"));
  const file = path.join(directory, ".velvet", "planning-board.json");
  try {
    const legacy = {
      revision: 4, updatedAt: null, ready: false, overallNotes: "old notes",
      cards: defaultState().cards.map(({ id, priority, scope, dependencies }) => ({ id, choice: id === "npc-presence" ? "Remove" : "Need decision", priority, scope, dependencies })),
      decisions: ["companion-authority", "npc-semantics", "combat-scope", "multiclass-rules", "rules-dsl", "pack-mutability", "migration-policy", "dice-fairness", "remote-tenancy-auth", "external-data-licensing", "integrations", "autonomous-authority"].map((id) => ({ id, answer: id === "migration-policy" ? "Latest-only" : "" })),
      blockers: []
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(legacy));
    const migrated = readState(file);
    assert.equal(migrated.cards.find((card) => card.id === "documentation-reconciliation").enabled, true);
    assert.equal(migrated.cards.find((card) => card.id === "npc-presence").enabled, false);
    assert.equal(migrated.decisions.find((decision) => decision.id === "migration-policy").answer, "Latest-only");
    assert.equal(migrated.decisions.find((decision) => decision.id === "migration-policy").selection, "Custom answer");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), legacy);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("state persists atomically and rejects a stale revision", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-"));
  const file = path.join(directory, ".velvet", "planning-board.json");
  try {
    const initial = readState(file);
    initial.overallNotes = "Sequence the health gate first.";
    const saved = saveState(file, initial, 0, new Date("2026-08-10T12:00:00.000Z"));
    assert.equal(saved.revision, 1);
    assert.equal(readState(file).overallNotes, initial.overallNotes);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => saveState(file, initial, 0), { code: "REVISION_CONFLICT" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("planning UI is a compact semantic form with filters and accessible status", () => {
  const ui = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(ui, /<form id="board-form">/);
  assert.match(ui, /id="summary"[^>]+aria-label="Board summary"/);
  assert.match(ui, /id="search" type="search"/);
  assert.match(ui, /id="inclusion-filter"/);
  assert.match(ui, /id="priority-filter"/);
  assert.match(ui, /id="clear-filters"/);
  assert.match(ui, /id="filter-status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(ui, /id="unanswered-only" type="checkbox"/);
  assert.match(ui, /@media \(max-width: 520px\)/);
  assert.doesNotMatch(ui, /role="grid"|position:\s*sticky/);
});
test("GET state safely rejects corrupt persisted state and remains available", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-"));
  const file = path.join(directory, ".velvet", "planning-board.json");
  const server = createServer(file);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const initial = await request(server, "GET", "/api/state");
    assert.equal(initial.status, 200);
    assert.deepEqual(JSON.parse(initial.body), defaultState());
    for (const persisted of ["{", JSON.stringify({ ...defaultState(), cards: [{ id: CARD_IDS[0] }] })]) {
      fs.writeFileSync(file, persisted);
      const failed = await request(server, "GET", "/api/state");
      assert.equal(failed.status, 500);
      assert.deepEqual(JSON.parse(failed.body), { error: "Unable to load board state." });
      assert.doesNotMatch(failed.body, /planning-board|SyntaxError|Invalid planning board state/i);

      fs.writeFileSync(file, JSON.stringify(defaultState()));
      const recovered = await request(server, "GET", "/api/state");
      assert.equal(recovered.status, 200);
      assert.deepEqual(JSON.parse(recovered.body), defaultState());
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("oversized PUT state request receives JSON 413 without writing state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-"));
  const file = path.join(directory, ".velvet", "planning-board.json");
  const server = createServer(file);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const payload = JSON.stringify({ state: "x".repeat(MAX_BODY) });
    const response = await request(server, "PUT", "/api/state", payload);
    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), { error: "Invalid board request." });
    assert.equal(fs.existsSync(file), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("PUT state classifies validation, conflicts, and persistence failures safely", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "planning-board-"));
  const file = path.join(directory, ".velvet", "planning-board.json");
  const server = createServer(file);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const malformed = await request(server, "PUT", "/api/state", "{");
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse(malformed.body), { error: "Invalid board request." });

    const invalid = defaultState();
    invalid.cards[0].priority = "Immediately";
    const validation = await request(server, "PUT", "/api/state", JSON.stringify({ state: invalid, expectedRevision: 0 }));
    assert.equal(validation.status, 400);
    assert.deepEqual(JSON.parse(validation.body), { error: "Invalid board request." });

    const first = await request(server, "PUT", "/api/state", JSON.stringify({ state: defaultState(), expectedRevision: 0 }));
    assert.equal(first.status, 200);
    const reloaded = await request(server, "GET", "/api/state");
    assert.equal(reloaded.status, 200);
    assert.equal(JSON.parse(reloaded.body).revision, 1);
    const stale = await request(server, "PUT", "/api/state", JSON.stringify({ state: defaultState(), expectedRevision: 0 }));
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(stale.body).state.revision, 1);

    fs.rmSync(file);
    fs.mkdirSync(file);
    const failed = await request(server, "PUT", "/api/state", JSON.stringify({ state: defaultState(), expectedRevision: 0 }));
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.body), { error: "Unable to save board state." });
    assert.doesNotMatch(failed.body, /directory|filesystem|planning-board|EISDIR|regular file/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
