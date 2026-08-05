import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CharacterBuilderAuthorizationError, CharacterBuilderConflictError, CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError, CharacterBuilderStaleError, CharacterBuilderUnavailableError,
  type CharacterBuilderRepository,
} from "../../../repo/characterBuilderRepo.js";
import {
  characterDraftHttpViewSchema, characterDraftHttpMutationResultSchema,
  createCharacterDraftHttpInputSchema, updateCharacterDraftHttpInputSchema,
  createCharacterDraftInputSchema,
  resourceIdSchema,
} from "@velvet/contracts";

export interface CharacterBuilderHttpRoutesOptions {
  characterBuilderRepositoryAccessor: () => Pick<CharacterBuilderRepository,
    "createCharacterDraft" | "getCharacterDraft" | "updateCharacterDraft">;
  featureFlags?: () => { campaign?: boolean; mechanics: boolean };
}

const LOCAL_OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const BASE = "/campaigns/:campaignId/character-drafts";
const DETAIL = `${BASE}/:draftId`;

function queryPresent(request: FastifyRequest): boolean {
  return (request.raw.url ?? request.url).includes("?");
}
function noStore(reply: FastifyReply): void { reply.header("cache-control", "no-store"); }
function flags(options: CharacterBuilderHttpRoutesOptions): boolean {
  const value = (options.featureFlags ?? (() => readRpgFeatureFlags()))();
  return value.campaign !== false && value.mechanics;
}
function invalidPath(value: unknown): value is string { return typeof value !== "string" || !resourceIdSchema.safeParse(value).success; }
function safeDraft(value: unknown, campaignId: string, draftId?: string) {
  // Repository views intentionally contain controller/role authority fields;
  // remove them before applying the strict public wire contract.
  const publicValue = value && typeof value === "object"
    ? (({ controllerPrincipalId: _controller, role: _role, ...safe }) => safe)(value as Record<string, unknown>)
    : value;
  const parsed = characterDraftHttpViewSchema.safeParse(publicValue);
  if (!parsed.success || parsed.data.campaignId !== campaignId || (draftId !== undefined && parsed.data.id !== draftId)) return null;
  return parsed.data;
}
function receiptProjection(receipt: Record<string, unknown>) {
  const { commandId: _commandId, draft: _draft, ...safe } = receipt;
  return safe;
}
function problem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, detail: string) {
  return sendApiProblem(request, reply, status, code, detail);
}
function mapFailure(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CharacterBuilderAuthorizationError) return problem(request, reply, 404, "CHARACTER_DRAFT_NOT_FOUND", "Character draft not found");
  if (error instanceof CharacterBuilderStaleError) return problem(request, reply, 409, "CHARACTER_DRAFT_STALE", "Character draft revision is stale");
  if (error instanceof CharacterBuilderExpiredError) return problem(request, reply, 409, "CHARACTER_DRAFT_EXPIRED", "Character draft has expired");
  if (error instanceof CharacterBuilderIncompleteError) return problem(request, reply, 422, "CHARACTER_DRAFT_INCOMPLETE", "Character draft is incomplete");
  if (error instanceof CharacterBuilderConflictError) return problem(request, reply, 409, "CHARACTER_DRAFT_CONFLICT", "Character draft conflicts with authoritative state; do not retry automatically");
  if (error instanceof CharacterBuilderUnavailableError) return problem(request, reply, 503, "CHARACTER_DRAFT_UNAVAILABLE", "Character draft dependency is unavailable");
  request.log.error({ operation: "character-draft" }, "character draft operation failed");
  return problem(request, reply, 500, "RPG_INTERNAL_ERROR", "Character draft could not be loaded");
}

export const characterBuilderHttpRoutes: FastifyPluginAsync<CharacterBuilderHttpRoutesOptions> = async (app, options) => {
  const before = async (request: FastifyRequest, reply: FastifyReply, mutation: boolean) => {
    noStore(reply);
    if (!flags(options)) { await problem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return false; }
    if (queryPresent(request)) { await problem(request, reply, 400, "RPG_INVALID_REQUEST", "Character draft does not accept query parameters"); return false; }
    const params = request.params as { campaignId?: unknown; draftId?: unknown };
    if (invalidPath(params.campaignId) || (params.draftId !== undefined && invalidPath(params.draftId))) {
      await problem(request, reply, 404, "CHARACTER_DRAFT_NOT_FOUND", "Character draft not found"); return false;
    }
    if (mutation) {
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !JSON_TYPE.test(contentType)) {
        await problem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Character draft mutation requires application/json"); return false;
      }
    }
    return true;
  };

  app.post<{ Params: { campaignId: string }; Body: unknown }>(BASE, { exposeHeadRoute: false,
    onRequest: async (req, rep) => { await before(req, rep, true); },
    errorHandler: (_error, req, rep) => problem(req, rep, 400, "RPG_INVALID_REQUEST", "Character draft request is invalid"),
  }, async (request, reply) => {
    const body = createCharacterDraftHttpInputSchema.safeParse(request.body);
    if (!body.success) return problem(request, reply, 400, "RPG_INVALID_REQUEST", "Character draft request is invalid");
    try {
      const result = options.characterBuilderRepositoryAccessor().createCharacterDraft(LOCAL_OWNER, request.params.campaignId,
        createCharacterDraftInputSchema.parse({ ...body.data, controllerPrincipalId: LOCAL_OWNER }));
      const draft = safeDraft(result.draft, request.params.campaignId);
      const projected = characterDraftHttpMutationResultSchema.safeParse({ draft, receipt: receiptProjection(result.receipt as unknown as Record<string, unknown>) });
      if (!draft || !projected.success) throw new Error("invalid character draft projection");
      return reply.code(201).send(projected.data);
    } catch (error) { return mapFailure(request, reply, error); }
  });

  app.get<{ Params: { campaignId: string; draftId: string } }>(DETAIL, { exposeHeadRoute: false,
    onRequest: async (req, rep) => { await before(req, rep, false); },
  }, async (request, reply) => {
    try {
      const draft = safeDraft(options.characterBuilderRepositoryAccessor().getCharacterDraft(LOCAL_OWNER, request.params.draftId), request.params.campaignId, request.params.draftId);
      return draft ? reply.send(draft) : problem(request, reply, 404, "CHARACTER_DRAFT_NOT_FOUND", "Character draft not found");
    } catch (error) { return mapFailure(request, reply, error); }
  });

  app.patch<{ Params: { campaignId: string; draftId: string }; Body: unknown }>(DETAIL, { exposeHeadRoute: false,
    onRequest: async (req, rep) => { await before(req, rep, true); },
    errorHandler: (_error, req, rep) => problem(req, rep, 400, "RPG_INVALID_REQUEST", "Character draft request is invalid"),
  }, async (request, reply) => {
    const body = updateCharacterDraftHttpInputSchema.safeParse(request.body);
    if (!body.success) return problem(request, reply, 400, "RPG_INVALID_REQUEST", "Character draft request is invalid");
    try {
      const repository = options.characterBuilderRepositoryAccessor();
      // Bind the draft to the campaign before any mutation. The repository
      // update API is draft-ID based, so the route must perform this
      // authoritative ownership check itself rather than trust the path.
      const existing = safeDraft(repository.getCharacterDraft(LOCAL_OWNER, request.params.draftId),
        request.params.campaignId, request.params.draftId);
      if (!existing) return problem(request, reply, 404, "CHARACTER_DRAFT_NOT_FOUND", "Character draft not found");
      const result = repository.updateCharacterDraft(LOCAL_OWNER, request.params.draftId, body.data);
      const draft = safeDraft(result.draft, request.params.campaignId, request.params.draftId);
      const projected = characterDraftHttpMutationResultSchema.safeParse({ draft, receipt: receiptProjection(result.receipt as unknown as Record<string, unknown>) });
      if (!draft || !projected.success) throw new Error("invalid character draft projection");
      return reply.send(projected.data);
    } catch (error) { return mapFailure(request, reply, error); }
  });
};
