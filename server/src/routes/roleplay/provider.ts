import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { validateProviderBaseUrl } from "../../llm.js";
import { checkUserMessage, sanitizeInjectionText } from "../../policy.js";
import { getPublicProviderSettings, updateProviderSettings } from "../../repo/index.js";
import type { UpdateProviderInput } from "../../types.js";
import { getPromptPreset } from "../../presets.js";
import { getHarnessSettings, getProviderSettings } from "../../repo/index.js";
import {
  ProviderCallerAbortError, ProviderConfigurationError, ProviderHttpError, ProviderProtocolError,
  ProviderResponseError, ProviderTimeoutError, ProviderTransportError, completeWithProvider,
} from "../../provider/openAiCompatibleCompletion.js";
import { classifyProviderFailure, runProviderCapabilityPreflight, type ProviderFailure } from "../../provider/capabilityPreflight.js";

const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

function classifyPreflightError(error: unknown): ProviderFailure {
  if (error instanceof ProviderCallerAbortError) return classifyProviderFailure({ callerAborted: true });
  if (error instanceof ProviderTimeoutError) return classifyProviderFailure({ timedOut: true });
  if (error instanceof ProviderTransportError) return classifyProviderFailure({ transportFailed: true });
  if (error instanceof ProviderProtocolError) return classifyProviderFailure({ protocolFailed: true });
  if (error instanceof ProviderConfigurationError) return classifyProviderFailure({ providerCode: "configuration" });
  if (error instanceof ProviderHttpError) return classifyProviderFailure({ httpStatus: error.status, retryAfter: error.retryAfter });
  if (error instanceof ProviderResponseError) return classifyProviderFailure({ providerCode: "provider-rejected" });
  return classifyProviderFailure({ protocolFailed: true });
}

const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;

export const roleplayProviderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider", async () => {
    return getPublicProviderSettings();
  });

  app.put("/provider", async (request, reply) => {
    const body = request.body as Partial<UpdateProviderInput> | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "provider patch is required" });
    }
    if (typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
      const validation = validateProviderBaseUrl(body.baseUrl);
      if (!validation.ok) {
        return reply.code(400).send({ error: "invalid baseUrl", reason: validation.reason });
      }
    }
    if (typeof body.httpReferer === "string" && body.httpReferer.trim() !== "") {
      const validation = validateProviderBaseUrl(body.httpReferer);
      if (!validation.ok) return reply.code(400).send({ error: "invalid httpReferer", reason: validation.reason });
    }
    const sanitized: Partial<UpdateProviderInput> = { ...body };
    if (typeof body.samplers?.startReplyWith === "string" && body.samplers.startReplyWith.trim() !== "") {
      const opening = sanitizeInjectionText(body.samplers.startReplyWith);
      const check = checkUserMessage(opening);
      if (!check.allowed) return reply.code(422).send({ error: "policy violation", violations: check.violations });
      sanitized.samplers = { ...body.samplers, startReplyWith: opening };
    }
    return updateProviderSettings(sanitized);
  });

  app.post("/provider/preflight", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (hasQuery(request)) { await reply.code(400).send({ error: "provider preflight does not accept query parameters" }); return; }
      if (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"])) {
        await reply.code(415).send({ error: "provider preflight requires application/json" });
      }
    },
  }, async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body as object).length !== 0) {
      return reply.code(400).send({ error: "provider preflight body must be an empty object" });
    }
    const [provider, harness] = await Promise.all([getProviderSettings(), getHarnessSettings()]);
    const result = await runProviderCapabilityPreflight({
      model: provider.model.trim() || "unconfigured",
      probe: async (probe, signal) => {
        try {
          const completed = await completeWithProvider({ provider, harness, preset: getPromptPreset("default"),
            messages: probe.messages, ...(probe.tools ? { tools: probe.tools } : {}),
            ...(probe.toolChoice ? { toolChoice: probe.toolChoice } : {}), ...(probe.jsonSchema ? { jsonSchema: probe.jsonSchema } : {}),
            promptVersion: "provider-capability-v1", schemaVersion: "provider-capability-v1", ...(signal ? { signal } : {}) });
          return { ok: true, result: completed };
        } catch (error) {
          return { ok: false, failure: classifyPreflightError(error) };
        }
      },
    });
    return reply.send({ model: provider.model.trim() || "unconfigured", ...result });
  });
};
