"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const stateModule = require("../state.js");
const { isSafeBind, loadConfig, loadManifest } = require("../server.js");

const root = path.resolve(__dirname, "..");
const fixture = () => stateModule.parseJsonStrict(fs.readFileSync(path.join(root, "manifest.example.json"), "utf8"));
const roots = [];
function temporary() { const directory = fs.mkdtempSync(path.join(fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir(), "repoworkshop-board-test-")); roots.push(directory); return directory; }
test.after(() => roots.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
function answerRequired(state) { state.intentAcknowledged = true; state.epics.forEach((epic) => { epic.approvedPriority = "P1"; epic.approvalRationale = "Approved for the stated outcome."; }); state.decisions[0].selectedOptionId = "DEC-001-OPT-01"; state.decisions[0].selectionRationale = "Fits the stated outcome."; state.decisions[0].acceptedRisks = "None"; state.ready = stateModule.computeReady(state, fixture()).ready; state.stateDigest = stateModule.stateDigest(state); }

test("published canonical vectors cover exact bytes, Unicode ordering, and strict rejection", () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "canonical-vectors.json"), "utf8"));
  vectors.accepted.forEach((vector) => { const value = stateModule.parseJsonStrict(vector.json); assert.equal(stateModule.canonical(value), vector.canonical, vector.name); assert.equal(stateModule.hash(value), vector.sha256, vector.name); });
  vectors.rejected.forEach((vector) => assert.throws(() => stateModule.parseJsonStrict(vector.json), undefined, vector.name));
  assert.throws(() => stateModule.parseJsonStrict('{"outer":{"x":1,"x":2}}'), /duplicate JSON object key/);
});

test("canonical manifest validates self projections and typed IDs", () => {
  const manifest = fixture(); assert.equal(stateModule.validateManifest(manifest), manifest); assert.equal(stateModule.manifestDigest(manifest), manifest.manifestDigest); assert.equal(stateModule.baselineDigest(manifest.researchBaseline), manifest.baselineDigest);
  const changed = structuredClone(manifest); changed.epics[0].id = "epic-1"; changed.manifestDigest = stateModule.manifestDigest(changed); assert.throws(() => stateModule.validateManifest(changed), /type prefix/);
  const badOption = structuredClone(manifest); badOption.decisions[0].options[0].id = "DEC-002-OPT-01"; badOption.manifestDigest = stateModule.manifestDigest(badOption); assert.throws(() => stateModule.validateManifest(badOption), /does not belong/);
});

test("revision zero is synthesized only; first persisted state is revision one and retrievable", () => {
  const manifest = fixture(); const parent = temporary(); const directory = path.join(parent, "state"); const state = stateModule.loadState(directory, manifest); assert.equal(state.revision, 0); assert.equal(fs.existsSync(directory), false); assert.doesNotThrow(() => stateModule.validateState(state, manifest, { allowSynthesized: true })); assert.throws(() => stateModule.validateState(state, manifest), /revision/); assert.throws(() => stateModule.persistState(directory, manifest, state, 0), /created owner-only/); fs.mkdirSync(directory, { mode: 0o700 });
  answerRequired(state); const result = stateModule.persistState(directory, manifest, state, 0, "2026-08-11T00:00:00.000Z"); assert.equal(result.state.revision, 1); assert.equal(result.state.ready, true); assert.match(result.state.stateDigest, /^sha256:[0-9a-f]{64}$/); const snapshot = stateModule.approvedSelectionSnapshot(result.state, manifest); assert.equal(snapshot.sourceStateDigest, result.state.stateDigest); assert.equal(snapshot.epics[0].id, "EPIC-001"); assert.match(snapshot.snapshotDigest, /^sha256:/);
});

test("readiness reports direct, transitive, and dependency-decision targets", () => {
  const manifest = fixture(); const state = stateModule.initialState(manifest); answerRequired(state); assert.equal(stateModule.computeReady(state, manifest).ready, true);
  state.epics[0].enabled = false; const failures = stateModule.computeReady(state, manifest).failures; assert.ok(failures.some((item) => item.targetId === "EPIC-001" && item.relatedId === "EPIC-002")); assert.ok(failures.some((item) => item.targetId === "EPIC-001" && item.relatedId === "EPIC-003" && /via EPIC-002/.test(item.message)));
  state.epics[0].enabled = true; state.decisions[0].selectedOptionId = null; assert.ok(stateModule.computeReady(state, manifest).failures.some((item) => item.targetId === "DEC-001" && item.relatedId === "EPIC-001"));
});

test("readiness requires intent, Build approval, and decision rationale", () => {
  const manifest = fixture(); const state = stateModule.initialState(manifest); const failures = stateModule.computeReady(state, manifest).failures;
  assert.ok(failures.some((item) => item.code === "INTENT")); assert.ok(failures.some((item) => item.code === "EPIC_PRIORITY"));
  answerRequired(state); assert.equal(stateModule.computeReady(state, manifest).ready, true);
  state.decisions[0].acceptedRisks = ""; assert.ok(stateModule.computeReady(state, manifest).failures.some((item) => item.code === "DECISION_RISK"));
});

test("selected option prerequisites and incompatibilities block readiness", () => {
  const manifest = fixture(); const state = stateModule.initialState(manifest); answerRequired(state); state.epics[0].enabled = false; state.decisions[0].selectedOptionId = "DEC-001-OPT-02"; assert.ok(stateModule.computeReady(state, manifest).failures.some((item) => item.code === "OPTION_DEPENDENCY"));
  const conflicting = structuredClone(manifest); const copy = structuredClone(conflicting.decisions[0]); copy.id = "DEC-002"; copy.required = false; copy.dependsOnDecisionIds = []; copy.options.forEach((option, index) => { option.id = `DEC-002-OPT-0${index + 1}`; option.incompatibleOptionIds = index === 0 ? ["DEC-001-OPT-01"] : []; }); copy.recommendedOptionId = "DEC-002-OPT-01"; conflicting.decisions.push(copy); conflicting.manifestDigest = stateModule.manifestDigest(conflicting); const board = stateModule.initialState(conflicting); answerRequired(board); board.decisions[1].selectedOptionId = "DEC-002-OPT-01"; assert.ok(stateModule.computeReady(board, conflicting).failures.some((item) => item.code === "OPTION_CONFLICT"));
});

test("selected custom answers require interpretation and accepted risks", () => {
  const manifest = fixture(); manifest.decisions[0].required = false; manifest.epics[0].requiredDecisionIds = []; manifest.manifestDigest = stateModule.manifestDigest(manifest);
  const state = stateModule.initialState(manifest); state.intentAcknowledged = true; state.epics.forEach((epic) => { epic.approvedPriority = "P1"; epic.approvalRationale = "Approved."; });
  state.decisions[0].customAnswer = "Adopt the existing internal scheduler"; const codes = () => stateModule.computeReady(state, manifest).failures.map((item) => item.code);
  assert.ok(codes().includes("CUSTOM_INTERPRETATION")); assert.ok(codes().includes("CUSTOM_RISK"));
  state.decisions[0].selectionRationale = "Use the internal scheduler; affects EPIC-002."; state.decisions[0].acceptedRisks = "None"; assert.equal(stateModule.computeReady(state, manifest).ready, true);
});

test("snapshot freezes intent digest and selected option dependencies", () => {
  const manifest = fixture(); const directory = path.join(temporary(), "state"); fs.mkdirSync(directory, { mode: 0o700 });
  const state = stateModule.initialState(manifest); answerRequired(state); state.decisions[0].selectedOptionId = "DEC-001-OPT-02"; const saved = stateModule.persistState(directory, manifest, state, 0).state;
  const snapshot = stateModule.approvedSelectionSnapshot(saved, manifest); assert.equal(snapshot.intentDigest, stateModule.hash(manifest.intent)); assert.deepEqual(snapshot.selectedOptionDependencies, [{ optionId: "DEC-001-OPT-02", dependsOnEpicIds: ["EPIC-001"] }]);
});

test("empty custom remains saveable and unanswered while optional custom does not block", () => {
  const manifest = fixture(); manifest.decisions[0].required = false; manifest.epics[0].requiredDecisionIds = []; manifest.manifestDigest = stateModule.manifestDigest(manifest); const state = stateModule.initialState(manifest); state.intentAcknowledged = true; state.epics.forEach((epic) => { epic.approvedPriority = "P1"; epic.approvalRationale = "Approved."; }); state.decisions[0].customAnswer = "   "; state.ready = true; state.stateDigest = stateModule.stateDigest(state); assert.equal(stateModule.computeReady(state, manifest).ready, true); assert.doesNotThrow(() => stateModule.validateState(state, manifest, { allowSynthesized: true }));
  manifest.decisions[0].required = true; manifest.manifestDigest = stateModule.manifestDigest(manifest); const required = stateModule.initialState(manifest); required.decisions[0].customAnswer = " "; assert.equal(stateModule.computeReady(required, manifest).ready, false);
});

test("custom answer modes enforce effective limits and line patterns", () => {
  const multilineManifest = fixture(); multilineManifest.decisions[0].customAnswer.validation = "multiline"; multilineManifest.decisions[0].customAnswer.maxLength = 12; multilineManifest.manifestDigest = stateModule.manifestDigest(multilineManifest); const multiline = stateModule.initialState(multilineManifest); multiline.intentAcknowledged = true; multiline.epics.forEach((epic) => { epic.approvedPriority = "P1"; epic.approvalRationale = "Approved."; }); multiline.decisions[0].customAnswer = "first\nsecond"; multiline.decisions[0].selectionRationale = "Custom."; multiline.decisions[0].acceptedRisks = "None"; multiline.ready = true; multiline.stateDigest = stateModule.stateDigest(multiline); assert.doesNotThrow(() => stateModule.validateState(multiline, multilineManifest, { allowSynthesized: true }));
  const singleManifest = fixture(); singleManifest.decisions[0].customAnswer.validation = "single-line"; singleManifest.manifestDigest = stateModule.manifestDigest(singleManifest); const single = stateModule.initialState(singleManifest); single.decisions[0].customAnswer = "first\nsecond"; single.stateDigest = stateModule.stateDigest(single); assert.throws(() => stateModule.validateState(single, singleManifest, { allowSynthesized: true }), /single-line/);
  const limitedManifest = fixture(); limitedManifest.limits.decisionCustomMax = 5; limitedManifest.manifestDigest = stateModule.manifestDigest(limitedManifest); const limited = stateModule.initialState(limitedManifest); limited.decisions[0].customAnswer = "123456"; limited.stateDigest = stateModule.stateDigest(limited); assert.throws(() => stateModule.validateState(limited, limitedManifest, { allowSynthesized: true }), /bounded/);
});

test("durable publication keeps prior state and recovers validated backup", () => {
  const manifest = fixture(); const directory = path.join(temporary(), "state"); fs.mkdirSync(directory, { mode: 0o700 }); const first = stateModule.initialState(manifest); answerRequired(first); const saved = stateModule.persistState(directory, manifest, first, 0).state; assert.equal(saved.revision, 1);
  const candidate = structuredClone(saved); candidate.overallNotes = "new"; assert.throws(() => stateModule.persistState(directory, manifest, candidate, 1, undefined, { beforePublish() { throw new Error("simulated publication failure"); } }), /simulated publication failure/); assert.equal(stateModule.loadState(directory, manifest).revision, 1);
  const file = stateModule.statePath(directory, manifest.project.slug); fs.writeFileSync(file, "corrupt", { mode: 0o600 }); assert.equal(stateModule.loadState(directory, manifest).revision, 1); assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  const linked = path.join(temporary(), "linked"); fs.symlinkSync(directory, linked); assert.throws(() => stateModule.loadState(linked, manifest), /unsafe/);
});

test("every publication stage remains descriptor-anchored across state-directory swaps", { skip: process.platform !== "linux" && "descriptor race proof requires Linux /proc" }, () => {
  const stages = ["directory-opened", "before-backup-write", "backup-opened", "backup-synced", "backup-closed", "before-backup-publish", "backup-published", "before-state-write", "state-opened", "state-synced", "state-closed", "before-state-publish", "state-published", "before-directory-sync", "directory-synced"];
  for (const targetStage of stages) {
    const manifest = fixture(); const parent = temporary(); const directory = path.join(parent, "state"); const attacker = path.join(parent, "attacker"); const original = path.join(parent, "opened-original");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(attacker, { mode: 0o700 }); fs.writeFileSync(path.join(attacker, "target.txt"), "attacker sentinel\n", { mode: 0o600 });
    const first = stateModule.initialState(manifest); answerRequired(first); const saved = stateModule.persistState(directory, manifest, first, 0).state; const candidate = structuredClone(saved); candidate.overallNotes = targetStage;
    let swapped = false;
    assert.throws(() => stateModule.persistState(directory, manifest, candidate, 1, undefined, { onStage(stage) { if (!swapped && stage === targetStage) { swapped = true; fs.renameSync(directory, original); fs.symlinkSync(attacker, directory, "dir"); } } }), /state directory pathname was replaced/);
    assert.equal(swapped, true, targetStage); assert.equal(fs.readFileSync(path.join(attacker, "target.txt"), "utf8"), "attacker sentinel\n", targetStage); assert.deepEqual(fs.readdirSync(attacker), ["target.txt"], targetStage); assert.equal(stateModule.loadState(original, manifest).revision, 2, targetStage);
  }
});

test("bind/configuration and no-follow manifest loading fail closed", () => {
  ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.5.4"].forEach((address) => assert.equal(isSafeBind(address), true)); ["0.0.0.0", "::", "localhost", "8.8.8.8", "172.32.0.1"].forEach((address) => assert.equal(isSafeBind(address), false)); assert.throws(() => loadConfig({ REPOWORKSHOP_BIND: "0.0.0.0", REPOWORKSHOP_CAPABILITY: "a".repeat(32) })); assert.equal(loadManifest(path.join(root, "manifest.example.json")).schemaVersion, 1);
  assert.equal(loadConfig({ REPOWORKSHOP_BIND: "127.0.0.1", REPOWORKSHOP_CAPABILITY: "a".repeat(32), REPOWORKSHOP_READ_ONLY: "1" }).readOnly, true); assert.throws(() => loadConfig({ REPOWORKSHOP_BIND: "10.1.2.3", REPOWORKSHOP_CAPABILITY: "a".repeat(32), REPOWORKSHOP_READ_ONLY: "1" }), /loopback/);
  const link = path.join(temporary(), "manifest.json"); fs.symlinkSync(path.join(root, "manifest.example.json"), link); assert.throws(() => loadManifest(link));
});

test("UI stays dependency-free, local, accessible, narrow, and manifest-driven", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8"); const js = fs.readFileSync(path.join(root, "public/app.js"), "utf8"); const css = fs.readFileSync(path.join(root, "public/app.css"), "utf8"); const combined = `${html}\n${js}\n${css}`; assert.match(html, /ui-helpers\.js/); assert.match(html, /role="status"/); assert.match(css, /max-width: 600px/); assert.match(css, /:focus-visible/); assert.doesNotMatch(combined, /https?:\/\/|innerHTML|document\.write/i); assert.match(js, /manifest\.epics/); assert.match(js, /review\.txt/);
});
