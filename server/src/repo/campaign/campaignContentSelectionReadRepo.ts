// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { ContentPack, RulesProfile } from "../../types.js";

interface RulesProfileRow {
  rules_profile_id: string;
  name: string;
  description: string;
  tags: string;
}

interface ContentPackRow extends RulesProfileRow {
  pack_id: string;
  pack_version: string;
}

interface CampaignContentSelectionReadProjectors {
  rulesProfileProjection: string;
  contentPackProjection: string;
  toRulesProfile(row: RulesProfileRow): RulesProfile;
  toContentPack(row: ContentPackRow): ContentPack;
}

export interface CampaignContentSelectionReadRepository {
  getCampaignRulesProfile(actorPrincipalId: string, campaignId: string): RulesProfile | null;
  listCampaignContentPacks(actorPrincipalId: string, campaignId: string): ContentPack[];
}

export function createCampaignContentSelectionReadRepository(
  db: DatabaseDriver.Database,
  projectors: CampaignContentSelectionReadProjectors,
): CampaignContentSelectionReadRepository {
  return {
    getCampaignRulesProfile(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const row = db.prepare(`SELECT ${projectors.rulesProfileProjection}
    FROM campaign_memberships cm
    JOIN campaign_rules_profiles crp ON crp.campaign_id = cm.campaign_id
    JOIN rpg_rules_profiles rp ON rp.rules_profile_id = crp.rules_profile_id
    WHERE cm.principal_id = ? AND cm.campaign_id = ?`).get(actorId, id) as RulesProfileRow | undefined;
      return row ? projectors.toRulesProfile(row) : null;
    },
    listCampaignContentPacks(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const rows = db.prepare(`SELECT ${projectors.contentPackProjection}
    FROM campaign_memberships cm
    JOIN campaign_content_packs cp ON cp.campaign_id = cm.campaign_id
    JOIN rpg_content_packs p ON p.pack_id = cp.pack_id AND p.pack_version = cp.pack_version
      AND p.rules_profile_id = cp.rules_profile_id AND p.sealed = 1
    WHERE cm.principal_id = ? AND cm.campaign_id = ?
    ORDER BY p.pack_id ASC, p.pack_version ASC`).all(actorId, id) as ContentPackRow[];
      return rows.map(projectors.toContentPack);
    },
  };
}
