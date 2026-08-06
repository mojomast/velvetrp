import { z } from "zod";
import {
  catalogValidationReportSchema,
  campaignCatalogResolutionReportSchema,
  configureCampaignCatalogInputSchema,
  gmCatalogProjectionSchema,
  observerCatalogProjectionSchema,
  ownerCatalogProjectionSchema,
  playerCatalogProjectionSchema,
  publicationSummarySchema,
  publishContentCatalogInputSchema,
} from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

const MAX_CONTENT_CATALOG_PAGE_SIZE = 100;

/** Pagination cursors are opaque to clients and interpreted by the route. */
export const contentCatalogHttpPublicationsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONTENT_CATALOG_PAGE_SIZE).optional(),
}).strict();
export const contentCatalogHttpPublicationsResponseSchema = z.object({
  publications: z.array(publicationSummarySchema).max(MAX_CONTENT_CATALOG_PAGE_SIZE),
  nextCursor: z.string().min(1).max(1_024).nullable(),
}).strict();

export const contentCatalogHttpOwnerDetailResponseSchema = z.object({
  catalog: ownerCatalogProjectionSchema,
}).strict();

/** The route supplies its own idempotency key after validating this payload. */
export const contentCatalogHttpValidationRequestSchema = publishContentCatalogInputSchema.omit({
  idempotencyKey: true,
});
export const contentCatalogHttpValidationResponseSchema = z.object({
  report: catalogValidationReportSchema,
}).strict();

export const contentCatalogHttpPublicationRequestSchema = publishContentCatalogInputSchema;
export const contentCatalogHttpPublicationResponseSchema = contentCatalogHttpOwnerDetailResponseSchema;

/** Campaign identity is supplied by the route and never repeated in HTTP bodies. */
export const contentCatalogHttpCampaignContentSchema = campaignCatalogResolutionReportSchema.omit({
  campaignId: true,
});
export const contentCatalogHttpCampaignContentGetResponseSchema = z.object({
  content: contentCatalogHttpCampaignContentSchema,
}).strict();
export const contentCatalogHttpCampaignContentPutRequestSchema = configureCampaignCatalogInputSchema;
export const contentCatalogHttpCampaignContentReceiptSchema = z.object({
  commandId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: expectedRevisionSchema,
  revisionAfter: revisionSchema,
  configuredAt: utcIsoTimestampSchema,
  content: contentCatalogHttpCampaignContentSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.revisionAfter !== receipt.revisionBefore + 1) {
    context.addIssue({ code: "custom", message: "catalog receipt revision must advance exactly once", path: ["revisionAfter"] });
  }
});
export const contentCatalogHttpCampaignContentPutResponseSchema = z.object({
  content: contentCatalogHttpCampaignContentSchema,
  receipt: contentCatalogHttpCampaignContentReceiptSchema,
}).strict();

export const contentCatalogHttpCampaignPackSchema = z.union([
  gmCatalogProjectionSchema,
  playerCatalogProjectionSchema,
  observerCatalogProjectionSchema,
]);
export const contentCatalogHttpCampaignPackDetailResponseSchema = z.object({
  catalog: contentCatalogHttpCampaignPackSchema,
}).strict();

export type ContentCatalogHttpPublicationsQuery = z.infer<typeof contentCatalogHttpPublicationsQuerySchema>;
export type ContentCatalogHttpPublicationsResponse = z.infer<typeof contentCatalogHttpPublicationsResponseSchema>;
export type ContentCatalogHttpOwnerDetailResponse = z.infer<typeof contentCatalogHttpOwnerDetailResponseSchema>;
export type ContentCatalogHttpValidationRequest = z.infer<typeof contentCatalogHttpValidationRequestSchema>;
export type ContentCatalogHttpValidationResponse = z.infer<typeof contentCatalogHttpValidationResponseSchema>;
export type ContentCatalogHttpPublicationRequest = z.infer<typeof contentCatalogHttpPublicationRequestSchema>;
export type ContentCatalogHttpPublicationResponse = z.infer<typeof contentCatalogHttpPublicationResponseSchema>;
export type ContentCatalogHttpCampaignContent = z.infer<typeof contentCatalogHttpCampaignContentSchema>;
export type ContentCatalogHttpCampaignContentGetResponse = z.infer<typeof contentCatalogHttpCampaignContentGetResponseSchema>;
export type ContentCatalogHttpCampaignContentPutRequest = z.infer<typeof contentCatalogHttpCampaignContentPutRequestSchema>;
export type ContentCatalogHttpCampaignContentReceipt = z.infer<typeof contentCatalogHttpCampaignContentReceiptSchema>;
export type ContentCatalogHttpCampaignContentPutResponse = z.infer<typeof contentCatalogHttpCampaignContentPutResponseSchema>;
export type ContentCatalogHttpCampaignPack = z.infer<typeof contentCatalogHttpCampaignPackSchema>;
export type ContentCatalogHttpCampaignPackDetailResponse = z.infer<typeof contentCatalogHttpCampaignPackDetailResponseSchema>;
