import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { applyCharacterProgressionInputSchema, characterProgressionHttpGrantXpRequestSchema, characterProgressionHttpGrantXpResponseSchema, resourceIdSchema, type ProgressionSelection, type ProgressionState, type ProgressionPreview } from "@velvet/contracts";
import {
  characterProgressionHttpPreviewRequestSchema,
  characterProgressionHttpStateResponseSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CharacterProgressionAuthorizationError,
  CharacterProgressionConflictError,
  CharacterProgressionStaleError,
  CharacterProgressionUnavailableError,
  type CharacterProgressionRepository,
} from "../../../repo/characterProgressionRepo.js";

const LOCAL_OWNER = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

export interface CharacterProgressionHttpOptions {
  /** Supplied by the application; this plugin never opens or constructs a repository. */
  characterProgressionRepositoryAccessor: () => Pick<CharacterProgressionRepository,
    "getCharacterProgression" | "previewCharacterProgression" | "grantCharacterXp" | "applyCharacterProgression">;
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

function stateProjection(state: ProgressionState) {
  return {
    campaignId: state.campaignId, campaignCharacterId: state.campaignCharacterId, profile: state.profile,
    classRef: state.classRef, level: state.level, totalXp: state.totalXp, milestoneCount: state.milestoneCount,
    revision: state.revision, pendingChoices: state.pendingChoices, knownAbilities: state.knownAbilities,
    knownSpells: state.knownSpells, derived: state.derived, updatedAt: state.updatedAt,
  };
}

function previewProjection(preview: ProgressionPreview, campaignId: string) {
  return { campaignId, campaignCharacterId: preview.campaignCharacterId, previewRevision: preview.revision, previewToken: preview.token, mode: preview.mode,
    currentLevel: preview.currentLevel, eligibleLevel: preview.eligibleLevel, totalXp: preview.totalXp,
    milestoneCount: preview.milestoneCount, pendingChoices: preview.pendingChoices, levels: preview.levels };
}

function applyProjection(result: ReturnType<CharacterProgressionRepository["applyCharacterProgression"]>) {
  return {
    progression: stateProjection(result.progression),
    receipt: {
      campaignCharacterId: result.receipt.campaignCharacterId, idempotencyKey: result.receipt.idempotencyKey, type: result.receipt.type,
      revisionBefore: result.receipt.revisionBefore, revisionAfter: result.receipt.revisionAfter,
      occurredAt: result.receipt.occurredAt, appliedLevels: result.receipt.appliedLevels,
    },
  };
}

function failure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], status: 404 | 500) {
  // Authorization, unavailable characters, and provenance failures are intentionally
  // indistinguishable to callers. Never serialize repository exception text.
  return sendApiProblem(request, reply, status, status === 404 ? "RPG_CHARACTER_PROGRESSION_NOT_FOUND" : "RPG_INTERNAL_ERROR",
    status === 404 ? "Character progression not found" : "Character progression could not be loaded");
}

function mapFailure(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof CharacterProgressionAuthorizationError
    || error instanceof CharacterProgressionUnavailableError) {
    return failure(request, reply, 404);
  }
  if (error instanceof CharacterProgressionStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_CHARACTER_PROGRESSION_STALE",
      "Character progression is stale; refresh before trying again");
  }
  if (error instanceof CharacterProgressionConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_CHARACTER_PROGRESSION_CONFLICT",
      "Character progression conflicts with current state");
  }
  return failure(request, reply, 500);
}

export const characterProgressionRoutes: FastifyPluginAsync<CharacterProgressionHttpOptions> = async (app, options) => {
  const guard = async (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1]) => {
    reply.header("cache-control", "no-store");
    const flags = readRpgFeatureFlags();
    if (!flags.campaign || !flags.mechanics) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      return false;
    }
    if (invalidQuery(request)) {
      await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Character progression does not accept query parameters");
      return false;
    }
    return true;
  };

  app.get<{ Params: { campaignId: string; campaignCharacterId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/characters/:campaignCharacterId/progression", { exposeHeadRoute: false }, async (request, reply) => {
      if (!(await guard(request, reply))) return;
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const characterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
      if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      if (!characterId.success) return sendApiProblem(request, reply, 404, "RPG_CHARACTER_NOT_FOUND", "Character not found");
      try {
        const repository = options.characterProgressionRepositoryAccessor();
        const state = repository.getCharacterProgression(LOCAL_OWNER, characterId.data);
        if (!state || state.campaignId !== campaignId.data || state.campaignCharacterId !== characterId.data) return failure(request, reply, 404);
        return reply.code(200).send(characterProgressionHttpStateResponseSchema.parse({ progression: stateProjection(state) }));
      } catch (error) { return mapFailure(request, reply, error); }
    });

  app.post<{ Params: { campaignId: string; campaignCharacterId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/characters/:campaignCharacterId/progression/preview", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Progression preview requires application/json");
          return;
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Progression preview request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const characterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
      if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      if (!characterId.success) return sendApiProblem(request, reply, 404, "RPG_CHARACTER_NOT_FOUND", "Character not found");
      const body = characterProgressionHttpPreviewRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Progression preview request is invalid");
      try {
        // Existing repository API has separate read methods. Read state first to bind
        // campaign and character; a future snapshot API can make this one boundary.
        const repository = options.characterProgressionRepositoryAccessor();
        const state = repository.getCharacterProgression(LOCAL_OWNER, characterId.data);
        if (!state || state.campaignId !== campaignId.data || state.campaignCharacterId !== characterId.data) return failure(request, reply, 404);
        const preview = repository.previewCharacterProgression(LOCAL_OWNER, characterId.data, body.data.selections as ProgressionSelection[]);
        if (!preview || preview.campaignCharacterId !== characterId.data) return failure(request, reply, 404);
        return reply.code(200).send({ preview: previewProjection(preview, campaignId.data) });
      } catch (error) { return mapFailure(request, reply, error); }
    });

  app.post<{ Params: { campaignId: string; campaignCharacterId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/characters/:campaignCharacterId/xp-commands", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "XP command requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "XP command request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const characterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
      if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      if (!characterId.success) return sendApiProblem(request, reply, 404, "RPG_CHARACTER_NOT_FOUND", "Character not found");
      const body = characterProgressionHttpGrantXpRequestSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "XP command request is invalid");
      try {
        const repository = options.characterProgressionRepositoryAccessor();
        const state = repository.getCharacterProgression(LOCAL_OWNER, characterId.data);
        if (!state || state.campaignId !== campaignId.data || state.campaignCharacterId !== characterId.data) return failure(request, reply, 404);
        const result = repository.grantCharacterXp(LOCAL_OWNER, characterId.data, body.data);
        if (result.progression.campaignId !== campaignId.data || result.progression.campaignCharacterId !== characterId.data) {
          return failure(request, reply, 404);
        }
        return reply.code(200).send(characterProgressionHttpGrantXpResponseSchema.parse(applyProjection(result)));
      } catch (error) { return mapFailure(request, reply, error); }
    });

  app.post<{ Params: { campaignId: string; campaignCharacterId: string }; Querystring: Record<string, unknown>; Body: unknown }>(
    "/campaigns/:campaignId/characters/:campaignCharacterId/progression/apply", {
      exposeHeadRoute: false,
      onRequest: async (request, reply) => {
        if (!(await guard(request, reply))) return;
        const contentType = request.headers["content-type"];
        if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
          await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Progression apply requires application/json");
        }
      },
      errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Progression apply request is invalid"),
    }, async (request, reply) => {
      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const characterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
      if (!campaignId.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      if (!characterId.success) return sendApiProblem(request, reply, 404, "RPG_CHARACTER_NOT_FOUND", "Character not found");
      const body = applyCharacterProgressionInputSchema.safeParse(request.body);
      if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Progression apply request is invalid");
      try {
        const repository = options.characterProgressionRepositoryAccessor();
        const state = repository.getCharacterProgression(LOCAL_OWNER, characterId.data);
        if (!state || state.campaignId !== campaignId.data || state.campaignCharacterId !== characterId.data) return failure(request, reply, 404);
        const result = repository.applyCharacterProgression(LOCAL_OWNER, characterId.data, body.data);
        if (result.progression.campaignId !== campaignId.data || result.progression.campaignCharacterId !== characterId.data) {
          return failure(request, reply, 404);
        }
        return reply.code(200).send(applyProjection(result));
      } catch (error) { return mapFailure(request, reply, error); }
    });
};
