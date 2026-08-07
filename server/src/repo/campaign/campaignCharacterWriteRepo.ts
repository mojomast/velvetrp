// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type {
  CreateCampaignCharacterInput,
  PrivilegedCampaignCharacterProjection,
} from "../../types.js";
import type { OriginalStarterCampaignCharacterCreationResult } from "./campaignTypes.js";

/** Write boundary for campaign-character creation. */
export interface CampaignCharacterWriteRepository {
  createCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): PrivilegedCampaignCharacterProjection;
  createOriginalStarterCampaignCharacter(
    actorPrincipalId: string,
    input: CreateCampaignCharacterInput,
  ): OriginalStarterCampaignCharacterCreationResult;
}

export function createCampaignCharacterWriteRepository(
  operations: CampaignCharacterWriteRepository,
): CampaignCharacterWriteRepository {
  return operations;
}
