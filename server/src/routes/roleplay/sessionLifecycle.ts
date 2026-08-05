import type { FastifyPluginAsync } from "fastify";
import { deleteSession, getSession, stopSession } from "../../repo/index.js";

export interface RoleplaySessionLifecycleRoutesOptions {
  abortActiveGeneration: (sessionId: string) => void;
}

export const roleplaySessionLifecycleRoutes: FastifyPluginAsync<RoleplaySessionLifecycleRoutesOptions> = async (app, options) => {
  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    options.abortActiveGeneration(session.id);
    await deleteSession(session.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const existing = await getSession(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "session not found" });
    }
    options.abortActiveGeneration(existing.id);
    const session = await stopSession(existing.id, "user-stop");
    return session;
  });
};
