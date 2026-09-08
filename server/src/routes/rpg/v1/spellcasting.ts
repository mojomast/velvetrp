import { castSpellCommandRequestSchema, castSpellCommandResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { ActorPowerConflictError, M16AuthorizationError, M16ConflictError, M16StaleError, SpellcastingComponentError, SpellcastingRangeError, SpellcastingUnavailableError, type SpellcastingRepository } from "../../../repo/index.js";

const JSON_TYPE = /^application\/json(?:\s*;.*)?$/i;
export interface SpellcastingHttpOptions { spellcastingRepositoryAccessor: () => Pick<SpellcastingRepository, "castSpell">; }
const missing = (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => sendApiProblem(request, reply, 404, "RPG_SPELL_NOT_FOUND", "Spellcasting unavailable");

export const spellcastingHttpRoutes: FastifyPluginAsync<SpellcastingHttpOptions> = async (app, options) => {
  app.post<{ Params: { actorId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/actors/:actorId/spell-commands", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    const actorId = resourceIdSchema.safeParse(request.params.actorId);
    if (!actorId.success) return missing(request, reply);
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length || typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"]))
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Spell command requires JSON without query parameters");
    const body = castSpellCommandRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Spell command is invalid");
    try {
      const result = options.spellcastingRepositoryAccessor().castSpell("local-owner", actorId.data, body.data);
      return reply.send(castSpellCommandResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof SpellcastingUnavailableError || error instanceof M16AuthorizationError) return missing(request, reply);
      if (error instanceof SpellcastingRangeError) return sendApiProblem(request, reply, 409, "RPG_SPELL_OUT_OF_RANGE", "Spell target is out of range or blocked");
      if (error instanceof SpellcastingComponentError || error instanceof ActorPowerConflictError || error instanceof M16ConflictError) return sendApiProblem(request, reply, 409, "RPG_SPELL_CONFLICT", "Spell is not legal in the current state");
      if (error instanceof M16StaleError) return sendApiProblem(request, reply, 409, "RPG_SPELL_STALE", "Spellcasting state is stale; refresh before retrying");
      request.log.error({ operation: "spell-command", method: request.method, route: request.routeOptions.url }, "RPG spell command failed");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Spell outcome could not be confirmed");
    }
  });
};
