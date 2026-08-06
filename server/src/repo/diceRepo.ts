import type DatabaseDriver from "better-sqlite3";
import type { CommandEnvelope, CommandReceipt, RpgEvent } from "../types.js";
import type { CampaignCommandRepository } from "./campaign/campaignCommandRepo.js";
import type { RepositoryDependencies } from "./campaign/repositoryDependencies.js";

export type CampaignDiceEvent = Extract<RpgEvent, { type: "actor_dice_rolled" }>;

/** Internal evidence captured by campaign-dice preflight; never a wire shape. */
export interface CampaignDiceVisibleCharacterBinding {
  position: number;
  name: string;
  campaignCharacterId: string;
}

/** A valid preflight character binding no longer matches the locked roster. */
export class CampaignDiceCharacterConflict extends Error {
  readonly code = "CAMPAIGN_DICE_CHARACTER_CONFLICT";
  constructor() {
    super("campaign dice character conflicts with the current roster");
    this.name = "CampaignDiceCharacterConflict";
  }
}

/**
 * Dice-specific repository bound to one database connection and runtime.
 *
 * Keeping this boundary connection-scoped is essential: deterministic RNG,
 * command/event/receipt writes, and visible-character ancestry checks all run
 * through the same transaction-owning implementation.
 */
export interface DiceRepository {
  executeRollActorDice(actorPrincipalId: string, envelope: CommandEnvelope): CommandReceipt;
  executeRollActorDiceForVisibleCharacter(
    actorPrincipalId: string,
    envelope: CommandEnvelope,
    binding: CampaignDiceVisibleCharacterBinding,
  ): CommandReceipt;
  listRecentCampaignDiceEvents(
    actorPrincipalId: string,
    campaignId: string,
    timelineId: string,
  ): CampaignDiceEvent[];
  getCommandReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CommandReceipt | null;
}

export function createDiceRepository(
  db: DatabaseDriver.Database,
  dependencies: RepositoryDependencies,
  commandRepository: CampaignCommandRepository,
): DiceRepository {
  return {
    executeRollActorDice: (actorPrincipalId, envelope) =>
      commandRepository.executeRollActorDice(actorPrincipalId, envelope),
    executeRollActorDiceForVisibleCharacter: (actorPrincipalId, envelope, binding) =>
      commandRepository.executeRollActorDiceForVisibleCharacter(actorPrincipalId, envelope, binding),
    listRecentCampaignDiceEvents: (actorPrincipalId, campaignId, timelineId) =>
      commandRepository.listRecentCampaignDiceEvents(actorPrincipalId, campaignId, timelineId),
    getCommandReceipt: (actorPrincipalId, campaignId, commandId) =>
      commandRepository.getCommandReceipt(actorPrincipalId, campaignId, commandId),
  };
}
