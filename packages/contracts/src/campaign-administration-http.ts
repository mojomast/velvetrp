import { z } from "zod";
import {
  campaignMembershipMutationSchema,
  campaignMembershipRoleMutationSchema,
  campaignAdministrationReceiptSchema,
  campaignAdministrationPatchSchema,
  campaignAdministrationSchema,
  campaignRevisionMutationSchema,
} from "./campaign-administration.js";
import {
  campaignMembershipReadSchema,
  campaignNameSchema,
  campaignSessionAttachmentSchema,
} from "./campaigns.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";

/** Wire contracts for the intentionally small, trusted-local administration lane. */
export const campaignAdministrationHttpPatchRequestSchema = campaignAdministrationPatchSchema;
export const campaignAdministrationHttpGetResponseSchema = z.object({
  campaign: campaignAdministrationSchema,
}).strict();
export const campaignAdministrationHttpPatchResponseSchema = z.object({
  campaign: campaignAdministrationSchema,
  receipt: campaignAdministrationReceiptSchema,
}).strict();
export const campaignAdministrationHttpArchiveRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  confirmationName: campaignNameSchema,
}).strict();
export const campaignAdministrationHttpArchiveResponseSchema = campaignAdministrationHttpPatchResponseSchema;

/** HTTP membership projections never disclose the route-owned campaign ID. */
export const campaignAdministrationHttpMembershipSchema = campaignMembershipReadSchema.omit({ campaignId: true });
export const campaignAdministrationHttpMembershipListResponseSchema = z.object({
  memberships: z.array(campaignAdministrationHttpMembershipSchema).max(100),
}).strict();
export const campaignAdministrationHttpMembershipCreateRequestSchema = campaignMembershipMutationSchema;
export const campaignAdministrationHttpMembershipUpdateRequestSchema = campaignMembershipRoleMutationSchema;
export const campaignAdministrationHttpMembershipDeleteRequestSchema = campaignRevisionMutationSchema;
export const campaignAdministrationHttpMembershipMutationResponseSchema = z.object({
  membership: campaignAdministrationHttpMembershipSchema,
  receipt: campaignAdministrationReceiptSchema,
}).strict();

/** The session ID is path-owned; attachment projections never disclose campaign ID. */
export const campaignAdministrationHttpRoomDetachRequestSchema = campaignRevisionMutationSchema;
export const campaignAdministrationHttpRoomAttachmentSchema = campaignSessionAttachmentSchema.omit({ campaignId: true });
export const campaignAdministrationHttpRoomDetachResponseSchema = z.object({
  attachment: campaignAdministrationHttpRoomAttachmentSchema,
  receipt: campaignAdministrationReceiptSchema,
}).strict();

export const campaignAdministrationHttpPatchSchema = campaignAdministrationHttpPatchRequestSchema;
export const campaignAdministrationHttpResponseSchema = campaignAdministrationHttpGetResponseSchema;

export type CampaignAdministrationHttpResponse = z.infer<typeof campaignAdministrationHttpGetResponseSchema>;
export type CampaignAdministrationHttpPatchRequest = z.infer<typeof campaignAdministrationHttpPatchRequestSchema>;
export type CampaignAdministrationHttpPatchResponse = z.infer<typeof campaignAdministrationHttpPatchResponseSchema>;
export type CampaignAdministrationHttpArchiveRequest = z.infer<typeof campaignAdministrationHttpArchiveRequestSchema>;
export type CampaignAdministrationHttpArchiveResponse = z.infer<typeof campaignAdministrationHttpArchiveResponseSchema>;
export type CampaignAdministrationHttpMembership = z.infer<typeof campaignAdministrationHttpMembershipSchema>;
export type CampaignAdministrationHttpMembershipListResponse = z.infer<typeof campaignAdministrationHttpMembershipListResponseSchema>;
export type CampaignAdministrationHttpMembershipCreateRequest = z.infer<typeof campaignAdministrationHttpMembershipCreateRequestSchema>;
export type CampaignAdministrationHttpMembershipUpdateRequest = z.infer<typeof campaignAdministrationHttpMembershipUpdateRequestSchema>;
export type CampaignAdministrationHttpMembershipDeleteRequest = z.infer<typeof campaignAdministrationHttpMembershipDeleteRequestSchema>;
export type CampaignAdministrationHttpMembershipMutationResponse = z.infer<typeof campaignAdministrationHttpMembershipMutationResponseSchema>;
export type CampaignAdministrationHttpRoomDetachRequest = z.infer<typeof campaignAdministrationHttpRoomDetachRequestSchema>;
export type CampaignAdministrationHttpRoomAttachment = z.infer<typeof campaignAdministrationHttpRoomAttachmentSchema>;
export type CampaignAdministrationHttpRoomDetachResponse = z.infer<typeof campaignAdministrationHttpRoomDetachResponseSchema>;
