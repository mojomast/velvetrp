import type { FastifyPluginAsync } from "fastify";
import { checkUserMessage, sanitizeInjectionText } from "../../policy.js";
import { getHarnessSettings, updateHarnessSettings } from "../../repo/index.js";
import type { UpdateHarnessInput } from "../../types.js";

export const roleplayHarnessRoutes: FastifyPluginAsync = async (app) => {
  app.get("/harness", async () => {
    return getHarnessSettings();
  });

  app.put("/harness", async (request, reply) => {
    const body = request.body as Partial<UpdateHarnessInput> | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "harness patch is required" });
    }
    const textFields = ["systemPrompt", "personaPreamble", "styleGuide", "postHistoryInstructions"] as const;
    const violations: string[] = [];
    const sanitized: Partial<UpdateHarnessInput> = { ...body };
    for (const field of textFields) {
      const value = body[field];
      if (typeof value === "string" && value.trim() !== "") {
        const clean = sanitizeInjectionText(value);
        const check = checkUserMessage(clean);
        if (!check.allowed) {
          violations.push(...check.violations.map((v) => `harness.${field} ${v}`));
        } else {
          sanitized[field] = clean;
        }
      }
    }
    if (violations.length > 0) {
      return reply.code(422).send({ error: "policy violation", violations });
    }
    return updateHarnessSettings(sanitized);
  });
};
