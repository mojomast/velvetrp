import type { FastifyPluginAsync } from "fastify";
import { validateProviderBaseUrl } from "../../llm.js";
import { checkUserMessage, sanitizeInjectionText } from "../../policy.js";
import { getPublicProviderSettings, updateProviderSettings } from "../../repo.js";
import type { UpdateProviderInput } from "../../types.js";

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
};
