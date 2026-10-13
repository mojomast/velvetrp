/**
 * OpenAI-compatible teacher HTTP client.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in the foundry had ever generated a byte. Every downstream module
 * (`grounding.ts`, `worldGeneration.ts`, `admission.ts`, `runstore.ts`) is a gate
 * over data that did not exist. This module is the narrowest possible piece that
 * can produce that data, and it is deliberately narrow: it speaks exactly one
 * protocol, to exactly one endpoint, and it refuses to be constructed at all
 * without a credential.
 *
 * FOUR HARD RULES, EACH ENFORCED IN CODE AND PINNED BY A TEST
 * ----------------------------------------------------------
 *
 * 1. CREDENTIAL DISCIPLINE. The API key lives in exactly one place: a private
 *    closure field of the client. It is never returned from any method, never
 *    placed in an error message, never logged, and never written into an
 *    artifact. Provenance records `baseUrlDigest`, never the endpoint URL and
 *    never a key fragment. `SecretGuard` exists so that a *future* careless
 *    `String(error)` cannot undo this: every error message and every value the
 *    client returns is passed through it first.
 *
 * 2. NO ACCIDENTAL SPEND. Construction requires a credential; a request is
 *    explicit; retries are bounded. There is no implicit request anywhere.
 *
 * 3. RESPECT THE RELAY'S TIMEOUT. The teacher relay is configured with a ~660s
 *    timeout because long completions are legitimate for this model. The default
 *    here matches it. An "optimistic" 30s default would abort real generations
 *    and turn a cost problem into a completeness problem.
 *
 * 4. RETRY ONLY WHAT IS RETRYABLE. 429 and 5xx are transient. Every other 4xx is
 *    a permanent refusal by the provider -- a malformed request, a bad model id,
 *    an auth failure -- and retrying it burns wall-clock and money to reach the
 *    same answer. Those are surfaced immediately.
 *
 * Usage is returned per call so budget accounting is possible at all. When the
 * provider omits usage the client says so (`usage: null`) rather than inventing
 * a number; the pipeline treats that as "payment outcome unknown" and retains the
 * budget reservation instead of settling it optimistically.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseArgumentsOnce } from "./hfAdapter.js";
import type { StoredTool, StoredToolCall } from "./spec.js";

export const TEACHER_CLIENT_VERSION = "teacher-client-v1";

/**
 * Default request timeout. Matches the relay's configured long timeout
 * (~660s). Lowering this by default would abort legitimate long completions.
 */
export const DEFAULT_TEACHER_TIMEOUT_MS = 660_000;

/** Total attempts including the first. Bounded so a bad provider cannot spin. */
export const DEFAULT_TEACHER_MAX_ATTEMPTS = 4;

export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 30_000;

/**
 * The relay is verified live at this endpoint and serves this model. It is a
 * fallback ONLY for the case where the operator has not set
 * `VELVET_TEACHER_MODEL`; an explicit env value always wins.
 */
export const DEFAULT_TEACHER_PROVIDER_ID = "agentrouter";
export const DEFAULT_TEACHER_MODEL = "deepseek-v4-flash";

/** Generator identity. `baseUrlDigest` is a digest, never the endpoint. */
export interface TeacherIdentity {
  readonly provider: string;
  readonly model: string;
  readonly baseUrlDigest: string;
  readonly credentialSource: CredentialSource;
}

export type CredentialSource = "env" | "opencode-config";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TeacherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeacherError";
  }
}

/** No credential could be resolved. The client refuses to exist. */
export class TeacherCredentialError extends TeacherError {
  readonly source: CredentialSource | null;
  constructor(message: string, source: CredentialSource | null = null) {
    super(message);
    this.name = "TeacherCredentialError";
    this.source = source;
  }
}

/** A non-retryable or exhausted HTTP failure. Never carries a credential. */
export class TeacherHttpError extends TeacherError {
  readonly status: number;
  readonly retried: boolean;
  readonly baseUrlDigest: string;
  constructor(status: number, bodyExcerpt: string, retried: boolean, baseUrlDigest: string) {
    super(
      `teacher relay returned HTTP ${status}${retried ? " after the retry budget was spent" : ""}` +
        `${bodyExcerpt ? `: ${bodyExcerpt}` : ""}`,
    );
    this.name = "TeacherHttpError";
    this.status = status;
    this.retried = retried;
    this.baseUrlDigest = baseUrlDigest;
  }
}

export class TeacherResponseError extends TeacherError {
  constructor(message: string) {
    super(message);
    this.name = "TeacherResponseError";
  }
}

export class TeacherTimeoutError extends TeacherError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`teacher request exceeded its ${timeoutMs}ms budget`);
    this.name = "TeacherTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Credential discipline
// ---------------------------------------------------------------------------

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Owns the secret and is the only thing that ever holds it.
 *
 * `scrub` is applied to every message this module produces. It is a last line of
 * defence, not the mechanism: the mechanism is that the key is never formatted
 * into anything. A test asserts that no credential-shaped substring survives in
 * any error, log record, returned object or provenance field.
 */
export class SecretGuard {
  private readonly secret: string;
  /** Minimum secret length; shorter values would scrub ordinary prose. */
  private readonly armed: boolean;

  constructor(secret: string) {
    this.secret = secret;
    this.armed = secret.length >= 8;
  }

  /** Replaces every occurrence of the secret. Short secrets are not scrubbed. */
  scrub(text: string): string {
    if (!this.armed || !text.includes(this.secret)) return text;
    return text.split(this.secret).join("[redacted-credential]");
  }

  /** Deep-walks a value and refuses to return anything containing the secret. */
  assertClean(what: string, value: unknown): void {
    if (!this.armed) return;
    if (typeof value === "string") {
      if (value.includes(this.secret)) {
        throw new TeacherCredentialError(`${what} contained a credential and was refused`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) this.assertClean(what, entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) this.assertClean(what, entry);
    }
  }

  /** Error message built from an unknown throwable, with the cause flattened safely. */
  describe(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause);
    return this.scrub(message);
  }
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

export interface ResolvedTeacherCredentials {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly providerId: string;
  readonly source: CredentialSource;
}

/** Minimal shape of the block this module reads. Avoids any dependency on a config type. */
interface OpenCodeProviderBlock {
  readonly options?: { readonly baseURL?: string; readonly apiKey?: string } | undefined;
  readonly models?: Readonly<Record<string, unknown>> | undefined;
}
interface OpenCodeConfig {
  readonly provider?: Readonly<Record<string, OpenCodeProviderBlock>> | undefined;
}

export interface CredentialResolutionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly providerId?: string;
  /** Overrides `~/.config/opencode/opencode.json`. Used by tests. */
  readonly configPath?: string | null;
  readonly readFile?: (path: string) => string;
  readonly homeDir?: string;
}

/**
 * The documented convenience fallback. It reads an EXISTING operator
 * configuration file; it never writes one and never creates one.
 */
export function openCodeConfigPath(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const override = env.OPENCODE_CONFIG;
  if (override && override.trim()) return override.trim();
  return join(homeDir, ".config", "opencode", "opencode.json");
}

function readProviderBlock(options: CredentialResolutionOptions): OpenCodeProviderBlock | null {
  const env = options.env ?? process.env;
  const read = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const path = options.configPath === undefined
    ? openCodeConfigPath(env, homeDir)
    : options.configPath;
  if (path === null) return null;
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const providerId = options.providerId ?? DEFAULT_TEACHER_PROVIDER_ID;
  return (parsed as OpenCodeConfig).provider?.[providerId] ?? null;
}

/**
 * Resolves credentials from the environment, falling back to the
 * `provider.agentrouter` block of `~/.config/opencode/opencode.json`.
 *
 * Returns null when neither source has a credential; `requireTeacherCredentials`
 * turns that into a refusal. Nothing here logs the resolved key or URL.
 */
export function resolveTeacherCredentials(
  options: CredentialResolutionOptions = {},
): ResolvedTeacherCredentials | null {
  const env = options.env ?? process.env;
  const providerId = options.providerId ?? DEFAULT_TEACHER_PROVIDER_ID;
  const envBaseUrl = env.VELVET_TEACHER_BASE_URL?.trim();
  const envApiKeyPresent = env.VELVET_TEACHER_API_KEY;
  const envApiKey = envApiKeyPresent?.trim();
  const envModel = env.VELVET_TEACHER_MODEL?.trim();
  if ((envBaseUrl !== undefined || envApiKeyPresent !== undefined)
    && (!envBaseUrl || envApiKeyPresent === undefined)) return null;
  // Presence, not truthiness: a variable that is SET but blank is a different
  // operator error from one that was never set, and the caller reports them
  // differently. Collapsing them here would hide the real mistake.
  if (envBaseUrl && envApiKeyPresent !== undefined) {
    return {
      baseUrl: envBaseUrl.replace(/\/+$/, ""),
      apiKey: envApiKey ?? "",
      model: envModel ?? DEFAULT_TEACHER_MODEL,
      providerId,
      source: "env",
    };
  }
  const block = readProviderBlock(options);
  const baseUrl = block?.options?.baseURL?.trim();
  const apiKey = block?.options?.apiKey?.trim();
  if (!baseUrl || !apiKey) return null;
  // A model is only inferable when the provider declares exactly one; otherwise
  // the operator must say which model, and guessing would silently change what
  // the run is attributed to.
  const declared = Object.keys(block?.models ?? {}).filter((name) => name.length > 0).sort();
  const model = envModel ?? (declared.length === 1 ? declared[0]! : DEFAULT_TEACHER_MODEL);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, providerId, source: "opencode-config" };
}

/** Refuses to hand back a half-configured credential. */
export function requireTeacherCredentials(
  options: CredentialResolutionOptions = {},
): ResolvedTeacherCredentials {
  const resolved = resolveTeacherCredentials(options);
  if (!resolved) {
    throw new TeacherCredentialError(
      "no teacher credential is available: set VELVET_TEACHER_BASE_URL and VELVET_TEACHER_API_KEY, " +
        "or configure provider." + (options.providerId ?? DEFAULT_TEACHER_PROVIDER_ID) +
        " in ~/.config/opencode/opencode.json",
    );
  }
  if (!resolved.apiKey) throw new TeacherCredentialError("teacher API key is empty");
  if (!/^https?:\/\//.test(resolved.baseUrl)) {
    throw new TeacherCredentialError("teacher base URL must be an http(s) endpoint");
  }
  if (!resolved.model.trim()) throw new TeacherCredentialError("teacher model is empty");
  return resolved;
}

/**
 * Picks a reviewer model that is genuinely NOT the teacher.
 *
 * `admitCandidate` enforces `reviewer !== generator`, and a review performed by
 * the same model is not a review at all -- it is a second sample from the same
 * distribution. This resolves deterministically and refuses when the choice
 * would collide, rather than discovering the collision at admission time after
 * the tokens have already been spent.
 */
export function requireReviewerCredentials(
  generatorModel: string,
  options: CredentialResolutionOptions = {},
): ResolvedTeacherCredentials {
  const base = requireTeacherCredentials(options);
  const env = options.env ?? process.env;
  const requested = env.VELVET_REVIEWER_MODEL?.trim();
  if (requested) {
    if (["auto", "best"].includes(requested)) {
      throw new TeacherCredentialError("independent review requires a concrete model, not a routing alias");
    }
    assertDistinctModels(generatorModel, requested);
    return { ...base, model: requested };
  }
  const block = readProviderBlock(options);
  const declared = Object.keys(block?.models ?? {}).filter((name) => name.length > 0).sort();
  const alternative = declared.find((name) => name !== generatorModel && !["auto", "best"].includes(name));
  if (!alternative) {
    throw new TeacherCredentialError(
      "independent review requires a reviewer model different from the generator model " +
        `"${generatorModel}"; set VELVET_REVIEWER_MODEL to one`,
    );
  }
  return { ...base, model: alternative };
}

/** The generator/reviewer distinction is a runtime property, not a comment. */
export function assertDistinctModels(generatorModel: string, reviewerModel: string): void {
  if (!generatorModel.trim() || !reviewerModel.trim()) {
    throw new TeacherCredentialError("both a generator model and a reviewer model are required");
  }
  if (generatorModel === reviewerModel) {
    throw new TeacherCredentialError(
      `reviewer model "${reviewerModel}" is the generator model; a self-review is not independent`,
    );
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TeacherHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export interface TeacherHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The seam every test injects. No test in this repository may reach the live
 * relay: a test that spends money is a test that fails differently every run.
 */
export type TeacherTransport = (request: TeacherHttpRequest) => Promise<TeacherHttpResponse>;

/** Real transport. Node's built-in `fetch`; no provider SDK, no new dependency. */
export const nodeFetchTransport: TeacherTransport = async (request: TeacherHttpRequest) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
      signal: controller.signal,
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, body, headers };
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new TeacherTimeoutError(request.timeoutMs);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TeacherMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** Present only on assistant tool-call turns, mirroring `StoredToolCall`. */
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }[];
}

export interface TeacherCompletionRequest {
  /** Stable identity of the attempt, used as a digest input and a retry key. */
  readonly attemptId: string;
  readonly system: string;
  readonly messages: readonly TeacherMessage[];
  readonly tools?: readonly StoredTool[] | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly seed?: number | undefined;
  /** `json` requests an object response where the relay supports it. */
  readonly responseFormat?: "text" | "json" | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

export interface TeacherUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface TeacherCompletion {
  readonly content: string;
  readonly toolCalls: readonly StoredToolCall[];
  /** `stop`, `length`, `tool_calls`, ... A `length` finish is a repairable fault. */
  readonly finishReason: string;
  /** Null when the provider reported no usage. Never estimated. */
  readonly usage: TeacherUsage | null;
  readonly responseId: string | null;
  /** Total HTTP attempts made, including retries. */
  readonly attempts: number;
  readonly latencyMs: number;
  readonly requestDigest: string;
}

/** A credential-free record of one call. What a log sink is allowed to receive. */
export interface TeacherCallLog {
  readonly attemptId: string;
  readonly model: string;
  readonly baseUrlDigest: string;
  readonly requestDigest: string;
  readonly attempts: number;
  readonly status: number | null;
  readonly finishReason: string | null;
  readonly usage: TeacherUsage | null;
  readonly contentBytes: number;
}

export interface TeacherClient {
  readonly identity: TeacherIdentity;
  readonly model: string;
  readonly baseUrlDigest: string;
  complete(request: TeacherCompletionRequest): Promise<TeacherCompletion>;
}

export interface CreateTeacherClientOptions {
  readonly credentials?: ResolvedTeacherCredentials | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly credentialOptions?: CredentialResolutionOptions | undefined;
  readonly transport?: TeacherTransport | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected so retry backoff does not make the test suite sleep. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly onCall?: ((log: TeacherCallLog) => void) | undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 429 and 5xx are transient. Every other non-2xx is a permanent refusal. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function retryDelayMs(attempt: number, retryAfterHeader?: string | undefined): number {
  const advertised = Number(retryAfterHeader);
  if (Number.isFinite(advertised) && advertised >= 0) {
    return Math.min(RETRY_MAX_DELAY_MS, advertised * 1_000);
  }
  // Deterministic exponential backoff. No jitter: a jitter that uses
  // `Math.random` would make a seeded run non-reproducible for no benefit here,
  // because the pipeline is single-writer by construction.
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
}

function parseUsage(raw: unknown): TeacherUsage | null {
  if (!isObject(raw)) return null;
  const prompt = raw.prompt_tokens;
  const completion = raw.completion_tokens;
  const total = raw.total_tokens;
  if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || !Number.isSafeInteger(total)) {
    return null;
  }
  if ((prompt as number) < 0 || (completion as number) < 0 || (total as number) < 0) return null;
  return {
    promptTokens: prompt as number,
    completionTokens: completion as number,
    totalTokens: total as number,
  };
}

/** Normalized choice. `content` is always a string; null became "" upstream. */
interface RelayChoice {
  readonly message: { readonly content: string; readonly tool_calls?: unknown };
  readonly finish_reason: string | null;
}

function parseChoices(parsed: unknown): { choices: RelayChoice[]; usage: TeacherUsage | null } {
  if (!isObject(parsed)) throw new TeacherResponseError("teacher response is not a JSON object");
  const rawChoices = parsed.choices;
  if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
    throw new TeacherResponseError("teacher response carries no choices");
  }
  const choices: RelayChoice[] = [];
  for (const entry of rawChoices) {
    if (!isObject(entry) || !isObject(entry.message)) {
      throw new TeacherResponseError("teacher response choice has no message");
    }
    const message = entry.message as { content: unknown; tool_calls?: unknown };
    // NOT scrubbed. If the model echoes the credential back, silently
    // rewriting its output would produce training data that differs from what
    // the model actually said. The refusal below is the honest response.
    const content = typeof message.content === "string"
      ? message.content
      : message.content === null || message.content === undefined
        ? ""
        : (() => { throw new TeacherResponseError("teacher message content is neither a string nor null"); })();
    choices.push({
      message: { content, ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}) },
      finish_reason: typeof entry.finish_reason === "string" ? entry.finish_reason : null,
    });
  }
  return { choices, usage: parseUsage(parsed.usage) };
}

function parseToolCalls(raw: unknown): StoredToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const calls: StoredToolCall[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isObject(entry) || entry.type !== "function" || !isObject(entry.function)) {
      throw new TeacherResponseError(`teacher tool call ${index} is not a function call`);
    }
    const fn = entry.function as { name?: unknown; arguments?: unknown };
    if (typeof fn.name !== "string" || !fn.name.trim()) {
      throw new TeacherResponseError(`teacher tool call ${index} has no function name`);
    }
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id : `call_${index + 1}`;
    // Arguments arrive as a JSON STRING from an OpenAI-shaped relay. The HF
    // contract requires an OBJECT. Parse exactly once; a parse failure is an
    // empty object plus a recorded problem, never a double-encoded string.
    const problems: string[] = [];
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const args = parseArgumentsOnce(rawArgs, problems, id);
    calls.push({ id, type: "function", function: { name: fn.name, arguments: args } });
  }
  return calls;
}

function buildRequestBody(request: TeacherCompletionRequest, model: string): string {
  const messages = [
    ...(request.system.trim() ? [{ role: "system" as const, content: request.system }] : []),
    ...request.messages.map((message): Record<string, unknown> => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls?.length
        ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
        : {}),
    })),
  ];
  return JSON.stringify({
    model,
    messages,
    ...(request.tools?.length ? { tools: request.tools } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
  });
}

/**
 * Constructs a teacher client, or refuses.
 *
 * Refusal is total: with no credential there is no object, so no downstream
 * code can accidentally reach a half-configured client.
 */
export function createTeacherClient(options: CreateTeacherClientOptions = {}): TeacherClient {
  const credentials = options.credentials ?? requireTeacherCredentials(
    options.credentialOptions ?? (options.env === undefined ? {} : { env: options.env }),
  );
  const transport = options.transport ?? nodeFetchTransport;
  const guard = new SecretGuard(credentials.apiKey);
  const baseUrlDigest = sha256Hex(credentials.baseUrl);
  const endpoint = `${credentials.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const identity: TeacherIdentity = {
    provider: credentials.providerId,
    model: credentials.model,
    baseUrlDigest,
    credentialSource: credentials.source,
  };
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TEACHER_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    identity,
    model: credentials.model,
    baseUrlDigest,

    async complete(request: TeacherCompletionRequest): Promise<TeacherCompletion> {
      const body = buildRequestBody(request, credentials.model);
      // The digest is over the request WITHOUT the credential, so it can be
      // recorded in the run store and compared across attempts safely.
      const requestDigest = sha256Hex(
        JSON.stringify({ model: credentials.model, body, attemptId: request.attemptId }),
      );
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const maxAttempts = request.maxAttempts ?? DEFAULT_TEACHER_MAX_ATTEMPTS;
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new TeacherError("maxAttempts must be a positive safe integer");
      }
      const startedAt = Date.now();
      let lastError: TeacherError | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: TeacherHttpResponse;
        try {
          response = await transport({
            url: endpoint,
            method: "POST",
            // The ONLY place the credential is ever materialised onto a value
            // that leaves this module. It is never copied into a result.
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${credentials.apiKey}`,
            },
            body,
            timeoutMs,
          });
        } catch (cause) {
          // Transport-level failure (socket, abort). Retried within budget; the
          // message is flattened through the guard so a driver error cannot
          // surface a header.
          const message = guard.describe(cause);
          lastError = cause instanceof TeacherTimeoutError ? cause : new TeacherError(`teacher transport failed: ${message}`);
          if (attempt === maxAttempts) break;
          await sleep(retryDelayMs(attempt));
          continue;
        }

        if (response.status >= 200 && response.status < 300) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(response.body);
          } catch {
            throw new TeacherResponseError("teacher response body is not valid JSON");
          }
          const { choices, usage } = parseChoices(parsed);
          const first = choices[0]!;
          const completion: TeacherCompletion = {
            content: first.message.content,
            toolCalls: parseToolCalls(first.message.tool_calls),
            finishReason: first.finish_reason ?? "unknown",
            usage,
            responseId: typeof (parsed as Record<string, unknown>).id === "string"
              ? (parsed as Record<string, unknown>).id as string
              : `resp-${requestDigest.slice(0, 16)}-${attempt}`,
            attempts: attempt,
            latencyMs: Date.now() - startedAt,
            requestDigest,
          };
          guard.assertClean("teacher completion", completion);
          options.onCall?.({
            attemptId: request.attemptId,
            model: credentials.model,
            baseUrlDigest,
            requestDigest,
            attempts: attempt,
            status: response.status,
            finishReason: completion.finishReason,
            usage,
            contentBytes: completion.content.length,
          });
          return completion;
        }

        const excerpt = guard.scrub(response.body).slice(0, 400);
        const retryable = isRetryableStatus(response.status);
        if (!retryable) {
          // A permanent refusal. Retrying reaches the same answer for more money.
          options.onCall?.({
            attemptId: request.attemptId, model: credentials.model, baseUrlDigest, requestDigest,
            attempts: attempt, status: response.status, finishReason: null, usage: null, contentBytes: 0,
          });
          throw new TeacherHttpError(response.status, excerpt, false, baseUrlDigest);
        }
        lastError = new TeacherHttpError(response.status, excerpt, attempt === maxAttempts, baseUrlDigest);
        if (attempt === maxAttempts) break;
        await sleep(retryDelayMs(attempt, response.headers?.["retry-after"] ?? response.headers?.["Retry-After"]));
      }

      options.onCall?.({
        attemptId: request.attemptId, model: credentials.model, baseUrlDigest, requestDigest,
        attempts: maxAttempts, status: lastError instanceof TeacherHttpError ? lastError.status : null,
        finishReason: null, usage: null, contentBytes: 0,
      });
      throw lastError ?? new TeacherError("teacher request failed without a recorded reason");
    },
  };
}
