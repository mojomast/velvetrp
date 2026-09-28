import { createHash } from "node:crypto";
import {
  campaignRegionPackRequestSchema,
  campaignRegionPackResponseSchema,
  resourceIdSchema,
  stagedCampaignContentGenerationSchema,
  type CampaignContentGenerationRequest,
  type GeneratedCampaignContentProvider,
  type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { FastifyPluginAsync } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  AdventureTurnAuthorizationError,
  AdventureTurnConflictError,
  AdventureTurnStaleError,
  AdventureTurnUnavailableError,
  getProviderSettings,
  type Repository,
} from "../../../repo/index.js";
import { CAMPAIGN_GENERATION_LEASE_MS } from "../../../repo/campaignGenerationRecovery.js";
import { buildRegionPackBrief, regionPackArtifactKeys, regionPackSections, validateRegionPack } from "../../../startup/regionPack.js";
import type { ProviderSettings } from "../../../types.js";
import {
  canonicalCampaignGenerationJson,
  generateCandidate,
  publicGenerationCanon,
  sanitizeGeneratedCampaignContent,
  validateContent,
  type CampaignContentGenerationOptions,
} from "./campaignContentGeneration.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;.*)?$/i;
const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics && flags.combat; };
const digest = (value: unknown) => createHash("sha256").update(canonicalCampaignGenerationJson(value)).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const referenceIdentity = (value: { kind: string; packId: string; packVersion: string; definitionId: string }) =>
  `${value.kind}\0${value.packId}\0${value.packVersion}\0${value.definitionId}`;

type Repo = Pick<Repository,
  | "stageCampaignGenerationAtomically"
  | "getGenerationDraft"
  | "getGenerationDraftByIdempotencyKey"
  | "applyCampaignContentGenerationDraftAtomically"
  | "getCampaign"
  | "getCampaignAdministration"
  | "getSessionZeroSafetyPolicy"
  | "beginCampaignGenerationCall"
  | "getCampaignGenerationCall"
  | "finishCampaignGenerationCall"
  | "getCampaignGenerationContext"
  | "getCampaignStartingLocation">;

export interface CampaignRegionPackOptions {
  generationDraftRepositoryAccessor: () => Repo;
  generateCampaignContent?: CampaignContentGenerationOptions["generateCampaignContent"];
}

class RegionPackLeaseExpired extends Error {}

function privateDraft(value: unknown): PrivateGenerationDraft {
  if (!value || typeof value !== "object" || !("stagedContent" in value)) throw new AdventureTurnUnavailableError();
  return value as PrivateGenerationDraft;
}

/** One bounded provider dispatch that mirrors the content-generation lease. */
async function generateRegionPackCandidate(
  input: CampaignContentGenerationRequest,
  safeCanon: unknown,
  options: CampaignContentGenerationOptions,
  signal: AbortSignal,
  providerSettings: ProviderSettings | null,
): Promise<Awaited<ReturnType<typeof generateCandidate>>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      generateCandidate(input, safeCanon, options, controller.signal, providerSettings),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new RegionPackLeaseExpired()); controller.abort(); }, CAMPAIGN_GENERATION_LEASE_MS);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Applies the exact staged candidate selection; an applied replay is idempotent. */
function applyRegionPack(repo: Repo, draft: PrivateGenerationDraft, idempotencyKey: string): PrivateGenerationDraft {
  const staged = stagedCampaignContentGenerationSchema.parse(draft.stagedContent);
  return repo.applyCampaignContentGenerationDraftAtomically(OWNER, {
    draftId: draft.draftId,
    expectedDraftRevision: draft.revision,
    expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey,
    selectedArtifactKeys: regionPackArtifactKeys(staged as unknown as GeneratedCampaignContentProvider),
  });
}

function regionPackSummary(repo: Repo, campaignId: string, applied: PrivateGenerationDraft, anchorLocationKey: string | undefined) {
  const receipt = applied.applyReceipt;
  if (!receipt) throw new Error("region pack apply receipt is missing");
  const start = repo.getCampaignStartingLocation(OWNER, campaignId)?.startingLocation ?? null;
  const staged = stagedCampaignContentGenerationSchema.parse(applied.stagedContent);
  const startArtifactKey = start ? resolveStartArtifactKey(repo, campaignId, start.locationId, [
    ...regionPackArtifactKeys(staged as unknown as GeneratedCampaignContentProvider),
    ...(anchorLocationKey !== undefined ? [anchorLocationKey] : []),
  ]) : null;
  return campaignRegionPackResponseSchema.parse({
    campaignId,
    draft: {
      draftId: applied.draftId, campaignId: applied.campaignId, kind: "campaign-content", state: applied.state,
      revision: applied.revision, createdAt: applied.createdAt, updatedAt: applied.updatedAt,
    },
    appliedArtifactKeys: (receipt.result as { selectedArtifactKeys?: unknown }).selectedArtifactKeys,
    receipt: { receiptId: receipt.receiptId, appliedAt: receipt.appliedAt },
    startLocation: start ? { artifactKey: startArtifactKey, locationId: start.locationId, name: start.name } : null,
  });
}

/** Best-effort artifact-key resolution for the designated start; null when it predates this pack and the anchor. */
function resolveStartArtifactKey(repo: Repo, campaignId: string, locationId: string, keys: string[]): string | null {
  try {
    const artifacts = repo.getCampaignGenerationContext(OWNER, campaignId, [...new Set(keys)])?.artifacts ?? [];
    return artifacts.find((item) => item.serverResourceId === locationId)?.key ?? null;
  } catch {
    return null;
  }
}

function problem(request: any, reply: any, error: unknown, commitMayHaveOccurred = false) {
  if (error instanceof AdventureTurnUnavailableError || error instanceof AdventureTurnAuthorizationError) {
    return sendApiProblem(request, reply, 404, "RPG_GENERATION_DRAFT_NOT_FOUND", "Campaign region pack draft not found");
  }
  if (error instanceof AdventureTurnConflictError || error instanceof AdventureTurnStaleError) {
    return sendApiProblem(request, reply, 409, "RPG_GENERATION_DRAFT_CONFLICT", "Campaign region pack conflicts with durable state");
  }
  request.log.error({ operation: "campaign-region-pack", failureKind: "generation-failed" }, "campaign region pack generation failed");
  return sendApiProblem(request, reply, 503, "RPG_GENERATION_UNAVAILABLE",
    commitMayHaveOccurred
      ? "Campaign region pack outcome could not be confirmed; reconcile authoritative state and do not automatically retry"
      : "Campaign region pack generation is unavailable; no content was applied");
}

/**
 * One-request region pack: exactly one provider dispatch and exactly one atomic
 * apply for a connected opening/quest area. The route reuses the content-generation
 * provider pipeline and adds the anchor/connectivity validator before staging.
 */
export const campaignRegionPackHttpRoutes: FastifyPluginAsync<CampaignRegionPackOptions> = async (app, options) => {
  const gate = (request: any, reply: any) => {
    reply.header("cache-control", "no-store");
    if (!enabled()) return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    if ((request.raw.url ?? request.url).includes("?")) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign region packs do not accept query parameters");
    if (typeof request.headers["content-type"] !== "string" || !JSON_TYPE.test(request.headers["content-type"])) {
      return sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign region packs require application/json");
    }
  };

  app.post("/campaigns/:campaignId/region-packs", { onRequest: async (r, p) => gate(r, p) }, async (request: any, reply) => {
    const id = resourceIdSchema.safeParse(request.params.campaignId);
    if (!id.success) return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    const parsed = campaignRegionPackRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign region pack request is invalid");
    const campaignId = id.data, body = parsed.data;
    const requestDigest = digest({
      kind: "campaign-region-pack", campaignId, idempotencyKey: body.idempotencyKey, brief: body.brief,
      tone: body.tone ?? null, exclusions: body.exclusions ?? [], anchorLocationKey: body.anchorLocationKey ?? null,
      locationCount: body.locationCount, linked: body.linked ?? null,
    });
    let repo: Repo | undefined, owned: { attempt: number; startedAt: number } | null = null;
    try {
      repo = options.generationDraftRepositoryAccessor();
      const existing = repo.getGenerationDraftByIdempotencyKey(OWNER, campaignId, body.idempotencyKey);
      if (existing) {
        const draft = privateDraft(existing);
        const storedDigest = stagedCampaignContentGenerationSchema.parse(draft.stagedContent).requestDigest;
        if (storedDigest !== requestDigest) throw new AdventureTurnConflictError("idempotency key was reused");
        const applied = applyRegionPack(repo, draft, body.idempotencyKey);
        return reply.code(201).send(regionPackSummary(repo, campaignId, applied, body.anchorLocationKey));
      }

      const campaign = repo.getCampaign(OWNER, campaignId);
      const administration = repo.getCampaignAdministration(OWNER, campaignId);
      const starting = repo.getCampaignStartingLocation(OWNER, campaignId);
      if (!campaign || !administration || !starting) throw new AdventureTurnUnavailableError();
      const anchorRequired = starting.startingLocation !== null;
      if (anchorRequired && !body.anchorLocationKey) {
        return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign region packs require anchorLocationKey once a starting location is designated");
      }
      const expandKeys = body.anchorLocationKey ? [body.anchorLocationKey] : [];
      const context = repo.getCampaignGenerationContext(OWNER, campaignId, expandKeys);
      const safety = repo.getSessionZeroSafetyPolicy(OWNER, campaignId);
      if (!context || !safety) throw new AdventureTurnUnavailableError();
      if (body.anchorLocationKey) {
        const anchor = context.artifacts.find((item) => item.key === body.anchorLocationKey);
        if (!anchor || anchor.kind !== "location" || anchor.visibility !== "public") {
          throw new AdventureTurnConflictError("region pack anchor location is not accepted public canon");
        }
      }

      const provider = await getProviderSettings();
      const jobId = `campaign-region-pack-${digest(`${campaignId}:${body.idempotencyKey}`).slice(0, 40)}`;
      const startedAt = Date.now();
      const call = repo.beginCampaignGenerationCall(campaignId, body.idempotencyKey, requestDigest, {
        provider: provider?.providerType || "unconfigured",
        model: provider?.model.trim() || "none",
        operation: "campaign-region-pack",
        stage: "candidate",
        promptVersion: "campaign-region-pack-v1",
        schemaVersion: "campaign-content-v4",
        jobId,
      }, null);
      if (call.state === "succeeded" && call.draftId) {
        const applied = applyRegionPack(repo, privateDraft(repo.getGenerationDraft(OWNER, call.draftId)), body.idempotencyKey);
        return reply.code(201).send(regionPackSummary(repo, campaignId, applied, body.anchorLocationKey));
      }
      if (!call.acquired) {
        for (let index = 0; index < 40 && call.state === "running"; index++) {
          await sleep(25);
          const winner = repo.getCampaignGenerationCall(campaignId, body.idempotencyKey, requestDigest);
          if (winner?.state === "succeeded" && winner.draftId) {
            const applied = applyRegionPack(repo, privateDraft(repo.getGenerationDraft(OWNER, winner.draftId)), body.idempotencyKey);
            return reply.code(201).send(regionPackSummary(repo, campaignId, applied, body.anchorLocationKey));
          }
          if (winner?.state === "failed") throw new AdventureTurnConflictError("the acknowledged provider attempt failed");
        }
        throw new AdventureTurnConflictError("generation call is still in progress");
      }

      owned = { attempt: call.attempt, startedAt };
      const safeCanon = {
        artifacts: context.artifacts.filter((item) => item.visibility === "public")
          .map((item) => ({ key: item.key, kind: item.kind, content: publicGenerationCanon(item.canonical) })),
        rulesIdentity: context.rulesIdentity,
        catalog: context.catalogDefinitions,
        safety: { hardLimits: safety.hardLimits, veils: safety.veils, pvpPolicy: safety.pvpPolicy, romancePolicy: safety.romancePolicy, lethalityPolicy: safety.lethalityPolicy },
      };
      const sections = regionPackSections(body.linked);
      const generationInput: CampaignContentGenerationRequest = {
        campaignId,
        brief: buildRegionPackBrief({
          brief: body.brief, tone: body.tone, exclusions: body.exclusions, locationCount: body.locationCount,
          linked: body.linked, anchorLocationKey: body.anchorLocationKey, anchorRequired,
        }),
        tone: body.tone ?? "grounded",
        exclusions: body.exclusions ?? [],
        idempotencyKey: body.idempotencyKey,
        sections,
        expandArtifactKeys: expandKeys,
        revisionFeedback: null,
        retryFailedAttempt: null,
      };
      const generationOptions = {
        generationDraftRepositoryAccessor: options.generationDraftRepositoryAccessor,
        ...(options.generateCampaignContent ? { generateCampaignContent: options.generateCampaignContent } : {}),
      } as unknown as CampaignContentGenerationOptions;
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
      const generated = await generateRegionPackCandidate(generationInput, safeCanon, generationOptions, abort.signal, provider);
      const dependencies = new Map(context.artifacts.map((item) => [item.key, item.visibility] as const));
      const catalogReferences = new Set(context.catalogDefinitions.map((item) => referenceIdentity(item.reference)));
      const sanitized = sanitizeGeneratedCampaignContent(generated.content, dependencies, catalogReferences);
      const content = validateContent(sanitized, sections, dependencies, catalogReferences);
      validateRegionPack(content, {
        locationCount: body.locationCount,
        ...(body.anchorLocationKey !== undefined ? { anchorLocationKey: body.anchorLocationKey } : {}),
        anchorRequired,
        acceptedLocationKeys: new Set(context.artifacts.filter((item) => item.kind === "location" && item.visibility === "public").map((item) => item.key)),
      });

      const usage = generated.usage, pricing = provider?.pricing;
      const estimatedCostUsd = usage && pricing && pricing.promptPerMillion !== null && pricing.completionPerMillion !== null
        ? (usage.promptTokens * pricing.promptPerMillion + usage.completionTokens * pricing.completionPerMillion) / 1_000_000
        : null;
      const draft = repo.stageCampaignGenerationAtomically(OWNER, {
        campaignId,
        timelineId: campaign.activeTimelineId,
        kind: "content-pack",
        stagedContent: {
          kind: "campaign-content", requestDigest, baseContentRevision: context.revision,
          dependencyDigests: Object.fromEntries(context.artifacts.map((item) => [item.key, item.digest])), ...content,
        },
        validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
        expectedCampaignRevision: administration.revision,
        idempotencyKey: body.idempotencyKey,
      }, call.attempt, content, context.artifacts, {
        responseModel: generated.responseModel,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd,
      });
      owned = null;
      const applied = applyRegionPack(repo, draft, body.idempotencyKey);
      return reply.code(201).send(regionPackSummary(repo, campaignId, applied, body.anchorLocationKey));
    } catch (error) {
      if (repo && owned) {
        try {
          repo.finishCampaignGenerationCall(campaignId, body.idempotencyKey, owned.attempt, null,
            error instanceof RegionPackLeaseExpired ? "outcome-uncertain" : "generation-failed",
            { responseModel: null, promptTokens: null, completionTokens: null, totalTokens: null, latencyMs: Date.now() - owned.startedAt, estimatedCostUsd: null });
        } catch { /* the durable call already settled */ }
      }
      if (error instanceof RegionPackLeaseExpired) {
        return sendApiProblem(request, reply, 503, "RPG_GENERATION_OUTCOME_UNCERTAIN", "Provider ownership expired; payment and response outcome are uncertain. Reconcile before explicitly acknowledging another paid attempt.");
      }
      return problem(request, reply, error);
    }
  });
};
