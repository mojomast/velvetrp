// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type { CampaignCharacterCreationOptionsResponse, CampaignCharacterRead } from "../../types.js";
import type {
  CampaignCharacterRosterSnapshot,
  CampaignCharacterSheetSnapshot,
  CampaignCharacterWorkspaceSnapshot,
} from "../campaignRepo.js";

interface CampaignActorOperations {
  getCampaignCharacterCreationOptions(actorPrincipalId: string, campaignId: string): CampaignCharacterCreationOptionsResponse | null;
  getCampaignCharacterRoster(actorPrincipalId: string, campaignId: string): CampaignCharacterRosterSnapshot | null;
  getCampaignCharacterWorkspace(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterWorkspaceSnapshot | null;
  getCampaignCharacterSheetSnapshot(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterSheetSnapshot | null;
  listCampaignCharacters(actorPrincipalId: string, campaignId: string): CampaignCharacterRead[];
  getCampaignCharacter(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterRead | null;
  getCampaignCharacterByActorId(actorPrincipalId: string, campaignId: string, actorId: string): CampaignCharacterRead | null;
}

/** Safe, actor-authorized campaign character projections. */
export interface CampaignActorRepository {
  getCampaignCharacterCreationOptions(actorPrincipalId: string, campaignId: string): CampaignCharacterCreationOptionsResponse | null;
  getCampaignCharacterRoster(actorPrincipalId: string, campaignId: string): CampaignCharacterRosterSnapshot | null;
  getCampaignCharacterWorkspace(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterWorkspaceSnapshot | null;
  getCampaignCharacterSheetSnapshot(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterSheetSnapshot | null;
  listCampaignCharacters(actorPrincipalId: string, campaignId: string): CampaignCharacterRead[];
  getCampaignCharacter(actorPrincipalId: string, campaignId: string, campaignCharacterId: string): CampaignCharacterRead | null;
  getCampaignCharacterByActorId(actorPrincipalId: string, campaignId: string, actorId: string): CampaignCharacterRead | null;
}

export function createCampaignActorRepository(
  operations: CampaignActorOperations,
): CampaignActorRepository {
  return operations;
}
