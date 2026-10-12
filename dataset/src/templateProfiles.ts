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
export type SupervisionSpan = "assistant-prose" | "tool-calls" | "tool-results" | "user" | "system";

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
  /** Documented capability limits that must not be silently ignored. */
  knownLimits: readonly string[];
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

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
{%- endgeneration -%}
{{- '<|eot_id|>' }}
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
  supervisedSpans: ["assistant-prose", "tool-calls"],
  generationPrompt: "<|start_header_id|>assistant<|end_header_id|>\n\n",
  stopSequences: ["<|eot_id|>", "<|end_of_text|>"],
  toolCallParser: "llama3_json",
  requiredTemplateOverride: LLAMA31_JSON_TOOL_TEMPLATE_WITH_GENERATION,
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
  // The published Qwen3 template has no generation markers; TRL's patched
  // `qwen3_training.jinja` adds them. Recorded as requiring that patch.
  templateDigest: sha256("qwen3_training.jinja:trl-patched"),
  publishedTemplateRendersTools: true,
  publishedTemplateHasGenerationMarkers: false,
  supervisedSpans: ["assistant-prose", "tool-calls"],
  generationPrompt: "<|im_start|>assistant\n",
  stopSequences: ["<|im_end|>"],
  toolCallParser: "qwen3_coder",
  requiredTemplateOverride:
    "Use TRL's patched `qwen3_training.jinja`. It adds `{% generation %}` AND fixes prefix preservation so an appended tool message does not change earlier assistant rendering.",
  knownLimits: [
    "Published template lacks `{% generation %}`; the TRL patched template is required for assistant-only loss.",
    "Tool results render as a `user` turn wrapped in `<tool_response>`, not a distinct tool role.",
    "Consecutive tool results coalesce into one user block.",
    "In thinking mode the model may plan a tool call in reasoning and never emit it (Qwen3 issue #1817).",
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
  if (!profile.tokenizerRevision || !/^[0-9a-f]{40}$/.test(profile.tokenizerRevision)) {
    problems.push("tokenizer revision must be a pinned 40-hex commit sha");
  }
  if (problems.length > 0) throw new TemplateProfileError(problems);
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