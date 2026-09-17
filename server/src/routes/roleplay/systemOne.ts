import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { validateSystemOneBaseUrl } from "../../provider/providerTransport.js";
import {
  classifySystemOneFailure,
  completeWithSystemOne,
  type SystemOneFailure,
  type SystemOneQuestion,
} from "../../provider/systemOneCompletion.js";
import { getPublicSystemOneSettings, getSystemOneSettings, updateSystemOneSettings } from "../../repo/index.js";
import type { UpdateSystemOneInput } from "../../types.js";

const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

const PROBE_QUESTIONS: Record<string, SystemOneQuestion> = {
  reachable: { type: "noul", instructions: "Is this a reachable capability probe?" },
};

const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;

export const roleplaySystemOneRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/system-one", async () => getPublicSystemOneSettings());

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
