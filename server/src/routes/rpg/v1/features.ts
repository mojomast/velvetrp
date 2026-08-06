import {
  campaignCreateRequestSchema,
  campaignCreateResponseSchema,
  campaignCharacterCreateRequestSchema,
  campaignCharacterCreateResponseSchema,
  campaignCharacterCreationOptionsResponseSchema,
  campaignCharacterListResponseSchema,
  campaignCharacterWorkspaceResponseSchema,
  campaignDetailResponseSchema,
  campaignDiceHistoryResponseSchema,
  campaignDiceRollRequestSchema,
  campaignDiceRollResponseSchema,
  campaignListResponseSchema,
  campaignMechanicsStarterSetupRequestSchema,
  campaignMechanicsStarterSetupResponseSchema,
  campaignRenameRequestSchema,
  campaignRenameResponseSchema,
  campaignRoomAttachRequestSchema,
  campaignRoomAttachResponseSchema,
  campaignRoomLinkingResponseSchema,
  campaignStarterSetupRequestSchema,
  campaignStarterSetupResponseSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type {
  Campaign,
  CampaignAccess,
  CampaignCharacterCreationOptionsResponse,
  CampaignDetail,
  CampaignRenameRequest,
  CreateCampaignInput,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { IdGenerator } from "../../../runtime.js";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
} from "../../../repo/index.js";
import type { OriginalStarterSetupRepository } from "../../../content/originalStarterSetup.js";
import type {
  MechanicsStarterSetupRepository,
  MechanicsStarterSetupSnapshotRepository,
} from "../../../content/mechanicsStarterSetup.js";
import type { CampaignCharacterRosterSnapshot } from "../../../repo/index.js";
import type { CampaignCharacterWorkspaceSnapshot } from "../../../repo/index.js";
import type { CampaignRoomLinkingSnapshot } from "../../../repo/index.js";
import {
  CampaignDiceUnavailableError,
  CampaignDiceVisibleBindingConflictError,
  createCampaignDiceService,
  type CampaignDiceRepository,
} from "../../../campaignDice.js";
import {
  createOriginalStarterSetupService,
  OriginalStarterSetupConflictError,
  OriginalStarterSetupUnavailableError,
} from "../../../content/originalStarterSetup.js";
import {
  createMechanicsStarterSetupService,
  MechanicsStarterSetupConflictError,
  MechanicsStarterSetupUnavailableError,
} from "../../../content/mechanicsStarterSetup.js";
import {
  createOriginalStarterCharacterCreationService,
  OriginalStarterCharacterCreationConflictError,
  OriginalStarterCharacterCreationUnavailableError,
  OriginalStarterCharacterPersonaUnavailableError,
  type OriginalStarterCharacterCreationRepository,
} from "../../../content/originalStarterCharacterCreation.js";
import {
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../../../content/originalStarterManifest.js";
import { MECHANICS_STARTER_IDENTITY } from "@velvet/contracts";
import { characterBuilderHttpRoutes } from "./characterBuilder.js";
import { characterProgressionRoutes } from "./characterProgression.js";
import { characterSheetHttpRoutes } from "./characterSheet.js";
import { campaignAdministrationHttpRoutes } from "./campaignAdministration.js";
import { campaignMembershipHttpRoutes } from "./campaignMemberships.js";
import { campaignHistoryHttpRoutes } from "./campaignHistory.js";
import { campaignTransferHttpRoutes } from "./campaignTransfer.js";
import type { CharacterBuilderRepository } from "../../../repo/characterBuilderRepo.js";
import type { CharacterProgressionRepository } from "../../../repo/characterProgressionRepo.js";
import type { CampaignAdministrationRepository } from "../../../repo/campaignAdministrationRepo.js";
import type { CampaignEventPage } from "../../../repo/campaignRepo.js";
import { questHttpRoutes } from "./questRoutes.js";
import type { QuestRepository } from "../../../repo/questRepo.js";
import { contentCatalogHttpRoutes } from "./contentCatalog.js";
import type { ContentCatalogRepository } from "../../../repo/contentCatalogRepo.js";
import { actorResourcesHttpRoutes } from "./actorResources.js";
import type { ActorResourceRepository } from "../../../repo/actorResourceRepo.js";
import { actorInventoryHttpRoutes } from "./actorInventory.js";
import type { InventoryRepository } from "../../../repo/inventoryRepo.js";
import { actorRestHttpRoutes } from "./actorRest.js";
import type { RestRepository } from "../../../repo/restRepo.js";

export interface CampaignListRepository extends
  Partial<OriginalStarterSetupRepository>,
  Partial<CampaignDiceRepository>,
  Partial<Pick<CharacterBuilderRepository, "createCharacterDraft" | "getCharacterDraft" | "updateCharacterDraft" | "finalizeCharacterDraft">>,
  Partial<Pick<CharacterProgressionRepository, "getCharacterProgression" | "previewCharacterProgression" | "grantCharacterXp" | "applyCharacterProgression">>,
  Partial<Pick<CampaignAdministrationRepository,
    "getCampaignAdministration" | "updateCampaignAdministration" | "archiveCampaignWithConfirmation"
    | "addAuditedCampaignMembership" | "changeAuditedCampaignMembershipRole" | "removeAuditedCampaignMembership"
    | "detachAuditedCampaignRoom" | "listCampaignTimelineHistory" | "createCampaignCheckpoint"
    | "listCampaignCheckpoints" | "forkCampaignTimeline" | "createCampaignRecap" | "listCampaignRecaps"
    | "getCampaignAdministrationReceipt" | "dryRunCampaignImport">>,
  Partial<QuestRepository>,
  Partial<Pick<ActorResourceRepository, "getActorResourceSnapshot" | "changeActorResourceForActor">>,
  Partial<Pick<InventoryRepository, "getActorInventorySnapshot" | "mutateInventoryForActor">>,
  Partial<Pick<RestRepository, "takeRest">>,
  Partial<Pick<ContentCatalogRepository, "validateContentCatalog" | "publishContentCatalog" | "listContentCatalogPublicationPage" | "getContentCatalogForOwner" | "getCampaignContentCatalog" | "configureCampaignCatalog" | "resolveCampaignCatalog">> {
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  listCampaignMemberships?(actorPrincipalId: string, campaignId: string): unknown[];
  listPublicCampaignEvents?(actorPrincipalId: string, campaignId: string, timelineId: string, afterRevision: number, limit: number): CampaignEventPage;
  getCommandReceipt?(actorPrincipalId: string, campaignId: string, commandId: string): unknown;
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
  createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign;
  getCampaignCharacterCreationOptions(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignCharacterCreationOptionsResponse | null;
  getCampaignCharacterRoster(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignCharacterRosterSnapshot | null;
  getCampaignCharacterWorkspace(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): CampaignCharacterWorkspaceSnapshot | null;
  getCampaignCharacterSheetSnapshot?(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): import("../../../repo/index.js").CampaignCharacterSheetSnapshot | null;
  createOriginalStarterCampaignCharacter: OriginalStarterCharacterCreationRepository["createOriginalStarterCampaignCharacter"];
  resolveCampaignCatalog?: MechanicsStarterSetupSnapshotRepository["resolveCampaignCatalog"];
  installMechanicsStarterCatalog?: MechanicsStarterSetupRepository["installMechanicsStarterCatalog"];
  configureMechanicsStarterCatalog?: MechanicsStarterSetupRepository["configureMechanicsStarterCatalog"];
  renameCampaignIfUnchanged(
    actorPrincipalId: string,
    campaignId: string,
    input: CampaignRenameRequest,
  ): Campaign;
  getCampaignRoomLinkingSnapshot?(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignRoomLinkingSnapshot | null;
  attachCampaignSession?(
    actorPrincipalId: string,
    input: { campaignId: string; sessionId: string },
  ): { campaignId: string; sessionId: string; attachedAt: string };
  close(): void;
}

interface RpgV1RoutesOptions {
  campaignRepositoryFactory: () => CampaignListRepository;
  diceCommandIds: IdGenerator;
}

const LOCAL_CAMPAIGN_PRINCIPAL = "local-owner";
const APPLICATION_JSON = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;

/**
 * Log only reviewed operation context. `request.log` retains Fastify's
 * request-scoped timing context, while exception objects (including cached
 * repository-open errors) are never serialized into production logs.
 */
function logCampaignOperationFailure(
  request: FastifyRequest,
  operation: string,
  level: "error" | "info" = "error",
): void {
  request.log[level]({ operation, method: request.method, route: request.routeOptions.url }, "RPG campaign operation failed");
}

type CharacterBuilderLaneRepository = Pick<CharacterBuilderRepository,
  "createCharacterDraft" | "getCharacterDraft" | "updateCharacterDraft" | "finalizeCharacterDraft">;
type CharacterProgressionLaneRepository = Pick<CharacterProgressionRepository,
  "getCharacterProgression" | "previewCharacterProgression" | "grantCharacterXp" | "applyCharacterProgression">;
type CharacterSheetLaneRepository = Required<Pick<CampaignListRepository, "getCampaignCharacterSheetSnapshot">>;
type CampaignAdministrationLaneRepository = Pick<CampaignAdministrationRepository,
  "getCampaignAdministration" | "updateCampaignAdministration" | "archiveCampaignWithConfirmation">;
type CampaignTransferLaneRepository = Pick<CampaignAdministrationRepository, "dryRunCampaignImport">;
type CampaignMembershipLaneRepository = Pick<CampaignAdministrationRepository,
  "addAuditedCampaignMembership" | "changeAuditedCampaignMembershipRole" | "removeAuditedCampaignMembership"
  | "detachAuditedCampaignRoom"> & {
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): unknown[];
};
type CampaignHistoryLaneRepository = Pick<CampaignAdministrationRepository,
  "listCampaignTimelineHistory" | "createCampaignCheckpoint" | "listCampaignCheckpoints"
  | "forkCampaignTimeline" | "createCampaignRecap" | "listCampaignRecaps" | "getCampaignAdministrationReceipt"> & {
  listPublicCampaignEvents(actorPrincipalId: string, campaignId: string, timelineId: string, afterRevision: number, limit: number): CampaignEventPage;
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): unknown;
};
type QuestLaneRepository = Pick<QuestRepository,
  "listStorylines" | "createStoryline" | "getStoryline" | "updateStoryline" | "listQuests" | "createQuest"
  | "getQuestDetail" | "updateQuest" | "createClue" | "markClueDiscovered" | "createReward" | "grantReward"
  | "completeObjective">;
type ContentCatalogLaneRepository = Pick<ContentCatalogRepository,
  "validateContentCatalog" | "publishContentCatalog" | "listContentCatalogPublicationPage"
  | "getContentCatalogForOwner" | "getCampaignContentCatalog" | "configureCampaignCatalog"
  | "resolveCampaignCatalog">;
type ActorResourceLaneRepository = Pick<ActorResourceRepository,
  "getActorResourceSnapshot" | "changeActorResourceForActor">;
type InventoryLaneRepository = Pick<InventoryRepository,
  "getActorInventorySnapshot" | "mutateInventoryForActor">;
type RestLaneRepository = Pick<RestRepository, "takeRest">;

class UnsupportedCampaignRepositoryError extends Error {
  constructor() {
    super("campaign repository does not support this route");
    this.name = "UnsupportedCampaignRepositoryError";
  }
}

function assertCharacterBuilderRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CharacterBuilderLaneRepository {
  if (typeof repository.createCharacterDraft !== "function"
    || typeof repository.getCharacterDraft !== "function"
    || typeof repository.updateCharacterDraft !== "function"
    || typeof repository.finalizeCharacterDraft !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}

function assertCharacterProgressionRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CharacterProgressionLaneRepository {
  if (typeof repository.getCharacterProgression !== "function"
    || typeof repository.previewCharacterProgression !== "function"
    || typeof repository.grantCharacterXp !== "function"
    || typeof repository.applyCharacterProgression !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}

function assertCharacterSheetRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CharacterSheetLaneRepository {
  if (typeof repository.getCampaignCharacterSheetSnapshot !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}

function assertCampaignAdministrationRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CampaignAdministrationLaneRepository {
  if (typeof repository.getCampaignAdministration !== "function"
    || typeof repository.updateCampaignAdministration !== "function"
    || typeof repository.archiveCampaignWithConfirmation !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}

function assertCampaignTransferRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CampaignTransferLaneRepository {
  if (typeof repository.dryRunCampaignImport !== "function") throw new UnsupportedCampaignRepositoryError();
}

function assertCampaignMembershipRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CampaignMembershipLaneRepository {
  if (typeof repository.addAuditedCampaignMembership !== "function"
    || typeof repository.changeAuditedCampaignMembershipRole !== "function"
    || typeof repository.removeAuditedCampaignMembership !== "function"
    || typeof repository.detachAuditedCampaignRoom !== "function"
    || typeof repository.listCampaignMemberships !== "function") throw new UnsupportedCampaignRepositoryError();
}

function assertCampaignHistoryRepository(
  repository: CampaignListRepository,
): asserts repository is CampaignListRepository & CampaignHistoryLaneRepository {
  if (typeof repository.listCampaignTimelineHistory !== "function"
    || typeof repository.createCampaignCheckpoint !== "function"
    || typeof repository.listCampaignCheckpoints !== "function"
    || typeof repository.forkCampaignTimeline !== "function"
    || typeof repository.createCampaignRecap !== "function"
    || typeof repository.listCampaignRecaps !== "function"
    || typeof repository.getCampaignAdministrationReceipt !== "function"
    || typeof repository.listPublicCampaignEvents !== "function"
    || typeof repository.getCommandReceipt !== "function") throw new UnsupportedCampaignRepositoryError();
}

function assertQuestRepository(repository: CampaignListRepository): asserts repository is CampaignListRepository & QuestLaneRepository {
  const methods: Array<keyof QuestLaneRepository> = [
    "listStorylines", "createStoryline", "getStoryline", "updateStoryline", "listQuests", "createQuest",
    "getQuestDetail", "updateQuest", "createClue", "markClueDiscovered", "createReward", "grantReward",
    "completeObjective",
  ];
  if (methods.some((method) => typeof repository[method] !== "function")) throw new UnsupportedCampaignRepositoryError();
}
function assertContentCatalogRepository(repository: CampaignListRepository): asserts repository is CampaignListRepository & ContentCatalogLaneRepository {
  const methods: Array<keyof ContentCatalogLaneRepository> = ["validateContentCatalog", "publishContentCatalog", "listContentCatalogPublicationPage", "getContentCatalogForOwner", "getCampaignContentCatalog", "configureCampaignCatalog", "resolveCampaignCatalog"];
  if (methods.some((method) => typeof repository[method] !== "function")) throw new UnsupportedCampaignRepositoryError();
}
function assertActorResourceRepository(repository: CampaignListRepository): asserts repository is CampaignListRepository & ActorResourceLaneRepository {
  if (typeof repository.getActorResourceSnapshot !== "function" || typeof repository.changeActorResourceForActor !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}
function assertInventoryRepository(repository: CampaignListRepository): asserts repository is CampaignListRepository & InventoryLaneRepository {
  if (typeof repository.getActorInventorySnapshot !== "function" || typeof repository.mutateInventoryForActor !== "function") {
    throw new UnsupportedCampaignRepositoryError();
  }
}
function assertRestRepository(repository: CampaignListRepository): asserts repository is CampaignListRepository & RestLaneRepository {
  if (typeof repository.takeRest !== "function") throw new UnsupportedCampaignRepositoryError();
}

export const rpgV1Routes: FastifyPluginAsync<RpgV1RoutesOptions> = async (app, options) => {
  // The plugin lazily owns one narrow repository for its lifetime; requests never open DB connections repeatedly.
  let repositoryState:
    | { status: "ready"; repository: CampaignListRepository }
    | { status: "failed"; error: unknown }
    | null = null;
  let repositoryClosed = false;
  app.addHook("onClose", async () => {
    if (!repositoryClosed) {
      repositoryClosed = true;
      if (repositoryState?.status === "ready") repositoryState.repository.close();
    }
  });

  function getCampaignRepository(): CampaignListRepository {
    if (repositoryState === null) {
      try {
        repositoryState = { status: "ready", repository: options.campaignRepositoryFactory() };
      } catch (error) {
        // Opening is attempted once per plugin lifetime; recovery requires a fresh app instance.
        repositoryState = { status: "failed", error };
      }
    }
    if (repositoryState.status === "failed") throw repositoryState.error;
    return repositoryState.repository;
  }

  app.get("/features", async () => readRpgFeatureFlags());

  // Child lanes share this exact lazy repository and its single onClose hook.
  // They are registered with relative paths because this plugin owns /api/rpg/v1.
  const characterBuilderRepositoryAccessor = (): CharacterBuilderLaneRepository => {
    const repository = getCampaignRepository();
    assertCharacterBuilderRepository(repository);
    return repository;
  };
  const characterProgressionRepositoryAccessor = (): CharacterProgressionLaneRepository => {
    const repository = getCampaignRepository();
    assertCharacterProgressionRepository(repository);
    return repository;
  };
  const characterSheetRepositoryAccessor = (): CharacterSheetLaneRepository => {
    const repository = getCampaignRepository();
    assertCharacterSheetRepository(repository);
    return repository;
  };
  const campaignAdministrationRepositoryAccessor = (): CampaignAdministrationLaneRepository => {
    const repository = getCampaignRepository();
    assertCampaignAdministrationRepository(repository);
    return repository;
  };
  const campaignTransferRepositoryAccessor = (): CampaignTransferLaneRepository => {
    const repository = getCampaignRepository();
    assertCampaignTransferRepository(repository);
    return repository;
  };
  const campaignMembershipRepositoryAccessor = (): CampaignMembershipLaneRepository => {
    const repository = getCampaignRepository();
    assertCampaignMembershipRepository(repository);
    return repository;
  };
  const campaignHistoryRepositoryAccessor = (): CampaignHistoryLaneRepository => {
    const repository = getCampaignRepository();
    assertCampaignHistoryRepository(repository);
    return repository;
  };
  const questRepositoryAccessor = (): QuestLaneRepository => {
    const repository = getCampaignRepository();
    assertQuestRepository(repository);
    return repository;
  };
  const contentCatalogRepositoryAccessor = (): ContentCatalogLaneRepository => {
    const repository = getCampaignRepository();
    assertContentCatalogRepository(repository);
    return repository;
  };
  const actorResourceRepositoryAccessor = (): ActorResourceLaneRepository => {
    const repository = getCampaignRepository();
    assertActorResourceRepository(repository);
    return repository;
  };
  const inventoryRepositoryAccessor = (): InventoryLaneRepository => {
    const repository = getCampaignRepository();
    assertInventoryRepository(repository);
    return repository;
  };
  const restRepositoryAccessor = (): RestLaneRepository => {
    const repository = getCampaignRepository();
    assertRestRepository(repository);
    return repository;
  };
  await app.register(characterBuilderHttpRoutes, {
    characterBuilderRepositoryAccessor,
  });
  await app.register(characterProgressionRoutes, {
    characterProgressionRepositoryAccessor,
  });
  await app.register(characterSheetHttpRoutes, {
    characterSheetRepositoryAccessor,
  });
  await app.register(campaignAdministrationHttpRoutes, {
    campaignAdministrationRepositoryAccessor,
  });
  await app.register(campaignTransferHttpRoutes, { campaignTransferRepositoryAccessor });
  await app.register(campaignMembershipHttpRoutes, { campaignMembershipRepositoryAccessor });
  await app.register(campaignHistoryHttpRoutes, { campaignHistoryRepositoryAccessor });
  await app.register(questHttpRoutes, { questRepositoryAccessor });
  await app.register(contentCatalogHttpRoutes, { contentCatalogRepositoryAccessor });
  await app.register(actorResourcesHttpRoutes, { actorResourceRepositoryAccessor });
  await app.register(actorInventoryHttpRoutes, { inventoryRepositoryAccessor });
  await app.register(actorRestHttpRoutes, { restRepositoryAccessor });

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/rooms", { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign rooms do not accept query parameters");
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    try {
      const repository = getCampaignRepository();
      if (typeof repository.getCampaignRoomLinkingSnapshot !== "function") {
        throw new Error("campaign repository does not support room linking");
      }
      const snapshot = repository.getCampaignRoomLinkingSnapshot(LOCAL_CAMPAIGN_PRINCIPAL, campaignId.data);
      if (snapshot === null) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (snapshot.campaignId !== campaignId.data) throw new Error("campaign room snapshot does not match the request");
      return campaignRoomLinkingResponseSchema.parse({ attached: snapshot.attached, eligible: snapshot.eligible });
    } catch {
      logCampaignOperationFailure(request, "campaign-room-list");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign rooms could not be loaded");
    }
  });

  app.put<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/rooms", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!readRpgFeatureFlags().campaign) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign room attachment does not accept query parameters");
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) {
        await sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign room attachment requires application/json");
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-room-attach-body", "info");
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign room attachment request is invalid");
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const body = campaignRoomAttachRequestSchema.safeParse(request.body);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    if (!body.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign room attachment request is invalid");
    }
    try {
      const repository = getCampaignRepository();
      if (typeof repository.attachCampaignSession !== "function") {
        throw new Error("campaign repository does not support room attachment");
      }
      const attachment = repository.attachCampaignSession(LOCAL_CAMPAIGN_PRINCIPAL, {
        campaignId: campaignId.data, sessionId: body.data.sessionId,
      });
      if (attachment.campaignId !== campaignId.data || attachment.sessionId !== body.data.sessionId) {
        throw new Error("campaign room attachment does not match the request");
      }
      return reply.code(200).send(campaignRoomAttachResponseSchema.parse({
        attachment: { sessionId: attachment.sessionId, attachedAt: attachment.attachedAt },
      }));
    } catch (error) {
      if (error instanceof CampaignSessionAttachmentUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof CampaignSessionAttachmentSessionMissingError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_ROOM_NOT_FOUND", "Room not found");
      }
      if (error instanceof CampaignSessionAttachmentConflictError) {
        return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_ROOM_CONFLICT", "Room cannot be attached to this campaign");
      }
      logCampaignOperationFailure(request, "campaign-room-attach");
      return sendApiProblem(
        request, reply, 500, "RPG_INTERNAL_ERROR",
        "Campaign room attachment status is unknown; refresh campaign rooms before trying again; never retry automatically",
      );
    }
  });

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/dice-rolls", { exposeHeadRoute: false }, async (request, reply) => {
    const flags = readRpgFeatureFlags();
    reply.header("cache-control", "no-store");
    if (!flags.campaign || !flags.mechanics) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Campaign dice history does not accept query parameters",
      );
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    try {
      const repository = getCampaignRepository();
      if (typeof repository.transaction !== "function") {
        throw new Error("campaign repository does not support dice operations");
      }
      const response = createCampaignDiceService(repository as CampaignDiceRepository, options.diceCommandIds)
        .read(LOCAL_CAMPAIGN_PRINCIPAL, campaignId.data);
      return campaignDiceHistoryResponseSchema.parse(response);
    } catch (error) {
      if (error instanceof CampaignDiceUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      logCampaignOperationFailure(request, "campaign-dice-history");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign dice history could not be loaded; refresh is required");
    }
  });

  app.post<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/dice-rolls", {
    onRequest: async (request, reply) => {
      const flags = readRpgFeatureFlags();
      reply.header("cache-control", "no-store");
      if (!flags.campaign || !flags.mechanics) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(
          request, reply, 400, "RPG_INVALID_REQUEST", "Campaign dice roll does not accept query parameters",
        );
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) {
        await sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(
          request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign dice roll requires application/json",
        );
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-dice-roll-body", "info");
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign dice roll request is invalid");
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const body = campaignDiceRollRequestSchema.safeParse(request.body);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    if (!body.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign dice roll request is invalid");
    }
    try {
      const repository = getCampaignRepository();
      if (typeof repository.transaction !== "function"
          || typeof repository.executeRollActorDiceForVisibleCharacter !== "function") {
        throw new Error("campaign repository does not support dice operations");
      }
      const response = createCampaignDiceService(repository as CampaignDiceRepository, options.diceCommandIds)
        .roll(LOCAL_CAMPAIGN_PRINCIPAL, campaignId.data, body.data);
      return reply.code(201).send(campaignDiceRollResponseSchema.parse(response));
    } catch (error) {
      if (error instanceof CampaignDiceUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof CampaignDiceVisibleBindingConflictError) {
        return sendApiProblem(
          request, reply, 409, "RPG_CAMPAIGN_DICE_BINDING_CONFLICT",
          "Campaign character selection changed; refresh dice history before rolling",
        );
      }
      logCampaignOperationFailure(request, "campaign-dice-roll");
      return sendApiProblem(
        request, reply, 500, "RPG_INTERNAL_ERROR",
        "Dice roll status is unknown; refresh dice history before trying again; never retry automatically",
      );
    }
  });

  app.get<{ Querystring: Record<string, unknown> }>("/campaigns", { exposeHeadRoute: false }, async (request, reply) => {
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if (Object.keys(request.query).length > 0) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign list does not accept query parameters");
    }

    try {
      // This literal is trusted local context, not caller-controlled identity or authentication.
      const campaignRepository = getCampaignRepository();
      return campaignListResponseSchema.parse({
        campaigns: campaignRepository.listCampaigns(LOCAL_CAMPAIGN_PRINCIPAL),
      });
    } catch {
      logCampaignOperationFailure(request, "campaign-list");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaigns could not be loaded");
    }
  });

  app.get<{
    Params: { campaignId: string; campaignCharacterId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/characters/:campaignCharacterId/workspace", { exposeHeadRoute: false }, async (request, reply) => {
    // Workspaces can contain mutable character state. Apply this before every
    // validation branch so successes and scoped problems are never cached.
    reply.header("cache-control", "no-store");
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST",
        "Campaign character workspace does not accept query parameters",
      );
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const campaignCharacterId = resourceIdSchema.safeParse(request.params.campaignCharacterId);
    if (!campaignId.success || !campaignCharacterId.success) {
      return sendApiProblem(
        request, reply, 404, "RPG_CAMPAIGN_CHARACTER_NOT_FOUND", "Campaign character not found",
      );
    }

    try {
      const result = getCampaignRepository().getCampaignCharacterWorkspace(
        LOCAL_CAMPAIGN_PRINCIPAL, campaignId.data, campaignCharacterId.data,
      );
      if (result === null) {
        return sendApiProblem(
          request, reply, 404, "RPG_CAMPAIGN_CHARACTER_NOT_FOUND", "Campaign character not found",
        );
      }
      if (result.campaignId !== campaignId.data
        || result.campaignCharacterId !== campaignCharacterId.data) {
        throw new Error("campaign character workspace output does not match the request");
      }
      return campaignCharacterWorkspaceResponseSchema.parse({ character: result.character });
    } catch {
      logCampaignOperationFailure(request, "campaign-character-workspace");
      return sendApiProblem(
        request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign character workspace could not be loaded",
      );
    }
  });

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/characters/creation-options", { exposeHeadRoute: false }, async (request, reply) => {
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return sendApiProblem(
        request,
        reply,
        400,
        "RPG_INVALID_REQUEST",
        "Campaign character creation options do not accept query parameters",
      );
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }

    try {
      const campaignRepository = getCampaignRepository();
      // This is fixed trusted-local context, never caller-supplied identity.
      const optionsResult = campaignRepository.getCampaignCharacterCreationOptions(
        LOCAL_CAMPAIGN_PRINCIPAL,
        campaignId.data,
      );
      // Only the repository's documented null sentinel means unavailable.
      // Every other value must satisfy the strict response contract below.
      if (optionsResult === null) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      const response = campaignCharacterCreationOptionsResponseSchema.parse(optionsResult);
      if (response.campaignId !== campaignId.data) {
        throw new Error("campaign character creation-options output does not match the request");
      }
      return response;
    } catch {
      logCampaignOperationFailure(request, "campaign-character-creation-options");
      return sendApiProblem(
        request,
        reply,
        500,
        "RPG_INTERNAL_ERROR",
        "Campaign character creation options could not be loaded",
      );
    }
  });

  app.post<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/characters", {
    onRequest: async (request, reply) => {
      if (!readRpgFeatureFlags().campaign) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      // Inspect the raw target so even a bare trailing `?` is rejected.
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(
          request, reply, 400, "RPG_INVALID_REQUEST",
          "Campaign character creation does not accept query parameters",
        );
        return;
      }
      // Path validity deliberately precedes media/body parsing and repository opening.
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) {
        await sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(
          request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
          "Campaign character creation requires application/json",
        );
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-character-create-body", "info");
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Campaign character creation request is invalid",
      );
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    const body = campaignCharacterCreateRequestSchema.safeParse(request.body);
    // The path was checked in onRequest; retain a defensive check without opening the repository.
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    if (!body.success) {
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Campaign character creation request is invalid",
      );
    }

    try {
      const repository = getCampaignRepository();
      if (typeof repository.createOriginalStarterCampaignCharacter !== "function") {
        throw new Error("campaign repository does not support original starter character creation");
      }
      // Campaign, controller, content and aggregate fields stay server-owned in
      // the fixed trusted-local service. The caller selects only one persona.
      const rawResponse = createOriginalStarterCharacterCreationService(
        repository as OriginalStarterCharacterCreationRepository,
      ).create(campaignId.data, body.data);
      const response = campaignCharacterCreateResponseSchema.parse(rawResponse);
      if (response.character.characterId !== body.data.characterId) {
        throw new Error("campaign character creation output does not match the request");
      }
      return reply.code(201).send(response);
    } catch (error) {
      if (error instanceof OriginalStarterCharacterCreationUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof OriginalStarterCharacterPersonaUnavailableError) {
        return sendApiProblem(
          request, reply, 404, "RPG_CAMPAIGN_CHARACTER_PERSONA_NOT_FOUND", "Persona not found",
        );
      }
      if (error instanceof OriginalStarterCharacterCreationConflictError) {
        return sendApiProblem(
          request, reply, 409, "RPG_CAMPAIGN_CHARACTER_CREATE_CONFLICT",
          "Campaign character could not be created because of a conflict",
        );
      }
      logCampaignOperationFailure(request, "campaign-character-create");
      return sendApiProblem(
        request,
        reply,
        500,
        "RPG_INTERNAL_ERROR",
        "Campaign character creation status is unknown; reconciliation with authoritative character list and creation options GETs is required; never retry automatically",
      );
    }
  });

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId/characters", { exposeHeadRoute: false }, async (request, reply) => {
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST",
        "Campaign character roster does not accept query parameters",
      );
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }

    try {
      const result = getCampaignRepository().getCampaignCharacterRoster(
        LOCAL_CAMPAIGN_PRINCIPAL,
        campaignId.data,
      );
      if (result === null) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (result.campaignId !== campaignId.data) {
        throw new Error("campaign character roster output does not match the request");
      }
      return campaignCharacterListResponseSchema.parse({ characters: result.characters });
    } catch {
      logCampaignOperationFailure(request, "campaign-character-roster");
      return sendApiProblem(
        request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign characters could not be loaded",
      );
    }
  });

  app.get<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
  }>("/campaigns/:campaignId", { exposeHeadRoute: false }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!readRpgFeatureFlags().campaign) {
      return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
    }
    if (Object.keys(request.query).length > 0) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign detail does not accept query parameters");
    }
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }

    try {
      const campaignRepository = getCampaignRepository();
      // This literal is trusted local context, not an identity header.
      const campaign = campaignRepository.getCampaignDetail(LOCAL_CAMPAIGN_PRINCIPAL, campaignId.data);
      if (!campaign) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      const response = campaignDetailResponseSchema.parse({ campaign });
      if (response.campaign.id !== campaignId.data) {
        throw new Error("campaign detail output does not match the request");
      }
      return response;
    } catch {
      logCampaignOperationFailure(request, "campaign-detail");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign could not be loaded");
    }
  });

  app.patch<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId", {
    onRequest: async (request, reply) => {
      if (!readRpgFeatureFlags().campaign) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if (Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign rename does not accept query parameters");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign rename requires application/json");
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-rename-body", "info");
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign rename request is invalid");
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    const parsed = campaignRenameRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign rename request is invalid", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    try {
      const campaignRepository = getCampaignRepository();
      const campaign = campaignRepository.renameCampaignIfUnchanged(
        LOCAL_CAMPAIGN_PRINCIPAL,
        campaignId.data,
        parsed.data,
      );
      const response = campaignRenameResponseSchema.parse({
        campaign: { id: campaign.id, name: campaign.name, updatedAt: campaign.updatedAt },
      });
      // Schema validity alone is insufficient: every successful write must
      // advance the stale token strictly beyond the observed precondition.
      if (response.campaign.id !== campaignId.data
        || response.campaign.name !== parsed.data.name
        || response.campaign.updatedAt <= parsed.data.expectedUpdatedAt) {
        throw new Error("campaign rename output does not match the request");
      }
      return response;
    } catch (error) {
      if (error instanceof CampaignRenameUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof CampaignRenameStaleError) {
        return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_RENAME_STALE", "Campaign rename precondition is stale");
      }
      logCampaignOperationFailure(request, "campaign-rename");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign could not be renamed");
    }
  });

  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/campaigns", {
    onRequest: async (request, reply) => {
      if (!readRpgFeatureFlags().campaign) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if (Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign creation does not accept query parameters");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Campaign creation requires application/json");
      }
    },
    errorHandler: (_error, request, reply) => {
      // Fastify parses JSON before the handler. Collapse malformed and empty
      // JSON into the same public contract as a schema-invalid body.
      logCampaignOperationFailure(request, "campaign-create-body", "info");
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign creation request is invalid");
    },
  }, async (request, reply) => {
    const parsed = campaignCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Campaign creation request is invalid", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      });
    }

    try {
      const campaignRepository = getCampaignRepository();
      const response = campaignCreateResponseSchema.parse({
        // This literal is trusted local context, never caller identity.
        campaign: campaignRepository.createCampaign(LOCAL_CAMPAIGN_PRINCIPAL, parsed.data),
      });
      return reply.code(201).send(response);
    } catch (error) {
      if (error instanceof CampaignCreationAuthorizationError) {
        return sendApiProblem(request, reply, 403, "RPG_CAMPAIGN_CREATE_FORBIDDEN", "Campaign creation is not permitted");
      }
      if (error instanceof CampaignCreationIdCollisionError) {
        return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_CREATE_CONFLICT", "Campaign could not be created because of a conflict");
      }
      logCampaignOperationFailure(request, "campaign-create");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign could not be created");
    }
  });

  app.put<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/starter-setup", {
    exposeHeadRoute: false,
    onRequest: async (request, reply) => {
      if (!readRpgFeatureFlags().campaign) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if (Object.keys(request.query).length > 0) {
        await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starter setup does not accept query parameters");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Starter setup requires application/json");
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-starter-setup-body", "info");
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starter setup request is invalid");
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    const body = campaignStarterSetupRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Starter setup request is invalid", {
        issues: body.error.issues.map((issue) => ({
          path: issue.path.join("."), code: issue.code, message: issue.message,
        })),
      });
    }

    try {
      const repository = getCampaignRepository();
      if (typeof repository.inspectOriginalStarterSetup !== "function"
        || typeof repository.installOriginalStarterContent !== "function"
        || typeof repository.configureOriginalStarterContent !== "function") {
        throw new Error("campaign repository does not support starter setup");
      }
      const campaign = createOriginalStarterSetupService(repository as OriginalStarterSetupRepository)
        .setup(campaignId.data);
      const response = campaignStarterSetupResponseSchema.parse({ campaign });
      const content = response.campaign.content;
      if (response.campaign.id !== campaignId.data || response.campaign.actorRole !== "owner"
        || content.status !== "configured"
        || content.rulesProfileId !== ORIGINAL_STARTER_RULES_PROFILE_ID
        || content.contentPacks.length !== 1
        || content.contentPacks[0]?.packId !== ORIGINAL_STARTER_PACK_ID
        || content.contentPacks[0]?.packVersion !== ORIGINAL_STARTER_PACK_VERSION) {
        throw new Error("starter setup output does not prove the exact setup");
      }
      return response;
    } catch (error) {
      if (error instanceof OriginalStarterSetupUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof OriginalStarterSetupConflictError) {
        return sendApiProblem(request, reply, 409, "RPG_CAMPAIGN_STARTER_SETUP_CONFLICT", "Starter setup conflicts with current campaign state");
      }
      logCampaignOperationFailure(request, "campaign-starter-setup");
      return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Campaign starter setup could not be completed");
    }
  });

  app.put<{
    Params: { campaignId: string };
    Querystring: Record<string, unknown>;
    Body: unknown;
  }>("/campaigns/:campaignId/mechanics-starter-setup", {
    exposeHeadRoute: false,
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      // Both flags precede every caller-controlled query/path/media/body check
      // and repository lifecycle touch.
      const flags = readRpgFeatureFlags();
      if (!flags.campaign || !flags.mechanics) {
        await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
        return;
      }
      if ((request.raw.url ?? request.url).includes("?") || Object.keys(request.query).length > 0) {
        await sendApiProblem(
          request, reply, 400, "RPG_INVALID_REQUEST",
          "Mechanics starter setup does not accept query parameters",
        );
        return;
      }
      if (!resourceIdSchema.safeParse(request.params.campaignId).success) {
        await sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
        return;
      }
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !APPLICATION_JSON.test(contentType)) {
        await sendApiProblem(
          request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE",
          "Mechanics starter setup requires application/json",
        );
      }
    },
    errorHandler: (_error, request, reply) => {
      logCampaignOperationFailure(request, "campaign-mechanics-starter-setup-body", "info");
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Mechanics starter setup request is invalid",
      );
    },
  }, async (request, reply) => {
    const campaignId = resourceIdSchema.safeParse(request.params.campaignId);
    if (!campaignId.success) {
      return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
    }
    const body = campaignMechanicsStarterSetupRequestSchema.safeParse(request.body);
    if (!body.success) {
      return sendApiProblem(
        request, reply, 400, "RPG_INVALID_REQUEST", "Mechanics starter setup request is invalid",
        { issues: body.error.issues.map((issue) => ({
          path: issue.path.join("."), code: issue.code, message: issue.message,
        })) },
      );
    }

    try {
      const repository = getCampaignRepository();
      if (typeof repository.transaction !== "function"
        || typeof repository.installMechanicsStarterCatalog !== "function"
        || typeof repository.configureMechanicsStarterCatalog !== "function") {
        throw new Error("campaign repository does not support mechanics starter setup");
      }
      const campaign = createMechanicsStarterSetupService(repository as unknown as MechanicsStarterSetupRepository)
        .setup(campaignId.data);
      const response = campaignMechanicsStarterSetupResponseSchema.parse({ campaign });
      const content = response.campaign.content;
      if (response.campaign.id !== campaignId.data || response.campaign.actorRole !== "owner"
        || content.status !== "configured"
        || content.rulesProfileId !== MECHANICS_STARTER_IDENTITY.rulesProfileId
        || content.contentPacks.length !== 1
        || content.contentPacks[0]?.packId !== MECHANICS_STARTER_IDENTITY.packId
        || content.contentPacks[0]?.packVersion !== MECHANICS_STARTER_IDENTITY.packVersion) {
        throw new Error("mechanics starter setup output does not prove the exact setup");
      }
      return reply.code(200).send(response);
    } catch (error) {
      if (error instanceof MechanicsStarterSetupUnavailableError) {
        return sendApiProblem(request, reply, 404, "RPG_CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      if (error instanceof MechanicsStarterSetupConflictError) {
        return sendApiProblem(
          request, reply, 409, "RPG_CAMPAIGN_MECHANICS_STARTER_SETUP_CONFLICT",
          "Mechanics starter setup conflicts with current campaign state",
        );
      }
      logCampaignOperationFailure(request, "campaign-mechanics-starter-setup");
      return sendApiProblem(
        request, reply, 500, "RPG_INTERNAL_ERROR",
        "Campaign mechanics starter setup status is unknown; reconcile with campaign detail before trying again; never retry automatically",
      );
    }
  });

  app.setNotFoundHandler((request, reply) => {
    // Scoped misses include unsupported methods (including Fastify's implicit
    // HEAD/OPTIONS paths); none may be cached differently from RPG resources.
    reply.header("cache-control", "no-store");
    return sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found");
  });
};
