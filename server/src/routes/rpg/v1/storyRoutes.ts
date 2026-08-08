import {
  campaignStoryHttpResponseSchema, createCampaignStorylineHttpRequestSchema, createCampaignStorylineHttpResponseSchema,
  resourceIdSchema, storylineCommandHttpRequestSchema, storylineCommandHttpResponseSchema,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  StoryAuthorizationError, StoryConflictError, StoryStaleError, StoryUnavailableError, type StoryRepository,
} from "../../../repo/storyRepo.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; };
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as object).length > 0;
type Repo = Pick<StoryRepository, "getCampaignStory" | "createCampaignStorylineGraph" | "executeStorylineCommand">;
export interface StoryHttpRoutesOptions { storyRepositoryAccessor: () => Repo }
const missing = (request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], target = false) => sendApiProblem(request, reply, 404,
  target ? "RPG_STORYLINE_NOT_FOUND" : "RPG_CAMPAIGN_STORY_NOT_FOUND", target ? "Storyline not found" : "Campaign story not found");
function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown, operation: string, target = false) {
  if (error instanceof StoryAuthorizationError || error instanceof StoryUnavailableError) return missing(request, reply, target);
  if (error instanceof StoryStaleError) return sendApiProblem(request, reply, 409, "RPG_STORY_STALE", "Story state is stale; refresh before trying again");
  if (error instanceof StoryConflictError) return sendApiProblem(request, reply, 409, "RPG_STORY_CONFLICT", "Story command conflicts with current state");
  request.log.error({ operation, method: request.method, route: request.routeOptions.url }, "RPG story operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Story outcome could not be confirmed; reconcile story state before retrying and do not automatically retry");
}
const publicReceipt = (receipt: any) => ({ idempotencyKey: receipt.idempotencyKey, revisionBefore: receipt.revisionBefore,
  revisionAfter: receipt.revisionAfter, occurredAt: receipt.occurredAt });
function assertGmStoryBinding(story: any, campaignId: string): asserts story is Extract<ReturnType<typeof campaignStoryHttpResponseSchema.parse>, { storylines: unknown }> {
  if (!("storylines" in story) || story.storylines.some((item: any) => item.campaignId !== campaignId)) throw new Error("GM story campaign binding is invalid");
  const storylines = new Set(story.storylines.map((item: any) => item.storylineId));
  const nodes = new Map(story.nodes.map((item: any) => [item.nodeId, item.storylineId]));
  if (story.nodes.some((item: any) => !storylines.has(item.storylineId))
    || story.edges.some((item: any) => !storylines.has(item.storylineId) || nodes.get(item.fromNodeId) !== item.storylineId || nodes.get(item.toNodeId) !== item.storylineId)
    || story.plotPoints.some((item: any) => !storylines.has(item.storylineId) || nodes.get(item.nodeId) !== item.storylineId)
    || story.clues.some((item: any) => !storylines.has(item.storylineId) || item.sources.some((source: any) => source.kind === "node"
      ? nodes.get(source.targetId) !== item.storylineId
      : !story.plotPoints.some((point: any) => point.plotPointId === source.targetId && point.storylineId === item.storylineId)))) throw new Error("GM story graph binding is invalid");
}

export const storyHttpRoutes: FastifyPluginAsync<StoryHttpRoutesOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/story", {
    exposeHeadRoute: false, onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign story does not accept query parameters"); },
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) return missing(request, reply); if (request.body !== undefined) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign story does not accept a request body");
    try { const result = options.storyRepositoryAccessor().getCampaignStory(OWNER, campaignId.data); if (!result) return missing(request, reply);
      if (result.campaignId !== campaignId.data || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("story read binding is invalid");
      const story = campaignStoryHttpResponseSchema.parse(result.story); assertGmStoryBinding(story, campaignId.data);
      reply.header("x-story-revision", String(result.revision)); return reply.send(story);
    } catch (error) { return fail(request, reply, error, "story-read"); } });

  app.post<{ Params: { campaignId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/campaigns/:campaignId/storylines", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) { await missing(request, reply); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Storyline creation requires application/json"); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation request is invalid"),
  }, async (request, reply) => { const campaignId = resourceIdSchema.safeParse(request.params.campaignId), body = createCampaignStorylineHttpRequestSchema.safeParse(request.body);
    if (!campaignId.success) return missing(request, reply); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline creation request is invalid");
    try { const result = options.storyRepositoryAccessor().createCampaignStorylineGraph(OWNER, campaignId.data, body.data);
      const story = campaignStoryHttpResponseSchema.parse(result.story); assertGmStoryBinding(story, campaignId.data);
      const createdNodes = story.nodes.filter((item) => item.storylineId === result.storyline.storylineId);
      const createdEdges = story.edges.filter((item) => item.storylineId === result.storyline.storylineId);
      const createdPoints = story.plotPoints.filter((item) => item.storylineId === result.storyline.storylineId);
      const createdClues = story.clues.filter((item) => item.storylineId === result.storyline.storylineId);
      if (result.campaignId !== campaignId.data || result.storyline.campaignId !== campaignId.data || result.storyline.storylineId !== body.data.storyline.storylineId
        || result.storyline.title !== body.data.storyline.title || result.storyline.summary !== body.data.storyline.summary || result.storyline.status !== "active"
        || !story.storylines.some((item) => item.storylineId === result.storyline.storylineId && item.title === result.storyline.title
          && item.summary === result.storyline.summary && item.status === result.storyline.status)
        || createdNodes.length !== body.data.storyline.nodes.length || createdEdges.length !== body.data.storyline.edges.length
        || createdPoints.length !== body.data.storyline.plotPoints.length || createdClues.length !== body.data.storyline.clues.length
        || body.data.storyline.nodes.some((input) => !createdNodes.some((item) => item.nodeId === input.nodeId && item.title === input.title && item.description === input.description && item.gmNotes === input.gmNotes && item.revealThreshold === input.revealThreshold && item.status === "hidden"))
        || body.data.storyline.edges.some((input) => !createdEdges.some((item) => item.edgeId === input.edgeId && item.kind === input.kind && item.fromNodeId === input.fromNodeId && item.toNodeId === input.toNodeId))
        || body.data.storyline.plotPoints.some((input) => !createdPoints.some((item) => item.plotPointId === input.plotPointId && item.nodeId === input.nodeId && item.question === input.question && item.answer === input.answer && item.gmNotes === input.gmNotes && !item.answered))
        || body.data.storyline.clues.some((input) => !createdClues.some((item) => item.clueId === input.clueId && item.title === input.title && item.content === input.content && item.truth === input.truth && item.gmNotes === input.gmNotes && item.revealThreshold === input.revealThreshold && !item.revealed
          && item.sources.length === input.sources.length && input.sources.every((source) => item.sources.some((actual) => actual.sourceId === source.sourceId && actual.kind === source.kind && actual.targetId === source.targetId))))
        || result.receipt.idempotencyKey !== body.data.idempotencyKey
        || result.receipt.revisionBefore !== body.data.expectedRevision || result.receipt.revisionAfter !== body.data.expectedRevision + 1) throw new Error("storyline creation binding is invalid");
      return reply.code(201).send(createCampaignStorylineHttpResponseSchema.parse({ storyline: result.storyline, story, receipt: publicReceipt(result.receipt) }));
    } catch (error) { return fail(request, reply, error, "storyline-create"); } });

  app.post<{ Params: { storylineId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/storylines/:storylineId/commands", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline commands do not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.storylineId).success) { await missing(request, reply, true); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Storyline commands require application/json"); },
    errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline command request is invalid"),
  }, async (request, reply) => { const storylineId = resourceIdSchema.safeParse(request.params.storylineId), body = storylineCommandHttpRequestSchema.safeParse(request.body);
    if (!storylineId.success) return missing(request, reply, true); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Storyline command request is invalid");
    try { const result = options.storyRepositoryAccessor().executeStorylineCommand(OWNER, storylineId.data, body.data);
      if (result.storylineId !== storylineId.data || result.receipt.idempotencyKey !== body.data.idempotencyKey
        || result.receipt.revisionBefore !== body.data.expectedRevision || result.receipt.revisionAfter !== body.data.expectedRevision + 1) throw new Error("story command binding is invalid");
      const story = campaignStoryHttpResponseSchema.parse(result.story); assertGmStoryBinding(story, result.campaignId);
      const targetBound = body.data.kind === "reveal-node" ? story.nodes.some((item) => item.storylineId === storylineId.data && item.nodeId === body.data.targetId && item.status === "revealed")
        : body.data.kind === "resolve-node" ? story.nodes.some((item) => item.storylineId === storylineId.data && item.nodeId === body.data.targetId && item.status === "resolved")
          : body.data.kind === "reveal-clue" ? story.clues.some((item) => item.storylineId === storylineId.data && item.clueId === body.data.targetId && item.revealed)
            : story.plotPoints.some((item) => item.storylineId === storylineId.data && item.plotPointId === body.data.targetId && item.answered && item.playerAnswer === body.data.data.answer);
      if (!targetBound) throw new Error("story command target binding is invalid");
      return reply.send(storylineCommandHttpResponseSchema.parse({ story, receipt: publicReceipt(result.receipt) }));
    } catch (error) { return fail(request, reply, error, "storyline-command", true); } });
};
