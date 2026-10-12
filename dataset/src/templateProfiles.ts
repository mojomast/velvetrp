/**
 * Pinned, model-specific chat-template and loss-mask profiles.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The audit fetched the real tokenizer configs and found a blocker: the RPMax
 * candidate's published chat template is
 *
 *   {{ role + '\n\n' + content | trim }}  ...then appends 'assistant\n\n'
 *
 * It references neither `tools` nor `tool_calls`, and has no `{% generation %}`
 * block. A tool-call assistant message carries `content: null`, and Jinja's
 * `null | trim` renders the literal string `None`. So a naive run trains RPMax
 * to emit the word "None" for every structured action, while `assistant_only_loss`
 * cannot work at all.
 *
 * Qwen3's template does render tools and tool_calls, but also lacks
 * `{% generation %}`.
 *
 * Therefore: a successful `apply_chat_template` call is NOT evidence that the
 * dataset is trainable. The mask and the rendered tool text must be inspected.
 * This module makes that a checkable, versioned artifact rather than a hope.
 *
 * Everything here is data + pure functions. No tokenizer is imported, so this
 * is CPU-only and testable in CI without model downloads.
 */

import { createHash } from "node:crypto";
import { stableStringify, type StoredMessage, type StoredToolCall } from "./spec.js";

export const TEMPLATE_PROFILE_VERSION = "template-profile-v1";

/**
 * Which supervision regions a run is allowed to compute loss on.
 *
 * - `assistant-prose`: the assistant's visible text.
 * - `tool-calls`: the serialized tool call an assistant emitted. MUST be
 *   supervised, or the model never learns to call tools.
 * - `tool-results`: environment output. MUST NOT be supervised, or the model
 *   learns to emit tool-result-shaped text (a documented Qwen3 failure mode).
 * - `user`/`system`: context. Not supervised for roleplay quality.
 */
export type SupervisionSpan = "assistant-prose" | "tool-calls" | "turn-terminator" | "tool-results" | "user" | "system" | "unapproved-assistant-history";

/** Exact UTF-8 bytes or a content-addressed reference to those bytes, never a label hash. */
export interface TemplateArtifact {
  modelId: string;
  tokenizerRevision: string;
  templateDigest: string;
  templateText: string | null;
  source: string;
  /** Null explicitly means unmeasured. Export refuses an unpinned runtime. */
  trlVersion: string | null;
  transformersVersion: string | null;
  thinkingMode: "enabled" | "disabled" | "not-applicable";
  hasGenerationMarkers: boolean;
  rendersTools: boolean;
  /** Actual special-token ID from the pinned tokenizer_config.json. */
  toolCallTurnTerminatorTokenId: number;
}

export interface TemplateProfile {
  profileId: string;
  /** Exact Hugging Face model id. */
  modelId: string;
  /** Exact tokenizer_config.json revision. Reproducibility requires the pin. */
  tokenizerRevision: string;
  /** Digest of the chat template text itself, so a template edit is detectable. */
  templateDigest: string;
  /**
   * Whether the model's PUBLISHED template renders tools and tool_calls.
   * `false` means a custom template MUST be supplied before training.
   */
  publishedTemplateRendersTools: boolean;
  /** Whether the published template contains `{% generation %}` markers. */
  publishedTemplateHasGenerationMarkers: boolean;
  /** Spans this profile supervises. Anything else is masked to -100. */
  supervisedSpans: readonly SupervisionSpan[];
  /** Generation prompt the template appends to start an assistant turn. */
  generationPrompt: string;
  /** Tokens that terminate an assistant turn. */
  stopSequences: readonly string[];
  /** Deployment-side parser required to read tool calls back out. */
  toolCallParser: string | null;
  /**
   * Deployment template override, required when the published template cannot
   * render tools. This is the RPMax remedy.
   */
  requiredTemplateOverride: string | null;
  templateArtifact?: TemplateArtifact | null;
  maskedSpans?: readonly SupervisionSpan[];
  toolCallTurnTerminator?: string;
  prefixPreservation?: PrefixPreservationEvidence;
  toolCallSupervisionProbes?: readonly ToolCallSupervisionSegments[];
  /** Documented capability limits that must not be silently ignored. */
  knownLimits: readonly string[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function computeTemplateDigest(templateText: string): string {
  return sha256(templateText);
}

const MASKED_SPANS: readonly SupervisionSpan[] = ["system", "user", "tool-results", "unapproved-assistant-history"];

/**
 * The Llama 3.1 JSON tool-call template, used to REPLACE the RPMax published
 * template. This is Meta's own documented JSON-based zero-shot tool format:
 * `<|python_tag|>` for built-in tools, JSON bodies for custom tools, `<|eom_id|>`
 * to continue into a tool result, `<|eot_id|>` to end a turn.
 *
 * `{% generation %}` markers are added so `assistant_only_loss=True` works.
 */
const LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION = `{%- set loop_messages = messages -%}
{%- for message in loop_messages -%}
{%- if message['role'] == 'system' -%}
{%- if loop.index0 == 0 -%}{{- bos_token }}{%- endif -%}
{{- '<|start_header_id|>system<|end_header_id|>\n\n' + message['content'] | trim + '<|eot_id|>' }}
{%- elif message['role'] == 'user' -%}
{%- if loop.index0 == 0 -%}{{- bos_token }}{%- endif -%}
{{- '<|start_header_id|>user<|end_header_id|>\n\n' + message['content'] | trim + '<|eot_id|>' }}
{%- elif message['role'] == 'assistant' -%}
{{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
{% generation %}
{%- if message.get('tool_calls') -%}
{%- for call in message['tool_calls'] -%}
{{- '<|python_tag|>' + (call['function']['name'] | trim) + '(' }}
{{- call['function']['arguments'] | tojson }}
{{- ')<|eom_id|>' }}
{%- endfor -%}
{%- endif -%}
{%- if message['content'] -%}{{ message['content'] | trim }}{%- endif -%}
{{- '<|eot_id|>' }}
{%- endgeneration -%}
{%- elif message['role'] == 'tool' -%}
{{- '<|start_header_id|>ipython<|end_header_id|>\n\n' + message['content'] | trim + '<|eom_id|>' }}
{%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
{{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
{% endif -%}`;

/** The actual published RPMax template, recorded verbatim for the audit trail. */
export const RPMax_PUBLISHED_TEMPLATE =
  "{% set loop_messages = messages %}{% for message in loop_messages %}{% set content = '' + message['role'] + '\\n\\n'+ message['content'] | trim + '' %}{% if loop.index0 == 0 %}{% set content = bos_token + content %}{% endif %}{{ content }}{% endfor %}{{ 'assistant\\n\\n' }}";

export const RPMAX_TEMPLATE_PROFILE: TemplateProfile = {
  profileId: "rpmax-v1.3-llama31-json-tool",
  modelId: "ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3",
  tokenizerRevision: "8fb4a0d9e7944ecfa75b9c50a2818b33b85cc436",
  templateDigest: sha256(LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION),
  publishedTemplateRendersTools: false,
  publishedTemplateHasGenerationMarkers: false,
  supervisedSpans: ["assistant-prose", "tool-calls", "turn-terminator"],
  maskedSpans: MASKED_SPANS,
  toolCallTurnTerminator: "<|eom_id|>",
  generationPrompt: "<|start_header_id|>assistant<|end_header_id|>\n\n",
  stopSequences: ["<|eot_id|>", "<|end_of_text|>"],
  toolCallParser: "llama3_json",
  requiredTemplateOverride: LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION,
  templateArtifact: {
    modelId: "ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3",
    tokenizerRevision: "8fb4a0d9e7944ecfa75b9c50a2818b33b85cc436",
    templateDigest: sha256(LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION),
    templateText: LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION,
    source: "velvet:rpmax-generation-override-v2",
    trlVersion: null, transformersVersion: null, thinkingMode: "not-applicable",
    hasGenerationMarkers: true,
    toolCallTurnTerminatorTokenId: 128008,
    // The local override serializes calls but does not advertise tool schemas.
    // Keep this limitation explicit; the export readiness check fails closed.
    rendersTools: false,
  },
  knownLimits: [
    "Published template renders neither `tools` nor `tool_calls`; the override above is MANDATORY.",
    "Published template emits `content | trim`, so a null tool-call content renders the literal string `None`.",
    "Published template has no `{% generation %}`; `assistant_only_loss=True` is impossible without the override.",
    "Meta's model card warns Llama-8B-Instruct cannot reliably maintain conversation alongside tool definitions.",
    "Measured 67% tool-hallucination rate on When2Call (arXiv 2504.18851).",
    "vLLM does not support parallel tool calls for Llama 3; it may serialize arrays as strings.",
  ],
};

export const QWEN3_8B_TEMPLATE_PROFILE: TemplateProfile = {
  profileId: "qwen3-8b-native-tools",
  modelId: "Qwen/Qwen3-8B",
  tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
  // SHA-256 of the 4,360 downloaded UTF-8 bytes at the immutable TRL source below.
  // No claim of local Transformers rendering or mask measurement is implied.
  templateDigest: "1d944ff8f268b611abb296cdd24d0f51981eef1c8647ac321c3a0258f61eb6c9",
  publishedTemplateRendersTools: true,
  publishedTemplateHasGenerationMarkers: false,
  supervisedSpans: ["assistant-prose", "tool-calls", "turn-terminator"],
  maskedSpans: MASKED_SPANS,
  toolCallTurnTerminator: "<|im_end|>",
  generationPrompt: "<|im_start|>assistant\n<think>\n\n</think>\n\n",
  stopSequences: ["<|im_end|>"],
  // Ordinary Qwen3 uses Hermes JSON in <tool_call>, not Qwen3-Coder syntax.
  // https://qwen.readthedocs.io/en/latest/framework/function_call.html#vllm
  toolCallParser: "hermes",
  requiredTemplateOverride:
    "https://raw.githubusercontent.com/huggingface/trl/63b7c3f547d3e06d0eae72712e36b7b64e9d5a45/trl/chat_templates/qwen3_training.jinja",
  templateArtifact: {
    modelId: "Qwen/Qwen3-8B",
    tokenizerRevision: "b968826d9c46dd6066d109eabc6255188de91218",
    templateDigest: "1d944ff8f268b611abb296cdd24d0f51981eef1c8647ac321c3a0258f61eb6c9",
    templateText: null,
    source: "https://raw.githubusercontent.com/huggingface/trl/63b7c3f547d3e06d0eae72712e36b7b64e9d5a45/trl/chat_templates/qwen3_training.jinja",
    trlVersion: null, transformersVersion: null, thinkingMode: "disabled",
    hasGenerationMarkers: true, rendersTools: true,
    toolCallTurnTerminatorTokenId: 151645,
  },
  knownLimits: [
    "Published template lacks `{% generation %}`; the TRL patched template is required for assistant-only loss.",
    "Tool results render as a `user` turn wrapped in `<tool_response>`, not a distinct tool role.",
    "Consecutive tool results coalesce into one user block.",
    "In thinking mode the model may plan a tool call in reasoning and never emit it (Qwen3 issue #1817).",
    "Hermes is the parser in Qwen's Qwen3-8B function-calling documentation; qwen3_coder is a different tool format.",
    "Export requires the pinned template bytes and real runtime prefix/mask measurements; none are bundled as benchmark evidence.",
  ],
};

export const TEMPLATE_PROFILES: readonly TemplateProfile[] = [RPMAX_TEMPLATE_PROFILE, QWEN3_8B_TEMPLATE_PROFILE];

export function templateProfileFor(modelId: string): TemplateProfile | null {
  return TEMPLATE_PROFILES.find((profile) => profile.modelId === modelId) ?? null;
}

export class TemplateProfileError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`template profile is unusable: ${problems.join("; ")}`);
    this.name = "TemplateProfileError";
    this.problems = problems;
  }
}

export interface ToolPrecondition {
  /** The example advertises at least one tool schema. */
  advertisesTools: boolean;
  /** At least one assistant message carries a tool call. */
  hasToolCalls: boolean;
  /** The example is intended to supervise tool-call tokens. */
  wantsToolCallSupervision: boolean;
}

/**
 * The gate that `apply_chat_template` cannot provide.
 *
 * Rejects any tool training configuration that would silently lose its
 * supervision target or corrupt the rendered text. Call this BEFORE training.
 */
export function assertTemplateCanTrain(profile: TemplateProfile, precondition: ToolPrecondition): void {
  const problems: string[] = [];
  const needsToolRendering = precondition.advertisesTools || precondition.hasToolCalls;
  if (!profile.publishedTemplateHasGenerationMarkers && !profile.requiredTemplateOverride) {
    problems.push("published template lacks generation markers; a pinned override is required for assistant-only loss in every family");
  }
  const artifact = profile.templateArtifact;
  if (!artifact) problems.push("a pinned template artifact is required");
  else {
    if (artifact.modelId !== profile.modelId || artifact.tokenizerRevision !== profile.tokenizerRevision) problems.push("template artifact model/tokenizer binding mismatch");
    if (!/^[0-9a-f]{64}$/.test(artifact.templateDigest) || artifact.templateDigest !== profile.templateDigest) problems.push("template artifact digest mismatch");
    if (!artifact.hasGenerationMarkers) problems.push("template artifact lacks generation markers");
    if (artifact.templateText !== null) {
      if (sha256(artifact.templateText) !== profile.templateDigest) problems.push("template bytes do not match the pinned digest");
      if (!hasGenerationMarkers(artifact.templateText)) problems.push("template bytes lack balanced generation markers");
    }
    if (profile.requiredTemplateOverride && profile.requiredTemplateOverride !== artifact.source
      && profile.requiredTemplateOverride !== artifact.templateText) problems.push("required override does not resolve to the pinned template artifact");
  }
  if (needsToolRendering && !profile.publishedTemplateRendersTools && !profile.requiredTemplateOverride) {
    problems.push("tools are advertised but the template neither renders tools nor supplies an override");
  }
  if (precondition.wantsToolCallSupervision && !profile.supervisedSpans.includes("tool-calls")) {
    problems.push("tool-call supervision was requested but the profile does not supervise tool-calls");
  }
  if (needsToolRendering && !profile.toolCallParser) {
    problems.push("tools are advertised but no deployment tool-call parser is pinned");
  }
  if (profile.supervisedSpans.includes("tool-results")) {
    problems.push("tool-results must never be supervised; the model would learn to emit environment output");
  }
  for (const span of MASKED_SPANS) {
    if (profile.supervisedSpans.includes(span)) problems.push(`${span} must never be supervised`);
    if (!profile.maskedSpans?.includes(span)) problems.push(`${span} must be explicitly masked`);
  }
  for (const span of ["assistant-prose", "turn-terminator"] as const) {
    if (!profile.supervisedSpans.includes(span)) problems.push(`${span} must receive loss`);
  }
  if (profile.modelId === "Qwen/Qwen3-8B") {
    if (profile.toolCallParser !== "hermes") problems.push("ordinary Qwen3 requires the hermes tool-call parser");
    if (profile.toolCallTurnTerminator !== "<|im_end|>" || artifact?.toolCallTurnTerminatorTokenId !== 151645
      || !profile.stopSequences.includes("<|im_end|>")) problems.push("Qwen3 must terminate tool-call turns with the pinned <|im_end|> special token");
    const expectedPrompt = "<|im_start|>assistant\n" + (artifact?.thinkingMode === "disabled" ? "<think>\n\n</think>\n\n" : "");
    if (artifact?.thinkingMode === "not-applicable" || profile.generationPrompt !== expectedPrompt) problems.push("Qwen3 generation prompt does not match the pinned thinking mode");
  }
  if (!profile.tokenizerRevision || !/^[0-9a-f]{40}$/.test(profile.tokenizerRevision)) {
    problems.push("tokenizer revision must be a pinned 40-hex commit sha");
  }
  if (problems.length > 0) throw new TemplateProfileError(problems);
}

function hasGenerationMarkers(text: string): boolean {
  // Comments can describe markers without actually providing loss-mask blocks.
  const template = text.replace(/\{#[\s\S]*?#\}/g, "");
  const markers = [...template.matchAll(/\{%[-+]?\s*(generation|endgeneration)\s*[-+]?%\}/g)];
  return markers.length > 0 && markers.length % 2 === 0
    && markers.every((match, index) => match[1] === (index % 2 === 0 ? "generation" : "endgeneration"));
}

export interface TemplateMeasurementBinding {
  templateDigest: string;
  tokenizerRevision: string;
  trlVersion: string;
  transformersVersion: string;
  thinkingMode: TemplateArtifact["thinkingMode"];
}

function measurementProblems(profile: TemplateProfile, binding: TemplateMeasurementBinding): string[] {
  const artifact = profile.templateArtifact;
  if (!artifact) return ["measurement requires a template artifact"];
  const problems: string[] = [];
  for (const key of ["templateDigest", "tokenizerRevision", "trlVersion", "transformersVersion", "thinkingMode"] as const) {
    if (!binding[key] || binding[key] !== artifact[key]) problems.push(`measurement ${key} does not match the pinned artifact/runtime`);
  }
  return problems;
}

export interface PrefixPreservationEvidence extends TemplateMeasurementBinding {
  /** Actual apply_chat_template output, with add_generation_prompt=false on both sides. */
  samples: readonly {
    messages: readonly StoredMessage[];
    appendedToolMessage: StoredMessage;
    before: string;
    after: string;
    beforeTokenIds: readonly number[];
    afterTokenIds: readonly number[];
  }[];
}

export function assertPrefixPreserving(profile: TemplateProfile): void {
  assertTemplateCanTrain(profile, { advertisesTools: true, hasToolCalls: true, wantsToolCallSupervision: true });
  const evidence = profile.prefixPreservation;
  if (!evidence || !evidence.samples.length) throw new TemplateProfileError(["measured prefix-preservation evidence is required"]);
  const problems = measurementProblems(profile, evidence);
  for (const sample of evidence.samples) {
    const last = sample.messages[sample.messages.length - 1];
    if (last?.role !== "assistant" || sample.appendedToolMessage.role !== "tool"
      || !last.tool_calls?.some((call) => call.id === sample.appendedToolMessage.tool_call_id)) {
      problems.push("prefix probe must append a result to an existing assistant tool call");
    }
    if (!sample.before || sample.after.length <= sample.before.length || !sample.after.startsWith(sample.before)) problems.push("appending a tool message changed earlier assistant rendering");
    if (!sample.beforeTokenIds.length || sample.afterTokenIds.length <= sample.beforeTokenIds.length
      || sample.beforeTokenIds.some((token, index) => token !== sample.afterTokenIds[index])) problems.push("appending a tool message changed earlier assistant tokens");
  }
  if (problems.length) throw new TemplateProfileError(problems);
}

export interface TextRange { start: number; end: number }

/** Offsets are JS string offsets from the tokenizer's decoded rendering. Labels are pre-shift loss labels. */
export interface ToolCallSupervisionSegments extends TemplateMeasurementBinding {
  renderedText: string;
  call: StoredToolCall["function"];
  serializedCall: TextRange;
  turnTerminator: TextRange;
  tokens: readonly { start: number; end: number; tokenId: number; label: number }[];
}

export function assertToolCallIsSupervised(profile: TemplateProfile, segments: ToolCallSupervisionSegments): void {
  assertTemplateCanTrain(profile, { advertisesTools: true, hasToolCalls: true, wantsToolCallSupervision: true });
  const problems = measurementProblems(profile, segments);
  if (!profile.supervisedSpans.includes("tool-calls") || !profile.supervisedSpans.includes("turn-terminator")) problems.push("tool calls and their turn terminator must receive loss");
  const slice = (range: TextRange): string => segments.renderedText.slice(range.start, range.end);
  const serialized = slice(segments.serializedCall);
  try {
    if (profile.toolCallParser === "hermes") {
      const match = /^<tool_call>\s*([\s\S]+?)\s*<\/tool_call>$/.exec(serialized);
      if (!match?.[1] || stableStringify(JSON.parse(match[1]) as unknown) !== stableStringify(segments.call)) {
        problems.push("serialized call name, argument values, or closing syntax differ from the target");
      }
    } else if (profile.toolCallParser === "llama3_json") {
      if (stableStringify(JSON.parse(serialized) as unknown) !== stableStringify({ name: segments.call.name, parameters: segments.call.arguments })) {
        problems.push("serialized Llama JSON call differs from the target");
      }
    } else problems.push("unsupported tool-call parser for supervision verification");
  } catch {
    problems.push("serialized call has invalid JSON or closing syntax");
  }
  if (!profile.toolCallTurnTerminator || slice(segments.turnTerminator) !== profile.toolCallTurnTerminator) problems.push("incorrect tool-call turn terminator");
  const terminatorId = profile.templateArtifact?.toolCallTurnTerminatorTokenId;
  if (!Number.isSafeInteger(terminatorId) || !segments.tokens.some((token) => token.start === segments.turnTerminator.start
    && token.end === segments.turnTerminator.end && token.tokenId === terminatorId && token.label === terminatorId)) {
    problems.push("the pinned end-of-turn special token must receive loss, not ordinary text spelling its name");
  }
  if (segments.turnTerminator.start < segments.serializedCall.end) problems.push("turn terminator must follow the serialized call");
  for (const [label, range] of [["tool call name/arguments/closing syntax", segments.serializedCall], ["turn terminator", segments.turnTerminator]] as const) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > segments.renderedText.length) {
      problems.push(`invalid ${label} range`);
      continue;
    }
    let coveredUntil = range.start;
    for (const token of segments.tokens) {
      if (!Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || token.start < 0 || token.end <= token.start
        || token.end > segments.renderedText.length || !Number.isSafeInteger(token.tokenId) || token.tokenId < 0) {
        problems.push("invalid measured token");
        continue;
      }
      if (token.end <= range.start || token.start >= range.end) continue;
      if (token.start > coveredUntil) problems.push(`${label} has an unmeasured token gap`);
      coveredUntil = Math.max(coveredUntil, token.end);
      if (token.label !== token.tokenId) problems.push(`${label} contains masked or incorrect loss labels`);
    }
    if (coveredUntil < range.end) problems.push(`${label} is not fully covered by measured supervised tokens`);
  }
  if (problems.length) throw new TemplateProfileError(problems);
}

/** Required at export, after actual tokenizer/TRL measurements have been supplied. */
export function assertTemplateReadyForExport(profile: TemplateProfile, artifacts: ReadonlyMap<string, string | Uint8Array>): void {
  assertTemplateCanTrain(profile, { advertisesTools: true, hasToolCalls: true, wantsToolCallSupervision: true });
  const artifact = profile.templateArtifact;
  if (!artifact) throw new TemplateProfileError(["template artifact is absent"]);
  const problems: string[] = [];
  const bytes = artifacts.get(artifact.templateDigest);
  if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== artifact.templateDigest) problems.push("pinned template bytes are absent or changed");
  else {
    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
    if (!hasGenerationMarkers(text)) problems.push("resolved template bytes lack generation markers");
    const executable = text.replace(/\{#[\s\S]*?#\}/g, "");
    if (!artifact.rendersTools || !/\btools\b/.test(executable) || !/\btool_calls\b/.test(executable)) problems.push("resolved template does not render both tools and tool_calls");
  }
  for (const version of [artifact.trlVersion, artifact.transformersVersion]) {
    if (!version || !/^(?:\d+\.\d+\.\d+(?:[a-zA-Z0-9.+-]*)?|git:[0-9a-f]{40})$/.test(version)) problems.push("export requires exact measured TRL and Transformers versions");
  }
  if (!profile.toolCallSupervisionProbes?.length) problems.push("export requires measured tool-call supervision, including the turn terminator");
  if (problems.length) throw new TemplateProfileError(problems);
  assertPrefixPreserving(profile);
  for (const probe of profile.toolCallSupervisionProbes ?? []) assertToolCallIsSupervised(profile, probe);
}

/**
 * CPU-only check that the RPMax published template would destroy a tool call.
 * Kept as an executable regression test: if a future RPMax revision fixes this,
 * this test fails and forces a deliberate decision rather than silent drift.
 */
export function publishedTemplateDropsToolCalls(): boolean {
  return !/\btools\b/.test(RPMax_PUBLISHED_TEMPLATE) && !/tool_calls/.test(RPMax_PUBLISHED_TEMPLATE);
}

/**
 * Length/truncation policy. An example whose required context or target would be
 * truncated is worse than a dropped example, because it teaches a truncated
 * target. Reject rather than truncate.
 */
export interface TruncationPolicy {
  maxSequenceLength: number;
  /** Refuse the example if any supervised span is truncated. */
  rejectOnTargetTruncation: boolean;
  /** Refuse if the required CONTEXT is truncated, even if the target is not. */
  rejectOnContextTruncation: boolean;
  /** Packing must not let one example attend to another's completion. */
  packingIsolation: boolean;
}

export const DEFAULT_TRUNCATION_POLICY: TruncationPolicy = {
  maxSequenceLength: 4_096,
  rejectOnTargetTruncation: true,
  rejectOnContextTruncation: true,
  packingIsolation: true,
};

/**
 * Verifies a materialized example against the profile using measured tokenizer
 * spans. The real tokenizer check runs in the Colab preprocessing script; this is
 * the policy that script must implement, kept here so it is versioned and tested.
 */
export interface MeasuredSpan {
  span: SupervisionSpan;
  startToken: number;
  endToken: number;
}

export function assertWithinTruncationPolicy(
  profile: TemplateProfile,
  spans: readonly MeasuredSpan[],
  measuredTotalTokens: number,
  policy: TruncationPolicy = DEFAULT_TRUNCATION_POLICY,
): void {
  const problems: string[] = [];
  if (measuredTotalTokens > policy.maxSequenceLength) {
    problems.push(`example is ${measuredTotalTokens} tokens, over the ${policy.maxSequenceLength} limit`);
  }
  for (const span of spans) {
    if (span.endToken > policy.maxSequenceLength) {
      const label = profile.supervisedSpans.includes(span.span) ? "supervised target" : "context";
      problems.push(`${label} span (${span.span}) ends at ${span.endToken}, beyond the limit`);
    }
  }
  const supervised = spans.filter((span) => profile.supervisedSpans.includes(span.span));
  if (supervised.length === 0) problems.push("no supervised span: the example would train on nothing");
  if (problems.length > 0) throw new TemplateProfileError(problems);
}
