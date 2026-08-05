import type { FastifyPluginAsync } from "fastify";
import { checkUserMessage, sanitizeInjectionText } from "../../policy.js";
import {
  addMemoryFacts,
  forgetMemory,
  getCharacter,
  getMemory,
  listAllMemories,
  restoreMemory,
  updateMemory,
} from "../../repo.js";
import type { MemoryKind } from "../../types.js";

export const roleplayMemoryRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/characters/:id/memories", async (request, reply) => {
    const character = await getCharacter(request.params.id);
    if (!character) {
      return reply.code(404).send({ error: "character not found" });
    }
    return { memories: await listAllMemories(character.id) };
  });

  app.post<{ Params: { id: string } }>("/characters/:id/memories", async (request, reply) => {
    const character = await getCharacter(request.params.id);
    if (!character) return reply.code(404).send({ error: "character not found" });
    const body = request.body as Partial<{ content: string; kind: MemoryKind; userApproved: boolean }> | null;
    if (!body || typeof body.content !== "string" || body.content.trim() === "") {
      return reply.code(400).send({ error: "content is required" });
    }
    if (body.kind !== undefined && !["fact", "preference", "event"].includes(body.kind)) {
      return reply.code(400).send({ error: "kind must be fact, preference, or event" });
    }
    if (body.userApproved !== undefined && typeof body.userApproved !== "boolean") {
      return reply.code(400).send({ error: "userApproved must be a boolean" });
    }
    const content = sanitizeInjectionText(body.content).slice(0, 160).trim();
    if (!content) return reply.code(400).send({ error: "content is required" });
    const policy = checkUserMessage(content);
    if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    const [memory] = await addMemoryFacts(character.id, [{
      kind: body.kind ?? "fact", content, sourceTurnId: "manual", userApproved: body.userApproved ?? true,
    }]);
    return reply.code(201).send(memory);
  });

  app.patch<{ Params: { id: string } }>("/memories/:id", async (request, reply) => {
    const current = await getMemory(request.params.id);
    if (!current) return reply.code(404).send({ error: "memory not found" });
    const body = request.body as Partial<{ content: string; kind: MemoryKind; userApproved: boolean; forgottenAt: null }> | null;
    if (!body || typeof body !== "object" || Object.keys(body).length === 0) return reply.code(400).send({ error: "memory patch is required" });
    if (body.kind !== undefined && !["fact", "preference", "event"].includes(body.kind)) return reply.code(400).send({ error: "invalid kind" });
    if (body.userApproved !== undefined && typeof body.userApproved !== "boolean") return reply.code(400).send({ error: "userApproved must be a boolean" });
    if (body.forgottenAt !== undefined && body.forgottenAt !== null) return reply.code(400).send({ error: "forgottenAt may only be null to restore" });
    let content = body.content;
    if (content !== undefined) {
      if (typeof content !== "string" || content.trim() === "") return reply.code(400).send({ error: "content must not be empty" });
      content = sanitizeInjectionText(content).slice(0, 160).trim();
      const policy = checkUserMessage(content);
      if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    }
    return updateMemory(current.id, {
      ...(content !== undefined ? { content } : {}), ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.userApproved !== undefined ? { userApproved: body.userApproved } : {}),
      ...(body.forgottenAt === null ? { forgottenAt: null } : {}),
    });
  });

  app.post<{ Params: { id: string } }>("/memories/:id/restore", async (request, reply) => {
    const memory = await restoreMemory(request.params.id);
    return memory ?? reply.code(404).send({ error: "memory not found" });
  });

  app.delete<{ Params: { id: string } }>("/memories/:id", async (request, reply) => {
    const memory = await forgetMemory(request.params.id);
    if (!memory) {
      return reply.code(404).send({ error: "memory not found" });
    }
    return { ok: true, forgottenAt: memory.forgottenAt };
  });
};
