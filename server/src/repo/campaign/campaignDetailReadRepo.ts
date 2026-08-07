// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import { campaignDetailSchema } from "@velvet/contracts";
import type {
  CampaignAccess,
  CampaignContentConfiguration,
  CampaignDetail,
} from "../../types.js";

interface CampaignDetailReadDependencies {
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  getCampaignContentConfiguration(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignContentConfiguration | null;
}

export interface CampaignDetailReadRepository {
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
}

export function createCampaignDetailReadRepository(
  dependencies: CampaignDetailReadDependencies,
): CampaignDetailReadRepository {
  return {
    getCampaignDetail(actorPrincipalId, campaignId) {
      const campaign = dependencies.getCampaign(actorPrincipalId, campaignId);
      if (!campaign) return null;
      const configuration = dependencies.getCampaignContentConfiguration(actorPrincipalId, campaignId);
      return campaignDetailSchema.parse({
        id: campaign.id,
        name: campaign.name,
        actorRole: campaign.actorRole,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        content: configuration
          ? {
            status: "configured",
            rulesProfileId: configuration.rulesProfileId,
            contentPacks: configuration.contentPacks,
          }
          : { status: "unconfigured" },
      });
    },
  };
}
