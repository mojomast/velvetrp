import { createHash } from "node:crypto";
import type { Repository } from "../repo/index.js";
import {
  SINTERMARK_RECIPE_NAME,
  SintermarkBuildStepError,
  readSintermarkRecipe,
  runSintermarkBuildIntoCampaign,
} from "./sintermarkBuilder.js";

export const QUICK_ADVENTURE_CAMPAIGN_NAME = SINTERMARK_RECIPE_NAME;

const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export class QuickAdventureError extends Error {
  readonly step: string;
  readonly campaignId: string | null;

  constructor(step: string, campaignId: string | null, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Quick adventure failed at step ${step}: ${message}`, { cause });
    this.name = "QuickAdventureError";
    this.step = step;
    this.campaignId = campaignId;
  }
}

function keyPrefixForCampaign(campaignId: string): string {
  const raw = `quick.${campaignId}`;
  if (raw.length <= 128 && KEY_PATTERN.test(raw)) return raw;
  return `quick.${createHash("sha256").update(campaignId).digest("hex")}`;
}

function archiveFailedCampaign(repository: Repository, ownerId: string, campaignId: string, keyPrefix: string): void {
  try {
    const administration = repository.getCampaignAdministration(ownerId, campaignId);
    if (!administration || administration.status === "archived") return;
    repository.archiveCampaignWithConfirmation(ownerId, campaignId, {
      confirmationName: QUICK_ADVENTURE_CAMPAIGN_NAME,
      expectedRevision: administration.revision,
      idempotencyKey: `${keyPrefix}.archive`,
    });
  } catch {
    // Archiving is best effort; the original build failure is the useful error.
  }
}

export interface QuickAdventureResult {
  campaignId: string;
  campaignName: string;
  sessionId: string;
  actorId: string;
  heroes: Array<{ name: string; actorId: string; campaignCharacterId: string }>;
}

/**
 * Builds the reviewed Sintermark world into the owner's database as a new
 * campaign. It never reuses an existing campaign and never contacts a model
 * provider; on failure the partial campaign is archived before the step-named
 * error is returned.
 */
export async function createQuickAdventure({
  repository,
  ownerId,
}: {
  repository: Repository;
  ownerId: string;
}): Promise<QuickAdventureResult> {
  let campaignId: string | null = null;
  let keyPrefix: string | null = null;
  try {
    const recipe = readSintermarkRecipe();
    const campaign = repository.createCampaign(ownerId, { name: recipe.name });
    campaignId = campaign.id;
    keyPrefix = keyPrefixForCampaign(campaign.id);

    const built = await runSintermarkBuildIntoCampaign({
      repository,
      ownerId,
      campaignId,
      keyPrefix,
      recipe,
    });
    const heroes = built.heroes.map((hero) => ({
      name: hero.name,
      actorId: hero.actorId,
      campaignCharacterId: hero.campaignCharacterId,
    }));
    return {
      campaignId,
      campaignName: built.recipe.name,
      sessionId: built.sessionId,
      actorId: heroes[0]!.actorId,
      heroes,
    };
  } catch (error) {
    if (campaignId && keyPrefix) archiveFailedCampaign(repository, ownerId, campaignId, keyPrefix);
    const step = error instanceof SintermarkBuildStepError ? error.step : campaignId ? "build" : "create-campaign";
    const cause = error instanceof SintermarkBuildStepError ? error.cause : error;
    throw new QuickAdventureError(step, campaignId, cause);
  }
}
