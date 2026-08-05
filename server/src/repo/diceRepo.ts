import type DatabaseDriver from "better-sqlite3";
import type { CommandEnvelope, CommandReceipt, RpgEvent } from "../types.js";
import {
  executeRollActorDiceForVisibleCharacterSync,
  executeRollActorDiceSync,
  getCommandReceiptSync,
  listRecentCampaignDiceEventsSync,
  type RepositoryDependencies,
} from "./campaignRepo.js";

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
): DiceRepository {
  return {
    executeRollActorDice: (actorPrincipalId, envelope) =>
      executeRollActorDiceSync(db, dependencies, actorPrincipalId, envelope),
    executeRollActorDiceForVisibleCharacter: (actorPrincipalId, envelope, binding) =>
      executeRollActorDiceForVisibleCharacterSync(db, dependencies, actorPrincipalId, envelope, binding),
    listRecentCampaignDiceEvents: (actorPrincipalId, campaignId, timelineId) =>
      listRecentCampaignDiceEventsSync(db, actorPrincipalId, campaignId, timelineId),
    getCommandReceipt: (actorPrincipalId, campaignId, commandId) =>
      getCommandReceiptSync(db, actorPrincipalId, campaignId, commandId),
  };
}
