import { z } from "zod";
import {
  campaignMemberRoleSchema,
  campaignRoleSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
} from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";
import {
  campaignContentPackIdentifiersSchema,
  rulesProfileIdSchema,
} from "./rpg-content.js";
import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_ID,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
} from "./original-starter.js";
import { MECHANICS_STARTER_ID } from "./mechanics-starter.js";

export {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_ID,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
} from "./original-starter.js";

export const campaignNameSchema = z.string().trim().min(1).max(200);

export const createCampaignInputSchema = z.object({
  name: campaignNameSchema,
}).strict();

export const renameCampaignInputSchema = z.object({
  name: campaignNameSchema,
}).strict();

// HTTP renames are deliberately a separate concurrency-aware contract. Keep
// RenameCampaignInput unchanged for the existing repository compatibility API.
export const campaignRenameRequestSchema = z.object({
  name: campaignNameSchema,
  expectedUpdatedAt: utcIsoTimestampSchema,
}).strict();

export const campaignRenameResultSchema = z.object({
  id: resourceIdSchema,
  name: campaignNameSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const campaignRenameResponseSchema = z.object({
  campaign: campaignRenameResultSchema,
}).strict();

export const campaignSchema = z.object({
  id: resourceIdSchema,
  name: campaignNameSchema,
  activeTimelineId: resourceIdSchema,
  ownerPrincipalId: resourceIdSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const campaignTimelineSchema = z.object({
  id: resourceIdSchema,
  campaignId: resourceIdSchema,
  revision: revisionSchema,
  createdAt: utcIsoTimestampSchema,
}).strict();

export const campaignAccessSchema = campaignSchema.extend({
  actorRole: campaignRoleSchema,
}).strict();

export const campaignListResponseSchema = z.object({
  campaigns: z.array(campaignAccessSchema),
}).strict();

export const campaignDetailContentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unconfigured") }).strict(),
  z.object({
    status: z.literal("configured"),
    rulesProfileId: rulesProfileIdSchema,
    contentPacks: campaignContentPackIdentifiersSchema,
  }).strict(),
]);

export const campaignDetailSchema = z.object({
  id: resourceIdSchema,
  name: campaignNameSchema,
  actorRole: campaignRoleSchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
  content: campaignDetailContentSchema,
}).strict().superRefine((campaign, context) => {
  if (campaign.updatedAt < campaign.createdAt) {
    context.addIssue({
      code: "custom",
      message: "updatedAt cannot precede createdAt",
      path: ["updatedAt"],
    });
  }
});

export const campaignDetailResponseSchema = z.object({
  campaign: campaignDetailSchema,
}).strict();

/** Recursively readonly while preserving tuple positions and literal types. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

// Client-safe presentation for the fixed built-in. The server manifest consumes
// these same values, so setup previews cannot drift from installed metadata.
export const originalStarterPresentationSchema = z.object({
  starterId: z.literal(ORIGINAL_STARTER_ID),
  rulesProfile: z.object({
    id: z.literal(ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId),
    name: z.literal(ORIGINAL_STARTER_RULES_PROFILE.name),
    description: z.literal(ORIGINAL_STARTER_RULES_PROFILE.description),
  }).strict(),
  pack: z.object({
    id: z.literal(ORIGINAL_STARTER_PACK.packId),
    version: z.literal(ORIGINAL_STARTER_PACK.packVersion),
    name: z.literal(ORIGINAL_STARTER_PACK.name),
    description: z.literal(ORIGINAL_STARTER_PACK.description),
  }).strict(),
  classes: z.tuple([z.object({
    id: z.literal(ORIGINAL_STARTER_CLASS.reference.definitionId),
    name: z.literal(ORIGINAL_STARTER_CLASS.name),
    description: z.literal(ORIGINAL_STARTER_CLASS.description),
  }).strict()]),
  races: z.tuple([z.object({
    id: z.literal(ORIGINAL_STARTER_RACE.reference.definitionId),
    name: z.literal(ORIGINAL_STARTER_RACE.name),
    description: z.literal(ORIGINAL_STARTER_RACE.description),
  }).strict()]),
  backgrounds: z.tuple([z.object({
    id: z.literal(ORIGINAL_STARTER_BACKGROUND.reference.definitionId),
    name: z.literal(ORIGINAL_STARTER_BACKGROUND.name),
    description: z.literal(ORIGINAL_STARTER_BACKGROUND.description),
  }).strict()]),
}).strict();

export type OriginalStarterPresentation = z.infer<typeof originalStarterPresentationSchema>;

export const ORIGINAL_STARTER_PRESENTATION: DeepReadonly<OriginalStarterPresentation> = deepFreeze(originalStarterPresentationSchema.parse({
  starterId: ORIGINAL_STARTER_ID,
  rulesProfile: {
    id: ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId,
    name: ORIGINAL_STARTER_RULES_PROFILE.name,
    description: ORIGINAL_STARTER_RULES_PROFILE.description,
  },
  pack: {
    id: ORIGINAL_STARTER_PACK.packId,
    version: ORIGINAL_STARTER_PACK.packVersion,
    name: ORIGINAL_STARTER_PACK.name,
    description: ORIGINAL_STARTER_PACK.description,
  },
  classes: [{
    id: ORIGINAL_STARTER_CLASS.reference.definitionId,
    name: ORIGINAL_STARTER_CLASS.name,
    description: ORIGINAL_STARTER_CLASS.description,
  }],
  races: [{
    id: ORIGINAL_STARTER_RACE.reference.definitionId,
    name: ORIGINAL_STARTER_RACE.name,
    description: ORIGINAL_STARTER_RACE.description,
  }],
  backgrounds: [{
    id: ORIGINAL_STARTER_BACKGROUND.reference.definitionId,
    name: ORIGINAL_STARTER_BACKGROUND.name,
    description: ORIGINAL_STARTER_BACKGROUND.description,
  }],
}));
export const campaignStarterSetupRequestSchema = z.object({
  starterId: z.literal(ORIGINAL_STARTER_ID),
}).strict();
// Deliberately return the existing minimal authoritative campaign projection;
// starter metadata is not a second source of campaign truth.
export const campaignStarterSetupResponseSchema = campaignDetailResponseSchema;

/** A distinct fixed operation: callers can select no catalog or command data. */
export const campaignMechanicsStarterSetupRequestSchema = z.object({
  starterId: z.literal(MECHANICS_STARTER_ID),
}).strict();
export const campaignMechanicsStarterSetupResponseSchema = campaignDetailResponseSchema;

// The HTTP create boundary intentionally shares the repository input contract.
export const campaignCreateRequestSchema = createCampaignInputSchema;

export const campaignCreateResponseSchema = z.object({
  campaign: campaignSchema,
}).strict();

export const addCampaignMembershipInputSchema = z.object({
  principalId: resourceIdSchema,
  role: campaignMemberRoleSchema,
}).strict();

export const campaignMembershipSchema = z.object({
  campaignId: resourceIdSchema,
  principalId: resourceIdSchema,
  role: campaignMemberRoleSchema,
  createdAt: utcIsoTimestampSchema,
}).strict();

export const campaignMembershipReadSchema = z.object({
  campaignId: resourceIdSchema,
  principalId: resourceIdSchema,
  role: campaignRoleSchema,
  createdAt: utcIsoTimestampSchema,
}).strict();

/** Legacy room identifiers are opaque: do not trim or apply resource-ID rules. */
const legacySessionIdSchema = z.string().min(1);

export const MAX_CAMPAIGN_ROOM_SUMMARIES = 1000;
export const MAX_CAMPAIGN_ROOM_PARTICIPANTS = 12;

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Mirrors SQLite BINARY ordering for well-formed UTF-8 text without Node APIs. */
function compareBinaryText(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return leftIndex === left.length ? (rightIndex === right.length ? 0 : -1) : 1;
}

const campaignRoomDisplayTextSchema = z.string().min(1).max(200)
  .refine((value) => value.trim().length > 0 && hasWellFormedUtf16(value), "invalid room display text");

export const campaignRoomSummarySchema = z.object({
  sessionId: legacySessionIdSchema,
  title: campaignRoomDisplayTextSchema.nullable(),
  participantNames: z.array(campaignRoomDisplayTextSchema)
    .min(1).max(MAX_CAMPAIGN_ROOM_PARTICIPANTS),
  createdAt: utcIsoTimestampSchema,
}).strict();

export const attachedCampaignRoomSummarySchema = campaignRoomSummarySchema.extend({
  attachedAt: utcIsoTimestampSchema,
  stopped: z.boolean(),
}).strict();

export const campaignRoomLinkingResponseSchema = z.object({
  attached: z.array(attachedCampaignRoomSummarySchema).max(MAX_CAMPAIGN_ROOM_SUMMARIES),
  eligible: z.array(campaignRoomSummarySchema).max(MAX_CAMPAIGN_ROOM_SUMMARIES),
}).strict().superRefine((value, context) => {
  const attachedIds = new Set<string>();
  for (let index = 0; index < value.attached.length; index += 1) {
    const room = value.attached[index]!;
    if (attachedIds.has(room.sessionId)) {
      context.addIssue({ code: "custom", path: ["attached", index, "sessionId"], message: "duplicate attached room" });
    }
    attachedIds.add(room.sessionId);
    const previous = value.attached[index - 1];
    if (previous && (previous.attachedAt > room.attachedAt
      || (previous.attachedAt === room.attachedAt && compareBinaryText(previous.sessionId, room.sessionId) > 0))) {
      context.addIssue({ code: "custom", path: ["attached", index], message: "attached rooms are out of order" });
    }
  }
  const eligibleIds = new Set<string>();
  for (let index = 0; index < value.eligible.length; index += 1) {
    const room = value.eligible[index]!;
    if (eligibleIds.has(room.sessionId)) {
      context.addIssue({ code: "custom", path: ["eligible", index, "sessionId"], message: "duplicate eligible room" });
    }
    if (attachedIds.has(room.sessionId)) {
      context.addIssue({ code: "custom", path: ["eligible", index, "sessionId"], message: "room cannot be attached and eligible" });
    }
    eligibleIds.add(room.sessionId);
    const previous = value.eligible[index - 1];
    if (previous && (previous.createdAt > room.createdAt
      || (previous.createdAt === room.createdAt && compareBinaryText(previous.sessionId, room.sessionId) > 0))) {
      context.addIssue({ code: "custom", path: ["eligible", index], message: "eligible rooms are out of order" });
    }
  }
});

export const campaignRoomAttachRequestSchema = z.object({
  sessionId: legacySessionIdSchema,
}).strict();

export const campaignRoomAttachResponseSchema = z.object({
  attachment: z.object({
    sessionId: legacySessionIdSchema,
    attachedAt: utcIsoTimestampSchema,
  }).strict(),
}).strict();

export const attachCampaignSessionInputSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: legacySessionIdSchema,
}).strict();

export const detachCampaignSessionInputSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: legacySessionIdSchema,
}).strict();

export const campaignSessionAttachmentSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: legacySessionIdSchema,
  attachedAt: utcIsoTimestampSchema,
}).strict();

export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;
export type RenameCampaignInput = z.infer<typeof renameCampaignInputSchema>;
export type CampaignRenameRequest = z.infer<typeof campaignRenameRequestSchema>;
export type CampaignRenameResult = z.infer<typeof campaignRenameResultSchema>;
export type CampaignRenameResponse = z.infer<typeof campaignRenameResponseSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignTimeline = z.infer<typeof campaignTimelineSchema>;
export type CampaignAccess = z.infer<typeof campaignAccessSchema>;
export type CampaignListResponse = z.infer<typeof campaignListResponseSchema>;
export type CampaignDetailContent = z.infer<typeof campaignDetailContentSchema>;
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;
export type CampaignDetailResponse = z.infer<typeof campaignDetailResponseSchema>;
export type CampaignStarterSetupRequest = z.infer<typeof campaignStarterSetupRequestSchema>;
export type CampaignStarterSetupResponse = z.infer<typeof campaignStarterSetupResponseSchema>;
export type CampaignMechanicsStarterSetupRequest = z.infer<typeof campaignMechanicsStarterSetupRequestSchema>;
export type CampaignMechanicsStarterSetupResponse = z.infer<typeof campaignMechanicsStarterSetupResponseSchema>;
export type CampaignCreateRequest = z.infer<typeof campaignCreateRequestSchema>;
export type CampaignCreateResponse = z.infer<typeof campaignCreateResponseSchema>;
export type AddCampaignMembershipInput = z.infer<typeof addCampaignMembershipInputSchema>;
export type CampaignMembership = z.infer<typeof campaignMembershipSchema>;
export type CampaignMembershipRead = z.infer<typeof campaignMembershipReadSchema>;
export type AttachCampaignSessionInput = z.infer<typeof attachCampaignSessionInputSchema>;
export type DetachCampaignSessionInput = z.infer<typeof detachCampaignSessionInputSchema>;
export type CampaignSessionAttachment = z.infer<typeof campaignSessionAttachmentSchema>;
export type CampaignRoomSummary = z.infer<typeof campaignRoomSummarySchema>;
export type AttachedCampaignRoomSummary = z.infer<typeof attachedCampaignRoomSummarySchema>;
export type CampaignRoomLinkingResponse = z.infer<typeof campaignRoomLinkingResponseSchema>;
export type CampaignRoomAttachRequest = z.infer<typeof campaignRoomAttachRequestSchema>;
export type CampaignRoomAttachResponse = z.infer<typeof campaignRoomAttachResponseSchema>;
