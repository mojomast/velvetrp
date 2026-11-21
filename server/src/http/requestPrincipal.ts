import { createHmac, timingSafeEqual } from "node:crypto";
import { campaignRoleSchema, resourceIdSchema, type CampaignRole } from "@velvet/contracts";
import type { FastifyRequest } from "fastify";

/** Cookie carrying the signed session principal for multiplayer invites. */
export const SESSION_COOKIE_NAME = "velvet_session";

/** The trusted single-user principal used when no signed session is present. */
export const LOCAL_OWNER_PRINCIPAL_ID = "local-owner";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const REMOTE_AUTH_MODE = "remote";

function sessionSecret(): string | null {
  const secret = process.env.VELVET_SESSION_SECRET;
  return secret !== undefined && secret.trim() !== "" ? secret : null;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function principalFromSessionCookie(value: string): string | null {
  const secret = sessionSecret();
  if (secret === null) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;
  const payload = value.slice(0, separator);
  const presented = value.slice(separator + 1);
  const expected = sign(payload, secret);
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length) return null;
  if (!timingSafeEqual(presentedBytes, expectedBytes)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const principal = resourceIdSchema.safeParse(decoded);
  return principal.success ? principal.data : null;
}

/**
 * Resolves the acting principal from a signed `velvet_session` cookie.
 * Without a valid cookie the trusted local single-user principal remains the
 * default unless remote authentication is required, in which case the caller
 * must respond with 401.
 */
export function getRequestPrincipal(request: FastifyRequest): string | null {
  const cookie = readCookie(request, SESSION_COOKIE_NAME);
  if (cookie !== null) {
    const principalId = principalFromSessionCookie(cookie);
    if (principalId !== null) return principalId;
  }
  return process.env.VELVET_AUTH_MODE === REMOTE_AUTH_MODE ? null : LOCAL_OWNER_PRINCIPAL_ID;
}

/** Serializes the signed, httpOnly session cookie issued after invite redemption. */
export function createSessionCookie(principalId: string): string {
  const secret = sessionSecret();
  if (secret === null) throw new Error("VELVET_SESSION_SECRET is required to issue a session cookie");
  const parsed = resourceIdSchema.parse(principalId);
  const payload = Buffer.from(parsed, "utf8").toString("base64url");
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_MAX_AGE_SECONDS}`];
  if (process.env.VELVET_AUTH_MODE === REMOTE_AUTH_MODE) attributes.push("Secure");
  return `${SESSION_COOKIE_NAME}=${payload}.${sign(payload, secret)}; ${attributes.join("; ")}`;
}

/**
 * Resolves the campaign role of a principal. The trusted local principal is the
 * campaign owner; other principals are looked up through the caller's
 * membership read lane when one is available.
 */
export function resolveCampaignActorRole(
  principalId: string,
  campaignId: string,
  listCampaignMemberships?: (principalId: string, campaignId: string) => unknown,
): CampaignRole | null {
  if (principalId === LOCAL_OWNER_PRINCIPAL_ID) return "owner";
  if (listCampaignMemberships === undefined) return null;
  let memberships: unknown;
  try {
    memberships = listCampaignMemberships(principalId, campaignId);
  } catch {
    return null;
  }
  if (!Array.isArray(memberships)) return null;
  for (const membership of memberships) {
    if (typeof membership !== "object" || membership === null) continue;
    const candidate = membership as { principalId?: unknown; role?: unknown };
    if (candidate.principalId !== principalId) continue;
    const role = campaignRoleSchema.safeParse(candidate.role);
    if (role.success) return role.data;
  }
  return null;
}
