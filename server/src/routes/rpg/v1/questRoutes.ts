import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  completeQuestObjectiveRequestSchema,
  completeQuestObjectiveResponseSchema,
  createQuestClueRequestSchema,
  createQuestClueResponseSchema,
  createQuestRequestSchema,
  createQuestResponseSchema,
  createQuestRewardRequestSchema,
  createQuestRewardResponseSchema,
  createStorylineRequestSchema,
  createStorylineResponseSchema,
  discoverQuestClueRequestSchema,
  discoverQuestClueResponseSchema,
  grantQuestRewardRequestSchema,
  grantQuestRewardResponseSchema,
  listQuestsQuerySchema,
  listQuestsResponseSchema,
  questDetailResponseSchema,
  resourceIdSchema,
  StorylineSchema,
  updateQuestStatusRequestSchema,
  updateQuestStatusResponseSchema,
  updateStorylineStatusRequestSchema,
  updateStorylineStatusResponseSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import { QuestUnavailableError, type QuestRepository } from "../../../repo/questRepo.js";

const LOCAL_OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const listStorylinesResponseSchema = z.object({ storylines: z.array(StorylineSchema) }).strict();

export interface QuestHttpRoutesOptions {
  questRepositoryAccessor: () => Pick<QuestRepository,
    "listStorylines" | "createStoryline" | "getStoryline" | "updateStoryline" | "listQuests" | "createQuest"
    | "getQuestDetail" | "updateQuest" | "createClue" | "markClueDiscovered" | "createReward" | "grantReward"
    | "completeObjective">;
}

function problem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  return sendApiProblem(request, reply, status, code, detail);
}

function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
}

function failure(request: FastifyRequest, reply: FastifyReply, error: unknown, operation: string) {
  if (error instanceof QuestUnavailableError) return unavailable(request, reply);
  request.log.error({ operation }, "quest operation failed");
  return problem(request, reply, 500, "RPG_INTERNAL_ERROR", "Quest resource could not be processed");
}

function queryPresent(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?");
}

function before(request: FastifyRequest, reply: FastifyReply, mutation: boolean, allowsQuestQuery = false): boolean {
  reply.header("cache-control", "no-store");
  if (!readRpgFeatureFlags().campaign) {
    void problem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    return false;
  }
  const query = request.query as Record<string, unknown>;
  if ((!allowsQuestQuery && queryPresent(request)) || (allowsQuestQuery && !listQuestsQuerySchema.safeParse(query).success)) {
    void problem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest request has invalid query parameters");
    return false;
  }
  const params = request.params as Record<string, unknown>;
  if (Object.values(params).some((value) => !resourceIdSchema.safeParse(value).success)) {
    void unavailable(request, reply);
    return false;
  }
  if (mutation) {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_TYPE.test(contentType)) {
      void problem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Quest mutation requires application/json");
      return false;
    }
  }
  return true;
}

function invalid(request: FastifyRequest, reply: FastifyReply) {
  return problem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest request is invalid");
}

export const questHttpRoutes: FastifyPluginAsync<QuestHttpRoutesOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/storylines", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, false); },
  }, async (request, reply) => {
    try {
      const storylines = await options.questRepositoryAccessor().listStorylines(request.params.campaignId);
      const response = listStorylinesResponseSchema.parse({ storylines });
      if (response.storylines.some((storyline) => storyline.campaignId !== request.params.campaignId)) throw new Error("wrong storyline list");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-storyline-list"); }
  });

  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/storylines", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = createStorylineRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const storyline = await options.questRepositoryAccessor().createStoryline(request.params.campaignId, {
        title: body.data.title,
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.status === undefined ? {} : { status: body.data.status }),
      });
      const response = createStorylineResponseSchema.parse({ storyline });
      if (response.storyline.campaignId !== request.params.campaignId) throw new Error("wrong campaign");
      return reply.code(201).send(response);
    } catch (error) { return failure(request, reply, error, "quest-storyline-create"); }
  });

  app.get<{ Params: { campaignId: string; storylineId: string } }>("/campaigns/:campaignId/storylines/:storylineId", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, false); },
  }, async (request, reply) => {
    try {
      const storyline = await options.questRepositoryAccessor().getStoryline(request.params.campaignId, request.params.storylineId);
      if (storyline === null) return unavailable(request, reply);
      const response = createStorylineResponseSchema.parse({ storyline });
      if (response.storyline.campaignId !== request.params.campaignId || response.storyline.id !== request.params.storylineId) throw new Error("wrong storyline");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-storyline-detail"); }
  });

  app.patch<{ Params: { campaignId: string; storylineId: string }; Body: unknown }>("/campaigns/:campaignId/storylines/:storylineId/status", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = updateStorylineStatusRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const storyline = await options.questRepositoryAccessor().updateStoryline(request.params.campaignId, request.params.storylineId, body.data);
      const response = updateStorylineStatusResponseSchema.parse({ storyline });
      if (response.storyline.campaignId !== request.params.campaignId || response.storyline.id !== request.params.storylineId) throw new Error("wrong storyline");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-storyline-status-update"); }
  });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/quests", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, false, true); },
  }, async (request, reply) => {
    const query = listQuestsQuerySchema.safeParse(request.query);
    if (!query.success) return invalid(request, reply);
    try {
      const quests = await options.questRepositoryAccessor().listQuests(request.params.campaignId, query.data.storylineId);
      const response = listQuestsResponseSchema.parse({ quests });
      if (response.quests.some((quest) => quest.campaignId !== request.params.campaignId
        || (query.data.storylineId !== undefined && quest.storylineId !== query.data.storylineId))) throw new Error("wrong quest list");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-list"); }
  });

  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/quests", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = createQuestRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const quest = await options.questRepositoryAccessor().createQuest(request.params.campaignId, body.data.storylineId, {
        title: body.data.title,
        ...(body.data.description === undefined ? {} : { description: body.data.description }),
        ...(body.data.status === undefined ? {} : { status: body.data.status }),
        ...(body.data.sortOrder === undefined ? {} : { sortOrder: body.data.sortOrder }),
      });
      const response = createQuestResponseSchema.parse({ quest });
      if (response.quest.campaignId !== request.params.campaignId || response.quest.storylineId !== body.data.storylineId) throw new Error("wrong quest");
      return reply.code(201).send(response);
    } catch (error) { return failure(request, reply, error, "quest-create"); }
  });

  app.get<{ Params: { campaignId: string; questId: string } }>("/campaigns/:campaignId/quests/:questId", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, false); },
  }, async (request, reply) => {
    try {
      const detail = await options.questRepositoryAccessor().getQuestDetail(request.params.campaignId, request.params.questId);
      if (detail === null) return unavailable(request, reply);
      const response = questDetailResponseSchema.parse(detail);
      if (response.quest.campaignId !== request.params.campaignId || response.quest.id !== request.params.questId
        || response.clues.some((clue) => clue.campaignId !== request.params.campaignId || clue.questId !== request.params.questId)
        || response.rewards.some((reward) => reward.campaignId !== request.params.campaignId || reward.questId !== request.params.questId)
        || response.objectiveCompletions.some((objective) => objective.questId !== request.params.questId)) throw new Error("wrong quest detail");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-detail"); }
  });

  app.patch<{ Params: { campaignId: string; questId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/status", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = updateQuestStatusRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const quest = await options.questRepositoryAccessor().updateQuest(request.params.campaignId, request.params.questId, body.data);
      const response = updateQuestStatusResponseSchema.parse({ quest });
      if (response.quest.campaignId !== request.params.campaignId || response.quest.id !== request.params.questId) throw new Error("wrong quest");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-status-update"); }
  });

  app.post<{ Params: { campaignId: string; questId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/clues", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = createQuestClueRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const clue = await options.questRepositoryAccessor().createClue(request.params.campaignId, request.params.questId, body.data.content, body.data.discoveredByCharacterId);
      const response = createQuestClueResponseSchema.parse({ clue });
      if (response.clue.campaignId !== request.params.campaignId || response.clue.questId !== request.params.questId) throw new Error("wrong clue");
      return reply.code(201).send(response);
    } catch (error) { return failure(request, reply, error, "quest-clue-create"); }
  });

  app.patch<{ Params: { campaignId: string; questId: string; clueId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/clues/:clueId/discover", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = discoverQuestClueRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const clue = await options.questRepositoryAccessor().markClueDiscovered(request.params.campaignId, request.params.questId, request.params.clueId, body.data.characterId);
      const response = discoverQuestClueResponseSchema.parse({ clue });
      if (response.clue.campaignId !== request.params.campaignId || response.clue.questId !== request.params.questId || response.clue.id !== request.params.clueId) throw new Error("wrong clue");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-clue-discover"); }
  });

  app.post<{ Params: { campaignId: string; questId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/rewards", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = createQuestRewardRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const reward = await options.questRepositoryAccessor().createReward(request.params.campaignId, request.params.questId, {
        kind: body.data.kind,
        label: body.data.label,
        ...(body.data.amount === undefined ? {} : { amount: body.data.amount }),
      });
      const response = createQuestRewardResponseSchema.parse({ reward });
      if (response.reward.campaignId !== request.params.campaignId || response.reward.questId !== request.params.questId) throw new Error("wrong reward");
      return reply.code(201).send(response);
    } catch (error) { return failure(request, reply, error, "quest-reward-create"); }
  });

  app.patch<{ Params: { campaignId: string; questId: string; rewardId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/rewards/:rewardId/grant", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = grantQuestRewardRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const reward = await options.questRepositoryAccessor().grantReward(request.params.campaignId, request.params.questId, request.params.rewardId, body.data.characterId);
      const response = grantQuestRewardResponseSchema.parse({ reward });
      if (response.reward.campaignId !== request.params.campaignId || response.reward.questId !== request.params.questId || response.reward.id !== request.params.rewardId) throw new Error("wrong reward");
      return reply.send(response);
    } catch (error) { return failure(request, reply, error, "quest-reward-grant"); }
  });

  app.post<{ Params: { campaignId: string; questId: string }; Body: unknown }>("/campaigns/:campaignId/quests/:questId/objectives", { exposeHeadRoute: false,
    onRequest: async (req, rep) => { before(req, rep, true); }, errorHandler: (_error, req, rep) => invalid(req, rep),
  }, async (request, reply) => {
    const body = completeQuestObjectiveRequestSchema.safeParse(request.body);
    if (!body.success) return invalid(request, reply);
    try {
      const objectiveCompletion = await options.questRepositoryAccessor().completeObjective(request.params.campaignId, request.params.questId, body.data.description, body.data.characterId);
      const response = completeQuestObjectiveResponseSchema.parse({ objectiveCompletion });
      if (response.objectiveCompletion.questId !== request.params.questId) throw new Error("wrong objective");
      return reply.code(201).send(response);
    } catch (error) { return failure(request, reply, error, "quest-objective-complete"); }
  });
};
