import { z } from "zod";
import {
  campaignAdministrationPatchSchema,
  campaignAdministrationSchema,
} from "./campaign-administration.js";

/** Wire contracts for the intentionally small, trusted-local administration lane. */
export const campaignAdministrationHttpResponseSchema = campaignAdministrationSchema;
export const campaignAdministrationHttpPatchRequestSchema = campaignAdministrationPatchSchema;

// Descriptive aliases keep the HTTP boundary usable without exposing a second
// representation of the domain administration object.
export const campaignAdministrationHttpPatchSchema = campaignAdministrationHttpPatchRequestSchema;
export const campaignAdministrationHttpGetResponseSchema = campaignAdministrationHttpResponseSchema;

export type CampaignAdministrationHttpResponse = z.infer<typeof campaignAdministrationHttpResponseSchema>;
export type CampaignAdministrationHttpPatchRequest = z.infer<typeof campaignAdministrationHttpPatchRequestSchema>;
