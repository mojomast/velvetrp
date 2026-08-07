// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { CharacterProgressionRepository } from "../characterProgressionRepo.js";
import type {
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
} from "./campaignTypes.js";

interface CampaignCharacterWorkspaceRepository {
  getCampaignCharacterWorkspace(
    actorPrincipalId: string,
    campaignId: string,
    campaignCharacterId: string,
  ): CampaignCharacterWorkspaceSnapshot | null;
}

/**
 * The caller owns the surrounding SQLite snapshot. The workspace read proves
 * the complete campaign ancestry; progression then narrows visibility to an
 * owner, GM, or the actor's controller before its derived state is returned.
 */
function getCampaignCharacterSheetSnapshotSyncInternal(
  db: DatabaseDriver.Database,
  progressionRepository: CharacterProgressionRepository,
  workspaceRepository: CampaignCharacterWorkspaceRepository,
  actorPrincipalId: string,
  campaignId: string,
  campaignCharacterId: string,
): CampaignCharacterSheetSnapshot | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const targetId = resourceIdSchema.parse(campaignCharacterId);
  const workspace = workspaceRepository.getCampaignCharacterWorkspace(actorId, id, targetId);
  if (workspace === null) return null;

  const progression = progressionRepository.getCharacterProgression(actorId, targetId);
  if (progression === null) return null;
  if (workspace.campaignId !== id || workspace.campaignCharacterId !== targetId
    || progression.campaignId !== id || progression.campaignCharacterId !== targetId) {
    throw new Error("campaign character sheet snapshot is malformed");
  }
  return { campaignId: id, campaignCharacterId: targetId, sheet: workspace.character, progression };
}

export function createCampaignCharacterSheetSnapshotRepository(
  db: DatabaseDriver.Database,
  progressionRepository: CharacterProgressionRepository,
  workspaceRepository: CampaignCharacterWorkspaceRepository,
) {
  return {
    getCampaignCharacterSheetSnapshot: (
      actorPrincipalId: string,
      campaignId: string,
      campaignCharacterId: string,
    ) => getCampaignCharacterSheetSnapshotSyncInternal(
      db,
      progressionRepository,
      workspaceRepository,
      actorPrincipalId,
      campaignId,
      campaignCharacterId,
    ),
  };
}
