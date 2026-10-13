import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SupervisedExample } from "../src/generate.js";
import { assertTemplateReadyForExport, QWEN3_8B_TEMPLATE_PROFILE } from "../src/templateProfiles.js";
import {
  DEFAULT_TOKENIZER_EVIDENCE_DIR, loadMeasuredTokenizerEvidence, assertTokenizerMeasurement,
  createTokenizerBridge, withMeasuredQwen3Template,
} from "../src/tokenizer.js";

const evidence = loadMeasuredTokenizerEvidence();

test("real measured Qwen3 evidence satisfies the export template gate", () => {
  assert.doesNotThrow(() => assertTemplateReadyForExport(evidence.profile, evidence.artifacts));
  assert.throws(() => assertTemplateReadyForExport(QWEN3_8B_TEMPLATE_PROFILE, new Map()), /pinned template bytes/);
  assert.equal(evidence.profile.templateArtifact!.trlVersion, "1.15.0");
  assert.equal(evidence.profile.templateArtifact!.transformersVersion, "5.19.0");
  assert.equal(evidence.probes.length, 8);
});

test("real traces supervise tool names, numeric/Unicode arguments, closing syntax and special-token terminators", () => {
  const probe = evidence.probes.find((item) => item.id === "quoted-numeric-arguments")!;
  assertTokenizerMeasurement(probe.measurement, probe.example);
  const segment = probe.measurement.toolCallProbes[0]!;
  assert.match(segment.renderedText.slice(segment.serializedCall.start, segment.serializedCall.end), /2220/);
  assert.ok(segment.renderedText.slice(segment.serializedCall.start, segment.serializedCall.end).includes("🌊"));
  assert.ok(segment.tokens.some((token) => token.tokenId === 151645 && token.label === 151645
    && token.start === segment.turnTerminator.start));
  assert.equal(probe.measurement.supervisedTokens, 38);
});

test("UTF-16 offsets remain valid after non-BMP characters", () => {
  const probe = evidence.probes.find((item) => item.id === "mixed-prose-and-call")!;
  const segment = probe.measurement.toolCallProbes[0]!;
  assert.ok(probe.measurement.renderedText.indexOf("🌊") < segment.serializedCall.start);
  assert.equal(probe.measurement.renderedText.slice(segment.serializedCall.start, segment.serializedCall.start + 11), "<tool_call>");
  assert.equal(probe.measurement.renderedText.slice(segment.turnTerminator.start, segment.turnTerminator.end), "<|im_end|>");
});

test("null content is normalized and consecutive tool results are masked", () => {
  const nullCall = evidence.probes.find((item) => item.id === "call-only-null")!;
  assert.doesNotMatch(nullCall.measurement.renderedText, /None/);
  const consecutive = evidence.probes.find((item) => item.id === "consecutive-tool-results")!;
  const text = consecutive.measurement.renderedText;
  assert.equal((text.match(/<tool_response>/g) ?? []).length, 2);
  let cursor = 0;
  for (let ordinal = 0; ordinal < 2; ordinal += 1) {
    const start = text.indexOf("<tool_response>", cursor);
    const end = text.indexOf("</tool_response>", start) + "</tool_response>".length;
    const tokens = consecutive.measurement.tokens.filter((token) => token.start < end && token.end > start);
    assert.ok(tokens.length);
    assert.ok(tokens.every((token) => token.label === -100));
    cursor = end;
  }
});

test("unapproved assistant history is masked even when HF marks it as assistant generation", () => {
  for (const id of ["unapproved-assistant-history", "unapproved-call-history"]) {
    const probe = evidence.probes.find((item) => item.id === id)!;
    const old = probe.measurement.assistantRanges.find((region) => !region.selected)!;
    const indices = probe.measurement.tokens.flatMap((token, index) => token.start < old.end && token.end > old.start ? [index] : []);
    assert.ok(indices.some((index) => probe.measurement.assistantMask[index] === 1));
    assert.ok(indices.every((index) => probe.measurement.labels[index] === -100));
  }
});

test("thinking scaffold is excluded from the final selected-target loss", () => {
  const measured = evidence.probes[0]!.measurement;
  const selected = measured.assistantRanges[0]!;
  assert.equal(measured.renderedText.slice(selected.start, selected.targetStart), "<think>\n\n</think>\n\n");
  assert.ok(measured.tokens.filter((token) => token.start < selected.targetStart && token.end > selected.start)
    .every((token) => token.label === -100));
  assert.equal(measured.labels.filter((label) => label !== -100).length, measured.supervisedTokens);
});

test("both measured prefix samples preserve text and tokens", () => {
  for (const sample of evidence.profile.prefixPreservation!.samples) {
    assert.ok(sample.after.startsWith(sample.before));
    assert.deepEqual(sample.afterTokenIds.slice(0, sample.beforeTokenIds.length), sample.beforeTokenIds);
  }
});

test("wrong counts, stale target selections and context labels reject at the intended gate", () => {
  const probe = evidence.probes[0]!;
  const wrongCount = structuredClone(probe.measurement);
  wrongCount.supervisedTokens += 1;
  assert.throws(() => assertTokenizerMeasurement(wrongCount, probe.example), /count differs/);
  const contextLoss = structuredClone(probe.measurement);
  contextLoss.labels[0] = contextLoss.inputIds[0]!;
  contextLoss.tokens[0]!.label = contextLoss.inputIds[0]!;
  assert.throws(() => assertTokenizerMeasurement(contextLoss, probe.example), /masked context/);
  assert.throws(() => assertTokenizerMeasurement(probe.measurement, { ...probe.example,
    targetSelection: { supervisedAssistantIndices: [], supervisedToolCallIndices: [] } }), /bind target selection/);
});

test("missing/changed evidence refuses; recomputed outer checksum cannot hide a changed runtime pin", (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-tokenizer-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(DEFAULT_TOKENIZER_EVIDENCE_DIR, root, { recursive: true });
  const path = join(root, "qwen3-8b.json");
  const changed = JSON.parse(readFileSync(path, "utf8")) as { runtimeVersions: { trl: string } };
  changed.runtimeVersions.trl = "unmeasured";
  const bytes = JSON.stringify(changed);
  writeFileSync(path, bytes);
  assert.throws(() => loadMeasuredTokenizerEvidence(root), /checksum mismatch/);
  const checksumPath = join(root, "checksums.json");
  const checksums = JSON.parse(readFileSync(checksumPath, "utf8")) as { files: Record<string, string> };
  checksums.files["qwen3-8b.json"] = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(checksumPath, JSON.stringify(checksums));
  assert.throws(() => loadMeasuredTokenizerEvidence(root), /pinned model\/template\/runtime/);
  rmSync(join(root, "qwen3_training.jinja"));
  assert.throws(() => loadMeasuredTokenizerEvidence(root));
});

test("template registry integration preserves independent certificate/validator approvals", () => {
  const certificates = new Map<string, string>();
  const validators = {};
  const updated = withMeasuredQwen3Template({ certificates, validators, artifacts: new Map(), templateProfiles: [] }, evidence);
  assert.equal(updated.certificates, certificates);
  assert.equal(updated.validators, validators);
  assert.equal(updated.templateProfiles[0]!.modelId, "Qwen/Qwen3-8B");
  assert.doesNotThrow(() => assertTemplateReadyForExport(updated.templateProfiles[0]!, updated.artifacts));
});

test("real CPU bridge handles fresh inputs, matches fixture counts and refuses truncation", {
  skip: !process.env.FOUNDRY_TOKENIZER_PYTHON,
}, () => {
  const bridge = createTokenizerBridge({ python: process.env.FOUNDRY_TOKENIZER_PYTHON!,
    assetsDir: process.env.FOUNDRY_TOKENIZER_ASSETS ?? ".dataset/tokenizer/qwen3-8b" });
  const fixture = evidence.probes[0]!;
  assert.equal(bridge.countSupervisedTokens(fixture.example), fixture.measurement.supervisedTokens);
  const fresh: SupervisedExample = { family: "roleplay-conversation",
    messages: [{ role: "user", content: "Oswin a obtenu 27." }, { role: "assistant", content: "Oswin lit le résultat 27 près du quai 🌊." }],
    targetSelection: { supervisedAssistantIndices: [1], supervisedToolCallIndices: [] } };
  const measured = bridge.measure(fresh);
  assert.equal(bridge.countSupervisedTokens(fresh), measured.labels.filter((label) => label !== -100).length);
  assert.match(measured.renderedText, /Oswin.*27/);
  measured.labels.fill(-100);
  assert.ok(bridge.countSupervisedTokens(fresh) > 0, "caller mutation cannot corrupt cached measurements");
  assert.throws(() => bridge.measure({ ...fresh, messages: [
    { role: "user", content: "long ".repeat(4200) }, fresh.messages[1]!,
  ] }), /truncation is disabled/);
});
