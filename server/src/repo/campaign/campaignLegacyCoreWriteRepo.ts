// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  addCampaignMembershipInputSchema,
  attachCampaignSessionInputSchema,
  detachCampaignSessionInputSchema,
} from "@velvet/contracts";
import type {
  AddCampaignMembershipInput, AttachCampaignSessionInput, Campaign,
  CampaignRenameRequest, CampaignSessionAttachment, CreateCampaignInput,
  DetachCampaignSessionInput, RenameCampaignInput,
} from "../../types.js";
import type { CampaignCoreRepository } from "./campaignCoreRepo.js";

/** Compatibility write facade retaining the legacy immediate audit composition. */
export function createCampaignLegacyCoreWriteRepository(
  db: DatabaseDriver.Database,
  core: CampaignCoreRepository,
) {
  return {
    createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign {
      return core.createCampaign(actorPrincipalId, input);
    },
    renameCampaign(actorPrincipalId: string, campaignId: string, input: RenameCampaignInput): Campaign {
      return db.transaction(() => {
        const value = core.renameCampaign(actorPrincipalId, campaignId, input);
        core.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "campaign_renamed",
          { name: value.name }, { name: value.name, updatedAt: value.updatedAt }, value.updatedAt);
        return value;
      }).immediate();
    },
    renameCampaignIfUnchanged(actorPrincipalId: string, campaignId: string, input: CampaignRenameRequest): Campaign {
      return db.transaction(() => {
        const value = core.renameCampaignIfUnchanged(actorPrincipalId, campaignId, input);
        core.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "campaign_renamed",
          { name: value.name }, { name: value.name, updatedAt: value.updatedAt }, value.updatedAt);
        return value;
      }).immediate();
    },
    addCampaignMembership(actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput) {
      return db.transaction(() => {
        const normalized = addCampaignMembershipInputSchema.parse(input);
        const existed = db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
          .get(campaignId, normalized.principalId);
        const value = core.addCampaignMembership(actorPrincipalId, campaignId, normalized);
        if (!existed) core.writeCompatibilityAdministrationAudit(campaignId, actorPrincipalId, "membership_added",
          { principalId: value.principalId, role: value.role }, value, value.createdAt);
        return value;
      }).immediate();
    },
    attachCampaignSession(actorPrincipalId: string, input: AttachCampaignSessionInput): CampaignSessionAttachment {
      return db.transaction(() => {
        const normalized = attachCampaignSessionInputSchema.parse(input);
        const existed = db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?")
          .get(normalized.campaignId, normalized.sessionId);
        const value = core.attachCampaignSession(actorPrincipalId, normalized);
        if (!existed) core.writeCompatibilityAdministrationAudit(normalized.campaignId, actorPrincipalId, "room_attached",
          { sessionId: value.sessionId }, value, value.attachedAt);
        return value;
      }).immediate();
    },
    detachCampaignSession(actorPrincipalId: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null {
      return db.transaction(() => {
        const normalized = detachCampaignSessionInputSchema.parse(input);
        const value = core.detachCampaignSession(actorPrincipalId, normalized);
        if (value) {
          const campaign = db.prepare("SELECT updated_at FROM campaigns WHERE id=?").get(normalized.campaignId) as { updated_at: string };
          core.writeCompatibilityAdministrationAudit(normalized.campaignId, actorPrincipalId, "room_detached",
            { sessionId: value.sessionId }, value, campaign.updated_at);
        }
        return value;
      }).immediate();
    },
  };
}
