import type {
  CompletionFunctionTool,
  CompletionJsonSchemaFormat,
  CompletionMessage,
  ProviderCompletionResult,
} from "./openAiCompatibleCompletion.js";

export type ProviderCapability = "function-tools" | "strict-json-schema";

export type ProviderPermanentFailureCode =
  | "caller-aborted"
  | "configuration"
  | "authentication"
  | "authorization"
  | "not-found"
  | "unsupported-capability"
  | "invalid-request"
  | "protocol"
  | "provider-rejected";

export type ProviderTransientFailureCode =
  | "rate-limit"
  | "timeout"
  | "overloaded"
  | "server-error"
  | "transport"
  | "conflict";

export interface ProviderPermanentFailure {
  permanence: "permanent";
  code: ProviderPermanentFailureCode;
  httpStatus: number | null;
}

export interface ProviderTransientFailure {
  permanence: "transient";
  code: ProviderTransientFailureCode;
  httpStatus: number | null;
  /** Server-requested delay, normalized to milliseconds. */
  retryAfterMs: number | null;
}

export type ProviderFailure = ProviderPermanentFailure | ProviderTransientFailure;

/** Safe, already-redacted evidence used to classify a provider failure. */
export interface ProviderFailureObservation {
  httpStatus?: number;
  providerCode?: string;
  retryAfter?: string | null;
  callerAborted?: boolean;
  timedOut?: boolean;
  transportFailed?: boolean;
  protocolFailed?: boolean;
  capabilityRejected?: boolean;
}

/** Parses either Retry-After seconds or an HTTP date. Invalid/past values are ignored. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(nowMs)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Math.ceil(Number(trimmed) * 1_000);
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) && at > nowMs ? Math.ceil(at - nowMs) : null;
}

/** Classifies only retry-safe failure categories as transient. Unknown failures fail closed. */
export function classifyProviderFailure(
  observation: ProviderFailureObservation,
  nowMs = Date.now(),
): ProviderFailure {
  const status = observation.httpStatus ?? null;
  const providerCode = observation.providerCode?.trim().toLowerCase() ?? "";
  if (observation.callerAborted) return { permanence: "permanent", code: "caller-aborted", httpStatus: status };
  if (observation.capabilityRejected || /(?:unsupported|not_supported|strict|json_schema|tool)/.test(providerCode)) {
    return { permanence: "permanent", code: "unsupported-capability", httpStatus: status };
  }
  if (observation.protocolFailed) return { permanence: "permanent", code: "protocol", httpStatus: status };
  if (observation.timedOut || status === 408 || status === 504) {
    return { permanence: "transient", code: "timeout", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (observation.transportFailed) {
    return { permanence: "transient", code: "transport", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (status === 429) {
    return { permanence: "transient", code: "rate-limit", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (status === 409 || status === 425) {
    return { permanence: "transient", code: "conflict", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (status === 502 || status === 503) {
    return { permanence: "transient", code: "overloaded", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (status !== null && status >= 500) {
    return { permanence: "transient", code: "server-error", httpStatus: status, retryAfterMs: parseRetryAfterMs(observation.retryAfter, nowMs) };
  }
  if (status === 401) return { permanence: "permanent", code: "authentication", httpStatus: status };
  if (status === 403) return { permanence: "permanent", code: "authorization", httpStatus: status };
  if (status === 404) return { permanence: "permanent", code: "not-found", httpStatus: status };
  if (status === 400 || status === 405 || status === 422) {
    return { permanence: "permanent", code: "invalid-request", httpStatus: status };
  }
  if (status === null && providerCode === "configuration") {
    return { permanence: "permanent", code: "configuration", httpStatus: null };
  }
  return { permanence: "permanent", code: "provider-rejected", httpStatus: status };
}

export interface ProviderRetryPolicy {
  /** Number of total attempts, including the initial attempt. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ProviderRetryRecommendation =
  | { retry: true; delayMs: number; nextAttempt: number }
  | { retry: false; reason: "permanent" | "attempt-limit" | "delay-limit" | "deadline" };

/** Recommends a bounded retry only for explicitly transient failures. It does not sleep or retry. */
export function recommendProviderRetry(input: {
  failure: ProviderFailure;
  /** One-based attempt that just failed. */
  attempt: number;
  nowMs: number;
  deadlineAtMs: number;
  policy: ProviderRetryPolicy;
}): ProviderRetryRecommendation {
  const { failure, policy } = input;
  if (failure.permanence === "permanent") return { retry: false, reason: "permanent" };
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt >= policy.maxAttempts) {
    return { retry: false, reason: "attempt-limit" };
  }
  if (![policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs].every(Number.isFinite)
      || policy.maxAttempts < 1 || policy.baseDelayMs < 0 || policy.maxDelayMs < 0) {
    return { retry: false, reason: "delay-limit" };
  }
  const exponential = policy.baseDelayMs * (2 ** (input.attempt - 1));
  const requested = Math.max(exponential, failure.retryAfterMs ?? 0);
  if (!Number.isSafeInteger(requested) || requested > policy.maxDelayMs) return { retry: false, reason: "delay-limit" };
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.deadlineAtMs)
      || input.nowMs + requested >= input.deadlineAtMs) return { retry: false, reason: "deadline" };
  return { retry: true, delayMs: requested, nextAttempt: input.attempt + 1 };
}

export interface ProviderCapabilityProbeRequest {
  capability: ProviderCapability;
  model: string;
  messages: readonly CompletionMessage[];
  tools?: readonly CompletionFunctionTool[];
  toolChoice?: "required";
  jsonSchema?: CompletionJsonSchemaFormat;
}

export type ProviderCapabilityProbeOutcome =
  | { ok: true; result: ProviderCompletionResult }
  | { ok: false; failure: ProviderFailure };

export type ProviderCapabilityProbe = (
  request: ProviderCapabilityProbeRequest,
  signal?: AbortSignal,
) => Promise<ProviderCapabilityProbeOutcome>;

export interface ProviderCapabilityPreflightRequest {
  model: string;
  capabilities?: readonly ProviderCapability[];
  probe: ProviderCapabilityProbe;
  signal?: AbortSignal;
}

export type ProviderCapabilityClassification =
  | { capability: ProviderCapability; status: "supported" }
  | { capability: ProviderCapability; status: "unsupported"; failure: ProviderPermanentFailure }
  | { capability: ProviderCapability; status: "unavailable"; failure: ProviderFailure };

export interface ProviderCapabilityPreflightResult {
  /** DM planning and narration require usable schema-bound function tool calls. */
  dmPlayCompatible: boolean;
  /** Reviewed campaign generation requires strict JSON Schema. */
  campaignGenerationCompatible: boolean;
  /** True only when every requested capability probe succeeded. */
  ok: boolean;
  capabilities: readonly ProviderCapabilityClassification[];
}

const PROBE_NONCE = "velvet-capability-v1";

/** Creates a harmless request that proves one required capability independently. */
export function createProviderCapabilityProbeRequest(
  capability: ProviderCapability,
  model: string,
): ProviderCapabilityProbeRequest {
  const messages: readonly CompletionMessage[] = [{ role: "user", content: `Return the exact marker ${PROBE_NONCE}.` }];
  if (capability === "function-tools") {
    return {
      capability,
      model,
      messages,
      tools: [{
        name: "velvet_capability_probe",
        parameters: {
          type: "object",
          properties: { marker: { type: "string", const: PROBE_NONCE } },
          required: ["marker"],
          additionalProperties: false,
        },
      }],
      toolChoice: "required",
    };
  }
  return {
    capability,
    model,
    messages,
    jsonSchema: {
      name: "velvet_capability_probe",
      schema: {
        type: "object",
        properties: { marker: { type: "string", const: PROBE_NONCE } },
        required: ["marker"],
        additionalProperties: false,
      },
    },
  };
}

function validProbeResponse(capability: ProviderCapability, result: ProviderCompletionResult): boolean {
  if (capability === "function-tools") {
    const calls = result.message.toolCalls;
    if (calls?.length !== 1 || calls[0]?.name !== "velvet_capability_probe") return false;
    try {
      const value = JSON.parse(calls[0].arguments) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value)
        && (value as Record<string, unknown>).marker === PROBE_NONCE
        && Object.keys(value).length === 1;
    } catch {
      return false;
    }
  }
  if (result.message.toolCalls?.length || typeof result.message.content !== "string") return false;
  try {
    const value = JSON.parse(result.message.content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).marker === PROBE_NONCE
      && Object.keys(value).length === 1;
  } catch {
    return false;
  }
}

/** Runs each requested capability probe once. Retry ownership remains with the caller. */
export async function runProviderCapabilityPreflight(
  input: ProviderCapabilityPreflightRequest,
): Promise<ProviderCapabilityPreflightResult> {
  const capabilities = [...new Set(input.capabilities ?? ["function-tools", "strict-json-schema"] as const)];
  const classifications: ProviderCapabilityClassification[] = [];
  for (const capability of capabilities) {
    if (input.signal?.aborted) {
      classifications.push({ capability, status: "unavailable", failure: classifyProviderFailure({ callerAborted: true }) });
      continue;
    }
    let outcome: ProviderCapabilityProbeOutcome;
    try {
      outcome = await input.probe(createProviderCapabilityProbeRequest(capability, input.model), input.signal);
    } catch {
      outcome = { ok: false, failure: classifyProviderFailure({ transportFailed: true }) };
    }
    if (outcome.ok && validProbeResponse(capability, outcome.result)) {
      classifications.push({ capability, status: "supported" });
      continue;
    }
    const failure = outcome.ok
      ? classifyProviderFailure({ protocolFailed: true })
      : outcome.failure;
    if (failure.permanence === "permanent"
        && ["unsupported-capability", "invalid-request", "protocol", "provider-rejected"].includes(failure.code)) {
      classifications.push({ capability, status: "unsupported", failure });
    } else {
      classifications.push({ capability, status: "unavailable", failure });
    }
  }
  const supported = (capability: ProviderCapability) => classifications
    .some((result) => result.capability === capability && result.status === "supported");
  const dmPlayCompatible = supported("function-tools");
  const campaignGenerationCompatible = supported("strict-json-schema");
  return { dmPlayCompatible, campaignGenerationCompatible,
    ok: classifications.every((result) => result.status === "supported"), capabilities: classifications };
}

export type ProviderFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error" | "unknown";

/** Non-content metadata safe to persist for provider request provenance. */
export interface ProviderRequestProvenance {
  requestId: string | null;
  requestedModel: string;
  responseModel: string | null;
  systemFingerprint: string | null;
  finishReason: ProviderFinishReason;
  latencyMs: number;
  promptVersion: string;
  schemaVersion: string;
}
