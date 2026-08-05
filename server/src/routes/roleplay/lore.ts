import type { FastifyPluginAsync } from "fastify";
import { checkUserMessage, sanitizeInjectionText } from "../../policy.js";
import {
  createLoreEntry,
  deleteLoreEntry,
  getCharacter,
  getLoreEntry,
  listLoreEntries,
  updateLoreEntry,
} from "../../repo.js";
import type { NewLoreEntry } from "../../types.js";

export const roleplayLoreRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { characterId?: string } }>("/lore", async (request) => {
    return { lore: await listLoreEntries(request.query.characterId) };
  });

  app.post("/lore", async (request, reply) => {
    const body = request.body as Partial<NewLoreEntry> | null;
    if (!body || !Array.isArray(body.keys) || body.keys.some((key) => typeof key !== "string")) {
      return reply.code(400).send({ error: "keys must be an array of strings" });
    }
    if (typeof body.content !== "string" || body.content.trim() === "") {
      return reply.code(400).send({ error: "content is required" });
    }
    if (body.characterId !== null && body.characterId !== undefined && typeof body.characterId !== "string") {
      return reply.code(400).send({ error: "characterId must be a string or null" });
    }
    if (body.characterIds !== undefined && (!Array.isArray(body.characterIds) || body.characterIds.some((id) => typeof id !== "string"))) {
      return reply.code(400).send({ error: "characterIds must be an array of strings" });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    if (body.insertionOrder !== undefined && (typeof body.insertionOrder !== "number" || !Number.isFinite(body.insertionOrder))) return reply.code(400).send({ error: "insertionOrder must be a finite number" });
    const characterIds = [...new Set(body.characterIds ?? (body.characterId ? [body.characterId] : []))];
    for (const id of characterIds) {
      if (!(await getCharacter(id))) return reply.code(404).send({ error: `character not found: ${id}` });
    }
    const cleanContent = sanitizeInjectionText(body.content);
    const cleanKeys = body.keys.map((key) => sanitizeInjectionText(key).slice(0, 60));
    const policy = checkUserMessage([cleanContent, ...cleanKeys].join("\n"));
    if (!policy.allowed) {
      return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    }
    const entry = await createLoreEntry({
      characterId: characterIds[0] ?? null,
      characterIds,
      keys: cleanKeys,
      content: cleanContent,
      enabled: body.enabled ?? true,
      insertionOrder: typeof body.insertionOrder === "number" ? body.insertionOrder : 100,
    });
    return reply.code(201).send(entry);
  });

  app.patch<{ Params: { id: string } }>("/lore/:id", async (request, reply) => {
    const existing = await getLoreEntry(request.params.id);
    if (!existing) return reply.code(404).send({ error: "lore entry not found" });
    const body = request.body as Partial<NewLoreEntry> | null;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "lore patch is required" });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be a boolean" });
    if (body.insertionOrder !== undefined && (typeof body.insertionOrder !== "number" || !Number.isFinite(body.insertionOrder))) return reply.code(400).send({ error: "insertionOrder must be a finite number" });
    const keys = body.keys ?? existing.keys;
    const contentRaw = body.content ?? existing.content;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) return reply.code(400).send({ error: "keys must be an array of strings" });
    if (typeof contentRaw !== "string" || contentRaw.trim() === "") return reply.code(400).send({ error: "content is required" });
    const characterIds = [...new Set(body.characterIds ?? (body.characterId !== undefined ? (body.characterId ? [body.characterId] : []) : existing.characterIds))];
    if (characterIds.some((id) => typeof id !== "string")) return reply.code(400).send({ error: "characterIds must be an array of strings" });
    for (const id of characterIds) if (!(await getCharacter(id))) return reply.code(404).send({ error: `character not found: ${id}` });
    const content = sanitizeInjectionText(contentRaw);
    const cleanKeys = keys.map((key) => sanitizeInjectionText(key).slice(0, 60));
    const policy = checkUserMessage([content, ...cleanKeys].join("\n"));
    if (!policy.allowed) return reply.code(422).send({ error: "policy violation", violations: policy.violations });
    return updateLoreEntry(existing.id, {
      characterIds, characterId: characterIds[0] ?? null, keys: cleanKeys, content,
      enabled: body.enabled ?? existing.enabled, insertionOrder: body.insertionOrder ?? existing.insertionOrder,
    });
  });

  app.delete<{ Params: { id: string } }>("/lore/:id", async (request, reply) => {
    if (!(await deleteLoreEntry(request.params.id))) return reply.code(404).send({ error: "lore entry not found" });
    return { ok: true };
  });
};
