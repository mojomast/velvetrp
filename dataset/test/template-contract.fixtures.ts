/** Synthetic unit-test measurements. These are NOT model/tokenizer benchmark artifacts. */
import {
  computeTemplateDigest, type TemplateProfile, type TemplateMeasurementBinding,
  type ToolCallSupervisionSegments,
} from "../src/templateProfiles.js";
import type { StoredToolCall } from "../src/spec.js";

export const FIXTURE_TEMPLATE = "{{ tools | tojson }}{% for message in messages %}{% generation %}{{ message.tool_calls | tojson }}<|im_end|>{% endgeneration %}{% endfor %}";
export const FIXTURE_CALL: StoredToolCall = {
  id: "fixture-call", type: "function", function: { name: "inspect", arguments: { target: "ledger", count: 2 } },
};
export const FIXTURE_BINDING: TemplateMeasurementBinding = {
  templateDigest: computeTemplateDigest(FIXTURE_TEMPLATE), tokenizerRevision: "a".repeat(40),
  trlVersion: "0.0.0-test", transformersVersion: "0.0.0-test", thinkingMode: "disabled",
};

export function fixtureSegments(): ToolCallSupervisionSegments {
  const call = `<tool_call>\n${JSON.stringify(FIXTURE_CALL.function)}\n</tool_call>`;
  const renderedText = `${call}<|im_end|>`;
  return {
    ...FIXTURE_BINDING, renderedText, call: structuredClone(FIXTURE_CALL.function),
    serializedCall: { start: 0, end: call.length }, turnTerminator: { start: call.length, end: renderedText.length },
    tokens: [...Array.from(call, (char, start) => ({ start, end: start + 1, tokenId: char.charCodeAt(0), label: char.charCodeAt(0) })),
      { start: call.length, end: renderedText.length, tokenId: 1001, label: 1001 }],
  };
}

export function fixtureProfile(): TemplateProfile {
  const segments = fixtureSegments();
  return {
    profileId: "unit-test-only", modelId: "fixture/not-a-model", tokenizerRevision: FIXTURE_BINDING.tokenizerRevision,
    templateDigest: FIXTURE_BINDING.templateDigest, publishedTemplateRendersTools: true,
    publishedTemplateHasGenerationMarkers: false, requiredTemplateOverride: FIXTURE_TEMPLATE,
    generationPrompt: "assistant", stopSequences: ["<|im_end|>"], toolCallParser: "hermes", knownLimits: ["Unit-test fixture only"],
    supervisedSpans: ["assistant-prose", "tool-calls", "turn-terminator"],
    maskedSpans: ["system", "user", "tool-results", "unapproved-assistant-history"],
    toolCallTurnTerminator: "<|im_end|>",
    templateArtifact: {
      ...FIXTURE_BINDING, modelId: "fixture/not-a-model", templateText: FIXTURE_TEMPLATE,
      source: "unit-test-only", hasGenerationMarkers: true, rendersTools: true,
      toolCallTurnTerminatorTokenId: 1001,
    },
    toolCallSupervisionProbes: [segments],
    prefixPreservation: {
      ...FIXTURE_BINDING,
      samples: [{
        messages: [{ role: "user", content: "Inspect" }, { role: "assistant", content: "", tool_calls: [FIXTURE_CALL] }],
        appendedToolMessage: { role: "tool", content: "Found", tool_call_id: FIXTURE_CALL.id },
        before: segments.renderedText, after: `${segments.renderedText}<tool_response>Found</tool_response>`,
        beforeTokenIds: segments.tokens.map((token) => token.tokenId),
        afterTokenIds: [...segments.tokens.map((token) => token.tokenId), 1000],
      }],
    },
  };
}
