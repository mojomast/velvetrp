const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type GuardEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface HostGuardProblem {
  statusCode: 403;
  code: "VELVET_HOST_NOT_ALLOWED" | "VELVET_ORIGIN_NOT_ALLOWED";
  message: string;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

export function isAllowedHostname(hostname: string, env: GuardEnv = process.env): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  if (LOOPBACK_HOSTNAMES.has(normalized)) return true;

  const configured = env.VELVET_ALLOWED_HOSTS ?? "";
  for (const rawEntry of configured.split(",")) {
    const entry = normalizeHostname(rawEntry);
    if (!entry) continue;
    if (entry.startsWith(".")) {
      const domain = entry.slice(1);
      if (!domain) continue;
      if (normalized === domain || normalized.endsWith(entry)) return true;
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function hostnameFromHostHeader(host: string): string | null {
  const trimmed = host.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? null : normalizeHostname(trimmed.slice(0, end + 1));
  }
  const colon = trimmed.indexOf(":");
  if (colon === -1) return normalizeHostname(trimmed);
  // Unbracketed IPv6 literals have more than one colon and no port suffix.
  if (trimmed.indexOf(":", colon + 1) !== -1) return normalizeHostname(trimmed);
  const hostname = trimmed.slice(0, colon);
  return hostname ? normalizeHostname(hostname) : null;
}

export function hostGuardProblem(
  method: string,
  headers: Record<string, string | string[] | undefined>,
  env: GuardEnv = process.env,
): HostGuardProblem | null {
  const hostHeader = readHeader(headers, "host");
  const hostname = hostHeader ? hostnameFromHostHeader(hostHeader) : null;
  if (!hostname || !isAllowedHostname(hostname, env)) {
    return {
      statusCode: 403,
      code: "VELVET_HOST_NOT_ALLOWED",
      message: "Host is not allowed",
    };
  }

  if (SAFE_METHODS.has(method.toUpperCase())) return null;

  const fetchSite = readHeader(headers, "sec-fetch-site");
  if (fetchSite && normalizeHostname(fetchSite) === "cross-site") {
    return {
      statusCode: 403,
      code: "VELVET_ORIGIN_NOT_ALLOWED",
      message: "Origin is not allowed",
    };
  }

  const origin = readHeader(headers, "origin");
  if (origin !== undefined) {
    let originHostname: string | null = null;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      originHostname = null;
    }
    if (!originHostname || !isAllowedHostname(originHostname, env)) {
      return {
        statusCode: 403,
        code: "VELVET_ORIGIN_NOT_ALLOWED",
        message: "Origin is not allowed",
      };
    }
  }

  return null;
}
