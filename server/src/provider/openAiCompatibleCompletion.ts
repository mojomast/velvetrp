import type { PromptPreset } from "../presets.js";
import type { HarnessSettings, ProviderSettings } from "../types.js";
import { buildRequestBody } from "../llm.js";
import { buildProviderHeaders, canUseProvider, validateProviderBaseUrl } from "./providerTransport.js";

const HTTP_ERROR_DETAIL_LIMIT = 1_000;
const HTTP_ERROR_READ_LIMIT = 4_096;

/** A JSON value accepted in function parameters and response schemas. */
export type CompletionJsonValue = null | boolean | number | string | CompletionJsonValue[] | { [key: string]: CompletionJsonValue };

/** A system instruction sent to the completion provider. */
export interface CompletionSystemMessage {
  role: "system";
  content: string;
}

/** A user declaration sent to the completion provider. */
export interface CompletionUserMessage {
  role: "user";
  content: string;
}

/** A function call emitted by, or replayed to, the provider. */
export interface CompletionToolCall {
  id: string;
  name: string;
  /** The provider's exact argument text; parsing and validation belong to the caller. */
  arguments: string;
}

/** An assistant message, optionally containing function calls with raw arguments. */
export interface CompletionAssistantMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: readonly CompletionToolCall[];
}

/** A deterministic tool result associated with an earlier assistant call. */
export interface CompletionToolResultMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

/** A message accepted by the non-stream completion adapter. */
export type CompletionMessage = CompletionSystemMessage | CompletionUserMessage | CompletionAssistantMessage | CompletionToolResultMessage;

/**
 * A function tool whose wire declaration requests the provider's strict mode.
 * The adapter does not weaken or remove strict mode for incompatible providers.
 */
export interface CompletionFunctionTool {
  name: string;
  description?: string;
  /** JSON Schema forwarded as function parameters; it is not locally evaluated here. */
  parameters: { [key: string]: CompletionJsonValue };
}

/** The provider's function-selection mode. */
export type CompletionToolChoice = "none" | "auto" | "required" | { name: string };

/**
 * A JSON Schema response format sent with provider strict mode enabled.
 * The adapter transports this capability request unchanged; callers still
 * validate returned JSON locally and provider incompatibility is surfaced.
 */
export interface CompletionJsonSchemaFormat {
  name: string;
  description?: string;
  /** Response JSON Schema forwarded to the provider and validated later by the caller. */
  schema: { [key: string]: CompletionJsonValue };
}

/** Input for one non-stream OpenAI-compatible completion. */
export interface ProviderCompletionInput {
  provider: ProviderSettings;
  harness: HarnessSettings;
  preset: PromptPreset;
  messages: readonly CompletionMessage[];
  /** Strict function capabilities to advertise; an empty list is omitted. */
  tools?: readonly CompletionFunctionTool[];
  toolChoice?: CompletionToolChoice;
  /** Strict provider response-format request; never silently downgraded. */
  jsonSchema?: CompletionJsonSchemaFormat;
  signal?: AbortSignal;
}

/** Valid provider token accounting. Invalid or incomplete accounting is returned as null. */
export interface ProviderCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Requested and provider-reported model identifiers for audit metadata. */
export interface ProviderCompletionModelMetadata {
  requestedModel: string;
  responseModel: string | null;
}

/** Parsed result from one non-stream completion request. */
export interface ProviderCompletionResult {
  message: CompletionAssistantMessage;
  usage: ProviderCompletionUsage | null;
  model: ProviderCompletionModelMetadata;
}

/** Base class for classified completion adapter failures. */
export class ProviderCompletionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Provider settings cannot produce a real, policy-compliant request. */
export class ProviderConfigurationError extends ProviderCompletionError {}

/** A successful HTTP response contained a provider-declared error. */
export class ProviderResponseError extends ProviderCompletionError {
  constructor(detail: string, apiKey = "") {
    super(redactSensitiveExcerpt(detail, apiKey));
  }
}

/** The provider response violated the expected completion protocol. */
export class ProviderProtocolError extends ProviderCompletionError {}

/** The provider returned a non-successful HTTP status. */
export class ProviderHttpError extends ProviderCompletionError {
  /** HTTP status returned by the provider. */
  readonly status: number;

  constructor(status: number, detail: string, apiKey = "") {
    const safeDetail = redactSensitiveExcerpt(detail, apiKey);
    super(`Provider completion HTTP ${status}${safeDetail ? `: ${safeDetail}` : ""}`);
    this.status = status;
  }
}

/** A provider redirect was refused rather than followed with scoped headers. */
export class ProviderRedirectError extends ProviderCompletionError {}

/** The caller's signal cancelled the completion. */
export class ProviderCallerAbortError extends ProviderCompletionError {}

/** The configured provider deadline expired. */
export class ProviderTimeoutError extends ProviderCompletionError {}

/** The request failed before an HTTP response was available. */
export class ProviderTransportError extends ProviderCompletionError {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireName(value: string, label: string): string {
  if (!value.trim()) throw new ProviderConfigurationError(`${label} must not be empty`);
  return value;
}

interface WiredTranscript {
  messages: Array<Record<string, unknown>>;
  priorCallIds: Set<string>;
}

function wireMessages(messages: readonly CompletionMessage[]): WiredTranscript {
  if (messages.length === 0) throw new ProviderConfigurationError("messages must not be empty");
  const callIds = new Set<string>();
  const resolvedCallIds = new Set<string>();
  const pendingCallIds: string[] = [];
  const wired = messages.map((message, index) => {
    if (typeof message.content !== "string" && !(message.role === "assistant" && message.content === null)) {
      throw new ProviderConfigurationError(`messages[${index}].content is invalid`);
    }
    if (message.role === "tool") {
      const toolCallId = requireName(message.toolCallId, `messages[${index}].toolCallId`);
      if (resolvedCallIds.has(toolCallId)) throw new ProviderConfigurationError(`duplicate tool result for call id: ${toolCallId}`);
      if (pendingCallIds.length === 0) throw new ProviderConfigurationError(`orphan tool result for call id: ${toolCallId}`);
      if (pendingCallIds[0] !== toolCallId) {
        throw new ProviderConfigurationError(`out-of-order tool result for call id: ${toolCallId}; expected ${pendingCallIds[0]}`);
      }
      pendingCallIds.shift();
      resolvedCallIds.add(toolCallId);
      return { role: "tool", tool_call_id: toolCallId, content: message.content };
    }
    if (pendingCallIds.length > 0) {
      throw new ProviderConfigurationError(`unresolved tool call ${pendingCallIds[0]} before messages[${index}] ${message.role} message`);
    }
    if (message.role === "system" || message.role === "user") return { role: message.role, content: message.content };
    if (message.role !== "assistant") throw new ProviderConfigurationError(`messages[${index}].role is invalid`);
    const toolCalls = message.toolCalls?.map((call, callIndex) => {
      requireName(call.id, `messages[${index}].toolCalls[${callIndex}].id`);
      requireName(call.name, `messages[${index}].toolCalls[${callIndex}].name`);
      if (callIds.has(call.id)) throw new ProviderConfigurationError(`duplicate message tool call id: ${call.id}`);
      callIds.add(call.id);
      pendingCallIds.push(call.id);
      if (typeof call.arguments !== "string") throw new ProviderConfigurationError(`messages[${index}].toolCalls[${callIndex}].arguments is invalid`);
      return { id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } };
    });
    if (message.content === null && (!toolCalls || toolCalls.length === 0)) {
      throw new ProviderConfigurationError(`messages[${index}] has neither content nor tool calls`);
    }
    return { role: "assistant", content: message.content, ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) };
  });
  if (pendingCallIds.length > 0) throw new ProviderConfigurationError(`unresolved tool call at end of transcript: ${pendingCallIds[0]}`);
  return { messages: wired, priorCallIds: callIds };
}

function applyTools(body: Record<string, unknown>, input: ProviderCompletionInput): Set<string> {
  const tools = input.tools;
  const names = new Set<string>();
  if (tools && tools.length > 0) {
    body.tools = tools.map((tool, index) => {
      requireName(tool.name, `tools[${index}].name`);
      if (names.has(tool.name)) throw new ProviderConfigurationError(`duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      if (!isObject(tool.parameters)) throw new ProviderConfigurationError(`tools[${index}].parameters must be an object`);
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          parameters: tool.parameters,
          strict: true,
        },
      };
    });
  }
  if (input.toolChoice !== undefined) {
    if (typeof input.toolChoice === "object") {
      const name = requireName(input.toolChoice.name, "toolChoice.name");
      if (!tools?.some((tool) => tool.name === name)) throw new ProviderConfigurationError(`toolChoice references unknown tool: ${name}`);
      body.tool_choice = { type: "function", function: { name } };
    } else {
      if (input.toolChoice !== "none" && (!tools || tools.length === 0)) {
        throw new ProviderConfigurationError(`toolChoice ${input.toolChoice} requires at least one tool`);
      }
      body.tool_choice = input.toolChoice;
    }
  }
  return names;
}

function applyJsonSchema(body: Record<string, unknown>, format: CompletionJsonSchemaFormat | undefined): void {
  if (!format) return;
  requireName(format.name, "jsonSchema.name");
  if (!isObject(format.schema)) throw new ProviderConfigurationError("jsonSchema.schema must be an object");
  body.response_format = {
    type: "json_schema",
    json_schema: {
      name: format.name,
      ...(format.description !== undefined ? { description: format.description } : {}),
      schema: format.schema,
      strict: true,
    },
  };
}

interface ResponseToolPolicy {
  advertisedNames: ReadonlySet<string>;
  toolChoice: CompletionToolChoice | undefined;
  priorCallIds: ReadonlySet<string>;
}

function parseToolCalls(value: unknown, policy: ResponseToolPolicy): CompletionToolCall[] {
  if (!Array.isArray(value)) throw new ProviderProtocolError("Provider message tool_calls must be an array");
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isObject(candidate) || typeof candidate.id !== "string" || !candidate.id.trim() || candidate.type !== "function" || !isObject(candidate.function)) {
      throw new ProviderProtocolError(`Provider tool_calls[${index}] is malformed`);
    }
    if (ids.has(candidate.id)) throw new ProviderProtocolError("Provider returned a duplicate tool call id");
    if (policy.priorCallIds.has(candidate.id)) throw new ProviderProtocolError("Provider reused a prior tool call id");
    ids.add(candidate.id);
    const fn = candidate.function;
    if (typeof fn.name !== "string" || !fn.name.trim() || typeof fn.arguments !== "string") {
      throw new ProviderProtocolError(`Provider tool_calls[${index}].function is malformed`);
    }
    if (policy.advertisedNames.size === 0 || policy.toolChoice === "none") {
      throw new ProviderProtocolError("Provider returned tool calls when tools were not enabled");
    }
    if (!policy.advertisedNames.has(fn.name)) throw new ProviderProtocolError("Provider returned an undeclared tool");
    if (typeof policy.toolChoice === "object" && fn.name !== policy.toolChoice.name) {
      throw new ProviderProtocolError("Provider returned a tool other than the named tool choice");
    }
    return { id: candidate.id, name: fn.name, arguments: fn.arguments };
  });
}

function parseUsage(value: unknown): ProviderCompletionUsage | null {
  if (!isObject(value)) return null;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const total = value.total_tokens;
  const valid = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;
  if (!valid(prompt) || !valid(completion) || !valid(total) || total < prompt + completion) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function providerErrorMessage(error: unknown): string {
  if (isObject(error) && typeof error.message === "string" && error.message.trim()) return error.message;
  return "Provider returned an unspecified error";
}

function redactSensitiveExcerpt(value: string, apiKey: string): string {
  let redacted = value.slice(0, HTTP_ERROR_READ_LIMIT)
    .replace(/\bauthorization\s*["']?\s*[:=]\s*["']?\s*(?:(?:bearer|basic)\s+)?[A-Za-z0-9._~+/=-]+/gi, "Authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  const key = apiKey.trim();
  if (key) redacted = redacted.replaceAll(key, "[REDACTED]");
  return redacted.slice(0, HTTP_ERROR_DETAIL_LIMIT);
}

async function readBoundedErrorDetail(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  try {
    while (detail.length < HTTP_ERROR_READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        detail += decoder.decode();
        break;
      }
      const remaining = HTTP_ERROR_READ_LIMIT - detail.length;
      const bounded = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      detail += decoder.decode(bounded, { stream: value.byteLength <= remaining });
      if (value.byteLength > remaining) break;
    }
    return detail.slice(0, HTTP_ERROR_READ_LIMIT);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseResponse(
  payload: unknown,
  requestedModel: string,
  policy: ResponseToolPolicy,
  apiKey: string,
): ProviderCompletionResult {
  if (!isObject(payload)) throw new ProviderProtocolError("Provider completion response must be an object");
  if (Object.prototype.hasOwnProperty.call(payload, "error") && payload.error !== null) {
    throw new ProviderResponseError(providerErrorMessage(payload.error), apiKey);
  }
  if (!Array.isArray(payload.choices) || payload.choices.length === 0 || !isObject(payload.choices[0])) {
    throw new ProviderProtocolError("Provider completion response has no choice");
  }
  const choice = payload.choices[0];
  if (!isObject(choice.message) || (choice.message.role !== undefined && choice.message.role !== "assistant")) {
    throw new ProviderProtocolError("Provider completion choice has no assistant message");
  }
  const message = choice.message;
  const hasContent = Object.prototype.hasOwnProperty.call(message, "content");
  if (hasContent && typeof message.content !== "string" && message.content !== null) {
    throw new ProviderProtocolError("Provider assistant content must be a string or null");
  }
  const parsedToolCalls = Object.prototype.hasOwnProperty.call(message, "tool_calls") ? parseToolCalls(message.tool_calls, policy) : [];
  const toolCalls = parsedToolCalls.length > 0 ? parsedToolCalls : undefined;
  if ((!hasContent || message.content === null) && !toolCalls) {
    throw new ProviderProtocolError("Provider assistant message has neither content nor tool calls");
  }
  if ((policy.toolChoice === "required" || typeof policy.toolChoice === "object") && !toolCalls) {
    throw new ProviderProtocolError("Provider did not return a required tool call");
  }
  return {
    message: { role: "assistant", content: hasContent ? message.content as string | null : null, ...(toolCalls ? { toolCalls } : {}) },
    usage: parseUsage(payload.usage),
    model: {
      requestedModel,
      responseModel: typeof payload.model === "string" && payload.model.trim() ? payload.model : null,
    },
  };
}

function isRedirectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isObject(current); depth += 1) {
    if (typeof current.message === "string" && current.message.toLowerCase().includes("unexpected redirect")) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Executes one real, non-stream OpenAI-compatible completion request.
 *
 * Strict function tools and JSON Schema constraints are sent exactly as
 * requested. Provider incompatibility is surfaced as an HTTP, provider, or
 * protocol error and is never silently downgraded. The owning orchestrator
 * must still parse and locally validate tool arguments and schema content.
 * Redirects are refused so scoped credentials cannot be forwarded.
 *
 * @throws {ProviderConfigurationError} For invalid settings, capabilities, or transcripts.
 * @throws {ProviderCallerAbortError} When the caller aborts the request.
 * @throws {ProviderTimeoutError} When the configured deadline expires.
 * @throws {ProviderRedirectError} When the provider attempts a redirect.
 * @throws {ProviderHttpError} For non-success HTTP responses.
 * @throws {ProviderResponseError} For provider-declared errors.
 * @throws {ProviderProtocolError} For malformed or capability-incompatible responses.
 * @throws {ProviderTransportError} For other transport failures.
 */
export async function completeWithProvider(input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
  const baseUrl = input.provider.baseUrl.trim().replace(/\/+$/, "");
  const validation = validateProviderBaseUrl(baseUrl);
  if (!baseUrl || !validation.ok || !canUseProvider({ ...input.provider, baseUrl })) {
    throw new ProviderConfigurationError(!validation.ok ? validation.reason : "Provider is not fully configured");
  }
  const timeoutMs = input.provider.requestTimeoutSeconds * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ProviderConfigurationError("requestTimeoutSeconds must be positive");
  if (input.signal?.aborted) throw new ProviderCallerAbortError("Provider completion aborted by caller");

  const body = buildRequestBody(input.provider, input.harness, input.preset, [], false);
  const transcript = wireMessages(input.messages);
  body.messages = transcript.messages;
  body.stream = false;
  const advertisedNames = applyTools(body, input);
  applyJsonSchema(body, input.jsonSchema);
  const requestedModel = String(body.model);

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signals = input.signal ? [input.signal, timeout.signal] : [timeout.signal];
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildProviderHeaders(baseUrl, input.provider),
      signal: AbortSignal.any(signals),
      redirect: "error",
      body: JSON.stringify(body),
    });
    if (response.status >= 300 && response.status < 400) throw new ProviderRedirectError("Provider completion redirect refused");
    if (!response.ok) {
      throw new ProviderHttpError(response.status, await readBoundedErrorDetail(response), input.provider.apiKey);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (input.signal?.aborted || timeout.signal.aborted) throw error;
      throw new ProviderProtocolError("Provider completion response was not valid JSON", { cause: error });
    }
    return parseResponse(payload, requestedModel, {
      advertisedNames,
      toolChoice: input.toolChoice,
      priorCallIds: transcript.priorCallIds,
    }, input.provider.apiKey);
  } catch (error) {
    if (error instanceof ProviderCompletionError) throw error;
    if (input.signal?.aborted) throw new ProviderCallerAbortError("Provider completion aborted by caller", { cause: error });
    if (timeout.signal.aborted) throw new ProviderTimeoutError("Provider completion timed out", { cause: error });
    if (isRedirectFailure(error)) throw new ProviderRedirectError("Provider completion redirect refused");
    throw new ProviderTransportError("Provider completion transport failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
