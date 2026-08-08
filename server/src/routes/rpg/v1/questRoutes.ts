import {
  campaignQuestsHttpResponseSchema,
  createStorylineRequestSchema,
  createStorylineResponseSchema,
  createCampaignQuestHttpRequestSchema,
  createCampaignQuestHttpResponseSchema,
  questCommandHttpRequestSchema,
  questCommandHttpResponseSchema,
  resourceIdSchema,
  StorylineSchema,
  updateStorylineStatusRequestSchema,
  updateStorylineStatusResponseSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  QuestAuthorizationError,
  QuestConflictError,
  QuestDomainUnavailableError,
  QuestStaleError,
  QuestUnavailableError,
  type QuestRepository,
} from "../../../repo/questRepo.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo = Pick<QuestRepository, "listCampaignQuests" | "createCampaignQuest" | "executeQuestCommand"
  | "listCampaignStorylines" | "createCampaignStoryline" | "getCampaignStoryline" | "updateCampaignStoryline">;
export interface QuestHttpRoutesOptions { questRepositoryAccessor: () => Repo }

const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; };
const missing = (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], quest = false) =>
  sendApiProblem(request, reply, 404, quest ? "RPG_QUEST_NOT_FOUND" : "RPG_CAMPAIGN_QUESTS_NOT_FOUND",
    quest ? "Quest not found" : "Campaign quests not found");
function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown, operation: string, quest = false) {
  if (error instanceof QuestAuthorizationError || error instanceof QuestDomainUnavailableError || error instanceof QuestUnavailableError) return missing(request, reply, quest);
  if (error instanceof QuestStaleError) return sendApiProblem(request, reply, 409, "RPG_QUEST_STALE", "Quest state is stale; refresh before trying again");
  if (error instanceof QuestConflictError) return sendApiProblem(request, reply, 409, "RPG_QUEST_CONFLICT", "Quest command conflicts with current state");
  request.log.error({ operation, method: request.method, route: request.routeOptions.url }, "RPG quest operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Quest outcome could not be confirmed; reconcile quest state before retrying and do not automatically retry");
}
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;

export const questHttpRoutes: FastifyPluginAsync<QuestHttpRoutesOptions> = async (app, options) => {
  const storylineListSchema = z.object({ storylines: z.array(StorylineSchema) }).strict();
  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/storylines", {
    exposeHeadRoute: false, onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign storylines do not accept query parameters"); },
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId); if (!campaignId.success) return missing(request, reply);
    try { const storylines = options.questRepositoryAccessor().listCampaignStorylines(OWNER, campaignId.data); if (storylines === null) return missing(request, reply);
      if (storylines.some((storyline) => storyline.campaignId !== campaignId.data)) throw new Error("storyline list binding is invalid");
      return reply.send(storylineListSchema.parse({ storylines })); } catch (error) { return fail(request, reply, error, "storyline-list"); } });

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/storylines", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) { await missing(request, reply); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Storyline creation requires application/json"); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation request is invalid"),
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId), body = createStorylineRequestSchema.safeParse(request.body);
    if (!campaignId.success) return missing(request, reply); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation request is invalid");
    try { const storyline = options.questRepositoryAccessor().createCampaignStoryline(OWNER, campaignId.data, { title: body.data.title,
      ...(body.data.description === undefined ? {} : { description: body.data.description }),
      ...(body.data.status === undefined ? {} : { status: body.data.status }) });
      if (storyline.campaignId !== campaignId.data) throw new Error("storyline creation binding is invalid");
      return reply.code(201).send(createStorylineResponseSchema.parse({ storyline })); } catch (error) { return fail(request, reply, error, "storyline-create"); } });

  app.get<{ Params: { campaignId: string; storylineId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/storylines/:storylineId", {
    exposeHeadRoute: false, onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline detail does not accept query parameters"); },
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId), storylineId = resourceIdSchema.safeParse(request.params.storylineId);
    if (!campaignId.success || !storylineId.success) return missing(request, reply);
    try { const storyline = options.questRepositoryAccessor().getCampaignStoryline(OWNER, campaignId.data, storylineId.data); if (storyline === null) return missing(request, reply);
      if (storyline.campaignId !== campaignId.data || storyline.id !== storylineId.data) throw new Error("storyline detail binding is invalid");
      return reply.send(createStorylineResponseSchema.parse({ storyline })); } catch (error) { return fail(request, reply, error, "storyline-detail"); } });

  app.patch<{ Params: { campaignId: string; storylineId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/storylines/:storylineId/status", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline status does not accept query parameters"); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Storyline status requires application/json"); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline status request is invalid"),
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId), storylineId = resourceIdSchema.safeParse(request.params.storylineId), body = updateStorylineStatusRequestSchema.safeParse(request.body);
    if (!campaignId.success || !storylineId.success) return missing(request, reply); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline status request is invalid");
    try { const storyline = options.questRepositoryAccessor().updateCampaignStoryline(OWNER, campaignId.data, storylineId.data, body.data);
      if (storyline.campaignId !== campaignId.data || storyline.id !== storylineId.data) throw new Error("storyline status binding is invalid");
      return reply.send(updateStorylineStatusResponseSchema.parse({ storyline })); } catch (error) { return fail(request, reply, error, "storyline-status"); } });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/quests", {
    exposeHeadRoute: false, onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign quests do not accept query parameters");
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId); if (!campaignId.success) return missing(request, reply);
    try {
      const result = options.questRepositoryAccessor().listCampaignQuests(OWNER, campaignId.data); if (result === null) return missing(request, reply);
      const keys = new Set(["campaignId", "revision", "quests", "objectives", "journal"]);
      if (Object.keys(result).length !== keys.size || Object.keys(result).some((key) => !keys.has(key)) || result.campaignId !== campaignId.data
        || !Number.isSafeInteger(result.revision) || result.revision < 0
        || result.quests.some((quest) => quest.campaignId !== campaignId.data)
        || result.objectives.some((objective) => !result.quests.some((quest) => quest.questId === objective.questId))
        || result.journal.some((entry) => !result.quests.some((quest) => quest.questId === entry.questId))) throw new Error("quest list binding is invalid");
      reply.header("x-quest-revision", String(result.revision));
      return reply.send(campaignQuestsHttpResponseSchema.parse({ quests: result.quests, objectives: result.objectives, journal: result.journal }));
    } catch (error) { return fail(request, reply, error, "quest-list"); }
  });

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/quests", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest creation does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) { await missing(request, reply); return; }
      const type = request.headers["content-type"];
      if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Quest creation requires application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest creation request is invalid"),
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId), body = createCampaignQuestHttpRequestSchema.safeParse(request.body);
    if (!campaignId.success) return missing(request, reply); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest creation request is invalid");
    try {
      const result = options.questRepositoryAccessor().createCampaignQuest(OWNER, campaignId.data, body.data);
      if (result.campaignId !== campaignId.data || result.quest.campaignId !== campaignId.data || result.quest.questId !== body.data.quest.questId
        || result.quest.storylineId !== body.data.quest.storylineId || result.quest.title !== body.data.quest.title
        || result.receipt.idempotencyKey !== body.data.idempotencyKey || result.receipt.revisionBefore !== body.data.expectedRevision
        || result.receipt.revisionAfter !== body.data.expectedRevision + 1) throw new Error("quest creation binding is invalid");
      return reply.code(201).send(createCampaignQuestHttpResponseSchema.parse({ quest: result.quest, receipt: {
        idempotencyKey: result.receipt.idempotencyKey, revisionBefore: result.receipt.revisionBefore,
        revisionAfter: result.receipt.revisionAfter, occurredAt: result.receipt.occurredAt,
      } }));
    } catch (error) { return fail(request, reply, error, "quest-create"); }
  });

  app.post<{ Params: { questId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/quests/:questId/commands", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest commands do not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.questId).success) { await missing(request, reply, true); return; }
      const type = request.headers["content-type"];
      if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Quest commands require application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest command request is invalid"),
  }, async (request, reply) => {
    const questId = resourceIdSchema.safeParse(request.params.questId), body = questCommandHttpRequestSchema.safeParse(request.body);
    if (!questId.success) return missing(request, reply, true); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Quest command request is invalid");
    try {
      const result = options.questRepositoryAccessor().executeQuestCommand(OWNER, questId.data, body.data);
      let claimIsBound = true;
      if (body.data.kind === "claim-reward") {
        const { rewardId, actorId } = body.data;
        claimIsBound = result.quest.rewards.some((reward) => reward.rewardId === rewardId && reward.claimedByActorId === actorId);
      }
      if (result.quest.questId !== questId.data || result.quest.campaignId !== result.campaignId
        || result.receipt.idempotencyKey !== body.data.idempotencyKey || result.receipt.revisionBefore !== body.data.expectedRevision
        || result.receipt.revisionAfter !== body.data.expectedRevision + 1
        || !claimIsBound)
        throw new Error("quest command binding is invalid");
      return reply.send(questCommandHttpResponseSchema.parse({ quest: result.quest, receipt: {
        idempotencyKey: result.receipt.idempotencyKey, revisionBefore: result.receipt.revisionBefore,
        revisionAfter: result.receipt.revisionAfter, occurredAt: result.receipt.occurredAt,
      } }));
    } catch (error) { return fail(request, reply, error, "quest-command", true); }
  });
};
