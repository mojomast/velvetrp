import { z } from "zod";
import type { SystemOneSettings } from "../types.js";
import { buildSystemOneHeaders, canUseSystemOne, validateSystemOneBaseUrl } from "./providerTransport.js";

const HTTP_ERROR_DETAIL_LIMIT = 1_000;
const HTTP_ERROR_READ_LIMIT = 4_096;
const PROBABILITY_SUM_TOLERANCE = 0.02;
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4_000;

/** Successful System One bodies are bounded before JSON text is buffered. */
export const SYSTEM_ONE_SUCCESS_BODY_BYTE_LIMIT = 1_048_576;

/** A JSON value accepted in a System One state or structured instruction. */
export type SystemOneJsonValue = null | boolean | number | string | SystemOneJsonValue[] | { [key: string]: SystemOneJsonValue };

const jsonValueSchema: z.ZodType<SystemOneJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

/** Instructions may be a string, an array, an object with named fields, or null. */
const instructionsSchema: z.ZodType<SystemOneJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.string(),
  z.array(instructionsSchema),
  z.record(z.string(), instructionsSchema),
]));

/**
 * The vendor's EntryType: the value describing a Choice option, a Score level, or a Noul
 * `true`/`false` boundary. It may be a string, null, an array, or a structured object (for
 * example a choice rubric with `what`/`not_for`/`examples`, a score level with `summary` and
 * `signals`, or a taxonomy subtree the model should walk). See the vendor "Advanced: structure"
 * page; structure is accepted everywhere a string description is.
 */
const entrySchema = z.union([
  z.string(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]);

const noulCriteriaSchema = z.object({
  true: entrySchema,
  false: entrySchema,
}).partial();

const choiceCriteriaSchema = z.record(z.string(), entrySchema)
  .refine((value) => Object.keys(value).length >= 1, "choice criteria must declare at least one option")
  .refine((value) => Object.keys(value).length <= 255, "choice criteria may declare at most 255 options");

const scoreCriteriaSchema = z.array(entrySchema)
  .min(2, "score criteria must declare at least two levels")
  .max(10, "score criteria may declare at most ten levels");

const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: instructionsSchema,
  criteria: noulCriteriaSchema.optional(),
});

const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: instructionsSchema,
  criteria: choiceCriteriaSchema,
});

const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: instructionsSchema,
  criteria: scoreCriteriaSchema,
});

export const systemOneQuestionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

export const systemOneQuestionsSchema = z.record(z.string(), systemOneQuestionSchema)
  .refine((value) => Object.keys(value).length >= 1, "at least one question is required");

/** The vendor accepts a plain string, or structured object/array state. */
const systemOneStateSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]);

export const systemOneRequestSchema = z.object({
  state: systemOneStateSchema,
  model: z.string().min(1),
  questions: systemOneQuestionsSchema,
});

const probabilitySchema = z.number().min(0).max(1);

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: probabilitySchema,
}).strict();

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  confidence: probabilitySchema,
  probabilities: z.record(z.string(), probabilitySchema),
}).strict();

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: probabilitySchema,
  legend: z.record(z.string(), z.unknown()),
  probabilities: z.record(z.string(), probabilitySchema),
}).strict();

export const systemOneAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
]);

export const systemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), systemOneAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }).optional(),
});

export type SystemOneInstructions = z.infer<typeof instructionsSchema>;
export type SystemOneQuestion = z.infer<typeof systemOneQuestionSchema>;
export type SystemOneQuestions = z.infer<typeof systemOneQuestionsSchema>;
export type SystemOneNoulAnswer = z.infer<typeof noulAnswerSchema>;
export type SystemOneChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type SystemOneScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type SystemOneAnswer = z.infer<typeof systemOneAnswerSchema>;

/** Requested and provider-reported model identifiers for audit metadata. */
export interface SystemOneModelMetadata {
  requestedModel: string;
  responseModel: string | null;
}

export interface SystemOneUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SystemOneProvenance {
  requestId: string | null;
  latencyMs: number;
  attempts: number;
}

export interface SystemOneCompletionResult {
  model: SystemOneModelMetadata;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage | null;
  provenance: SystemOneProvenance;
}

export interface SystemOneCompletionInput {
  settings: SystemOneSettings;
  state: string | SystemOneJsonValue[] | { [key: string]: SystemOneJsonValue };
  questions: SystemOneQuestions;
  signal?: AbortSignal;
  /** Bounded total attempts for retryable `429`/`529` responses. Defaults to three. */
  maxAttempts?: number;
  /** Injectable delay used by tests; defaults to an abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A caller shape shared by the real adapter and deterministic doubles. */
export type SystemOneCaller = (input: SystemOneCompletionInput) => Promise<SystemOneCompletionResult>;

/** Base class for classified System One adapter failures. */
export class SystemOneError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** System One settings cannot produce a real, policy-compliant request. */
export class SystemOneConfigurationError extends SystemOneError {}

/** The credential was rejected (`401`). */
export class SystemOneAuthenticationError extends SystemOneError {}

/** The request body was rejected as invalid (`422` or `400`). */
export class SystemOneValidationError extends SystemOneError {}

/** The service rate-limited the request (`429`). */
export class SystemOneRateLimitError extends SystemOneError {
  readonly retryAfter: string | null;
  constructor(detail: string, retryAfter: string | null = null, options?: ErrorOptions) {
    super(detail, options);
    this.retryAfter = retryAfter;
  }
}

/** The service is temporarily overloaded (`529`). */
export class SystemOneOverloadedError extends SystemOneError {}

/** The service returned another non-successful HTTP status. */
export class SystemOneHttpError extends SystemOneError {
  readonly status: number;
  readonly retryAfter: string | null;
  constructor(status: number, detail: string, retryAfter: string | null = null) {
    super(`System One HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** The provider redirect was refused rather than followed with scoped headers. */
export class SystemOneRedirectError extends SystemOneError {}

/** The caller's signal cancelled the request. */
export class SystemOneCallerAbortError extends SystemOneError {}

/** The configured deadline expired. */
export class SystemOneTimeoutError extends SystemOneError {}

/** The request failed before an HTTP response was available. */
export class SystemOneTransportError extends SystemOneError {}

/** The response violated the declared System One schema or answer invariants. */
export class SystemOneProtocolError extends SystemOneError {}

/** A classified System One failure, safe to surface in an API problem. */
export interface SystemOneFailure {
  kind: "configuration" | "authentication" | "validation" | "rate-limit" | "overloaded" | "http" | "timeout" | "transport" | "protocol" | "aborted";
  status: number | null;
  retryable: boolean;
  detail: string;
}

/** Classifies a thrown System One error without serializing arbitrary error state. */
export function classifySystemOneFailure(error: unknown): SystemOneFailure {
  if (error instanceof SystemOneCallerAbortError) return { kind: "aborted", status: null, retryable: false, detail: "caller aborted" };
  if (error instanceof SystemOneTimeoutError) return { kind: "timeout", status: null, retryable: true, detail: "request timed out" };
  if (error instanceof SystemOneAuthenticationError) return { kind: "authentication", status: 401, retryable: false, detail: "credential rejected" };
  if (error instanceof SystemOneValidationError) return { kind: "validation", status: 422, retryable: false, detail: error.message };
  if (error instanceof SystemOneRateLimitError) return { kind: "rate-limit", status: 429, retryable: true, detail: "rate limited" };
  if (error instanceof SystemOneOverloadedError) return { kind: "overloaded", status: 529, retryable: true, detail: "service overloaded" };
  if (error instanceof SystemOneHttpError) return { kind: "http", status: error.status, retryable: error.status >= 500, detail: error.message };
  if (error instanceof SystemOneProtocolError) return { kind: "protocol", status: null, retryable: false, detail: error.message };
  if (error instanceof SystemOneTransportError) return { kind: "transport", status: null, retryable: true, detail: "transport failed" };
  if (error instanceof SystemOneConfigurationError) return { kind: "configuration", status: null, retryable: false, detail: error.message };
  return { kind: "protocol", status: null, retryable: false, detail: "unclassified failure" };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRedirectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isObject(current); depth += 1) {
    if (typeof current.message === "string" && current.message.toLowerCase().includes("unexpected redirect")) return true;
    current = current.cause;
  }
  return false;
}

function redact(value: string, apiKey: string): string {
  let redacted = value.slice(0, HTTP_ERROR_READ_LIMIT)
    .replace(/\bauthorization\s*["']?\s*[:=]\s*["']?\s*(?:(?:bearer|basic)\s+)?[A-Za-z0-9._~+/=-]+/gi, "Authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  const key = apiKey.trim();
  if (key) redacted = redacted.replaceAll(key, "[REDACTED]");
  return redacted.slice(0, HTTP_ERROR_DETAIL_LIMIT);
}

async function readBoundedDetail(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  try {
    while (detail.length < HTTP_ERROR_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) { detail += decoder.decode(); break; }
      const remaining = HTTP_ERROR_READ_LIMIT - detail.length;
      const bounded = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      detail += decoder.decode(bounded, { stream: value.byteLength <= remaining });
      if (value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return detail.slice(0, HTTP_ERROR_READ_LIMIT);
}

async function readBoundedPayload(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SYSTEM_ONE_SUCCESS_BODY_BYTE_LIMIT)) {
    throw new SystemOneProtocolError("System One response exceeded the byte limit");
  }
  if (!response.body) throw new SystemOneProtocolError("System One response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > SYSTEM_ONE_SUCCESS_BODY_BYTE_LIMIT) throw new SystemOneProtocolError("System One response exceeded the byte limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch (error) {
    throw new SystemOneProtocolError("System One response was not valid JSON", { cause: error });
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new SystemOneCallerAbortError("System One aborted by caller")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new SystemOneCallerAbortError("System One aborted by caller")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function probabilitySum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function sameKeySet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((key) => rightSet.has(key));
}

/**
 * Re-verifies that the response answers exactly the issued questions and that
 * every distribution is well-formed. This is the transport-independent half of
 * the "unknown answers are rejected" invariant.
 */
export function validateSystemOneAnswers(
  questions: SystemOneQuestions,
  answers: Record<string, SystemOneAnswer>,
): void {
  const questionIds = Object.keys(questions);
  const answerIds = Object.keys(answers);
  if (!sameKeySet(questionIds, answerIds)) {
    throw new SystemOneProtocolError("System One answers do not match the issued questions");
  }
  for (const id of questionIds) {
    const question = questions[id]!;
    const answer = answers[id]!;
    if (question.type !== answer.type) throw new SystemOneProtocolError(`answer type mismatch for question ${id}`);
    if (question.type === "noul") continue;
    if (answer.type === "noul") throw new SystemOneProtocolError(`answer type mismatch for question ${id}`);
    const probabilities = answer.probabilities;
    const sum = probabilitySum(probabilities);
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
      throw new SystemOneProtocolError(`probabilities for question ${id} do not sum to 1`);
    }
    const declared = question.type === "choice"
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
    if (!sameKeySet(Object.keys(probabilities), declared)) {
      throw new SystemOneProtocolError(`probabilities for question ${id} do not match the declared options`);
    }
    if (answer.type === "choice") {
      if (!(answer.choice in probabilities)) throw new SystemOneProtocolError(`choice for question ${id} is not a declared option`);
    } else {
      const levelKeys = new Set(declared);
      for (const key of Object.keys(answer.legend)) {
        if (!levelKeys.has(key)) throw new SystemOneProtocolError(`legend for question ${id} references an undeclared level`);
      }
    }
  }
}

/** Sends one already-validated decision battery and returns strictly-validated answers. */
export async function completeWithSystemOne(input: SystemOneCompletionInput): Promise<SystemOneCompletionResult> {
  const baseUrl = input.settings.baseUrl.trim().replace(/\/+$/, "");
  const validation = validateSystemOneBaseUrl(baseUrl);
  if (!baseUrl || !validation.ok) {
    throw new SystemOneConfigurationError(!validation.ok ? validation.reason : "System One is not configured");
  }
  if (!canUseSystemOne({ ...input.settings, baseUrl })) {
    throw new SystemOneConfigurationError("System One is not fully configured");
  }
  const timeoutMs = input.settings.requestTimeoutSeconds * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SystemOneConfigurationError("requestTimeoutSeconds must be positive");
  if (input.signal?.aborted) throw new SystemOneCallerAbortError("System One aborted by caller");

  let request: z.infer<typeof systemOneRequestSchema>;
  try {
    request = systemOneRequestSchema.parse({ state: input.state, model: input.settings.model, questions: input.questions });
  } catch (error) {
    throw new SystemOneConfigurationError("System One request is invalid", { cause: error });
  }
  const body = JSON.stringify(request);
  const maxAttempts = Math.max(1, Math.min(6, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const sleep = input.sleep ?? defaultSleep;
  const startedAt = performance.now();
  let lastError: SystemOneError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (input.signal?.aborted) throw new SystemOneCallerAbortError("System One aborted by caller");
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signals = input.signal ? [input.signal, timeout.signal] : [timeout.signal];
    try {
      const response = await fetch(`${baseUrl}/systemone`, {
        method: "POST",
        headers: buildSystemOneHeaders(baseUrl, input.settings.apiKey),
        signal: AbortSignal.any(signals),
        redirect: "error",
        body,
      });
      if (response.status >= 300 && response.status < 400) throw new SystemOneRedirectError("System One redirect refused");
      if (response.status === 401) throw new SystemOneAuthenticationError(redact(await readBoundedDetail(response), input.settings.apiKey));
      if (response.status === 422 || response.status === 400) {
        throw new SystemOneValidationError(redact(await readBoundedDetail(response), input.settings.apiKey));
      }
      if (response.status === 429) {
        throw new SystemOneRateLimitError(redact(await readBoundedDetail(response), input.settings.apiKey), response.headers.get("retry-after"));
      }
      if (response.status === 529) throw new SystemOneOverloadedError("System One overloaded");
      if (!response.ok) {
        throw new SystemOneHttpError(response.status, redact(await readBoundedDetail(response), input.settings.apiKey), response.headers.get("retry-after"));
      }
      const payload = await readBoundedPayload(response);
      const parsed = systemOneResponseSchema.safeParse(payload);
      if (!parsed.success) throw new SystemOneProtocolError("System One response did not match the declared schema");
      validateSystemOneAnswers(input.questions, parsed.data.answers);
      const usage = parsed.data.usage;
      return {
        model: { requestedModel: input.settings.model, responseModel: parsed.data.model },
        answers: parsed.data.answers,
        usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens } : null,
        provenance: {
          requestId: response.headers.get("x-typesafe-request-id"),
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: attempt,
        },
      };
    } catch (error) {
      const classified = error instanceof SystemOneError
        ? error
        : input.signal?.aborted
        ? new SystemOneCallerAbortError("System One aborted by caller", { cause: error })
        : timeout.signal.aborted
        ? new SystemOneTimeoutError("System One timed out", { cause: error })
        : isRedirectFailure(error)
        ? new SystemOneRedirectError("System One redirect refused")
        : new SystemOneTransportError("System One transport failed", { cause: error });
      if (!classifySystemOneFailure(classified).retryable) throw classified;
      lastError = classified;
      if (attempt >= maxAttempts) throw classified;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      await sleep(backoff, input.signal);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new SystemOneTransportError("System One transport failed");
}

/** The real adapter as a `SystemOneCaller`. */
export const callSystemOne: SystemOneCaller = completeWithSystemOne;
