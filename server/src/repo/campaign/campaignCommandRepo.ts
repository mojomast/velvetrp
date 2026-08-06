// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type { CommandEnvelope, CommandReceipt } from "../../types.js";
import type { CampaignDiceEvent, CampaignDiceVisibleCharacterBinding } from "../diceRepo.js";

export interface CampaignCommandRepository {
  executeRollActorDice(actorPrincipalId: string, input: CommandEnvelope): CommandReceipt;
  executeRollActorDiceForVisibleCharacter(actorPrincipalId: string, input: CommandEnvelope, inputBinding: CampaignDiceVisibleCharacterBinding): CommandReceipt;
  listRecentCampaignDiceEvents(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignDiceEvent[];
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CommandReceipt | null;
}

export function createCampaignCommandRepository(
  operations: CampaignCommandRepository,
): CampaignCommandRepository {
  return operations;
}
