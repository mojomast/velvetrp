"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { decisionAnswered, requiredDecisionIds, computeReady } = require("./public/readiness.js");

const SHA = /^sha256:[0-9a-f]{64}$/;
const EPIC_ID = /^EPIC-[0-9]{3,}$/;
const DECISION_ID = /^DEC-[0-9]{3,}$/;
const BLOCKER_ID = /^BLOCK-[0-9]{3,}$/;
const OPTION_ID = /^DEC-[0-9]{3,}-OPT-[0-9]{2,}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys, label) {
  if (!plain(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  for (const key of actual) if (!keys.includes(key)) fail(`${label} has unknown key: ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing: ${key}`);
}
function safeInteger(value, label, minimum = -MAX_SAFE, maximum = MAX_SAFE) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} must be a safe integer in range`);
}
function text(value, label, minimum = 0, maximum = 2000) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.normalize("NFC") !== value || /[\uD800-\uDFFF]/u.test(value)) fail(`${label} must be bounded NFC Unicode scalar text`);
}
function match(value, expression, label) { text(value, label, 1, 120); if (!expression.test(value)) fail(`${label} has invalid type prefix`); }
function array(value, label, maximum, minimum = 0) { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} has invalid length`); }
function unique(values, label) { if (new Set(values).size !== values.length) fail(`${label} must be unique`); }
function utc(value, label) { text(value, label, 20, 32); if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} must be RFC3339 UTC`); }
function digest(value, label) { if (typeof value !== "string" || !SHA.test(value)) fail(`${label} must be sha256:<lowercase hex>`); }
function repoPath(value, label, allowRoot = false) { text(value, label, allowRoot ? 0 : 1, 500); if (allowRoot && value === "") return; if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || !value || value.split("/").some((part) => part === "." || part === ".." || part === "")) fail(`${label} must be a safe repository-relative path`); }

// Detect duplicate keys while tokenizing, before the ordinary JSON parse. This
// deliberately handles every nested object rather than relying on a reviver,
// which receives an object only after duplicate information has been lost.
function rejectDuplicateKeys(source) {
  let at = 0;
  const whitespace = () => { while (/\s/u.test(source[at] || "")) at += 1; };
  function stringToken() {
    whitespace(); const start = at;
    if (source[at++] !== '"') fail("invalid JSON string");
    while (at < source.length) {
      const character = source[at++];
      if (character === '"') { try { return JSON.parse(source.slice(start, at)); } catch { fail("invalid JSON string"); } }
      if (character === "\\") { if (source[at] === "u") at += 5; else at += 1; }
      else if (character.charCodeAt(0) < 0x20) fail("invalid JSON string");
    }
    fail("unterminated JSON string");
  }
  function value() {
    whitespace(); const character = source[at];
    if (character === "{") return object();
    if (character === "[") return list();
    if (character === '"') { stringToken(); return; }
    const match = source.slice(at).match(/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!match) fail("invalid JSON value"); at += match[0].length;
  }
  function object() {
    at += 1; whitespace(); const keys = new Set();
    if (source[at] === "}") { at += 1; return; }
    while (true) {
      const key = stringToken();
      if (keys.has(key)) fail(`duplicate JSON object key: ${key}`); keys.add(key);
      whitespace(); if (source[at++] !== ":") fail("invalid JSON object"); value(); whitespace();
      if (source[at] === "}") { at += 1; return; }
      if (source[at++] !== ",") fail("invalid JSON object");
    }
  }
  function list() {
    at += 1; whitespace(); if (source[at] === "]") { at += 1; return; }
    while (true) { value(); whitespace(); if (source[at] === "]") { at += 1; return; } if (source[at++] !== ",") fail("invalid JSON array"); }
  }
  value(); whitespace(); if (at !== source.length) fail("trailing JSON content");
}
function validateScalars(value, label = "JSON") {
  if (typeof value === "string") return text(value, label, 0, MAX_SAFE);
  if (typeof value === "number") return safeInteger(value, label);
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) return value.forEach((item, index) => validateScalars(item, `${label}[${index}]`));
  if (plain(value)) return Object.entries(value).forEach(([key, item]) => { text(key, `${label} key`, 0, MAX_SAFE); validateScalars(item, `${label}.${key}`); });
  fail(`${label} contains a non-JSON value`);
}
function parseJsonStrict(source) {
  if (typeof source !== "string") fail("JSON input must be text");
  rejectDuplicateKeys(source);
  let value; try { value = JSON.parse(source); } catch { fail("invalid JSON"); }
  validateScalars(value); return value;
}
function decodeUtf8Strict(buffer) { try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { fail("JSON input must be valid UTF-8"); } }

function scalarCompare(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
function quote(value) {
  let output = '"';
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === '"' || character === "\\") output += `\\${character}`;
    else if (code <= 0x1f) output += `\\u${code.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}
function canonical(value) {
  validateScalars(value);
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort(scalarCompare).map((key) => `${quote(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hash(value) { return `sha256:${crypto.createHash("sha256").update(canonical(value), "utf8").digest("hex")}`; }
function omit(value, key) { const copy = structuredClone(value); delete copy[key]; return copy; }
function manifestDigest(manifest) { return hash(omit(manifest, "manifestDigest")); }
function stateDigest(state) { return hash(omit(state, "stateDigest")); }
function baselineDigest(baseline) { return hash(omit(baseline, "digest")); }

function validateBaseline(value) {
  exact(value, ["capturedAt", "head", "branch", "status", "dirtyEvidence", "exclusions", "commandEvidence", "digest"], "researchBaseline");
  utc(value.capturedAt, "researchBaseline.capturedAt");
  text(value.head, "researchBaseline.head", 40, 64); if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.head)) fail("researchBaseline.head is invalid");
  if (value.branch !== null) text(value.branch, "researchBaseline.branch", 1, 255);
  array(value.status, "researchBaseline.status", 4096); value.status.forEach((entry, index) => { exact(entry, ["path", "index", "worktree", "originalPath"], `status[${index}]`); repoPath(entry.path, `status[${index}].path`); text(entry.index, "status.index", 1, 1); text(entry.worktree, "status.worktree", 1, 1); if (entry.originalPath !== null) repoPath(entry.originalPath, "status.originalPath"); });
  array(value.dirtyEvidence, "researchBaseline.dirtyEvidence", 2048); value.dirtyEvidence.forEach((entry, index) => { exact(entry, ["path", "originalPath", "status", "media", "revision", "bytes", "sha256", "absence"], `dirtyEvidence[${index}]`); repoPath(entry.path, "dirtyEvidence.path"); if (entry.originalPath !== null) repoPath(entry.originalPath, "dirtyEvidence.originalPath"); if (!["modified", "added", "untracked", "deleted", "renamed", "copied", "unmerged"].includes(entry.status)) fail("dirtyEvidence.status invalid"); if (!["text", "binary", "absent"].includes(entry.media)) fail("dirtyEvidence.media invalid"); if (!/^(?:worktree|index-stage-[0-3]|HEAD)$/.test(entry.revision)) fail("dirtyEvidence.revision invalid"); safeInteger(entry.bytes, "dirtyEvidence.bytes", 0); if (entry.sha256 !== null) digest(entry.sha256, "dirtyEvidence.sha256"); if (!["present", "deleted", "renamed-source-absent", "stage-absent"].includes(entry.absence)) fail("dirtyEvidence.absence invalid"); });
  array(value.exclusions, "researchBaseline.exclusions", 256); value.exclusions.forEach((entry, index) => repoPath(entry, `exclusions[${index}]`));
  array(value.commandEvidence, "researchBaseline.commandEvidence", 128); value.commandEvidence.forEach((entry, index) => { exact(entry, ["argv", "cwd", "capturedAt", "baselineHead", "exitCode", "maxBytes", "result", "truncated", "sha256"], `commandEvidence[${index}]`); array(entry.argv, "commandEvidence.argv", 64, 1); entry.argv.forEach((argument) => text(argument, "commandEvidence.argv item", 0, 1000)); repoPath(entry.cwd, "commandEvidence.cwd", true); utc(entry.capturedAt, "commandEvidence.capturedAt"); if (entry.baselineHead !== value.head) fail("commandEvidence.baselineHead mismatch"); safeInteger(entry.exitCode, "commandEvidence.exitCode", -1, 255); safeInteger(entry.maxBytes, "commandEvidence.maxBytes", 1, 65536); text(entry.result, "commandEvidence.result", 0, 65536); if (typeof entry.truncated !== "boolean") fail("commandEvidence.truncated invalid"); digest(entry.sha256, "commandEvidence.sha256"); });
  digest(value.digest, "researchBaseline.digest"); if (value.digest !== baselineDigest(value)) fail("researchBaseline.digest self-digest mismatch");
}
function validateIntent(value) {
  exact(value, ["problem", "affectedActors", "successSignals", "constraints", "nonGoals", "horizon"], "intent");
  text(value.problem, "intent.problem", 1, 2000);
  array(value.affectedActors, "intent.affectedActors", 32, 1); value.affectedActors.forEach((item, index) => text(item, `intent.affectedActors[${index}]`, 1, 300));
  array(value.successSignals, "intent.successSignals", 32, 1); value.successSignals.forEach((item, index) => text(item, `intent.successSignals[${index}]`, 1, 1000));
  array(value.constraints, "intent.constraints", 32); value.constraints.forEach((item, index) => text(item, `intent.constraints[${index}]`, 1, 1000));
  array(value.nonGoals, "intent.nonGoals", 32); value.nonGoals.forEach((item, index) => text(item, `intent.nonGoals[${index}]`, 1, 1000));
  text(value.horizon, "intent.horizon", 1, 300);
}
function validateEvidence(item, baseline, label) {
  const common = ["id", "type", "capturedAt", "baselineDigest", "confidence", "note", "redactedResult", "resultTruncated"];
  const variants = {
    "file-line": ["path", "startLine", "endLine", "revision", "contentSha256"],
    "binary-file": ["path", "revision", "contentSha256"],
    "git-commit": ["repository", "commit", "baseCommit", "path", "contentSha256"],
    "git-diff": ["repository", "commit", "baseCommit", "path", "contentSha256"],
    "command-output": ["argv", "cwd", "exitCode", "outputSha256", "maxBytes"],
    "external-url": ["url", "publisher", "publishedAt", "accessedAt", "revision", "contentSha256"]
  };
  if (!plain(item) || !variants[item.type]) fail(`${label}.type is unsupported`); exact(item, [...common, ...variants[item.type]], label);
  text(item.id, `${label}.id`, 3, 64); if (!/^[A-Z][A-Z0-9-]{2,63}$/.test(item.id)) fail(`${label}.id is invalid`);
  utc(item.capturedAt, `${label}.capturedAt`); if (item.baselineDigest !== baseline.digest) fail(`${label}.baselineDigest mismatch`);
  if (!["high", "medium", "low"].includes(item.confidence)) fail(`${label}.confidence is invalid`); text(item.note, `${label}.note`, 0, 1000); text(item.redactedResult, `${label}.redactedResult`, 0, 4000); if (typeof item.resultTruncated !== "boolean") fail(`${label}.resultTruncated is invalid`);
  if (["file-line", "binary-file"].includes(item.type)) { repoPath(item.path, `${label}.path`); if (!/^(?:worktree|index-stage-[0-3]|[0-9a-f]{40}(?:[0-9a-f]{24})?)$/.test(item.revision)) fail(`${label}.revision invalid`); digest(item.contentSha256, `${label}.contentSha256`); }
  if (item.type === "file-line") { safeInteger(item.startLine, `${label}.startLine`, 1); safeInteger(item.endLine, `${label}.endLine`, item.startLine); }
  if (["git-commit", "git-diff"].includes(item.type)) { if (item.repository !== "local") fail(`${label}.repository invalid`); text(item.commit, `${label}.commit`, 40, 64); if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(item.commit)) fail(`${label}.commit invalid`); if (item.baseCommit !== null && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(item.baseCommit)) fail(`${label}.baseCommit invalid`); if (item.path !== null) repoPath(item.path, `${label}.path`); digest(item.contentSha256, `${label}.contentSha256`); }
  if (item.type === "command-output") { array(item.argv, `${label}.argv`, 64, 1); item.argv.forEach((argument) => text(argument, `${label}.argv item`, 0, 1000)); repoPath(item.cwd, `${label}.cwd`, true); safeInteger(item.exitCode, `${label}.exitCode`, -1, 255); digest(item.outputSha256, `${label}.outputSha256`); safeInteger(item.maxBytes, `${label}.maxBytes`, 1, 65536); }
  if (item.type === "external-url") { text(item.url, `${label}.url`, 1, 2000); let parsed; try { parsed = new URL(item.url); } catch { fail(`${label}.url invalid`); } if (!["http:", "https:"].includes(parsed.protocol)) fail(`${label}.url invalid`); text(item.publisher, `${label}.publisher`, 1, 500); if (item.publishedAt !== null) utc(item.publishedAt, `${label}.publishedAt`); utc(item.accessedAt, `${label}.accessedAt`); text(item.revision, `${label}.revision`, 0, 500); digest(item.contentSha256, `${label}.contentSha256`); }
}
function dag(records, dependencyKey, label) {
  const byId = new Map(records.map((item) => [item.id, item])); const visiting = new Set(); const visited = new Set();
  function visit(id) { if (visiting.has(id)) fail(`${label} dependency cycle`); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id)[dependencyKey]) { if (!byId.has(dependency) || dependency === id) fail(`${label} ${id} has invalid dependency ${dependency}`); visit(dependency); } visiting.delete(id); visited.add(id); }
  records.forEach((item) => visit(item.id));
}
function validateManifest(manifest) {
  validateScalars(manifest, "manifest");
  exact(manifest, ["schemaVersion", "manifestVersion", "generatedAt", "project", "intent", "researchBaseline", "baselineDigest", "manifestDigest", "limits", "evidence", "epics", "decisions", "blockers"], "manifest");
  if (manifest.schemaVersion !== 1) fail("manifest.schemaVersion must be 1"); safeInteger(manifest.manifestVersion, "manifest.manifestVersion", 1, 2147483647); utc(manifest.generatedAt, "manifest.generatedAt");
  exact(manifest.project, ["displayName", "slug"], "project"); text(manifest.project.displayName, "project.displayName", 1, 120); text(manifest.project.slug, "project.slug", 1, 80); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.project.slug)) fail("project.slug is invalid");
  validateIntent(manifest.intent);
  validateBaseline(manifest.researchBaseline); digest(manifest.baselineDigest, "manifest.baselineDigest"); if (manifest.baselineDigest !== manifest.researchBaseline.digest) fail("manifest.baselineDigest mismatch"); digest(manifest.manifestDigest, "manifest.manifestDigest"); if (manifest.manifestDigest !== manifestDigest(manifest)) fail("manifest.manifestDigest self-digest mismatch");
  exact(manifest.limits, ["overallNotesMax", "epicNotesMax", "decisionCustomMax", "blockerNoteMax"], "limits"); for (const [key, ceiling] of [["overallNotesMax", 8000], ["epicNotesMax", 2000], ["decisionCustomMax", 2000], ["blockerNoteMax", 2000]]) safeInteger(manifest.limits[key], `limits.${key}`, 1, ceiling);
  array(manifest.evidence, "evidence", 4096); manifest.evidence.forEach((item, index) => validateEvidence(item, manifest.researchBaseline, `evidence[${index}]`)); const evidenceIds = manifest.evidence.map((item) => item.id); unique(evidenceIds, "evidence IDs");
  array(manifest.epics, "epics", 512); const epicIds = manifest.epics.map((epic, index) => {
    exact(epic, ["id", "title", "summary", "problem", "outcome", "acceptanceSignals", "classification", "evidenceIds", "evidenceMap", "dependsOnEpicIds", "requiredDecisionIds", "initialEnabled", "initialDisposition", "suggestedPriority", "priorityScore", "priorityBreakdown", "effort", "horizon", "externalDependency", "scope", "exclusions", "risks", "changeMap"], `epics[${index}]`);
    match(epic.id, EPIC_ID, "epic.id"); text(epic.title, "epic.title", 1, 120); text(epic.summary, "epic.summary", 0, 1000); text(epic.problem, `${epic.id}.problem`, 1, 2000); text(epic.outcome, `${epic.id}.outcome`, 1, 2000); array(epic.acceptanceSignals, `${epic.id}.acceptanceSignals`, 32, 1); epic.acceptanceSignals.forEach((item, i) => text(item, `${epic.id}.acceptanceSignals[${i}]`, 1, 1000)); if (!["present", "partial", "missing", "health", "deferred"].includes(epic.classification)) fail(`${epic.id} classification invalid`);
    array(epic.evidenceIds, `${epic.id}.evidenceIds`, 64, 1); unique(epic.evidenceIds, `${epic.id} evidence IDs`); epic.evidenceIds.forEach((id) => { if (!evidenceIds.includes(id)) fail(`${epic.id} has unknown evidence ${id}`); });
    exact(epic.evidenceMap, ["observation", "hypothesis", "intervention", "uncertainty"], `${epic.id}.evidenceMap`); for (const key of ["observation", "hypothesis", "intervention", "uncertainty"]) text(epic.evidenceMap[key], `${epic.id}.evidenceMap.${key}`, 1, 1000);
    array(epic.dependsOnEpicIds, `${epic.id}.dependsOnEpicIds`, 64); unique(epic.dependsOnEpicIds, `${epic.id} dependencies`); epic.dependsOnEpicIds.forEach((id) => match(id, EPIC_ID, "epic dependency"));
    array(epic.requiredDecisionIds, `${epic.id}.requiredDecisionIds`, 64); unique(epic.requiredDecisionIds, `${epic.id} decisions`); epic.requiredDecisionIds.forEach((id) => match(id, DECISION_ID, "required decision"));
    if (epic.initialEnabled !== true || epic.initialDisposition !== "Build") fail(`${epic.id} must initially be enabled Build`); if (!["P0", "P1", "P2", "P3"].includes(epic.suggestedPriority)) fail(`${epic.id} priority invalid`);
    if (!["XS", "S", "M", "L", "XL", "unknown"].includes(epic.effort)) fail(`${epic.id} effort invalid`); text(epic.horizon, `${epic.id}.horizon`, 1, 300); if (epic.externalDependency !== null) text(epic.externalDependency, `${epic.id}.externalDependency`, 1, 500);
    exact(epic.priorityBreakdown, ["impact", "riskReduction", "unblocks", "confidence", "costPenalty"], `${epic.id}.priorityBreakdown`); const b = epic.priorityBreakdown; safeInteger(b.impact, "impact", 0, 3); safeInteger(b.riskReduction, "riskReduction", 0, 3); safeInteger(b.unblocks, "unblocks", 0, 2); safeInteger(b.confidence, "confidence", 0, 2); safeInteger(b.costPenalty, "costPenalty", -2, 0); const score = b.impact + b.riskReduction + b.unblocks + b.costPenalty; if (epic.priorityScore !== score) fail(`${epic.id} priorityScore mismatch`); const expected = score >= 7 ? "P0" : score >= 4 ? "P1" : score >= 2 ? "P2" : "P3"; if (epic.suggestedPriority !== expected) fail(`${epic.id} suggestedPriority mismatch`);
    for (const [key, min] of [["scope", 1], ["exclusions", 0], ["risks", 0]]) { array(epic[key], `${epic.id}.${key}`, 64, min); epic[key].forEach((value, i) => text(value, `${epic.id}.${key}[${i}]`, 0, 1000)); }
    array(epic.changeMap, `${epic.id}.changeMap`, 64, 1); epic.changeMap.forEach((item, i) => { exact(item, ["boundary", "confidence", "reason"], `${epic.id}.changeMap[${i}]`); text(item.boundary, `${epic.id}.changeMap[${i}].boundary`, 1, 500); if (!["confirmed", "likely", "unknown"].includes(item.confidence)) fail(`${epic.id}.changeMap confidence invalid`); text(item.reason, `${epic.id}.changeMap[${i}].reason`, 1, 1000); });
    return epic.id;
  }); unique(epicIds, "epic IDs"); dag(manifest.epics, "dependsOnEpicIds", "epic");
  array(manifest.decisions, "decisions", 256); const decisionIds = manifest.decisions.map((decision, index) => {
    exact(decision, ["id", "title", "prompt", "required", "dependsOnDecisionIds", "evidenceIds", "options", "recommendedOptionId", "recommendationRationale", "customAnswer"], `decisions[${index}]`);
    match(decision.id, DECISION_ID, "decision.id"); text(decision.title, "decision.title", 1, 120); text(decision.prompt, "decision.prompt", 1, 1000); if (typeof decision.required !== "boolean") fail(`${decision.id}.required invalid`);
    array(decision.dependsOnDecisionIds, `${decision.id}.dependsOnDecisionIds`, 64); unique(decision.dependsOnDecisionIds, `${decision.id} dependencies`); decision.dependsOnDecisionIds.forEach((id) => match(id, DECISION_ID, "decision dependency"));
    array(decision.evidenceIds, `${decision.id}.evidenceIds`, 64, 1); decision.evidenceIds.forEach((id) => { if (!evidenceIds.includes(id)) fail(`${decision.id} unknown evidence`); });
    array(decision.options, `${decision.id}.options`, 4, 2); const options = decision.options.map((option, optionIndex) => { exact(option, ["id", "label", "implementationShape", "benefits", "costsAndRisks", "migrationAndOperations", "evidenceIds", "dependsOnEpicIds", "incompatibleOptionIds"], `${decision.id}.options[${optionIndex}]`); match(option.id, OPTION_ID, "option.id"); if (!option.id.startsWith(`${decision.id}-OPT-`)) fail(`${option.id} does not belong to ${decision.id}`); text(option.label, "option.label", 1, 120); text(option.implementationShape, "option.implementationShape", 1, 1000); for (const key of ["benefits", "costsAndRisks"]) { array(option[key], `option.${key}`, 16, 1); option[key].forEach((item, i) => text(item, `option.${key}[${i}]`, 1, 1000)); } text(option.migrationAndOperations, "option.migrationAndOperations", 0, 1000); array(option.evidenceIds, "option.evidenceIds", 64, 1); option.evidenceIds.forEach((id) => { if (!evidenceIds.includes(id)) fail(`${option.id} unknown evidence`); }); array(option.dependsOnEpicIds, `${option.id}.dependsOnEpicIds`, 64); unique(option.dependsOnEpicIds, `${option.id}.dependsOnEpicIds`); option.dependsOnEpicIds.forEach((id) => { if (!epicIds.includes(id)) fail(`${option.id} unknown epic dependency`); }); array(option.incompatibleOptionIds, `${option.id}.incompatibleOptionIds`, 64); unique(option.incompatibleOptionIds, `${option.id}.incompatibleOptionIds`); option.incompatibleOptionIds.forEach((id) => match(id, OPTION_ID, `${option.id} incompatible option`)); return option.id; }); unique(options, `${decision.id} option IDs`); if (!options.includes(decision.recommendedOptionId)) fail(`${decision.id} recommended option invalid`); text(decision.recommendationRationale, "recommendationRationale", 1, 1000); exact(decision.customAnswer, ["allowed", "maxLength", "validation"], `${decision.id}.customAnswer`); if (typeof decision.customAnswer.allowed !== "boolean") fail("customAnswer.allowed invalid"); safeInteger(decision.customAnswer.maxLength, "customAnswer.maxLength", 1, 2000); if (!["nonblank-trimmed", "single-line", "multiline"].includes(decision.customAnswer.validation)) fail("customAnswer.validation invalid"); return decision.id;
  }); unique(decisionIds, "decision IDs"); dag(manifest.decisions, "dependsOnDecisionIds", "decision"); const optionIds = new Set(manifest.decisions.flatMap((decision) => decision.options.map((option) => option.id))); for (const decision of manifest.decisions) for (const option of decision.options) for (const incompatible of option.incompatibleOptionIds) { if (!optionIds.has(incompatible) || incompatible === option.id) fail(`${option.id} has invalid incompatible option`); } for (const epic of manifest.epics) epic.requiredDecisionIds.forEach((id) => { if (!decisionIds.includes(id)) fail(`${epic.id} has unknown decision ${id}`); });
  array(manifest.blockers, "blockers", 256); const blockerIds = manifest.blockers.map((blocker, index) => { exact(blocker, ["id", "title", "detail", "epicIds", "decisionIds", "evidenceIds", "resolutionPredicate"], `blockers[${index}]`); match(blocker.id, BLOCKER_ID, "blocker.id"); text(blocker.title, "blocker.title", 1, 120); text(blocker.detail, "blocker.detail", 1, 1000); for (const [key, ids] of [["epicIds", epicIds], ["decisionIds", decisionIds], ["evidenceIds", evidenceIds]]) { array(blocker[key], `${blocker.id}.${key}`, 64); unique(blocker[key], `${blocker.id}.${key}`); blocker[key].forEach((id) => { if (!ids.includes(id)) fail(`${blocker.id} has unknown reference ${id}`); }); } if (!["manual-resolution", "all-decisions-answered", "epics-disabled"].includes(blocker.resolutionPredicate)) fail(`${blocker.id} predicate invalid`); return blocker.id; }); unique(blockerIds, "blocker IDs");
  return manifest;
}

function initialState(manifest, now = new Date().toISOString()) {
  validateManifest(manifest); const state = { schemaVersion: 1, baselineDigest: manifest.baselineDigest, manifestDigest: manifest.manifestDigest, stateDigest: "", revision: 0, updatedAt: now, ready: false, intentAcknowledged: false, epics: manifest.epics.map((item) => ({ id: item.id, enabled: true, disposition: "Build", dispositionReason: "", approvedPriority: null, approvalRationale: "", notes: "" })), decisions: manifest.decisions.map((item) => ({ id: item.id, selectedOptionId: null, customAnswer: null, selectionRationale: "", acceptedRisks: "", notes: "" })), blockers: manifest.blockers.map((item) => ({ id: item.id, resolved: false, resolutionNote: "" })), overallNotes: "" }; state.ready = computeReady(state, manifest).ready; state.stateDigest = stateDigest(state); return state;
}
function validateState(state, manifest, { allowSynthesized = false } = {}) {
  validateScalars(state, "state"); exact(state, ["schemaVersion", "baselineDigest", "manifestDigest", "stateDigest", "revision", "updatedAt", "ready", "intentAcknowledged", "epics", "decisions", "blockers", "overallNotes"], "state"); if (state.schemaVersion !== 1 || state.baselineDigest !== manifest.baselineDigest || state.manifestDigest !== manifest.manifestDigest) fail("state schema or authority digest mismatch"); digest(state.stateDigest, "state.stateDigest"); if (state.stateDigest !== stateDigest(state)) fail("state.stateDigest mismatch"); safeInteger(state.revision, "state.revision", allowSynthesized ? 0 : 1); if (state.revision === 0 && !allowSynthesized) fail("persisted state revision must be at least 1"); utc(state.updatedAt, "state.updatedAt"); if (typeof state.ready !== "boolean" || typeof state.intentAcknowledged !== "boolean") fail("state readiness controls invalid");
  array(state.epics, "state.epics", manifest.epics.length, manifest.epics.length); state.epics.forEach((answer, index) => { exact(answer, ["id", "enabled", "disposition", "dispositionReason", "approvedPriority", "approvalRationale", "notes"], `state.epics[${index}]`); if (answer.id !== manifest.epics[index].id) fail("state epic IDs/order must exactly match manifest"); if (typeof answer.enabled !== "boolean" || !["Build", "Remove", "Defer", "Need decision"].includes(answer.disposition)) fail(`${answer.id} controls invalid`); text(answer.dispositionReason, `${answer.id}.dispositionReason`, 0, 1000); if (answer.approvedPriority !== null && !["P0", "P1", "P2", "P3"].includes(answer.approvedPriority)) fail(`${answer.id} approved priority invalid`); text(answer.approvalRationale, `${answer.id}.approvalRationale`, 0, 1000); text(answer.notes, `${answer.id}.notes`, 0, manifest.limits.epicNotesMax); });
  array(state.decisions, "state.decisions", manifest.decisions.length, manifest.decisions.length); state.decisions.forEach((answer, index) => { const source = manifest.decisions[index]; exact(answer, ["id", "selectedOptionId", "customAnswer", "selectionRationale", "acceptedRisks", "notes"], `state.decisions[${index}]`); if (answer.id !== source.id) fail("state decision IDs/order must exactly match manifest"); if (answer.selectedOptionId !== null && !source.options.some((option) => option.id === answer.selectedOptionId)) fail(`${answer.id} selected option invalid`); if (answer.customAnswer !== null) { if (!source.customAnswer.allowed) fail(`${answer.id} custom answer forbidden`); text(answer.customAnswer, `${answer.id}.customAnswer`, 0, Math.min(source.customAnswer.maxLength, manifest.limits.decisionCustomMax)); if (source.customAnswer.validation === "single-line" && /[\r\n]/.test(answer.customAnswer)) fail(`${answer.id} custom answer must be single-line`); } text(answer.selectionRationale, `${answer.id}.selectionRationale`, 0, 1000); text(answer.acceptedRisks, `${answer.id}.acceptedRisks`, 0, 1000); text(answer.notes, `${answer.id}.notes`, 0, 1000); });
  array(state.blockers, "state.blockers", manifest.blockers.length, manifest.blockers.length); state.blockers.forEach((answer, index) => { exact(answer, ["id", "resolved", "resolutionNote"], `state.blockers[${index}]`); if (answer.id !== manifest.blockers[index].id) fail("state blocker IDs/order must exactly match manifest"); if (typeof answer.resolved !== "boolean") fail(`${answer.id}.resolved invalid`); text(answer.resolutionNote, `${answer.id}.resolutionNote`, 0, manifest.limits.blockerNoteMax); }); text(state.overallNotes, "state.overallNotes", 0, manifest.limits.overallNotesMax); const readiness = computeReady(state, manifest); if (state.ready !== readiness.ready) fail("state.ready does not match computed readiness"); return state;
}
function approvedSelectionSnapshot(state, manifest) { validateState(state, manifest); if (!state.ready) fail("state is not ready for retrieval"); const selectedOptionDependencies = []; state.decisions.forEach((answer, index) => { const option = manifest.decisions[index].options.find((item) => item.id === answer.selectedOptionId); if (option?.dependsOnEpicIds.length) selectedOptionDependencies.push({ optionId: option.id, dependsOnEpicIds: [...option.dependsOnEpicIds] }); }); const snapshot = { schemaVersion: 1, manifestDigest: state.manifestDigest, baselineDigest: state.baselineDigest, intentDigest: hash(manifest.intent), sourceStateRevision: state.revision, sourceStateDigest: state.stateDigest, epics: structuredClone(state.epics), decisions: structuredClone(state.decisions), blockers: structuredClone(state.blockers), overallNotes: state.overallNotes, selectedOptionDependencies, snapshotDigest: "" }; snapshot.snapshotDigest = hash(omit(snapshot, "snapshotDigest")); return snapshot; }

function statePath(stateDir, slug) { return path.join(stateDir, `${slug}.state.json`); }
function backupPath(stateDir, slug) { return path.join(stateDir, `${slug}.state.backup.json`); }
function nofollow() { return fs.constants.O_NOFOLLOW || 0; }
function safeParent(stateDir) { const parent = path.dirname(stateDir); const stat = fs.lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== path.resolve(parent)) fail("state directory parent is unsafe"); }
function sameInode(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function descriptorDirectory(fd, opened) {
  const candidates = process.platform === "linux" ? [`/proc/self/fd/${fd}`] : [`/dev/fd/${fd}`];
  for (const candidate of candidates) {
    try { if (sameInode(fs.statSync(candidate), opened)) return candidate; } catch {}
  }
  const error = new Error("writable persistence requires a verified descriptor-anchored directory path; use loopback read-only mode on this platform");
  error.code = "REPOWORKSHOP_PERSISTENCE_UNSUPPORTED";
  throw error;
}
function openStateDirectory(stateDir) {
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    const error = new Error("writable persistence requires O_DIRECTORY and O_NOFOLLOW; use loopback read-only mode on this platform");
    error.code = "REPOWORKSHOP_PERSISTENCE_UNSUPPORTED";
    throw error;
  }
  const before = fs.lstatSync(stateDir);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o077) || fs.realpathSync(stateDir) !== path.resolve(stateDir)) fail("state directory is unsafe");
  const fd = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || !sameInode(before, opened)) fail("state directory changed while opening");
    const root = descriptorDirectory(fd, opened);
    if (!sameInode(fs.statSync(root), opened)) fail("state directory descriptor verification failed");
    return { fd, root, opened, pathname: stateDir };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function verifyOriginalDirectory(directory) {
  let current;
  try { current = fs.lstatSync(directory.pathname); } catch {
    const error = new Error("state directory pathname was replaced during the operation; state remains only in the opened original directory");
    error.code = "REPOWORKSHOP_STATE_DIR_REPLACED";
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameInode(current, directory.opened)) {
    const error = new Error("state directory pathname was replaced during the operation; state remains only in the opened original directory");
    error.code = "REPOWORKSHOP_STATE_DIR_REPLACED";
    throw error;
  }
}
function readRegular(file, manifest, allowMissing = false) {
  let handle; try { handle = fs.openSync(file, fs.constants.O_RDONLY | nofollow()); } catch (error) { if (allowMissing && error.code === "ENOENT") return null; throw error; }
  try { const stat = fs.fstatSync(handle); if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o077))) fail("state file must be a regular owner-only file"); return validateState(parseJsonStrict(decodeUtf8Strict(fs.readFileSync(handle))), manifest); } finally { fs.closeSync(handle); }
}
function loadOpenedState(directory, manifest) {
  const file = statePath(directory.root, manifest.project.slug); const backup = backupPath(directory.root, manifest.project.slug);
  try { const state = readRegular(file, manifest, true); return state || initialState(manifest); } catch (error) { const recovered = readRegular(backup, manifest, true); if (recovered) return recovered; throw error; }
}
function loadState(stateDir, manifest) {
  let directory;
  try { directory = openStateDirectory(stateDir); } catch (error) { if (error.code === "ENOENT") { safeParent(stateDir); return initialState(manifest); } throw error; }
  try { const state = loadOpenedState(directory, manifest); verifyOriginalDirectory(directory); return state; }
  finally { fs.closeSync(directory.fd); }
}
function persistState(stateDir, manifest, candidate, expectedRevision, now = new Date().toISOString(), hooks = {}) {
  let directory;
  try { directory = openStateDirectory(stateDir); } catch (error) {
    if (error.code === "ENOENT") { error.message = "state directory must be created owner-only before writable persistence"; error.code = "REPOWORKSHOP_PERSISTENCE"; }
    throw error;
  }
  const stage = (name) => { if (hooks.onStage) hooks.onStage(name); };
  try { stage("directory-opened"); } catch (error) { fs.closeSync(directory.fd); throw error; }
  let current;
  try { current = loadOpenedState(directory, manifest); } catch (error) { fs.closeSync(directory.fd); throw error; }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) { try { verifyOriginalDirectory(directory); return { conflict: true, state: current }; } finally { fs.closeSync(directory.fd); } }
  let next;
  try { next = structuredClone(candidate); next.schemaVersion = 1; next.baselineDigest = manifest.baselineDigest; next.manifestDigest = manifest.manifestDigest; next.revision = current.revision + 1; next.updatedAt = now; next.ready = computeReady(next, manifest).ready; next.stateDigest = stateDigest(next); validateState(next, manifest); }
  catch (error) { fs.closeSync(directory.fd); throw error; }
  const file = statePath(directory.root, manifest.project.slug); const backup = backupPath(directory.root, manifest.project.slug); const temporary = path.join(directory.root, `.${manifest.project.slug}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`); let handle;
  try {
    // Preserve only a state already opened and fully validated through no-follow.
    const prior = readRegular(file, manifest, true); if (prior) { const backupTemp = `${temporary}.backup`; let backupHandle; try { stage("before-backup-write"); backupHandle = fs.openSync(backupTemp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow(), 0o600); stage("backup-opened"); fs.writeFileSync(backupHandle, `${JSON.stringify(prior, null, 2)}\n`); fs.fsyncSync(backupHandle); stage("backup-synced"); fs.closeSync(backupHandle); backupHandle = undefined; stage("backup-closed"); stage("before-backup-publish"); fs.renameSync(backupTemp, backup); stage("backup-published"); } finally { if (backupHandle !== undefined) fs.closeSync(backupHandle); try { fs.unlinkSync(backupTemp); } catch {} } }
    stage("before-state-write"); handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow(), 0o600); stage("state-opened"); const opened = fs.fstatSync(handle); if (!opened.isFile() || (opened.mode & 0o077)) fail("temporary state file is unsafe"); fs.writeFileSync(handle, `${JSON.stringify(next, null, 2)}\n`); fs.fsyncSync(handle); stage("state-synced"); if (hooks.beforePublish) hooks.beforePublish(); fs.closeSync(handle); handle = undefined; stage("state-closed"); stage("before-state-publish"); fs.renameSync(temporary, file); stage("state-published"); stage("before-directory-sync"); fs.fsyncSync(directory.fd); stage("directory-synced"); verifyOriginalDirectory(directory);
  } catch (error) { if (error.code !== "REPOWORKSHOP_STATE_DIR_REPLACED") error.code = "REPOWORKSHOP_PERSISTENCE"; throw error; } finally { if (handle !== undefined) try { fs.closeSync(handle); } catch {} try { fs.unlinkSync(temporary); } catch {} fs.closeSync(directory.fd); }
  return { conflict: false, state: next };
}

module.exports = { canonical, hash, parseJsonStrict, decodeUtf8Strict, manifestDigest, stateDigest, baselineDigest, validateManifest, computeReady, initialState, validateState, approvedSelectionSnapshot, loadState, persistState, statePath, backupPath };
