import { z } from "zod";
import {
  campaignAdministrationReceiptSchema,
  campaignAdministrationSchema,
  campaignImportDryRunSchema,
  campaignTransferPackageSchema,
} from "./campaign-administration.js";
import { idempotencyKeySchema } from "./rpg-commands.js";

/** Stateless validation of a portable campaign package before import. */
export const campaignTransferHttpDryRunRequestSchema = z.object({
  package: campaignTransferPackageSchema,
  mode: z.literal("dry-run"),
}).strict();
export const campaignTransferHttpDryRunResponseSchema = campaignImportDryRunSchema.omit({ packageHash: true });

/** No machine-resolvable conflict kinds exist yet, so only an explicit empty set is accepted. */
export const campaignTransferHttpConflictResolutionsSchema = z.tuple([]);
export const campaignTransferHttpApplyRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  conflictResolutions: campaignTransferHttpConflictResolutionsSchema,
}).strict();
export const campaignTransferHttpApplyResponseSchema = z.object({
  campaign: campaignAdministrationSchema,
  receipt: campaignAdministrationReceiptSchema,
}).strict();

export type CampaignTransferHttpDryRunRequest = z.infer<typeof campaignTransferHttpDryRunRequestSchema>;
export type CampaignTransferHttpDryRunResponse = z.infer<typeof campaignTransferHttpDryRunResponseSchema>;
export type CampaignTransferHttpApplyRequest = z.infer<typeof campaignTransferHttpApplyRequestSchema>;
export type CampaignTransferHttpApplyResponse = z.infer<typeof campaignTransferHttpApplyResponseSchema>;
