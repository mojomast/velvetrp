import {
  imageGenerationErrorSchema,
  imageGenerationHealthSchema,
  imageGenerationRequestSchema,
  imageGenerationResultSchema,
  type ImageGenerationHealth,
  type ImageGenerationRequest,
  type ImageGenerationRequestInput,
  type ImageGenerationResult,
} from "@velvet/contracts";
import { isLoopbackHost } from "./providerTransport.js";

/**
 * Provider-agnostic text-to-image adapter.
 *
 * The adapter talks to one operator-configured HTTP service (initially a
 * self-hosted Supra2-IMG wrapper). It never retries: an ambiguous generation
 * may have already spent GPU time, so a failure surfaces rather than
 * duplicating work. Failures are typed and bounded; credentials and raw
 * response bodies are never included in messages.
 */

export const IMAGE_GENERATION_DEFAULT_TIMEOUT_MS = 120_000;
export const IMAGE_GENERATION_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_GENERATION_MIN_TIMEOUT_MS = 1_000;
export const IMAGE_GENERATION_MAX_TIMEOUT_MS = 600_000;
export const IMAGE_GENERATION_MIN_MAX_BYTES = 1_024;
export const IMAGE_GENERATION_MAX_MAX_BYTES = 64 * 1024 * 1024;

const HEALTH_PATH = "/health";
const GENERATE_PATH = "/generate";
const HEALTH_BYTE_LIMIT = 32 * 1024;
const ERROR_DETAIL_LIMIT = 500;
const MAX_RESULT_IMAGES = 4;
const REDIRECT_STATUS_MIN = 300;
const REDIRECT_STATUS_MAX = 399;

/** Effective image-generation settings after environment parsing. */
export interface ImageGenerationConfig {
  /** True only when `VELVET_IMAGES_ENABLED` is the exact string `true` and a valid base URL is configured. */
  enabled: boolean;
  /** Normalized base URL without a trailing slash; empty when not validly configured. */
  baseUrl: string;
  /** Optional bearer credential. */
  token: string;
  /** Operator-declared model identifier, for health reporting and future provenance. */
  model: string;
  /** Per-request deadline in milliseconds. */
  timeoutMs: number;
  /** Decoded byte budget for each generated image. */
  maxBytes: number;
}

function ipv4Octets(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

/**
 * Hosts that may be reached over plain HTTP: loopback, RFC1918 private ranges,
 * and the Tailscale CGNAT range or `*.ts.net` names. The tailnet exception is
 * required for the private inference host, which is reachable over the tailnet
 * but is not a loopback or RFC1918 address. Public HTTP destinations remain
 * rejected; use HTTPS for anything outside the private network.
 */
export function isPrivateImageGenerationHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return true;
  if (host === "ts.net" || host.endsWith(".ts.net")) return true;
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [first, second] = octets;
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

/**
 * Validates the transport policy for the image-generation base URL: HTTPS to
 * any host, or HTTP only to loopback, RFC1918 private, or Tailscale
 * CGNAT/`*.ts.net` hosts.
 */
export function validateImageGenerationBaseUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "baseUrl is not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:" && isPrivateImageGenerationHost(url.hostname)) return { ok: true };
  return { ok: false, reason: "baseUrl must use https, or http for loopback, RFC1918 private, or Tailscale CGNAT/tailnet hosts" };
}

/**
 * Reads image-generation settings from the environment. Numeric deadlines and
 * byte budgets are always validated and rejected when malformed, even while
 * the integration is disabled. The integration is enabled only for the exact
 * string `true` plus a valid base URL; an absent or invalid URL leaves it
 * disabled.
 */
export function readImageGenerationConfig(env: NodeJS.ProcessEnv = process.env): ImageGenerationConfig {
  const requested = env.VELVET_IMAGES_ENABLED === "true";
  const timeoutMs = Number(env.VELVET_IMAGES_TIMEOUT_MS ?? IMAGE_GENERATION_DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < IMAGE_GENERATION_MIN_TIMEOUT_MS || timeoutMs > IMAGE_GENERATION_MAX_TIMEOUT_MS) {
    throw new Error("Image generation timeout must be an integer within 1000–600000ms");
  }
  const maxBytes = Number(env.VELVET_IMAGES_MAX_BYTES ?? IMAGE_GENERATION_DEFAULT_MAX_BYTES);
  if (!Number.isInteger(maxBytes) || maxBytes < IMAGE_GENERATION_MIN_MAX_BYTES || maxBytes > IMAGE_GENERATION_MAX_MAX_BYTES) {
    throw new Error("Image generation byte budget must be an integer within 1024–67108864 bytes");
  }
  const rawBaseUrl = (env.VELVET_IMAGES_BASE_URL ?? "").trim();
  const validation = validateImageGenerationBaseUrl(rawBaseUrl);
  return {
    enabled: requested && validation.ok,
    baseUrl: validation.ok ? rawBaseUrl.replace(/\/+$/, "") : "",
    token: (env.VELVET_IMAGES_TOKEN ?? "").trim(),
    model: (env.VELVET_IMAGES_MODEL ?? "").trim(),
    timeoutMs,
    maxBytes,
  };
}

/**
 * Estimates the decoded byte count of a base64 payload from its encoded
 * length. Non-multiple-of-four input over-estimates rather than under-counts,
 * so the byte budget stays a hard ceiling for malformed payloads.
 */
export function base64DecodedByteEstimate(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.ceil(value.length / 4) * 3 - padding);
}

/** Base class for classified image-generation adapter failures. */
export class ImageGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The adapter cannot produce a real, policy-compliant request. */
export class ImageGenerationConfigurationError extends ImageGenerationError {}

/** The service returned a non-successful HTTP status. */
export class ImageGenerationHttpError extends ImageGenerationError {
  readonly status: number;
  constructor(status: number, detail = "") {
    super(`Image generation HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

/** The configured deadline expired. */
export class ImageGenerationTimeoutError extends ImageGenerationError {}

/** The response violated the declared contract or was not valid JSON. */
export class ImageGenerationProtocolError extends ImageGenerationError {}

/** The response exceeded the configured decoded or transport byte budget. */
export class ImageGenerationPayloadTooLargeError extends ImageGenerationError {}

/** The request failed before an HTTP response was available. */
export class ImageGenerationTransportError extends ImageGenerationError {}

/** A client shape shared by the real adapter and deterministic doubles. */
export interface ImageGenerationClient {
  health(): Promise<ImageGenerationHealth>;
  generate(request: ImageGenerationRequestInput): Promise<ImageGenerationResult>;
}

export interface ImageGenerationClientOptions {
  config: ImageGenerationConfig;
  /** Injectable transport for deterministic tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

function responseByteCeiling(maxBytes: number): number {
  // Every accepted image may sit just under the decoded budget; allow for
  // base64 expansion and JSON framing across the maximum result image count.
  return Math.ceil((maxBytes * 4) / 3) * MAX_RESULT_IMAGES + 64 * 1024;
}

function requireEnabled(config: ImageGenerationConfig): void {
  if (!config.enabled) throw new ImageGenerationConfigurationError("Image generation is not enabled");
  const validation = validateImageGenerationBaseUrl(config.baseUrl);
  if (!validation.ok) throw new ImageGenerationConfigurationError(validation.reason);
}

function buildHeaders(config: ImageGenerationConfig, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (withBody) headers["Content-Type"] = "application/json";
  // The credential is sent only to the operator-configured base URL.
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return headers;
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new ImageGenerationPayloadTooLargeError("Image generation response exceeded the byte budget");
  }
  if (!response.body) throw new ImageGenerationProtocolError("Image generation response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > limit) throw new ImageGenerationPayloadTooLargeError("Image generation response exceeded the byte budget");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseJsonBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ImageGenerationProtocolError("Image generation response was not valid JSON", { cause: error });
  }
}

/** Reads only a bounded error detail; a failed detail read never masks the status. */
async function readBoundedDetail(response: Response, token: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = "";
  try {
    while (detail.length < ERROR_DETAIL_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        detail += decoder.decode();
        break;
      }
      const remaining = ERROR_DETAIL_LIMIT - detail.length;
      const bounded = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      detail += decoder.decode(bounded, { stream: value.byteLength <= remaining });
      if (value.byteLength > remaining) break;
    }
  } catch {
    // Ignore unreadable error details; the status still classifies the failure.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const redacted = token ? detail.slice(0, ERROR_DETAIL_LIMIT).split(token).join("[REDACTED]") : detail;
  try {
    const parsed = imageGenerationErrorSchema.safeParse(JSON.parse(redacted));
    return parsed.success ? parsed.data.error : "";
  } catch {
    return "";
  }
}

async function runWithTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ImageGenerationConfigurationError("Image generation timeout must be positive");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new ImageGenerationTimeoutError("Image generation request timed out", { cause: error });
    if (error instanceof ImageGenerationError) throw error;
    throw new ImageGenerationTransportError("Image generation transport failed", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the provider-agnostic image client. There is deliberately no retry:
 * a failed or ambiguous generation may already have consumed GPU time, so the
 * caller decides whether to try again.
 */
export function createImageGenerationClient(options: ImageGenerationClientOptions): ImageGenerationClient {
  const { config } = options;
  const http = options.fetch ?? fetch;

  return {
    async health(): Promise<ImageGenerationHealth> {
      requireEnabled(config);
      return runWithTimeout(config.timeoutMs, async (signal) => {
        const response = await http(`${config.baseUrl}${HEALTH_PATH}`, {
          method: "GET",
          headers: buildHeaders(config, false),
          signal,
          redirect: "error",
        });
        if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
          throw new ImageGenerationTransportError("Image generation redirect refused");
        }
        if (!response.ok) throw new ImageGenerationHttpError(response.status, await readBoundedDetail(response, config.token));
        const parsed = imageGenerationHealthSchema.safeParse(parseJsonBody(await readBoundedBody(response, HEALTH_BYTE_LIMIT)));
        if (!parsed.success) throw new ImageGenerationProtocolError("Image generation health response did not match the declared schema");
        return parsed.data;
      });
    },

    async generate(request: ImageGenerationRequestInput): Promise<ImageGenerationResult> {
      requireEnabled(config);
      let parsedRequest: ImageGenerationRequest;
      try {
        parsedRequest = imageGenerationRequestSchema.parse(request);
      } catch (error) {
        throw new ImageGenerationConfigurationError("Image generation request is invalid", { cause: error });
      }
      return runWithTimeout(config.timeoutMs, async (signal) => {
        const response = await http(`${config.baseUrl}${GENERATE_PATH}`, {
          method: "POST",
          headers: buildHeaders(config, true),
          signal,
          redirect: "error",
          body: JSON.stringify(parsedRequest),
        });
        if (response.status >= REDIRECT_STATUS_MIN && response.status <= REDIRECT_STATUS_MAX) {
          throw new ImageGenerationTransportError("Image generation redirect refused");
        }
        if (!response.ok) throw new ImageGenerationHttpError(response.status, await readBoundedDetail(response, config.token));
        const bytes = await readBoundedBody(response, responseByteCeiling(config.maxBytes));
        const parsed = imageGenerationResultSchema.safeParse(parseJsonBody(bytes));
        if (!parsed.success) throw new ImageGenerationProtocolError("Image generation response did not match the declared schema");
        for (const image of parsed.data.images) {
          if (base64DecodedByteEstimate(image.base64) > config.maxBytes) {
            throw new ImageGenerationPayloadTooLargeError("Image generation response exceeded the byte budget");
          }
        }
        return parsed.data;
      });
    },
  };
}
