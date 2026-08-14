"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CARD_IDS = [
  "documentation-reconciliation", "migration-support-fixtures", "deterministic-e2e-repair", "health-gate",
  "npc-presence", "companions", "combat-hardening", "multiclass", "agent-candidate-protocol",
  "expanded-agent-mechanics", "declarative-rules-ir", "mutable-pack-authoring", "reference-ingestion",
  "verifiable-dice", "branch-local-simulation", "boss-phases", "tactical-grid-los",
  "simultaneous-encounters", "remote-identity-security", "discord", "vtt", "proactive-automation",
  "autonomous-parties", "harness-budgets-session-overrides"
];
const DECISION_IDS = [
  "migration-policy", "npc-presence", "companion-authority", "combat-scope", "multiclass-model", "rules-ir-dsl",
  "pack-mutability", "branch-simulation", "boss-phases", "grid-los", "simultaneous-encounters",
  "agent-mechanics-candidate-protocol", "harness-budgets-session-overrides", "remote-identity-tenancy",
  "principal-propagation", "verifiable-dice-fairness", "reference-ingestion-licensing", "external-tool-policy",
  "discord-surface", "vtt-mode", "proactive-automation", "autonomous-party-authority"
];
const LEGACY_DECISION_IDS = [
  "companion-authority", "npc-semantics", "combat-scope", "multiclass-rules", "rules-dsl", "pack-mutability",
  "migration-policy", "dice-fairness", "remote-tenancy-auth", "external-data-licensing", "integrations", "autonomous-authority"
];
const LEGACY_DECISION_MAP = {
  "npc-semantics": "npc-presence", "multiclass-rules": "multiclass-model", "rules-dsl": "rules-ir-dsl",
  "dice-fairness": "verifiable-dice-fairness", "remote-tenancy-auth": "remote-identity-tenancy",
  "external-data-licensing": "reference-ingestion-licensing", integrations: "discord-surface",
  "autonomous-authority": "autonomous-party-authority"
};
const CHOICES = new Set(["Build", "Remove", "Defer", "Need decision"]);
const PRIORITIES = new Set(["Now", "Next", "Later", "Unscheduled"]);
const MAX_TEXT = 4000;
// Research P0/P1/P2/P3 maps to the board's Now/Next/Later/Unscheduled vocabulary.
const PRIORITY_BY_CARD = {
  "documentation-reconciliation": "Now", "migration-support-fixtures": "Now", "deterministic-e2e-repair": "Now", "health-gate": "Now",
  "remote-identity-security": "Now", "npc-presence": "Next", companions: "Next", "combat-hardening": "Next",
  "agent-candidate-protocol": "Next", "expanded-agent-mechanics": "Next", "verifiable-dice": "Next",
  multiclass: "Later", "declarative-rules-ir": "Later", "branch-local-simulation": "Later", "boss-phases": "Later",
  "harness-budgets-session-overrides": "Later", "reference-ingestion": "Later", "proactive-automation": "Later",
  "mutable-pack-authoring": "Unscheduled", "tactical-grid-los": "Unscheduled", "simultaneous-encounters": "Unscheduled",
  discord: "Unscheduled", vtt: "Unscheduled", "autonomous-parties": "Unscheduled"
};

function text(value, max = MAX_TEXT) { return typeof value === "string" && value.length <= max; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function idsMatch(items, ids) { return Array.isArray(items) && items.length === ids.length && items.every((item, index) => object(item) && item.id === ids[index]); }
function defaultState() {
  return {
    revision: 0, updatedAt: null, ready: false, overallNotes: "",
    cards: CARD_IDS.map((id) => ({ id, enabled: true, choice: "Build", priority: PRIORITY_BY_CARD[id], scope: "", dependencies: "" })),
    decisions: DECISION_IDS.map((id) => ({ id, selection: "", answer: "" })), blockers: []
  };
}
function validateState(value) {
  if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.ready !== "boolean" || !text(value.overallNotes) || !(value.updatedAt === null || (typeof value.updatedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.updatedAt)))) return false;
  if (!idsMatch(value.cards, CARD_IDS) || !idsMatch(value.decisions, DECISION_IDS) || !Array.isArray(value.blockers) || value.blockers.length > 50) return false;
  return value.cards.every((card) => typeof card.enabled === "boolean" && CHOICES.has(card.choice) && PRIORITIES.has(card.priority) && text(card.scope) && text(card.dependencies)) && value.decisions.every((decision) => text(decision.selection, 160) && text(decision.answer)) && value.blockers.every((blocker) => object(blocker) && text(blocker.owner, 160) && ["Low", "Medium", "High", "Critical"].includes(blocker.severity) && text(blocker.requestedDecision) && text(blocker.notes));
}
function sanitizeState(value) {
  if (!validateState(value)) {
    const error = new Error("Invalid planning board state.");
    error.code = "STATE_VALIDATION";
    throw error;
  }
  return JSON.parse(JSON.stringify(value));
}
function migrateState(value) {
  if (!object(value)) throw new Error("Invalid planning board state.");
  const defaults = defaultState();
  const legacyDecisionIds = idsMatch(value.decisions, LEGACY_DECISION_IDS);
  const cards = Array.isArray(value.cards) ? value.cards.map((card) => {
    if (!object(card)) return card;
    // Old boards intentionally removed/deferred work; other legacy cards now opt in by default.
    return { ...card, enabled: typeof card.enabled === "boolean" ? card.enabled : !["Remove", "Defer"].includes(card.choice) };
  }) : value.cards;
  const oldDecisions = new Map(Array.isArray(value.decisions) ? value.decisions.map((decision) => [LEGACY_DECISION_MAP[decision.id] || decision.id, decision]) : []);
  const decisions = legacyDecisionIds ? defaults.decisions.map((decision) => {
    const old = oldDecisions.get(decision.id);
    return old ? { ...decision, selection: old.answer ? "Custom answer" : "", answer: old.answer || "" } : decision;
  }) : value.decisions;
  return { ...value, cards, decisions };
}
function ensureStateDirectory(statePath) {
  const directory = path.dirname(statePath);
  try { const info = fs.lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("State directory is not a safe directory."); }
  catch (error) { if (error.code !== "ENOENT") throw error; const parentInfo = fs.lstatSync(path.dirname(directory)); if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("State parent is not a safe directory."); fs.mkdirSync(directory, { mode: 0o700 }); }
}
function readState(statePath) {
  try { const info = fs.lstatSync(statePath); if (!info.isFile() || info.isSymbolicLink()) throw new Error("State file is not a regular file."); return sanitizeState(migrateState(JSON.parse(fs.readFileSync(statePath, "utf8")))); }
  catch (error) { if (error.code === "ENOENT") return defaultState(); throw error; }
}
function saveState(statePath, proposed, expectedRevision, now = new Date()) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) { const error = new Error("Invalid revision."); error.code = "STATE_VALIDATION"; throw error; }
  const clean = sanitizeState({ ...proposed, revision: 0, updatedAt: null });
  let current;
  try { current = readState(statePath); } catch (error) { error.code = "PERSISTENCE_FAILURE"; throw error; }
  if (current.revision !== expectedRevision) { const error = new Error("State changed elsewhere."); error.code = "REVISION_CONFLICT"; error.current = current; throw error; }
  const next = sanitizeState({ ...clean, revision: current.revision + 1, updatedAt: now.toISOString() });
  ensureStateDirectory(statePath);
  const temporary = path.join(path.dirname(statePath), `.planning-board-${process.pid}-${Date.now()}.tmp`);
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, statePath); fs.chmodSync(statePath, 0o600); return next;
}
module.exports = { CARD_IDS, DECISION_IDS, PRIORITY_BY_CARD, defaultState, validateState, readState, saveState };
