import type { FastifyPluginAsync } from "fastify";
import { deleteSession, getSession, stopSession } from "../../repo/index.js";
import { generationRegistry } from "./generationRegistry.js";

export interface RoleplaySessionLifecycleRoutesOptions {
  /** Test seam; production composition always uses the shared registry. */
  abortActiveGeneration?: (sessionId: string) => void;
}

export const roleplaySessionLifecycleRoutes: FastifyPluginAsync<RoleplaySessionLifecycleRoutesOptions> = async (app, options) => {
  const abortActiveGeneration = options.abortActiveGeneration ?? ((sessionId: string) => generationRegistry.abort(sessionId));

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = await getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    abortActiveGeneration(session.id);
    await deleteSession(session.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request, reply) => {
    const existing = await getSession(request.params.id);
    if (!existing) {
      return reply.code(404).send({ error: "session not found" });
    }
    abortActiveGeneration(existing.id);
    const session = await stopSession(existing.id, "user-stop");
    return session;
  });
};
