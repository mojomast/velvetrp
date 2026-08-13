import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  campaignHistoryHttpCheckpointRequestSchema,
  campaignHistoryHttpCheckpointResponseSchema,
  campaignHistoryHttpCheckpointSchema,
  campaignHistoryHttpCommandReceiptSchema,
  campaignHistoryHttpEventsQuerySchema,
  campaignHistoryHttpEventsResponseSchema,
  campaignHistoryHttpForkRequestSchema,
  campaignHistoryHttpForkResponseSchema,
  campaignHistoryHttpPublicReceiptResponseSchema,
  campaignHistoryHttpRecapRequestSchema,
  campaignHistoryHttpRecapResponseSchema,
  campaignHistoryHttpRecapSchema,
  campaignHistoryHttpTimelineSchema,
  campaignHistoryHttpTimelinesResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
  CampaignAdministrationStaleError,
  type CampaignAdministrationRepository,
} from "../../../repo/campaignAdministrationRepo.js";
import type { Repository } from "../../../repo/campaign/campaignTypes.js";

const LOCAL_OWNER = "local-owner";
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

type CampaignHistoryRepository = Pick<CampaignAdministrationRepository,
  "listCampaignTimelineHistory" | "createCampaignCheckpoint" | "listCampaignCheckpoints"
  | "forkCampaignTimeline" | "createCampaignRecap" | "listCampaignRecaps"
  | "getCampaignAdministrationReceipt"> & Pick<Repository, "listPublicCampaignEvents" | "getCommandReceipt" | "getAgentCombatReceipt" | "getExactCandidateTravelPublicReceipt">;

export interface CampaignHistoryHttpOptions {
  campaignHistoryRepositoryAccessor: () => CampaignHistoryRepository;
}

function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }
function invalid(request: FastifyRequest, reply: FastifyReply, detail = "Campaign history request is invalid") {
  return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", detail);
}
function unavailable(request: FastifyRequest, reply: FastifyReply) {
  return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
}
function failure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CampaignAdministrationForbiddenError) return unavailable(request, reply);
  if (error instanceof CampaignAdministrationStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_STALE", "Campaign administration is stale; refresh before editing");
  }
  if (error instanceof CampaignAdministrationConflictError) {
    return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ADMINISTRATION_CONFLICT", "Campaign administration conflicts with current state");
  }
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR",
    "Campaign history status is unknown; refresh before trying again; never retry automatically");
}

function prepare(request: FastifyRequest, reply: FastifyReply, mutation: boolean, pathKeys: string[]): string | null {
  noStore(reply);
  if (!readRpgFeatureFlags().campaign) {
    void sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    return null;
  }
  if ((request.raw.url ?? request.url).includes("?") && request.method !== "GET") {
    void invalid(request, reply, "Campaign history does not accept query parameters");
    return null;
  }
  const params = request.params as Record<string, unknown>;
  if (pathKeys.some((key) => !resourceIdSchema.safeParse(params[key]).success)) {
    void unavailable(request, reply);
    return null;
  }
  if (mutation) {
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !JSON_MEDIA_TYPE.test(contentType)) {
      void sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign history requires application/json");
      return null;
    }
  }
  return params.campaignId as string;
}

function publicReceipt(receipt: unknown, campaignId: string, commandId?: string) {
  const value = receipt as { campaignId?: unknown; commandId?: unknown; events?: Array<{ campaignId?: unknown }> };
  if (value.campaignId !== campaignId || (commandId !== undefined && value.commandId !== commandId)
    || value.events?.some((event) => event.campaignId !== campaignId)) throw new Error("receipt does not match request");
  const { campaignId: _campaignId, events, ...rest } = value;
  return campaignHistoryHttpCommandReceiptSchema.parse({
    ...rest,
    events: events?.map(({ campaignId: _eventCampaignId, ...event }) => event),
  });
}

function accessibleTimelines(repository: CampaignHistoryRepository, campaignId: string, request: FastifyRequest, reply: FastifyReply) {
  const timelines = repository.listCampaignTimelineHistory(LOCAL_OWNER, campaignId);
  if (timelines.length === 0) {
    void unavailable(request, reply);
    return null;
  }
  if (timelines.some((timeline) => timeline.campaignId !== campaignId)) throw new Error("timeline does not match request");
  return timelines;
}

export const campaignHistoryHttpRoutes: FastifyPluginAsync<CampaignHistoryHttpOptions> = async (app, options) => {
  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/timelines", { exposeHeadRoute: false }, async (request, reply) => {
    const campaignId = prepare(request, reply, false, ["campaignId"]); if (campaignId === null) return reply;
    if ((request.raw.url ?? request.url).includes("?")) return invalid(request, reply, "Campaign history does not accept query parameters");
    try {
      const timelines = accessibleTimelines(options.campaignHistoryRepositoryAccessor(), campaignId, request, reply);
      if (timelines === null) return reply;
      const active = timelines.find((timeline) => timeline.active);
      if (!active) throw new Error("campaign has no active timeline");
      return reply.send(campaignHistoryHttpTimelinesResponseSchema.parse({ activeTimelineId: active.id,
        timelines: timelines.map(({ campaignId: _campaignId, ...timeline }) => campaignHistoryHttpTimelineSchema.parse(timeline)) }));
    } catch (error) { return failure(request, reply, error); }
  });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>("/campaigns/:campaignId/events", { exposeHeadRoute: false }, async (request, reply) => {
    const campaignId = prepare(request, reply, false, ["campaignId"]); if (campaignId === null) return reply;
    const query = campaignHistoryHttpEventsQuerySchema.safeParse(request.query); if (!query.success) return invalid(request, reply);
    try {
      const repository = options.campaignHistoryRepositoryAccessor();
      const timelines = accessibleTimelines(repository, campaignId, request, reply);
      if (timelines === null || !timelines.some((timeline) => timeline.id === query.data.timelineId)) return unavailable(request, reply);
      const page = repository.listPublicCampaignEvents(LOCAL_OWNER, campaignId, query.data.timelineId, query.data.afterRevision, query.data.limit);
      if (page.events.some((event) => event.campaignId !== campaignId || event.timelineId !== query.data.timelineId)) throw new Error("event does not match request");
      return reply.send(campaignHistoryHttpEventsResponseSchema.parse({ ...page,
        events: page.events.map(({ campaignId: _campaignId, ...event }) => event) }));
    } catch (error) { return failure(request, reply, error); }
  });

  app.get<{ Params: { campaignId: string; commandId: string } }>("/campaigns/:campaignId/commands/:commandId/receipt", { exposeHeadRoute: false }, async (request, reply) => {
    const campaignId = prepare(request, reply, false, ["campaignId", "commandId"]); if (campaignId === null) return reply;
    if ((request.raw.url ?? request.url).includes("?")) return invalid(request, reply, "Campaign history does not accept query parameters");
    try {
      const repository = options.campaignHistoryRepositoryAccessor();
      // The command repository performs campaign membership and owner binding
      // before returning its role-safe actor mechanic receipt.
      const mechanic = repository.getCommandReceipt(LOCAL_OWNER, campaignId, request.params.commandId);
      if (mechanic !== null) {
        const [event] = mechanic.events;
        if (mechanic.campaignId !== campaignId || mechanic.commandId !== request.params.commandId
          || mechanic.events.length !== 1 || !event || event.campaignId !== campaignId
          || event.commandId !== request.params.commandId || event.revision !== mechanic.revisionAfter) {
          throw new Error("mechanic receipt does not match request");
        }
        return reply.send(campaignHistoryHttpPublicReceiptResponseSchema.parse({ receipt: {
          kind: "mechanic", revisionBefore: mechanic.revisionBefore, revisionAfter: mechanic.revisionAfter,
          occurredAt: event.occurredAt, event: event.type === "actor_attribute_set"
            ? { type: event.type, data: { valueBefore: event.data.valueBefore, valueAfter: event.data.valueAfter } }
            : event.type === "actor_resource_initialized"
              ? { type: event.type, data: { current: event.data.current, max: event.data.max } }
              : { type: event.type, data: event.data },
        } }));
      }
      const combat=typeof repository.getAgentCombatReceipt==="function"?repository.getAgentCombatReceipt(LOCAL_OWNER,campaignId,request.params.commandId):null;
      if(combat)return reply.send(campaignHistoryHttpPublicReceiptResponseSchema.parse({receipt:{kind:"combat",revisionBefore:combat.revisionBefore,
        revisionAfter:combat.revisionAfter,occurredAt:combat.occurredAt,roundBefore:combat.resolution.roundBefore,roundAfter:combat.resolution.roundAfter}}));
      const travel=repository.getExactCandidateTravelPublicReceipt(LOCAL_OWNER,campaignId,request.params.commandId);
      if(travel)return reply.send(campaignHistoryHttpPublicReceiptResponseSchema.parse({receipt:{kind:"travel",...travel}}));
      const administration = repository.getCampaignAdministrationReceipt(LOCAL_OWNER, campaignId, request.params.commandId);
      if (administration === null) return unavailable(request, reply);
      const safe = publicReceipt(administration, campaignId, request.params.commandId);
      return reply.send(campaignHistoryHttpPublicReceiptResponseSchema.parse({ receipt: {
        kind: "administration", type: safe.type, revisionBefore: safe.revisionBefore,
        revisionAfter: safe.revisionAfter, occurredAt: safe.occurredAt,
      } }));
    } catch (error) { return failure(request, reply, error); }
  });

  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/checkpoints", { exposeHeadRoute: false }, async (request, reply) => {
    const campaignId = prepare(request, reply, false, ["campaignId"]); if (campaignId === null) return reply;
    if ((request.raw.url ?? request.url).includes("?")) return invalid(request, reply, "Campaign history does not accept query parameters");
    try {
      const repository = options.campaignHistoryRepositoryAccessor();
      if (accessibleTimelines(repository, campaignId, request, reply) === null) return reply;
      const checkpoints = repository.listCampaignCheckpoints(LOCAL_OWNER, campaignId);
      return reply.send({ checkpoints: checkpoints.map((checkpoint) => {
        if (checkpoint.campaignId !== campaignId) throw new Error("checkpoint does not match request");
        const { campaignId: _campaignId, ...value } = checkpoint; return campaignHistoryHttpCheckpointSchema.parse(value);
      }) });
    } catch (error) { return failure(request, reply, error); }
  });

  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/checkpoints", { exposeHeadRoute: false,
    errorHandler: (_error, request, reply) => { noStore(reply); return invalid(request, reply); },
  }, async (request, reply) => {
    const campaignId = prepare(request, reply, true, ["campaignId"]); if (campaignId === null) return reply;
    const body = campaignHistoryHttpCheckpointRequestSchema.safeParse(request.body); if (!body.success) return invalid(request, reply);
    try {
      const result = options.campaignHistoryRepositoryAccessor().createCampaignCheckpoint(LOCAL_OWNER, campaignId, body.data);
      if (result.value.campaignId !== campaignId) throw new Error("checkpoint does not match request");
      const { campaignId: _campaignId, ...checkpoint } = result.value;
      return reply.code(201).send(campaignHistoryHttpCheckpointResponseSchema.parse({ checkpoint, receipt: publicReceipt(result.receipt, campaignId) }));
    } catch (error) { return failure(request, reply, error); }
  });

  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/timeline-forks", { exposeHeadRoute: false,
    errorHandler: (_error, request, reply) => { noStore(reply); return invalid(request, reply); },
  }, async (request, reply) => {
    const campaignId = prepare(request, reply, true, ["campaignId"]); if (campaignId === null) return reply;
    const body = campaignHistoryHttpForkRequestSchema.safeParse(request.body); if (!body.success) return invalid(request, reply);
    try {
      const result = options.campaignHistoryRepositoryAccessor().forkCampaignTimeline(LOCAL_OWNER, campaignId, body.data);
      if (result.value.campaignId !== campaignId) throw new Error("timeline does not match request");
      const { campaignId: _campaignId, ...timeline } = result.value;
      return reply.code(201).send(campaignHistoryHttpForkResponseSchema.parse({ timeline, receipt: publicReceipt(result.receipt, campaignId) }));
    } catch (error) { return failure(request, reply, error); }
  });

  app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/recaps", { exposeHeadRoute: false }, async (request, reply) => {
    const campaignId = prepare(request, reply, false, ["campaignId"]); if (campaignId === null) return reply;
    if ((request.raw.url ?? request.url).includes("?")) return invalid(request, reply, "Campaign history does not accept query parameters");
    try {
      const repository = options.campaignHistoryRepositoryAccessor();
      if (accessibleTimelines(repository, campaignId, request, reply) === null) return reply;
      const recaps = repository.listCampaignRecaps(LOCAL_OWNER, campaignId);
      return reply.send({ recaps: recaps.map((recap) => {
        if (recap.campaignId !== campaignId) throw new Error("recap does not match request");
        const { campaignId: _campaignId, ...value } = recap; return campaignHistoryHttpRecapSchema.parse(value);
      }) });
    } catch (error) { return failure(request, reply, error); }
  });

  app.post<{ Params: { campaignId: string }; Body: unknown }>("/campaigns/:campaignId/recaps", { exposeHeadRoute: false,
    errorHandler: (_error, request, reply) => { noStore(reply); return invalid(request, reply); },
  }, async (request, reply) => {
    const campaignId = prepare(request, reply, true, ["campaignId"]); if (campaignId === null) return reply;
    const body = campaignHistoryHttpRecapRequestSchema.safeParse(request.body); if (!body.success) return invalid(request, reply);
    try {
      const result = options.campaignHistoryRepositoryAccessor().createCampaignRecap(LOCAL_OWNER, campaignId, body.data);
      if (result.value.campaignId !== campaignId) throw new Error("recap does not match request");
      const { campaignId: _campaignId, ...recap } = result.value;
      return reply.code(201).send(campaignHistoryHttpRecapResponseSchema.parse({ recap, receipt: publicReceipt(result.receipt, campaignId) }));
    } catch (error) { return failure(request, reply, error); }
  });
};
