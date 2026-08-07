// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import { revisionSchema } from "@velvet/contracts";
import type { CampaignEventReadRepository } from "./campaignEventReadRepo.js";

const MAX_PUBLIC_CAMPAIGN_EVENT_PAGE_SIZE = 100;

export function createCampaignEventProjectionRepo(eventReadRepository: CampaignEventReadRepository) {
  return {
    listPublicCampaignEvents(
      actorPrincipalId: string,
      campaignId: string,
      timelineId: string,
      afterRevision: number,
      limit: number,
    ) {
      const cursor = revisionSchema.parse(afterRevision);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PUBLIC_CAMPAIGN_EVENT_PAGE_SIZE) {
        throw new RangeError(`campaign event limit must be between 1 and ${MAX_PUBLIC_CAMPAIGN_EVENT_PAGE_SIZE}`);
      }
      const visible = eventReadRepository.listCampaignEvents(actorPrincipalId, campaignId, timelineId)
        .filter((event) => event.revision > cursor);
      const events = visible.slice(0, limit);
      return { events, nextAfterRevision: visible.length > events.length ? events.at(-1)!.revision : null };
    },
  };
}
