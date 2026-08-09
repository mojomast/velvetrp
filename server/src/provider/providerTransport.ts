import type { ProviderSettings } from "../types.js";

const SUPPORTED_HOSTED_PROVIDER_HOSTS = new Set(["api.openai.com", "openrouter.ai", "router.requesty.ai", "requesty.ai"]);

function providerHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
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
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return { ok: true };
  return { ok: false, reason: "baseUrl must use https, or http only for loopback hosts (localhost, 127.x, ::1)" };
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
      && (!SUPPORTED_HOSTED_PROVIDER_HOSTS.has(hostname) || provider.apiKey.trim()),
  );
}

/**
 * Builds scoped provider headers without sending credentials to arbitrary hosts.
 * Credentials are limited to exact supported hosted hosts and loopback; this
 * function intentionally does not authorize hosted-provider subdomains.
 */
export function buildProviderHeaders(baseUrl: string, provider: ProviderSettings): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const hostname = providerHostname(baseUrl);
  if (!hostname) return headers;
  if (provider.apiKey.trim() && (SUPPORTED_HOSTED_PROVIDER_HOSTS.has(hostname) || isLoopbackHost(hostname))) {
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }
  if (hostname === "openrouter.ai") {
    if (provider.httpReferer.trim()) headers["HTTP-Referer"] = provider.httpReferer.trim();
    if (provider.appTitle.trim()) headers["X-Title"] = provider.appTitle.trim();
  }
  return headers;
}
