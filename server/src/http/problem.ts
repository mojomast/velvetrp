import { apiProblemSchema } from "@velvet/contracts";
import type { ApiProblem, ApiProblemIssue } from "@velvet/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

const TITLES: Record<number, string> = {
  400: "Invalid request",
  401: "Authentication required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  415: "Unsupported media type",
  422: "Unprocessable request",
  500: "Internal server error",
  503: "Service unavailable",
};

interface ProblemOptions {
  violations?: string[];
  issues?: ApiProblemIssue[];
  /** A reviewed, non-sensitive request target for pre-routing failures. */
  instance?: string;
}

function safeProblemInstance(requestTarget: string): string {
  const queryIndex = requestTarget.indexOf("?");
  const path = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  const campaignPrefix = "/api/rpg/v1/campaigns/";
  if (path === "/api/rpg/v1/content-packs" || path === "/api/rpg/v1/content-packs/validate") return path;
  if (/^\/api\/rpg\/v1\/content-packs\/[^/]+\/versions\/[^/]+$/.test(path)) {
    return "/api/rpg/v1/content-packs/:packId/versions/:packVersion";
  }
  if (!path.startsWith(campaignPrefix)) return path;

  const remainder = path.slice(campaignPrefix.length);
  if (remainder.length === 0) return path;
  const suffixIndex = remainder.indexOf("/");
  if (suffixIndex === -1) return `${campaignPrefix}:campaignId`;

  const suffix = remainder.slice(suffixIndex);
  if (suffix === "/starter-setup"
    || suffix === "/mechanics-starter-setup"
    || suffix === "/characters"
    || suffix === "/characters/creation-options"
    || suffix === "/rooms"
    || suffix === "/memberships"
    || suffix === "/dice-rolls") {
    return `${campaignPrefix}:campaignId${suffix}`;
  }
  if (suffix === "/administration" || suffix === "/character-drafts") {
    return `${campaignPrefix}:campaignId${suffix}`;
  }
  if (suffix === "/content") return `${campaignPrefix}:campaignId/content`;
  if (/^\/content-packs\/[^/]+\/versions\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/content-packs/:packId/versions/:packVersion`;
  }
  if (suffix === "/timelines" || suffix === "/events" || suffix === "/checkpoints"
    || suffix === "/timeline-forks" || suffix === "/recaps") {
    return `${campaignPrefix}:campaignId${suffix}`;
  }
  if (/^\/commands\/[^/]+\/receipt$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/commands/:commandId/receipt`;
  }
  if (/^\/memberships\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/memberships/:principalId`;
  }
  if (/^\/rooms\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/rooms/:sessionId`;
  }
  if (suffix === "/storylines" || suffix === "/quests") {
    return `${campaignPrefix}:campaignId${suffix}`;
  }
  if (/^\/storylines\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/storylines/:storylineId`;
  }
  if (/^\/storylines\/[^/]+\/status$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/storylines/:storylineId/status`;
  }
  if (/^\/quests\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId`;
  }
  if (/^\/quests\/[^/]+\/status$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/status`;
  }
  if (/^\/quests\/[^/]+\/clues$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/clues`;
  }
  if (/^\/quests\/[^/]+\/clues\/[^/]+\/discover$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/clues/:clueId/discover`;
  }
  if (/^\/quests\/[^/]+\/rewards$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/rewards`;
  }
  if (/^\/quests\/[^/]+\/rewards\/[^/]+\/grant$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/rewards/:rewardId/grant`;
  }
  if (/^\/quests\/[^/]+\/objectives$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/quests/:questId/objectives`;
  }
  if (/^\/character-drafts\/[^/]+$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/character-drafts/:draftId`;
  }
  if (/^\/character-drafts\/[^/]+\/finalize$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/character-drafts/:draftId/finalize`;
  }
  if (/^\/characters\/[^/]+\/progression$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/progression`;
  }
  if (/^\/characters\/[^/]+\/progression\/preview$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/progression/preview`;
  }
  if (/^\/characters\/[^/]+\/progression\/apply$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/progression/apply`;
  }
  if (/^\/characters\/[^/]+\/xp-commands$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/xp-commands`;
  }
  if (/^\/characters\/[^/]+\/workspace$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/workspace`;
  }
  if (/^\/characters\/[^/]+\/sheet$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/sheet`;
  }
  // Unknown/lookalike suffixes are caller-controlled too. Retain only enough
  // context to identify this as a nested campaign resource.
  return `${campaignPrefix}:campaignId/*`;
}

export function createApiProblem(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  options: ProblemOptions = {},
): ApiProblem {
  const { instance, ...additionalFields } = options;
  return apiProblemSchema.parse({
    type: `https://velvet.local/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: TITLES[status] ?? "Request failed",
    status,
    detail,
    // Campaign IDs and unknown suffixes are caller-controlled resource data.
    // Preserve the string-valued contract using route-template context only.
    instance: safeProblemInstance(instance ?? request.url),
    code,
    requestId: request.id,
    error: detail,
    ...additionalFields,
  });
}

export function sendApiProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  options?: ProblemOptions,
): FastifyReply {
  const problem = createApiProblem(request, status, code, detail, options);
  // Pre-routing failures and uncommon methods can bypass ordinary hooks.
  reply.raw.setHeader("x-request-id", request.id);
  return reply.type("application/problem+json").code(status).send(problem);
}
