import assert from "node:assert/strict";
import { test } from "node:test";
import { TRAINING_FAMILIES } from "../src/spec.js";
import {
  QWEN3_8B_TEMPLATE_PROFILE, RPMAX_TEMPLATE_PROFILE, assertPrefixPreserving,
  assertTemplateCanTrain, assertTemplateReadyForExport, assertToolCallIsSupervised,
  computeTemplateDigest, type TemplateProfile, type ToolPrecondition,
} from "../src/templateProfiles.js";
import { FIXTURE_TEMPLATE, fixtureProfile, fixtureSegments } from "./template-contract.fixtures.js";

const TOOLS: ToolPrecondition = { advertisesTools: true, hasToolCalls: true, wantsToolCallSupervision: true };
const PROSE: ToolPrecondition = { advertisesTools: false, hasToolCalls: false, wantsToolCallSupervision: false };

// Frozen v1 probe: these predicates never checked generation markers.
function legacyCanTrain(profile: TemplateProfile, needs: ToolPrecondition): boolean {
  return !((needs.advertisesTools || needs.hasToolCalls) && !profile.publishedTemplateRendersTools && !profile.requiredTemplateOverride)
    && (!needs.wantsToolCallSupervision || profile.supervisedSpans.includes("tool-calls"))
    && !profile.supervisedSpans.includes("tool-results") && /^[0-9a-f]{40}$/.test(profile.tokenizerRevision);
}

test("REPRODUCTION: Qwen's missing override was accepted despite no published generation markers", () => {
  const broken = { ...QWEN3_8B_TEMPLATE_PROFILE, requiredTemplateOverride: null };
  assert.equal(broken.publishedTemplateHasGenerationMarkers, false);
  assert.equal(legacyCanTrain(broken, TOOLS), true);
  assert.throws(() => assertTemplateCanTrain(broken, TOOLS), /generation markers/);
});

test("REPRODUCTION: hashing a template label could not detect changed template bytes", () => {
  const label = "qwen3_training.jinja:trl-patched";
  const oldDigest = (_templateBytes: string): string => computeTemplateDigest(label);
  assert.equal(oldDigest("old bytes"), oldDigest("changed bytes"));
  assert.notEqual(computeTemplateDigest("old bytes"), computeTemplateDigest("changed bytes"));
  assert.notEqual(QWEN3_8B_TEMPLATE_PROFILE.templateDigest, computeTemplateDigest(label));
});

for (const family of TRAINING_FAMILIES) {
  test(`FIX: ${family} refuses override removal, including prose-only training`, () => {
    for (const profile of [QWEN3_8B_TEMPLATE_PROFILE, RPMAX_TEMPLATE_PROFILE]) {
      for (const needs of [TOOLS, PROSE]) {
        assert.throws(() => assertTemplateCanTrain({ ...profile, requiredTemplateOverride: null }, needs), /generation markers/);
      }
    }
  });
}

test("FIX: ordinary Qwen3 uses Hermes JSON and records the parser rationale", () => {
  assert.equal(QWEN3_8B_TEMPLATE_PROFILE.toolCallParser, "hermes");
  assert.ok(QWEN3_8B_TEMPLATE_PROFILE.knownLimits.some((limit) => /Qwen3-8B.*documentation/.test(limit)));
  assert.throws(() => assertTemplateCanTrain({ ...QWEN3_8B_TEMPLATE_PROFILE, toolCallParser: "qwen3_coder" }, TOOLS), /hermes/);
});

test("FIX: the Qwen override resolves to a byte digest at an immutable source revision", () => {
  const artifact = QWEN3_8B_TEMPLATE_PROFILE.templateArtifact!;
  assert.equal(QWEN3_8B_TEMPLATE_PROFILE.requiredTemplateOverride, artifact.source);
  assert.match(artifact.source, /\/trl\/[0-9a-f]{40}\/trl\/chat_templates\/qwen3_training\.jinja$/);
  assert.equal(artifact.templateDigest, "1d944ff8f268b611abb296cdd24d0f51981eef1c8647ac321c3a0258f61eb6c9");
  assert.match(artifact.tokenizerRevision, /^[0-9a-f]{40}$/);
  assert.equal(artifact.thinkingMode, "disabled");
  assert.equal(artifact.templateText, null, "the downloaded artifact must be resolved again at export");
  assert.throws(() => assertTemplateReadyForExport(QWEN3_8B_TEMPLATE_PROFILE, new Map()), /pinned template bytes are absent/);
});

test("FIX: generation markers must exist in executable template bytes, not comments or claims", () => {
  const profile = fixtureProfile();
  assert.doesNotThrow(() => assertTemplateCanTrain(profile, TOOLS));
  for (const text of ["{{ messages }}", "{# {% generation %} {% endgeneration %} #}{{ messages }}", "{% generation %}no end"] ) {
    const templateDigest = computeTemplateDigest(text);
    const altered = { ...profile, templateDigest, requiredTemplateOverride: text,
      templateArtifact: { ...profile.templateArtifact!, templateDigest, templateText: text } };
    assert.throws(() => assertTemplateCanTrain(altered, PROSE), /generation markers/);
  }
  assert.throws(() => assertTemplateCanTrain({ ...profile, templateArtifact: { ...profile.templateArtifact!, hasGenerationMarkers: false } }, PROSE), /generation markers/);
});

test("FIX: changing template text or model/tokenizer pins invalidates the artifact", () => {
  const profile = fixtureProfile();
  assert.throws(() => assertTemplateCanTrain({ ...profile, templateArtifact: { ...profile.templateArtifact!, templateText: `${FIXTURE_TEMPLATE}\n` } }, TOOLS), /pinned digest/);
  assert.throws(() => assertTemplateCanTrain({ ...profile, tokenizerRevision: "b".repeat(40) }, PROSE), /binding mismatch/);
  assert.throws(() => assertTemplateCanTrain({ ...profile, modelId: "different-model" }, PROSE), /binding mismatch/);
  assert.throws(() => assertTemplateCanTrain({ ...profile, requiredTemplateOverride: "Use an unpinned patch" }, PROSE), /does not resolve/);
  assert.throws(() => assertTemplateCanTrain({ ...profile, templateArtifact: null }, PROSE), /artifact is required/);
});

test("FIX: profile contract supervises prose, calls and terminators while masking context", () => {
  for (const profile of [RPMAX_TEMPLATE_PROFILE, QWEN3_8B_TEMPLATE_PROFILE]) {
    assert.deepEqual(profile.supervisedSpans, ["assistant-prose", "tool-calls", "turn-terminator"]);
    assert.deepEqual(profile.maskedSpans, ["system", "user", "tool-results", "unapproved-assistant-history"]);
    for (const masked of profile.maskedSpans!) {
      assert.throws(() => assertTemplateCanTrain({ ...profile, supervisedSpans: [...profile.supervisedSpans, masked] }, PROSE), /must never be supervised/);
    }
    assert.throws(() => assertTemplateCanTrain({ ...profile, supervisedSpans: ["assistant-prose", "tool-calls"] }, TOOLS), /turn-terminator must receive loss/);
  }
});

test("FIX: serialized name, argument values, closing syntax and the end-of-turn token all receive loss", () => {
  const profile = fixtureProfile();
  const segments = fixtureSegments();
  assert.doesNotThrow(() => assertToolCallIsSupervised(profile, segments));
  const positions = [segments.renderedText.indexOf("inspect"), segments.renderedText.indexOf("ledger"), segments.renderedText.indexOf("</tool_call>"), segments.turnTerminator.start];
  for (const start of positions) {
    const tokens = segments.tokens.map((token) => token.start === start ? { ...token, label: -100 } : token);
    assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, tokens }), /masked or incorrect loss labels/);
  }
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, tokens: segments.tokens.filter((token) => token.start !== positions[1]) }), /unmeasured token gap/);
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments,
    tokens: segments.tokens.map((token) => token.start === segments.turnTerminator.start ? { ...token, tokenId: 1002, label: 1002 } : token),
  }), /pinned end-of-turn special token/);
});

test("FIX: supervision checks compare actual call values and reject wrong stop tokens and stale measurements", () => {
  const profile = fixtureProfile();
  const segments = fixtureSegments();
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, call: { ...segments.call, name: "wrong" } }), /name, argument values, or closing syntax/);
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, call: { ...segments.call, arguments: { target: "different", count: 2 } } }), /name, argument values, or closing syntax/);
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, renderedText: segments.renderedText.replace("im_end", "im_bad") }), /incorrect tool-call turn terminator/);
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, templateDigest: "f".repeat(64) }), /measurement templateDigest/);
  assert.throws(() => assertToolCallIsSupervised(profile, { ...segments, thinkingMode: "enabled" }), /thinkingMode/);
});

test("FIX: prefix checks require measured tool-message append evidence and preserve bytes AND tokens", () => {
  const profile = fixtureProfile();
  assert.doesNotThrow(() => assertPrefixPreserving(profile));
  const evidence = profile.prefixPreservation!;
  const sample = evidence.samples[0]!;
  const { prefixPreservation: _removed, ...missing } = profile;
  assert.throws(() => assertPrefixPreserving(missing), /measured prefix-preservation evidence/);
  assert.throws(() => assertPrefixPreserving({ ...profile, prefixPreservation: { ...evidence, samples: [{ ...sample, after: `changed${sample.after}` }] } }), /changed earlier assistant rendering/);
  assert.throws(() => assertPrefixPreserving({ ...profile, prefixPreservation: { ...evidence, samples: [{ ...sample, afterTokenIds: [99, ...sample.afterTokenIds] }] } }), /changed earlier assistant tokens/);
  assert.throws(() => assertPrefixPreserving({ ...profile, prefixPreservation: { ...evidence, tokenizerRevision: "b".repeat(40) } }), /measurement tokenizerRevision/);
});

test("FIX: export fails closed without exact bytes, runtime pins and measured mask/prefix contracts", () => {
  const profile = fixtureProfile();
  const artifacts = new Map([[profile.templateDigest, FIXTURE_TEMPLATE]]);
  assert.doesNotThrow(() => assertTemplateReadyForExport(profile, artifacts));
  assert.throws(() => assertTemplateReadyForExport(profile, new Map([[profile.templateDigest, `${FIXTURE_TEMPLATE}\n`]])), /bytes are absent or changed/);
  assert.throws(() => assertTemplateReadyForExport({ ...profile, templateArtifact: { ...profile.templateArtifact!, transformersVersion: null } }, artifacts), /exact measured TRL and Transformers versions/);
  assert.throws(() => assertTemplateReadyForExport({ ...profile, templateArtifact: { ...profile.templateArtifact!, trlVersion: "latest" } }, artifacts), /exact measured TRL and Transformers versions/);
  assert.throws(() => assertTemplateReadyForExport({ ...profile, toolCallSupervisionProbes: [] }, artifacts), /measured tool-call supervision/);
  assert.throws(() => assertTemplateReadyForExport({ ...profile, prefixPreservation: { ...profile.prefixPreservation!, samples: [] } }, artifacts), /prefix-preservation/);
});
