import type { FastifyPluginAsync } from "fastify";
import { buildSessionContextBasket } from "../../context.js";
import { selectLoreEntries } from "../../lore.js";
import {
  createSession,
  getActiveLeaf,
  getCharacter,
  getHarnessSettings,
  getMessage,
  getSession,
  getSessionContextSource,
  listApprovedMemories,
  listBranchChildren,
  listBranchMessages,
  listLoreEntries,
  listMessages,
  listSessions,
  updateSessionContextSource,
} from "../../repo.js";
import type { CreateSessionInput } from "../../types.js";

export const roleplaySessionRoutes: FastifyPluginAsync = async (app) => {
  app.post("/sessions", async (request, reply) => {
    const body = request.body as Partial<CreateSessionInput> | null;
    if (!body || typeof body !== "object") return reply.code(400).send({ error: "session input is required" });
    if (body.characterId !== undefined && typeof body.characterId !== "string") return reply.code(400).send({ error: "characterId must be a string" });
    if (body.characterIds !== undefined && (!Array.isArray(body.characterIds) || body.characterIds.some((id) => typeof id !== "string"))) return reply.code(400).send({ error: "characterIds must be an array of strings" });
    const characterIds = [...new Set(body.characterIds ?? (body.characterId ? [body.characterId] : []))];
    if (characterIds.length === 0) return reply.code(400).send({ error: "characterId or characterIds is required" });
    if (characterIds.length > 12) return reply.code(400).send({ error: "at most 12 participants are allowed" });
    const primaryCharacterId = body.primaryCharacterId ?? body.characterId ?? characterIds[0]!;
    if (!characterIds.includes(primaryCharacterId)) return reply.code(400).send({ error: "primaryCharacterId must be a participant" });
    if (body.presetId !== undefined && typeof body.presetId !== "string") {
      return reply.code(400).send({ error: "presetId must be a string" });
    }
    if (body.title !== undefined && typeof body.title !== "string") return reply.code(400).send({ error: "title must be a string" });
    for (const id of characterIds) if (!(await getCharacter(id))) return reply.code(404).send({ error: `character not found: ${id}` });
    const session = await createSession({
      characterId: primaryCharacterId,
      characterIds,
      primaryCharacterId,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.presetId !== undefined ? { presetId: body.presetId } : {}),
    });
    return reply.code(201).send(session);
  });

  app.post("/sessions/solo", async (request, reply) => {
    const body = request.body as { characterId?: unknown } | null;
    if (!body || typeof body.characterId !== "string" || body.characterId.trim() === "") {
      return reply.code(400).send({ error: "characterId is required" });
    }
    const character = await getCharacter(body.characterId);
    if (!character) return reply.code(404).send({ error: "character not found" });
    const existing = (await listSessions(character.id))
      .filter((candidate) => candidate.participants.length === 1 && candidate.participants[0]?.id === character.id && candidate.state !== "closed" && !candidate.stoppedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const session = existing ?? await createSession({ characterId: character.id });
    return { session, messages: await listMessages(session.id), created: !existing };
  });

  app.get<{ Querystring: { characterId?: string } }>("/sessions", async (request) => {
    return { sessions: await listSessions(request.query.characterId) };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { session, messages: await listMessages(session.id) };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/messages", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    return { messages: await listMessages(session.id) };
  });

  app.get<{ Params: { id: string; mid: string } }>("/sessions/:id/messages/:mid/siblings", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: "session not found" });
    }
    const message = await getMessage(session.id, request.params.mid);
    if (!message) {
      return reply.code(404).send({ error: "message not found" });
    }
    const siblings = await listBranchChildren(session.id, message.parentId);
    const leaf = await getActiveLeaf(session.id);
    let activeMessageId: string | null = null;
    if (leaf) {
      const siblingIds = new Set(siblings.map((sibling) => sibling.id));
      const branch = await listBranchMessages(session.id, leaf.id);
      activeMessageId = branch.find((entry) => siblingIds.has(entry.id))?.id ?? null;
    }
    return { siblings, activeMessageId, activeLeafId: leaf?.id ?? null };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/context", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const messages = await listMessages(session.id);
    const harness = await getHarnessSettings();
    const participantIds = session.participants.map((participant) => participant.id);
    const lore = selectLoreEntries(
      await listLoreEntries(participantIds), participantIds, messages.map((message) => message.content).join("\n"), harness.loreChars,
    );
    const memories = (await Promise.all(session.participants.map(async (participant) =>
      (await listApprovedMemories(participant.id, 3)).map((memory) => ({ characterName: participant.name, memory }))))).flat();
    return { context: buildSessionContextBasket(session, messages, memories, lore, await getSessionContextSource(session.id)) };
  });

  app.put<{ Params: { id: string }; Body: { sourceOfTruth?: unknown } }>("/sessions/:id/context", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    if (typeof request.body?.sourceOfTruth !== "string") return reply.code(400).send({ error: "sourceOfTruth must be a string" });
    const sourceOfTruth = request.body.sourceOfTruth.trim();
    if (sourceOfTruth.length > 8000) return reply.code(400).send({ error: "sourceOfTruth must be at most 8000 characters" });
    return { source: await updateSessionContextSource(session.id, sourceOfTruth) };
  });
};
