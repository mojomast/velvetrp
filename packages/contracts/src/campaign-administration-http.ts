import { z } from "zod";
import {
  campaignAdministrationReceiptSchema,
  campaignAdministrationPatchSchema,
  campaignAdministrationSchema,
} from "./campaign-administration.js";
import { campaignNameSchema } from "./campaigns.js";
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

export const campaignAdministrationHttpPatchSchema = campaignAdministrationHttpPatchRequestSchema;
export const campaignAdministrationHttpResponseSchema = campaignAdministrationHttpGetResponseSchema;

export type CampaignAdministrationHttpResponse = z.infer<typeof campaignAdministrationHttpGetResponseSchema>;
export type CampaignAdministrationHttpPatchRequest = z.infer<typeof campaignAdministrationHttpPatchRequestSchema>;
export type CampaignAdministrationHttpPatchResponse = z.infer<typeof campaignAdministrationHttpPatchResponseSchema>;
export type CampaignAdministrationHttpArchiveRequest = z.infer<typeof campaignAdministrationHttpArchiveRequestSchema>;
export type CampaignAdministrationHttpArchiveResponse = z.infer<typeof campaignAdministrationHttpArchiveResponseSchema>;
