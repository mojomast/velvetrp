"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const state = require("../state.js");
const ui = require("../public/ui-helpers.js");
const readiness = require("../public/readiness.js");
const manifest = state.parseJsonStrict(fs.readFileSync(path.join(__dirname, "..", "manifest.example.json"), "utf8"));

test("pure option/custom transitions preserve draft and unanswered filtering", () => { let answer = state.initialState(manifest).decisions[0]; answer = ui.typeCustom(answer, "draft"); answer = ui.selectOption(answer, "DEC-001-OPT-02"); assert.equal(answer.customAnswer, "draft"); assert.equal(ui.answered(answer, manifest.decisions[0]), true); answer = ui.selectCustom(answer); assert.equal(answer.customAnswer, "draft"); answer = ui.typeCustom(answer, "  "); assert.equal(ui.answered(answer, manifest.decisions[0]), false); assert.equal(ui.decisionVisible(answer, manifest.decisions[0], true), true); });
test("pure filter behavior combines query, enabled, and priority", () => { const board = state.initialState(manifest); assert.equal(ui.epicVisible(manifest.epics[0], board.epics[0], { query: "core", inclusion: "included", priority: "P1" }), true); assert.equal(ui.epicVisible(manifest.epics[0], board.epics[0], { query: "missing", inclusion: "all", priority: "all" }), false); });
test("review export is inert text under hostile multiline payloads", () => { const board = state.initialState(manifest); board.overallNotes = "<script>alert(1)</script>\n![x](javascript:alert(1))\n[click](data:text/html,x)\u202e"; board.epics[0].notes = "# heading\n<div onload=x>"; const output = ui.reviewExport(manifest, board); assert.ok(output.startsWith("REVIEW ONLY - NON-AUTHORITATIVE")); assert.doesNotMatch(output, /<script|<div|\u202e/u); for (const hostile of output.split("\n").filter((line) => /javascript:|data:text|# heading/.test(line))) assert.match(hostile, /^ {4}/); });
test("readiness presentation identifies focusable records", () => { const board = state.initialState(manifest); const failures = ui.readinessFailures(board, manifest); assert.ok(failures.every((item) => /^DEC-|^EPIC-|^BLOCK-|^intent-/.test(item.targetId))); });
test("browser and server use one evaluator across every readiness predicate", () => {
  assert.equal(state.computeReady, readiness.computeReady);
  const cases = [];
  function add(name, mutate, sourceManifest = manifest) { const board = state.initialState(sourceManifest); mutate(board, sourceManifest); cases.push([name, board, sourceManifest]); }
  add("all ready through option", (board) => { board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; });
  add("required custom blank", (board) => { board.decisions[0].customAnswer = "  "; });
  add("required custom answered", (board) => { board.decisions[0].customAnswer = "custom"; });
  add("epic needs disposition", (board) => { board.epics[0].disposition = "Need decision"; });
  add("remove needs reason", (board) => { board.epics[0].disposition = "Remove"; });
  add("remove with reason", (board) => { board.epics[0].enabled = false; board.epics[0].disposition = "Remove"; board.epics[0].dispositionReason = "out"; board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; });
  add("direct and transitive epic dependencies", (board) => { board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; board.epics[0].enabled = false; });
  const withDecisionDependency = structuredClone(manifest); const dependency = structuredClone(withDecisionDependency.decisions[0]); dependency.id = "DEC-002"; dependency.required = false; dependency.dependsOnDecisionIds = []; dependency.options.forEach((option, index) => { option.id = `DEC-002-OPT-0${index + 1}`; }); dependency.recommendedOptionId = "DEC-002-OPT-01"; withDecisionDependency.decisions[0].dependsOnDecisionIds = ["DEC-002"]; withDecisionDependency.decisions.push(dependency); withDecisionDependency.manifestDigest = state.manifestDigest(withDecisionDependency);
  add("required decision dependency unanswered", (board) => { board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; }, withDecisionDependency);
  add("required decision dependency answered", (board) => { board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; board.decisions[1].selectedOptionId = "DEC-002-OPT-01"; }, withDecisionDependency);
  const blockerPredicates = ["manual-resolution", "all-decisions-answered", "epics-disabled"];
  for (const predicate of blockerPredicates) {
    const withBlocker = structuredClone(manifest); withBlocker.blockers = [{ id: "BLOCK-001", title: "Gate", detail: "Test gate", epicIds: ["EPIC-001"], decisionIds: ["DEC-001"], evidenceIds: ["EVIDENCE-001"], resolutionPredicate: predicate }]; withBlocker.manifestDigest = state.manifestDigest(withBlocker);
    add(`${predicate} unresolved`, () => {}, withBlocker);
    add(`${predicate} resolved contradiction`, (board) => { board.blockers[0].resolved = true; board.blockers[0].resolutionNote = "done"; }, withBlocker);
    add(`${predicate} resolved satisfied`, (board) => { board.decisions[0].selectedOptionId = "DEC-001-OPT-01"; board.blockers[0].resolved = true; board.blockers[0].resolutionNote = "done"; if (predicate === "epics-disabled") { board.epics.forEach((epic) => { epic.enabled = false; }); } }, withBlocker);
  }
  for (const [name, board, sourceManifest] of cases) assert.deepEqual(ui.readinessFailures(board, sourceManifest), state.computeReady(board, sourceManifest).failures, name);
});
test("custom answer control models multiline and single-line validation", () => {
  const source = structuredClone(manifest.decisions[0]); source.customAnswer.maxLength = 500;
  source.customAnswer.validation = "multiline"; assert.deepEqual(ui.customAnswerControl(source, 200), { tag: "textarea", attributes: { rows: "3", maxlength: "200" } });
  source.customAnswer.validation = "single-line"; assert.deepEqual(ui.customAnswerControl(source, 1000), { tag: "input", attributes: { type: "text", maxlength: "500", pattern: "[^\\r\\n]*" } });
  source.customAnswer.validation = "nonblank-trimmed"; assert.deepEqual(ui.customAnswerControl(source, 1000), { tag: "input", attributes: { type: "text", maxlength: "500" } });
});
test("served controller wires shared readiness and custom control rendering", () => { const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8"); assert.match(source, /ui\.readinessFailures\(view\.state, view\.manifest\)/); assert.match(source, /ui\.customAnswerControl/); assert.match(source, /addEventListener\("input"/); });
