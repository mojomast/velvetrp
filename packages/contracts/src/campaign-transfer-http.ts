import { z } from "zod";
import {
  campaignImportDryRunSchema,
  campaignTransferPackageSchema,
} from "./campaign-administration.js";

/** Stateless validation of a portable campaign package before import. */
export const campaignTransferHttpDryRunRequestSchema = z.object({
  package: campaignTransferPackageSchema,
  mode: z.literal("dry-run"),
}).strict();
export const campaignTransferHttpDryRunResponseSchema = campaignImportDryRunSchema.omit({ packageHash: true });

export type CampaignTransferHttpDryRunRequest = z.infer<typeof campaignTransferHttpDryRunRequestSchema>;
export type CampaignTransferHttpDryRunResponse = z.infer<typeof campaignTransferHttpDryRunResponseSchema>;
