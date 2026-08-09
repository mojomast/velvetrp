import { createHash } from "node:crypto";
import {
  generationDraftApplyRequestSchema, generationDraftApplyResponseSchema, generationDraftCreateRequestSchema,
  generationDraftCreateResponseSchema, generationDraftGetResponseSchema, resourceIdSchema,
  type GenerationDraftCreateRequest, type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnStaleError,
  AdventureTurnUnavailableError, type AdventureTurnRepository,
} from "../../../repo/index.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo = Pick<AdventureTurnRepository, "createGenerationDraft" | "getGenerationDraft" | "getGenerationDraftByIdempotencyKey"
  | "reviewGenerationDraft" | "applyGenerationDraft"> & {
  getCampaign(actorPrincipalId: string, campaignId: string): { activeTimelineId: string } | null;
  getCampaignAdministration(actorPrincipalId: string, campaignId: string): { revision: number } | null;
};
/** Narrow durable repository lane required by generation-draft HTTP routes. */
export interface GenerationDraftsHttpOptions { generationDraftRepositoryAccessor: () => Repo }

const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; };
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;
const commandKey = (prefix: string, value: string) => `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
  ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) : nested);

function staged(input: GenerationDraftCreateRequest) {
  return { provenance: { source: "user-brief" as const, method: "deterministic-fallback" as const,
      applicationScope: "draft-review" as const },
    changes: [{ changeId: "brief", summary: `Review the user-authored ${input.kind} brief`,
      content: { brief: input.brief, constraints: input.constraints } }] };
}
const draftProjection = (draft: PrivateGenerationDraft) => ({ draftId: draft.draftId, campaignId: draft.campaignId, kind: draft.kind,
  state: draft.state, revision: draft.revision, createdAt: draft.createdAt, updatedAt: draft.updatedAt });
function requirePrivate(value: ReturnType<Repo["getGenerationDraft"]>): PrivateGenerationDraft {
  if (!value || !("stagedContent" in value)) throw new AdventureTurnUnavailableError("generation draft is unavailable");
  return value;
}
function view(draft: PrivateGenerationDraft) {
  const content = draft.stagedContent as { provenance?: unknown; changes?: unknown };
  return generationDraftGetResponseSchema.parse({ draft: draftProjection(draft), provenance: content.provenance,
    changes: content.changes, validationIssues: draft.validation.issues });
}
function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof AdventureTurnUnavailableError || error instanceof AdventureTurnAuthorizationError) {
    return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found");
  }
  if (error instanceof AdventureTurnStaleError) return sendApiProblem(request, reply, 409, "RPG_GENERATION_DRAFT_STALE", "Generation draft is stale; refresh before trying again");
  if (error instanceof AdventureTurnConflictError) return sendApiProblem(request, reply, 409, "RPG_GENERATION_DRAFT_CONFLICT", "Generation draft command conflicts with durable state");
  request.log.error({ operation: "generation-draft", method: request.method, route: request.routeOptions.url }, "RPG generation draft operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Generation draft status is unknown; reconcile with GET before retrying and do not automatically retry");
}

/** Registers deterministic draft-review create, read, and draft-only apply routes. */
export const generationDraftsHttpRoutes: FastifyPluginAsync<GenerationDraftsHttpOptions> = async (app, options) => {
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/generation-drafts", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft creation does not accept query parameters"); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Generation draft creation requires application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft creation request is invalid"),
  }, async (request, reply) => {
    const body = generationDraftCreateRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft creation request is invalid");
    try {
      const repo = options.generationDraftRepositoryAccessor(); const content = staged(body.data);
      const existing = repo.getGenerationDraftByIdempotencyKey(OWNER, body.data.campaignId, body.data.idempotencyKey);
      let draft: PrivateGenerationDraft;
      if (existing) {
        draft = requirePrivate(existing);
        if (draft.kind !== body.data.kind || canonical(draft.stagedContent) !== canonical(content)) throw new AdventureTurnConflictError();
      } else {
        const campaign = repo.getCampaign(OWNER, body.data.campaignId);
        const administration = repo.getCampaignAdministration(OWNER, body.data.campaignId);
        if (!campaign || !administration) throw new AdventureTurnUnavailableError();
        draft = repo.createGenerationDraft(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId,
          kind: body.data.kind, stagedContent: content, validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
          expectedCampaignRevision: administration.revision, idempotencyKey: body.data.idempotencyKey });
      }
      return reply.code(201).send(generationDraftCreateResponseSchema.parse(view(draft)));
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: { draftId: string }; Querystring: Record<string, unknown> }>("/generation-drafts/:draftId", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft reads do not accept query parameters"); },
  }, async (request, reply) => {
    const draftId = resourceIdSchema.safeParse(request.params.draftId);
    if (!draftId.success) return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found");
    try { return reply.send(view(requirePrivate(options.generationDraftRepositoryAccessor().getGenerationDraft(OWNER, draftId.data)))); }
    catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: { draftId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/generation-drafts/:draftId/apply", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft apply does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.draftId).success) { await sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found"); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Generation draft apply requires application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft apply request is invalid"),
  }, async (request, reply) => {
    const draftId = resourceIdSchema.safeParse(request.params.draftId), body = generationDraftApplyRequestSchema.safeParse(request.body);
    if (!draftId.success) return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found");
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft apply request is invalid");
    try {
      const repo = options.generationDraftRepositoryAccessor(); const before = requirePrivate(repo.getGenerationDraft(OWNER, draftId.data));
      const known = new Set(view(before).changes.map(({ changeId }) => changeId));
      if (body.data.selectedChanges.some((changeId) => !known.has(changeId))) throw new AdventureTurnConflictError();
      const application = { applicationScope: "draft-only", selectedChanges: body.data.selectedChanges };
      const reviewed = repo.reviewGenerationDraft(OWNER, { draftId: draftId.data, decision: "approved",
        notes: canonical(application), expectedDraftRevision: body.data.expectedRevision, expectedCampaignRevision: before.campaignRevision,
        idempotencyKey: commandKey("http-review", body.data.idempotencyKey) });
      const applied = repo.applyGenerationDraft(OWNER, { draftId: draftId.data, expectedDraftRevision: body.data.expectedRevision + 1,
        expectedCampaignRevision: reviewed.campaignRevision, idempotencyKey: commandKey("http-apply", body.data.idempotencyKey),
        result: application });
      if (!applied.applyReceipt || applied.applyReceipt.draftId !== draftId.data
          || canonical(applied.applyReceipt.result) !== canonical(application)) throw new Error("draft apply response is ambiguously bound");
      return reply.send(generationDraftApplyResponseSchema.parse({ draft: draftProjection(applied),
        application: { scope: "draft-only", campaignDomainMutated: false }, receipts: [{
        receiptId: applied.applyReceipt.receiptId, reviewDecisionId: applied.applyReceipt.reviewDecisionId,
        scope: "draft-only", selectedChanges: body.data.selectedChanges, appliedAt: applied.applyReceipt.appliedAt,
      }] }));
    } catch (error) { return fail(request, reply, error); }
  });
};
