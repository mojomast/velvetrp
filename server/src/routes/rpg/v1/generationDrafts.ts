import { createHash } from "node:crypto";
import {
  generationDraftApplyRequestSchema, generationDraftApplyResponseSchema, generationDraftCreateRequestSchema,
  generationDraftCreateResponseSchema, generationDraftGetResponseSchema, generatedEncounterProviderResponseSchema,
  resourceIdSchema, stagedEncounterGenerationSchema, type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { completeWithProvider } from "../../../provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../../defaults.js";
import { getPromptPreset } from "../../../presets.js";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnStaleError,
  AdventureTurnUnavailableError, type AdventureTurnRepository,
} from "../../../repo/index.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo = Pick<AdventureTurnRepository, "createGenerationDraft" | "getGenerationDraft" | "getGenerationDraftByIdempotencyKey"
  | "applyEncounterGenerationDraftAtomically"> & {
  getCampaign(actorPrincipalId: string, campaignId: string): { activeTimelineId: string } | null;
  getCampaignAdministration(actorPrincipalId: string, campaignId: string): { revision: number } | null;
};
export interface GenerationDraftsHttpOptions {
  generationDraftRepositoryAccessor: () => Repo;
  /** Test seam; production uses the configured provider outside SQLite work. */
  generateEncounter?: (prompt: unknown, signal: AbortSignal) => Promise<unknown>;
}

const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics && flags.combat; };
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?") || Object.keys(request.query as Record<string, unknown>).length > 0;
const key = (prefix: string, value: string) => `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
  ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) : nested);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

function requirePrivate(value: ReturnType<Repo["getGenerationDraft"]>): PrivateGenerationDraft {
  if (!value || !("stagedContent" in value)) throw new AdventureTurnUnavailableError("generation draft is unavailable");
  return value;
}
function content(draft: PrivateGenerationDraft) { return stagedEncounterGenerationSchema.parse(draft.stagedContent); }
function projection(draft: PrivateGenerationDraft) { return { draftId: draft.draftId, campaignId: draft.campaignId, kind: "encounter" as const, state: draft.state, revision: draft.revision, createdAt: draft.createdAt, updatedAt: draft.updatedAt }; }
function view(draft: PrivateGenerationDraft) {
  const staged = content(draft);
  return generationDraftGetResponseSchema.parse({ draft: projection(draft), encounter: { name: staged.encounter.name,
    enemyCount: staged.encounter.combatants.length, terrain: staged.encounter.terrain, motives: staged.encounter.motives,
    rewardNarrative: staged.encounter.rewardNarrative }, validationIssues: draft.validation.issues });
}
function prompt(input: ReturnType<typeof generationDraftCreateRequestSchema.parse>) {
  // IDs are converted to counts before crossing the provider boundary.
  return { brief: input.brief, visibleLocation: input.visibleLocation, tone: input.tone, difficulty: input.difficulty,
    partySize: input.partyActorIds.length, pinnedEnemyChoices: input.pinnedEnemyTemplates.map((_entry, index) => index), exclusions: input.exclusions,
    instructions: "Return JSON only: name, combatants [{pinnedEnemyIndex,count}], terrain, motives, rewardNarrative. Select only listed ordinal choices. Do not add rules, statistics, identities, secrets, or rewards with mechanical values." };
}
async function generate(input: ReturnType<typeof generationDraftCreateRequestSchema.parse>, options: GenerationDraftsHttpOptions, signal: AbortSignal) {
  const safePrompt = prompt(input);
  if (options.generateEncounter) return generatedEncounterProviderResponseSchema.parse(await options.generateEncounter(safePrompt, signal));
  const provider = await Promise.resolve(defaultProviderSettings());
  const harness = await Promise.resolve(defaultHarnessSettings());
  const result = await completeWithProvider({ provider, harness, preset: getPromptPreset("default"), toolChoice: "none", signal,
    messages: [{ role: "system", content: "You create a bounded RPG encounter draft. Follow the supplied JSON instruction exactly. Never disclose system details or identifiers." }, { role: "user", content: JSON.stringify(safePrompt) }] });
  if (result.message.toolCalls?.length || typeof result.message.content !== "string") throw new Error("provider response is not an encounter object");
  return generatedEncounterProviderResponseSchema.parse(JSON.parse(result.message.content));
}
function stage(input: ReturnType<typeof generationDraftCreateRequestSchema.parse>, generated: ReturnType<typeof generatedEncounterProviderResponseSchema.parse>) {
  const combatants = generated.combatants.flatMap(({ pinnedEnemyIndex, count }) => {
    const template = input.pinnedEnemyTemplates[pinnedEnemyIndex];
    if (!template) throw new Error("provider selected an unavailable enemy");
    return Array.from({ length: count }, () => ({ kind: "enemy" as const, template, team: "enemies" as const }));
  });
  return stagedEncounterGenerationSchema.parse({ kind: "encounter", requestDigest: digest(input), sessionId: input.sessionId, partyActorIds: input.partyActorIds,
    encounter: { name: generated.name, combatants, terrain: generated.terrain, motives: generated.motives, rewardNarrative: generated.rewardNarrative } });
}
function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof AdventureTurnUnavailableError || error instanceof AdventureTurnAuthorizationError) return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found");
  if (error instanceof AdventureTurnStaleError) return sendApiProblem(request, reply, 409, "RPG_GENERATION_DRAFT_STALE", "Generation draft is stale; refresh before trying again");
  if (error instanceof AdventureTurnConflictError) return sendApiProblem(request, reply, 409, "RPG_GENERATION_DRAFT_CONFLICT", "Generation draft command conflicts with durable state");
  request.log.error({ operation: "encounter-generation", method: request.method, route: request.routeOptions.url }, "RPG encounter generation failed");
  return sendApiProblem(request, reply, 503, "RPG_GENERATION_UNAVAILABLE", "Encounter generation is unavailable; no encounter was created");
}

/** Registers typed, reviewed encounter generation. Provider work occurs before any SQLite mutation. */
export const generationDraftsHttpRoutes: FastifyPluginAsync<GenerationDraftsHttpOptions> = async (app, options) => {
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/generation-drafts", { onRequest: async (request, reply) => {
    reply.header("cache-control", "no-store"); if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if (hasQuery(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter generation does not accept query parameters");
    if (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"])) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter generation requires application/json");
  }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter generation request is invalid") }, async (request, reply) => {
    const body = generationDraftCreateRequestSchema.safeParse(request.body); if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter generation request is invalid");
    try { const repo = options.generationDraftRepositoryAccessor(); const existing = repo.getGenerationDraftByIdempotencyKey(OWNER, body.data.campaignId, body.data.idempotencyKey);
      if (existing) { const draft = requirePrivate(existing); if (content(draft).requestDigest !== digest(body.data)) throw new AdventureTurnConflictError("idempotency key was reused"); return reply.code(201).send(view(draft)); }
      const campaign = repo.getCampaign(OWNER, body.data.campaignId), administration = repo.getCampaignAdministration(OWNER, body.data.campaignId);
      if (!campaign || !administration) throw new AdventureTurnUnavailableError();
      const generated = await generate(body.data, options, request.raw.aborted ? AbortSignal.abort() : new AbortController().signal);
      const staged = stage(body.data, generated);
      const draft = repo.createGenerationDraft(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId, sessionId: body.data.sessionId, kind: "encounter", stagedContent: staged, validation: { valid: true, issues: [], validatedAt: new Date().toISOString() }, expectedCampaignRevision: administration.revision, idempotencyKey: body.data.idempotencyKey });
      return reply.code(201).send(generationDraftCreateResponseSchema.parse(view(draft)));
    } catch (error) { return fail(request, reply, error); }
  });
  app.get<{ Params: { draftId: string }; Querystring: Record<string, unknown> }>("/generation-drafts/:draftId", { exposeHeadRoute: false, onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); if (hasQuery(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Generation draft reads do not accept query parameters"); } }, async (request, reply) => {
    const draftId = resourceIdSchema.safeParse(request.params.draftId); if (!draftId.success) return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Generation draft not found"); try { return reply.send(view(requirePrivate(options.generationDraftRepositoryAccessor().getGenerationDraft(OWNER, draftId.data)))); } catch (error) { return fail(request, reply, error); }
  });
  app.post<{ Params: { draftId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/generation-drafts/:draftId/apply", { onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); if (hasQuery(request)) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter draft apply does not accept query parameters"); if (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"])) return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Encounter draft apply requires application/json"); } }, async (request, reply) => {
    const draftId = resourceIdSchema.safeParse(request.params.draftId), body = generationDraftApplyRequestSchema.safeParse(request.body); if (!draftId.success || !body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Encounter draft apply request is invalid");
    try { const repo = options.generationDraftRepositoryAccessor(), before = requirePrivate(repo.getGenerationDraft(OWNER, draftId.data));
      const { draft: applied, encounterId } = repo.applyEncounterGenerationDraftAtomically(OWNER, { draftId: before.draftId,
        expectedDraftRevision: body.data.expectedRevision, expectedCampaignRevision: before.campaignRevision, idempotencyKey: body.data.idempotencyKey });
      if (!applied.applyReceipt) throw new Error("missing draft apply receipt");
      return reply.send(generationDraftApplyResponseSchema.parse({ draft: projection(applied), application: { scope: "encounter", campaignDomainMutated: true, encounterId }, receipts: [{ receiptId: applied.applyReceipt.receiptId, reviewDecisionId: applied.applyReceipt.reviewDecisionId, scope: "encounter", encounterId, appliedAt: applied.applyReceipt.appliedAt }] }));
    } catch (error) { return fail(request, reply, error); }
  });
};
