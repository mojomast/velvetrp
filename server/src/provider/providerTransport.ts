import type { ProviderSettings } from "../types.js";

const SUPPORTED_HOSTED_PROVIDER_HOSTS = new Set(["api.openai.com", "openrouter.ai", "router.requesty.ai", "requesty.ai"]);
const AUTHORIZED_HTTP_PROVIDER = { hostname: "100.72.41.9", port: "8787", pathname: "/v1" } as const;
/**
 * The single hosted host that may receive the System One credential. Unlike the
 * OpenAI-compatible allowlist, this is deliberately not extended with a loopback
 * HTTP exception beyond ordinary loopback hosts, and never with arbitrary HTTPS.
 */
const SYSTEM_ONE_HOSTED_HOST = "api.typesafe.ai";

function providerHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The sole non-loopback HTTP provider endpoint authorized for live validation. */
function isAuthorizedHttpProvider(url: URL): boolean {
  return url.protocol === "http:"
    && url.hostname === AUTHORIZED_HTTP_PROVIDER.hostname
    && url.port === AUTHORIZED_HTTP_PROVIDER.port
    && url.pathname.replace(/\/+$/, "") === AUTHORIZED_HTTP_PROVIDER.pathname
    && !url.search
    && !url.hash
    && !url.username
    && !url.password;
}

/** Returns whether a hostname identifies a loopback-only destination. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.endsWith(".localhost")) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Validates the transport policy for a configured provider base URL. */
export function validateProviderBaseUrl(baseUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return { ok: false, reason: "baseUrl is not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:" && (isLoopbackHost(url.hostname) || isAuthorizedHttpProvider(url))) return { ok: true };
  return { ok: false, reason: "baseUrl must use https, http loopback, or the exact authorized live-validation endpoint" };
}

/**
 * Returns whether settings permit a real OpenAI-compatible request.
 *
 * Exact supported hosted-provider hosts require an API key. Loopback and
 * arbitrary HTTPS endpoints remain usable without one, but arbitrary HTTPS
 * hosts never receive the configured credential. `providerType` is descriptive
 * here and does not alter this OpenAI-compatible transport policy.
 */
export function canUseProvider(provider: ProviderSettings): boolean {
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, "");
  const hostname = providerHostname(baseUrl);
  return Boolean(
    baseUrl
      && hostname
      && validateProviderBaseUrl(baseUrl).ok
       && (!(SUPPORTED_HOSTED_PROVIDER_HOSTS.has(hostname) || (() => { try { return isAuthorizedHttpProvider(new URL(baseUrl)); } catch { return false; } })()) || provider.apiKey.trim()),
  );
}

/**
 * Builds scoped provider headers without sending credentials to arbitrary hosts.
 * Credentials are limited to exact supported hosted hosts, loopback, and the
 * one authorized live-validation endpoint; this
 * function intentionally does not authorize hosted-provider subdomains.
 */
export function buildProviderHeaders(baseUrl: string, provider: ProviderSettings): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const hostname = providerHostname(baseUrl);
  if (!hostname) return headers;
  let authorizedHttp = false; try { authorizedHttp = isAuthorizedHttpProvider(new URL(baseUrl.trim())); } catch { /* invalid URLs never receive credentials */ }
  if (provider.apiKey.trim() && (SUPPORTED_HOSTED_PROVIDER_HOSTS.has(hostname) || isLoopbackHost(hostname) || authorizedHttp)) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }
  if (hostname === "openrouter.ai" || isLoopbackHost(hostname)) {
    if (provider.httpReferer.trim()) headers["HTTP-Referer"] = provider.httpReferer.trim();
    if (provider.appTitle.trim()) headers["X-Title"] = provider.appTitle.trim();
    const userAgent = process.env.OPENROUTER_USER_AGENT?.trim() ?? "";
    if (/^[\x20-\x7E]{1,200}$/.test(userAgent)) headers["User-Agent"] = userAgent;
  }
  return headers;
}

function systemOneHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Validates the transport policy for the System One base URL (HTTPS or loopback HTTP). */
export function validateSystemOneBaseUrl(baseUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return { ok: false, reason: "baseUrl is not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return { ok: true };
  return { ok: false, reason: "baseUrl must use https or http loopback" };
}

/**
 * Returns whether System One settings permit a real decision request.
 *
 * The hosted host requires a key; loopback may run keyless for local doubles.
 * An arbitrary HTTPS host is structurally valid but unusable without being
 * allowlisted, and never receives the credential.
 */
export function canUseSystemOne(settings: { baseUrl: string; apiKey: string }): boolean {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "");
  const hostname = systemOneHostname(baseUrl);
  if (!baseUrl || !hostname || !validateSystemOneBaseUrl(baseUrl).ok) return false;
  if (hostname === SYSTEM_ONE_HOSTED_HOST) return settings.apiKey.trim().length > 0;
  if (isLoopbackHost(hostname)) return true;
  return false;
}

/**
 * Builds System One headers. The bearer credential is sent only to the exact
 * allowlisted hosted host or a loopback host; arbitrary HTTPS hosts get none.
 */
export function buildSystemOneHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const hostname = systemOneHostname(baseUrl);
  if (hostname && apiKey.trim() && (hostname === SYSTEM_ONE_HOSTED_HOST || isLoopbackHost(hostname))) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}
