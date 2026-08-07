// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type {
  AddCampaignMembershipInput, AttachCampaignSessionInput, Campaign, CampaignAccess,
  CampaignMembership, CampaignMembershipRead, CampaignRenameRequest, CampaignSessionAttachment,
  CampaignTimeline, CreateCampaignInput, DetachCampaignSessionInput, RenameCampaignInput,
} from "../../types.js";
import type { CampaignRoomLinkingSnapshot } from "./campaignTypes.js";

interface CampaignCoreOperations {
  createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign;
  renameCampaign(actorPrincipalId: string, campaignId: string, input: RenameCampaignInput): Campaign;
  renameCampaignIfUnchanged(actorPrincipalId: string, campaignId: string, input: CampaignRenameRequest): Campaign;
  addCampaignMembership(actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput): CampaignMembership;
  attachCampaignSession(actorPrincipalId: string, input: AttachCampaignSessionInput): CampaignSessionAttachment;
  detachCampaignSession(actorPrincipalId: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null;
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  listCampaignTimelines(actorPrincipalId: string, campaignId: string): CampaignTimeline[];
  getCampaignTimeline(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignTimeline | null;
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): CampaignMembershipRead[];
  getCampaignMembership(actorPrincipalId: string, campaignId: string, principalId: string): CampaignMembershipRead | null;
  listCampaignSessionAttachments(actorPrincipalId: string, campaignId: string): CampaignSessionAttachment[];
  getCampaignSessionAttachment(actorPrincipalId: string, campaignId: string, sessionId: string): CampaignSessionAttachment | null;
  getCampaignRoomLinkingSnapshot(actorPrincipalId: string, campaignId: string): CampaignRoomLinkingSnapshot | null;
  getCampaignRoomSessionLifecycle(sessionId: string): "running" | "stopped" | null;
}

export interface CampaignCoreRepository {
  createCampaign(actorPrincipalId: string, input: CreateCampaignInput): Campaign;
  renameCampaign(actorPrincipalId: string, campaignId: string, input: RenameCampaignInput): Campaign;
  renameCampaignIfUnchanged(actorPrincipalId: string, campaignId: string, input: CampaignRenameRequest): Campaign;
  addCampaignMembership(actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput): CampaignMembership;
  attachCampaignSession(actorPrincipalId: string, input: AttachCampaignSessionInput): CampaignSessionAttachment;
  detachCampaignSession(actorPrincipalId: string, input: DetachCampaignSessionInput): CampaignSessionAttachment | null;
  listCampaigns(actorPrincipalId: string): CampaignAccess[];
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  listCampaignTimelines(actorPrincipalId: string, campaignId: string): CampaignTimeline[];
  getCampaignTimeline(actorPrincipalId: string, campaignId: string, timelineId: string): CampaignTimeline | null;
  listCampaignMemberships(actorPrincipalId: string, campaignId: string): CampaignMembershipRead[];
  getCampaignMembership(actorPrincipalId: string, campaignId: string, principalId: string): CampaignMembershipRead | null;
  listCampaignSessionAttachments(actorPrincipalId: string, campaignId: string): CampaignSessionAttachment[];
  getCampaignSessionAttachment(actorPrincipalId: string, campaignId: string, sessionId: string): CampaignSessionAttachment | null;
  getCampaignRoomLinkingSnapshot(actorPrincipalId: string, campaignId: string): CampaignRoomLinkingSnapshot | null;
  getCampaignRoomSessionLifecycle(sessionId: string): "running" | "stopped" | null;
  writeCompatibilityAdministrationAudit: CompatibilityAdministrationAuditWriter;
}

export type CompatibilityAdministrationAuditWriter = (
  campaignId: string,
  actorPrincipalId: string,
  type: "campaign_renamed" | "membership_added" | "room_attached" | "room_detached",
  payload: object,
  result: object,
  occurredAt: string,
) => void;

/** Factory-independent campaign CRUD, authority, timeline, and room projections. */
export function createCampaignCoreRepository(
  operations: CampaignCoreOperations,
  writeCompatibilityAdministrationAudit: CompatibilityAdministrationAuditWriter = () => undefined,
): CampaignCoreRepository {
  return {
    ...operations,
    writeCompatibilityAdministrationAudit,
  };
}
