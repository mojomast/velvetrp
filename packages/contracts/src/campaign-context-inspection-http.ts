import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";

/** The only supported context-inspection wire version. */
export const campaignContextInspectionVersionSchema = z.literal("1.0");
export const campaignContextInspectionLaneSchema = z.enum([
  "adventure-planning",
  "adventure-narration",
  "director-planning",
  "director-narration",
]);

export const MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTIONS = 16;
export const MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTION_TEXT_UTF8_BYTES = 8_192;
export const MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_HITS = 8;
export const MAX_CAMPAIGN_CONTEXT_INSPECTION_DISPATCH_REFERENCES = 6;
export const MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_TEXT_UTF8_BYTES = 2_048;
export const MAX_CAMPAIGN_CONTEXT_INSPECTION_SAFE_RESPONSE_UTF8_BYTES = 24 * 1_024;

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

/** Exact path identity. A dispatch ID is never inferred from a turn, run, or claim. */
export const campaignContextInspectionIdentitySchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  lane: campaignContextInspectionLaneSchema,
  dispatchId: resourceIdSchema,
}).strict();

export const campaignContextInspectionDispatchReferenceSourceSchema = z.object({
  kind: z.enum(["adventure-turn", "director-run"]),
  sourceId: resourceIdSchema,
}).strict();

/** Exact public source identity used to select its recorded dispatch references. */
export const campaignContextInspectionDispatchReferenceSelectorIdentitySchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: resourceIdSchema,
  source: campaignContextInspectionDispatchReferenceSourceSchema,
}).strict();

export const campaignContextInspectionDispatchReferenceSchema = z.object({
  lane: campaignContextInspectionLaneSchema,
  dispatchId: resourceIdSchema,
}).strict();

/** Bounded references for one exact turn or run; repositories define deterministic order. */
export const campaignContextInspectionDispatchReferenceSelectorSchema = z.object({
  version: campaignContextInspectionVersionSchema,
  identity: campaignContextInspectionDispatchReferenceSelectorIdentitySchema,
  references: z.array(campaignContextInspectionDispatchReferenceSchema)
    .max(MAX_CAMPAIGN_CONTEXT_INSPECTION_DISPATCH_REFERENCES),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.references.forEach((reference, index) => {
    const key = `${reference.lane}\u0000${reference.dispatchId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["references", index],
        message: "dispatch references must be unique by lane and dispatchId",
      });
    }
    seen.add(key);
  });
});

export const campaignContextInspectionUnavailableReasonSchema = z.enum([
  "dispatch-not-found",
  "provenance-not-recorded",
  "provenance-version-unsupported",
  "provenance-corrupt",
  "access-revoked",
]);

export const campaignContextInspectionWithheldReasonSchema = z.enum([
  "current-visibility-revoked",
  "private-source",
  "unsafe-persisted-content",
  "metadata-overflow",
  "display-budget-exceeded",
]);

export const campaignContextInspectionAuthoritySchema = z.enum([
  "system-safety",
  "current-authoritative-state",
  "intent",
  "noncanonical-presentation",
  "committed-outcome",
  "authored-recap",
]);

export const campaignContextInspectionSectionKindSchema = z.enum([
  "safety",
  "current-state",
  "recent-history",
  "recall",
  "instructions",
  "other",
]);

const safeLabelSchema = z.string().trim().min(1).max(200);
const safeTextSchema = z.string().min(1).refine(
  (value) => utf8ByteLength(value) <= MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTION_TEXT_UTF8_BYTES,
  `text must be at most ${MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTION_TEXT_UTF8_BYTES} UTF-8 bytes`,
);
const byteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A section is either rendered safe text or an explicit current-visibility withholding. */
export const campaignContextInspectionSectionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("included"),
    kind: campaignContextInspectionSectionKindSchema,
    label: safeLabelSchema,
    authority: campaignContextInspectionAuthoritySchema,
    text: safeTextSchema,
    displayedUtf8Bytes: byteCountSchema.max(MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTION_TEXT_UTF8_BYTES),
  }).strict().refine(
    (value) => value.displayedUtf8Bytes === utf8ByteLength(value.text),
    { message: "displayedUtf8Bytes must equal the UTF-8 byte length of text", path: ["displayedUtf8Bytes"] },
  ),
  z.object({
    status: z.literal("withheld"),
    kind: campaignContextInspectionSectionKindSchema,
    reason: campaignContextInspectionWithheldReasonSchema,
  }).strict(),
]);

/** Source labels and optional links are server-reviewed projections, never raw recall packets. */
export const campaignContextInspectionRecallHitSchema = z.object({
  sourceId: resourceIdSchema,
  sourceLabel: safeLabelSchema,
  sourceLink: z.string().regex(/^\/(?![\\/])[^\\]*$/, "sourceLink must be an internal absolute path").max(512).nullable(),
  authority: campaignContextInspectionAuthoritySchema,
  text: z.string().min(1).refine(
    (value) => utf8ByteLength(value) <= MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_TEXT_UTF8_BYTES,
    `text must be at most ${MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_TEXT_UTF8_BYTES} UTF-8 bytes`,
  ),
  displayedUtf8Bytes: byteCountSchema.max(MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_TEXT_UTF8_BYTES),
}).strict().refine(
  (value) => value.displayedUtf8Bytes === utf8ByteLength(value.text),
  { message: "displayedUtf8Bytes must equal the UTF-8 byte length of text", path: ["displayedUtf8Bytes"] },
);

/** Counters deliberately retain their original unit and scope; none is an aggregate total. */
export const campaignContextInspectionUsageSchema = z.object({
  storedRecallPacketUtf8Bytes: byteCountSchema.nullable(),
  storedMessageContentUtf8Bytes: byteCountSchema.nullable(),
  serializedStoredRequestUtf8Bytes: byteCountSchema.nullable(),
  displayedSafeResponseUtf8Bytes: byteCountSchema.max(MAX_CAMPAIGN_CONTEXT_INSPECTION_SAFE_RESPONSE_UTF8_BYTES),
  reportedPromptTokens: tokenCountSchema.nullable(),
  reportedCompletionTokens: tokenCountSchema.nullable(),
  reservedPromptTokens: tokenCountSchema.nullable(),
  reservedCompletionTokens: tokenCountSchema.nullable(),
}).strict();

export const campaignContextInspectionDispatchSchema = z.object({
  recordedPhase: z.enum(["planned", "narrated"]),
  certainty: z.enum(["recorded", "provider-receipt-confirmed", "provider-outcome-unknown"]),
  settlement: z.enum(["not-dispatched", "claimed", "settled", "failed", "unknown"]),
}).strict();

const availableCampaignContextInspectionResponseSchema = z.object({
  version: campaignContextInspectionVersionSchema,
  identity: campaignContextInspectionIdentitySchema,
  availability: z.literal("available"),
  dispatch: campaignContextInspectionDispatchSchema,
  sections: z.array(campaignContextInspectionSectionSchema).max(MAX_CAMPAIGN_CONTEXT_INSPECTION_SECTIONS),
  recallHits: z.array(campaignContextInspectionRecallHitSchema).max(MAX_CAMPAIGN_CONTEXT_INSPECTION_RECALL_HITS),
  usage: campaignContextInspectionUsageSchema,
}).strict().superRefine((value, context) => {
  const includedBytes = value.sections.reduce((total, section) => total + (section.status === "included" ? section.displayedUtf8Bytes : 0), 0)
    + value.recallHits.reduce((total, hit) => total + hit.displayedUtf8Bytes, 0);
  if (includedBytes > value.usage.displayedSafeResponseUtf8Bytes) {
    context.addIssue({ code: "custom", path: ["usage", "displayedSafeResponseUtf8Bytes"], message: "safe response bytes must cover displayed section and recall text" });
  }
  if (value.sections.some((section) => section.status === "withheld")) {
    const restrictedCounters = [
      "storedRecallPacketUtf8Bytes",
      "storedMessageContentUtf8Bytes",
      "serializedStoredRequestUtf8Bytes",
      "reportedPromptTokens",
      "reportedCompletionTokens",
      "reservedPromptTokens",
      "reservedCompletionTokens",
    ] as const;
    for (const counter of restrictedCounters) {
      if (value.usage[counter] !== null) {
        context.addIssue({ code: "custom", path: ["usage", counter], message: "withheld sections require request-derived counters to be null" });
      }
    }
  }
  if (utf8ByteLength(JSON.stringify(value)) > MAX_CAMPAIGN_CONTEXT_INSPECTION_SAFE_RESPONSE_UTF8_BYTES) {
    context.addIssue({ code: "custom", path: [], message: "safe context-inspection response exceeds its serialized UTF-8 byte cap" });
  }
});

const unavailableCampaignContextInspectionResponseSchema = z.object({
  version: campaignContextInspectionVersionSchema,
  identity: campaignContextInspectionIdentitySchema,
  availability: z.literal("unavailable"),
  reason: campaignContextInspectionUnavailableReasonSchema,
}).strict();

/** Safe, bounded historical context inspection response for one exact dispatch. */
export const campaignContextInspectionResponseSchema = z.discriminatedUnion("availability", [
  availableCampaignContextInspectionResponseSchema,
  unavailableCampaignContextInspectionResponseSchema,
]);

export type CampaignContextInspectionIdentity = z.infer<typeof campaignContextInspectionIdentitySchema>;
export type CampaignContextInspectionLane = z.infer<typeof campaignContextInspectionLaneSchema>;
export type CampaignContextInspectionDispatchReferenceSource = z.infer<typeof campaignContextInspectionDispatchReferenceSourceSchema>;
export type CampaignContextInspectionDispatchReferenceSelectorIdentity = z.infer<typeof campaignContextInspectionDispatchReferenceSelectorIdentitySchema>;
export type CampaignContextInspectionDispatchReference = z.infer<typeof campaignContextInspectionDispatchReferenceSchema>;
export type CampaignContextInspectionDispatchReferenceSelector = z.infer<typeof campaignContextInspectionDispatchReferenceSelectorSchema>;
export type CampaignContextInspectionSection = z.infer<typeof campaignContextInspectionSectionSchema>;
export type CampaignContextInspectionRecallHit = z.infer<typeof campaignContextInspectionRecallHitSchema>;
export type CampaignContextInspectionUsage = z.infer<typeof campaignContextInspectionUsageSchema>;
export type CampaignContextInspectionResponse = z.infer<typeof campaignContextInspectionResponseSchema>;
