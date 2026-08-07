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
/**
 * Compatibility export for the established campaign repository factory path.
 * New implementation code belongs in `campaignRepositoryOrchestration`, but
 * the public repository barrel still imports this root facade.
 */
export { createRepository, type CreateRepositoryOptions } from "./campaignRepositoryOrchestration.js";

/**
 * @deprecated Compatibility delegate for callers importing this historical root API.
 * Prefer `createCampaignEventReadRepository(db).listRecentCampaignDiceEvents`.
 * The caller supplies and retains ownership of `db`; this delegate neither
 * opens nor closes it and can participate in the caller's synchronous SQLite
 * transaction.
 */
export function listRecentCampaignDiceEventsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  timelineId: string,
) {
  return createCampaignEventReadRepository(db)
    .listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId);
}

/**
 * @deprecated Compatibility delegate for callers importing this historical root API.
 * Prefer `createCampaignEventReadRepository(db).getCommandReceipt`. The caller
 * supplies and retains ownership of `db`; this delegate neither opens nor
 * closes it and can participate in the caller's synchronous SQLite transaction.
 */
export function getCommandReceiptSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  campaignId: string,
  commandId: string,
) {
  return createCampaignEventReadRepository(db)
    .getCommandReceipt(actorPrincipalId, campaignId, commandId);
}
