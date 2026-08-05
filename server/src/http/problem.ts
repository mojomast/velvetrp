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
  if (!path.startsWith(campaignPrefix)) return path;

  const remainder = path.slice(campaignPrefix.length);
  if (remainder.length === 0) return path;
  const suffixIndex = remainder.indexOf("/");
  if (suffixIndex === -1) return `${campaignPrefix}:campaignId`;

  const suffix = remainder.slice(suffixIndex);
  if (suffix === "/starter-setup"
    || suffix === "/characters"
    || suffix === "/characters/creation-options"
    || suffix === "/rooms"
    || suffix === "/dice-rolls") {
    return `${campaignPrefix}:campaignId${suffix}`;
  }
  if (/^\/characters\/[^/]+\/workspace$/.test(suffix)) {
    return `${campaignPrefix}:campaignId/characters/:campaignCharacterId/workspace`;
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
