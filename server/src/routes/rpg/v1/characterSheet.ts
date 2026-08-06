import { characterSheetHttpResponseSchema, resourceIdSchema } from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import type { CampaignCharacterSheetSnapshot } from "../../../repo/index.js";

const LOCAL_OWNER = "local-owner";

export interface CharacterSheetHttpOptions {
  /** Supplied by the application; this plugin never opens or constructs a repository. */
  characterSheetRepositoryAccessor: () => {
    getCampaignCharacterSheetSnapshot(
      actorPrincipalId: string,
      campaignId: string,
      campaignCharacterId: string,
    ): CampaignCharacterSheetSnapshot | null;
  };
}

function invalidQuery(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
}

export const characterSheetHttpRoutes: FastifyPluginAsync<CharacterSheetHttpOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string; campaignCharacterId: string }; Querystring: Record<string, unknown> }>(
    "/campaigns/:campaignId/characters/:campaignCharacterId/sheet", { exposeHeadRoute: false }, async (request, reply) => {
      reply.header("cache-control", "no-store");
      const flags = readRpgFeatureFlags();
      if (!flags.campaign || !flags.mechanics) {
        return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
      }
      if (invalidQuery(request)) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign character sheet does not accept query parameters");
      }

      const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
      const campaignCharacterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
      if (!campaignId.success || !campaignCharacterId.success) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_CHARACTER_NOT_FOUND", "Campaign character not found");
      }

      try {
        const snapshot = options.characterSheetRepositoryAccessor().getCampaignCharacterSheetSnapshot(
          LOCAL_OWNER, campaignId.data, campaignCharacterId.data,
        );
        if (snapshot === null) {
          return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_CHARACTER_NOT_FOUND", "Campaign character not found");
        }
        if (snapshot.campaignId !== campaignId.data || snapshot.campaignCharacterId !== campaignCharacterId.data
          || snapshot.progression.campaignId !== campaignId.data
          || snapshot.progression.campaignCharacterId !== campaignCharacterId.data) {
          throw new Error("campaign character sheet snapshot does not match the request");
        }
        return reply.code(200).send(characterSheetHttpResponseSchema.parse({
          sheet: snapshot.sheet,
          derived: snapshot.progression.derived,
          progression: {
            mode: snapshot.progression.profile.mode,
            level: snapshot.progression.level,
            totalXp: snapshot.progression.totalXp,
            milestoneCount: snapshot.progression.milestoneCount,
            updatedAt: snapshot.progression.updatedAt,
          },
        }));
      } catch {
        request.log.error({ operation: "campaign-character-sheet", method: request.method, route: request.routeOptions.url }, "RPG campaign operation failed");
        return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign character sheet could not be loaded");
      }
    },
  );
};
