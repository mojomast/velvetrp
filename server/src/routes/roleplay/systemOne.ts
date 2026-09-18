import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { validateSystemOneBaseUrl } from "../../provider/providerTransport.js";
import {
  classifySystemOneFailure,
  completeWithSystemOne,
  type SystemOneFailure,
  type SystemOneQuestion,
} from "../../provider/systemOneCompletion.js";
import {
  getPublicSystemOneSettings,
  getSystemOneSettings,
  listRecentSystemOneDecisionsWithLaneCommits,
  summarizeSystemOneDecisions,
  updateSystemOneSettings,
  type SystemOneDecisionRecord,
} from "../../repo/index.js";
import type { UpdateSystemOneInput } from "../../types.js";

const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

const DECISIONS_DEFAULT_LIMIT = 50;
const DECISIONS_MAX_LIMIT = 200;
const DECISIONS_POSITIVE_INTEGER = /^\d+$/;

const hasOnlyLimitQuery = (request: FastifyRequest): boolean =>
  Object.keys(request.query as Record<string, unknown>).every((key) => key === "limit");

/** Privacy projection: never expose raw state, questions, answers, request, selection, or usage. */
function projectDecision(record: SystemOneDecisionRecord): {
  decisionId: string; lane: string; campaignId: string | null; sessionId: string | null; turnId: string | null;
  provider: string; model: string; confidencePolicyVersion: string;
  requestDigest: string; questionsDigest: string; stateDigest: string;
  confidenceBand: SystemOneDecisionRecord["confidenceBand"];
  fallbackUsed: boolean; shadow: boolean; committedByLane: boolean; latencyMs: number; createdAt: string;
} {
  return {
    decisionId: record.decisionId,
    lane: record.lane,
    campaignId: record.campaignId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    provider: record.provider,
    model: record.model,
    confidencePolicyVersion: record.confidencePolicyVersion,
    requestDigest: record.requestDigest,
    questionsDigest: record.questionsDigest,
    stateDigest: record.stateDigest,
    confidenceBand: record.confidenceBand,
    fallbackUsed: record.fallbackUsed,
    shadow: record.shadow,
    committedByLane: record.committedByLane === true,
    latencyMs: record.latencyMs,
    createdAt: record.createdAt,
  };
}

const PROBE_QUESTIONS: Record<string, SystemOneQuestion> = {
  reachable: { type: "noul", instructions: "Is this a reachable capability probe?" },
};

const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;

export const roleplaySystemOneRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/system-one", async () => getPublicSystemOneSettings());

  app.get("/provider/system-one/decisions", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!hasOnlyLimitQuery(request)) {
      return reply.code(400).send({ error: "system-one decisions does not accept query parameters other than limit" });
    }
    const rawLimit = (request.query as Record<string, unknown>).limit;
    let limit = DECISIONS_DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "string" || !DECISIONS_POSITIVE_INTEGER.test(rawLimit)) {
        return reply.code(400).send({ error: "limit must be a positive integer" });
      }
      const parsed = Number(rawLimit);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        return reply.code(400).send({ error: "limit is out of range" });
      }
      limit = Math.min(DECISIONS_MAX_LIMIT, parsed);
    }
    return reply.send({ decisions: listRecentSystemOneDecisionsWithLaneCommits(limit).map(projectDecision) });
  });

  app.get("/provider/system-one/decisions/summary", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.send(summarizeSystemOneDecisions());
  });

  app.put("/provider/system-one", async (request, reply) => {
    const body = request.body as Partial<UpdateSystemOneInput> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "system-one patch is required" });
    }
    if (typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
      const validation = validateSystemOneBaseUrl(body.baseUrl);
      if (!validation.ok) return reply.code(400).send({ error: "invalid baseUrl", reason: validation.reason });
    }
    return updateSystemOneSettings(body);
  });

  app.post("/provider/system-one/preflight", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (hasQuery(request)) { await reply.code(400).send({ error: "system-one preflight does not accept query parameters" }); return; }
      if (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"])) {
        await reply.code(415).send({ error: "system-one preflight requires application/json" });
      }
    },
  }, async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body as object).length !== 0) {
      return reply.code(400).send({ error: "system-one preflight body must be an empty object" });
    }
    const settings = await getSystemOneSettings();
    let result: { ok: true; model: string; latencyMs: number; requestId: string | null } | { ok: false; failure: SystemOneFailure };
    try {
      const answered = await completeWithSystemOne({
        settings,
        state: "capability probe",
        questions: PROBE_QUESTIONS,
        maxAttempts: 2,
      });
      result = {
        ok: true,
        model: answered.model.responseModel ?? settings.model,
        latencyMs: answered.provenance.latencyMs,
        requestId: answered.provenance.requestId,
      };
    } catch (error) {
      result = { ok: false, failure: classifySystemOneFailure(error) };
    }
    return reply.send({
      enabled: settings.enabled,
      configured: settings.apiKey.trim().length > 0,
      model: settings.model.trim() || "unconfigured",
      ...result,
    });
  });
};
