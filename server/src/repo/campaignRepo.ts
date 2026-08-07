import type DatabaseDriver from "better-sqlite3";
import { createCampaignEventReadRepository } from "./campaign/campaignEventReadRepo.js";

export {
  CampaignDiceCharacterConflict,
  type CampaignDiceEvent,
  type CampaignDiceVisibleCharacterBinding,
} from "./diceRepo.js";
export {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
} from "./campaign/campaignErrors.js";
export type {
  CampaignCharacterRosterSnapshot,
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
  CampaignEventPage,
  CampaignRoomLinkingSnapshot,
  OriginalStarterCampaignCharacterCreationResult,
  OriginalStarterSetupInspection,
  Repository,
  RepositoryDependencies,
  RepositoryUnitOfWork,
} from "./campaign/campaignTypes.js";
export { createRepository, type CreateRepositoryOptions } from "./campaignRepositoryOrchestration.js";

/** @deprecated Prefer the database-scoped campaign event read repository. */
export function listRecentCampaignDiceEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
) {
  return createCampaignEventReadRepository(db)
    .listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId);
}

/** @deprecated Prefer the database-scoped campaign event read repository. */
export function getCommandReceiptSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  commandId: string,
) {
  return createCampaignEventReadRepository(db)
    .getCommandReceipt(actorPrincipalId, campaignId, commandId);
}

/*
 * Repository orchestration is implemented in campaignRepositoryOrchestration:
 * createCampaignActorOperations, runTransaction, and createRepository compose
 * database-scoped campaign repositories while this root preserves compatibility.
 */
