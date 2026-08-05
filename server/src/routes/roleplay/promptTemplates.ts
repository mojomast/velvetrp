import type { FastifyPluginAsync } from "fastify";
import { isPromptTemplateId, listPromptTemplates, validatePromptTemplate } from "../../promptTemplates.js";
import { getHarnessSettings, updateHarnessSettings } from "../../repo/index.js";

export const roleplayPromptTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.get("/prompt-templates", async () => {
    const harness = await getHarnessSettings();
    return { templates: listPromptTemplates(harness.promptOverrides) };
  });

  app.put<{ Params: { id: string } }>("/prompt-templates/:id", async (request, reply) => {
    if (!isPromptTemplateId(request.params.id)) return reply.code(404).send({ error: "prompt template not found" });
    const body = request.body as { template?: unknown } | null;
    if (!body || (body.template !== null && typeof body.template !== "string")) {
      return reply.code(400).send({ error: "template must be a string or null" });
    }
    if (typeof body.template === "string") {
      if (body.template.length > 64_000) return reply.code(400).send({ error: "template is too long" });
      const unknownPlaceholders = validatePromptTemplate(request.params.id, body.template);
      if (unknownPlaceholders.length > 0) return reply.code(400).send({ error: "unknown prompt placeholders", unknownPlaceholders });
    }
    const harness = await getHarnessSettings();
    const promptOverrides = { ...harness.promptOverrides };
    if (body.template === null) delete promptOverrides[request.params.id];
    else promptOverrides[request.params.id] = body.template;
    await updateHarnessSettings({ promptOverrides });
    return { templates: listPromptTemplates(promptOverrides) };
  });
};
