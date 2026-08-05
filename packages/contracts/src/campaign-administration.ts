import { z } from "zod";
import { campaignMemberRoleSchema, resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { actorAttributeSetEventDataSchema, actorDiceRolledEventDataSchema,
  actorResourceInitializedEventDataSchema, expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { definitionReferenceSchema } from "./rpg-content.js";

export const CAMPAIGN_TRANSFER_FORMAT_VERSION = 1 as const;
export const MAX_CAMPAIGN_IMPORT_BYTES = 1_000_000;
export const MAX_CAMPAIGN_IMPORT_RECORDS = 10_000;

function hasWellFormedUnicode(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every((entry) => hasWellFormedUnicode(entry, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, entry]) => hasWellFormedUnicode(key, depth + 1)
      && hasWellFormedUnicode(entry, depth + 1));
  }
  return true;
}

export const campaignLifecycleStatusSchema = z.enum(["draft", "published", "paused", "completed", "archived"]);
export const campaignRecapVisibilitySchema = z.enum(["members", "gm-only"]);
export const campaignSettingsSchema = z.object({
  maxPlayers: z.number().int().min(1).max(20),
  allowPlayerDice: z.boolean(),
  safetyMode: z.enum(["standard", "strict"]),
  recapVisibility: campaignRecapVisibilitySchema,
  gmNotes: z.string().max(4000),
}).strict();
export const publicCampaignSettingsSchema = campaignSettingsSchema.omit({ gmNotes: true });

const administrationBase = z.object({
  id: resourceIdSchema,
  status: campaignLifecycleStatusSchema,
  activeTimelineId: resourceIdSchema,
  revision: revisionSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();
export const privilegedCampaignAdministrationSchema = administrationBase.extend({
  actorRole: z.enum(["owner", "gm"]), settings: campaignSettingsSchema,
}).strict();
export const publicCampaignAdministrationSchema = administrationBase.extend({
  actorRole: z.enum(["player", "observer"]), settings: publicCampaignSettingsSchema,
}).strict();
export const campaignAdministrationSchema = z.discriminatedUnion("actorRole", [
  privilegedCampaignAdministrationSchema, publicCampaignAdministrationSchema,
]);

export const campaignAdministrationPatchSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  status: campaignLifecycleStatusSchema.optional(),
  settings: campaignSettingsSchema.partial().strict().optional(),
}).strict().refine((value) => value.status !== undefined
  || (value.settings !== undefined && Object.keys(value.settings).length > 0), "administration patch cannot be empty");

export const campaignMembershipMutationSchema = z.object({
  principalId: resourceIdSchema,
  role: campaignMemberRoleSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignMembershipRoleMutationSchema = z.object({
  role: campaignMemberRoleSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignRevisionMutationSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignRoomMutationSchema = campaignRevisionMutationSchema.extend({
  sessionId: z.string().min(1),
}).strict();

export const campaignAdministrationEventTypeSchema = z.enum(["campaign_renamed", "administration_updated",
  "membership_added", "membership_role_changed", "membership_removed", "room_attached", "room_detached",
  "checkpoint_created", "timeline_forked", "recap_created", "catalog_configured", "import_applied", "export_created"]);
type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };
const safeJsonSchema: z.ZodType<SafeJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(safeJsonSchema).max(1000),
  z.record(z.string().max(128), safeJsonSchema),
]));
export const campaignAdministrationEventSchema = z.object({
  eventId: resourceIdSchema, commandId: resourceIdSchema, campaignId: resourceIdSchema,
  type: campaignAdministrationEventTypeSchema, revision: revisionSchema,
  occurredAt: utcIsoTimestampSchema, data: z.record(z.string().max(128), safeJsonSchema),
}).strict();
export const campaignAdministrationReceiptSchema = z.object({
  commandId: resourceIdSchema,
  campaignId: resourceIdSchema,
  type: campaignAdministrationEventTypeSchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  events: z.tuple([campaignAdministrationEventSchema]),
}).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1, "receipt revision must advance once");

export const campaignCheckpointSchema = z.object({
  id: resourceIdSchema, campaignId: resourceIdSchema, timelineId: resourceIdSchema,
  timelineRevision: revisionSchema, label: z.string().trim().min(1).max(200), createdAt: utcIsoTimestampSchema,
}).strict();
export const createCampaignCheckpointInputSchema = z.object({
  timelineId: resourceIdSchema, timelineRevision: revisionSchema, label: z.string().trim().min(1).max(200),
  expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignTimelineHistorySchema = z.object({
  id: resourceIdSchema, campaignId: resourceIdSchema, parentTimelineId: resourceIdSchema.nullable(),
  forkedFromRevision: revisionSchema.nullable(), revision: revisionSchema, createdAt: utcIsoTimestampSchema,
  active: z.boolean(),
}).strict();
export const forkCampaignTimelineInputSchema = z.object({
  checkpointId: resourceIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();

export const campaignRecapSchema = z.object({
  id: resourceIdSchema, campaignId: resourceIdSchema, timelineId: resourceIdSchema,
  throughRevision: revisionSchema, selectedSessionIds: z.array(z.string().min(1)).max(100),
  visibility: campaignRecapVisibilitySchema, text: z.string().min(1).max(50_000), createdAt: utcIsoTimestampSchema,
}).strict();
export const createCampaignRecapInputSchema = z.object({
  timelineId: resourceIdSchema, throughRevision: revisionSchema,
  selectedSessionIds: z.array(z.string().min(1)).max(100), visibility: campaignRecapVisibilitySchema,
  text: z.string().min(1).max(50_000), expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();

export const campaignTransferMembershipSchema = z.object({ principalId: resourceIdSchema,
  role: campaignMemberRoleSchema, createdAt: utcIsoTimestampSchema }).strict();
const transferEventBase = { sourceEventId: resourceIdSchema, sourceCommandId: resourceIdSchema,
  actorId: resourceIdSchema, sourceTurnId: resourceIdSchema.nullable(), revision: revisionSchema,
  occurredAt: utcIsoTimestampSchema };
export const campaignTransferEventSchema = z.discriminatedUnion("type", [
  z.object({ ...transferEventBase, type: z.literal("actor_attribute_set"), data: actorAttributeSetEventDataSchema }).strict(),
  z.object({ ...transferEventBase, type: z.literal("actor_resource_initialized"), data: actorResourceInitializedEventDataSchema }).strict(),
  z.object({ ...transferEventBase, type: z.literal("actor_dice_rolled"), data: actorDiceRolledEventDataSchema }).strict(),
]);
export const campaignTransferTimelineSchema = z.object({ sourceId: resourceIdSchema,
  parentSourceId: resourceIdSchema.nullable(), forkedFromRevision: revisionSchema.nullable(),
  revision: revisionSchema, createdAt: utcIsoTimestampSchema,
  events: z.array(campaignTransferEventSchema).max(10_000),
}).strict();
export const campaignTransferCheckpointSchema = z.object({ sourceId: resourceIdSchema,
  timelineSourceId: resourceIdSchema, timelineRevision: revisionSchema,
  label: z.string().trim().min(1).max(200), createdAt: utcIsoTimestampSchema,
  state: z.object({ attributes: z.array(z.object({ actorId: resourceIdSchema, attributeId: resourceIdSchema,
      value: z.number().int().min(-1000).max(1000) }).strict()).max(10_000),
    resources: z.array(z.object({ actorId: resourceIdSchema, name: resourceIdSchema,
      current: z.number().int().min(0).max(1_000_000), max: z.number().int().min(0).max(1_000_000) }).strict()).max(10_000) }).strict(),
}).strict();
export const campaignTransferActorSchema = z.object({
  sourceActorId: resourceIdSchema, sourceCampaignCharacterId: resourceIdSchema, sourceSheetId: resourceIdSchema,
  name: z.string().trim().min(1).max(200), race: definitionReferenceSchema,
  background: definitionReferenceSchema,
  classes: z.array(z.object({ class: definitionReferenceSchema, level: z.number().int().min(1).max(100) }).strict()).min(1).max(16),
  attributes: z.array(z.object({ attributeId: resourceIdSchema, value: z.number().int().min(-1000).max(1000) }).strict()).max(64),
  resources: z.array(z.object({ name: resourceIdSchema, current: z.number().int().min(0).max(1_000_000),
    max: z.number().int().min(0).max(1_000_000) }).strict()).max(128),
}).strict();
export const campaignTransferContentSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unconfigured") }).strict(),
  z.object({ status: z.literal("configured"), rulesProfileId: resourceIdSchema,
    contentPacks: z.array(z.object({ packId: resourceIdSchema, packVersion: z.string().min(1).max(64) }).strict()).max(64) }).strict(),
]);
export const campaignTransferAdministrationProvenanceSchema = z.object({
  events: z.array(campaignAdministrationEventSchema.omit({ campaignId: true })).max(10_000),
  receipts: z.array(z.object({ commandId: resourceIdSchema, type: campaignAdministrationEventTypeSchema,
    revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema }).strict()
    .refine((value) => value.revisionAfter === value.revisionBefore + 1)).max(10_000),
}).strict().superRefine((value, context) => {
  const events = new Map(value.events.map((event) => [event.commandId, event]));
  value.receipts.forEach((receipt, index) => {
    const event = events.get(receipt.commandId);
    if (event && event.occurredAt !== receipt.occurredAt) context.addIssue({ code: "custom",
      path: ["receipts", index, "occurredAt"], message: "receipt time must match its event" });
  });
});
export const campaignTransferPackageSchema = z.object({
  formatVersion: z.literal(CAMPAIGN_TRANSFER_FORMAT_VERSION),
  exportedAt: utcIsoTimestampSchema,
  campaign: z.object({ name: z.string().trim().min(1).max(200), status: campaignLifecycleStatusSchema,
    settings: campaignSettingsSchema, administrationRevision: revisionSchema }).strict(),
  timelines: z.array(campaignTransferTimelineSchema).min(1).max(1000),
  activeTimelineSourceId: resourceIdSchema,
  content: campaignTransferContentSchema,
  records: z.object({ actors: z.array(campaignTransferActorSchema).max(1000),
    checkpoints: z.array(campaignTransferCheckpointSchema).max(1000),
    recaps: z.array(z.object({ sourceId: resourceIdSchema, timelineSourceId: resourceIdSchema, throughRevision: revisionSchema,
    selectedSessionIds: z.array(z.string().min(1)).max(100), visibility: campaignRecapVisibilitySchema,
    text: z.string().min(1).max(50_000), createdAt: utcIsoTimestampSchema }).strict()).max(1000),
    memberships: z.array(campaignTransferMembershipSchema).max(100),
    roomAttachments: z.array(z.object({ sessionId: z.string().min(1), attachedAt: utcIsoTimestampSchema }).strict()).max(1000),
    administration: campaignTransferAdministrationProvenanceSchema,
  }).strict(),
  excluded: z.tuple([z.literal("credentials"), z.literal("localPaths"), z.literal("usageHistory"), z.literal("privateActorState")]),
}).strict().refine((value) => hasWellFormedUnicode(value), "package must contain bounded well-formed Unicode");
export const campaignImportReportSchema = z.object({
  valid: z.boolean(), conflicts: z.array(z.string()).max(100), missingReferences: z.array(z.string()).max(100),
  warnings: z.array(z.string()).max(100), counts: z.object({ timelines: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(), actors: z.number().int().nonnegative(), checkpoints: z.number().int().nonnegative(),
    recaps: z.number().int().nonnegative(), memberships: z.number().int().nonnegative(),
    roomAttachments: z.number().int().nonnegative() }).strict(),
}).strict();
export const campaignImportDryRunSchema = z.object({ importId: resourceIdSchema, packageHash: z.string().regex(/^[a-f0-9]{64}$/), report: campaignImportReportSchema }).strict();
export const applyCampaignImportInputSchema = z.object({
  dryRun: campaignImportDryRunSchema, package: campaignTransferPackageSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const campaignExportManifestSchema = z.object({
  id: resourceIdSchema, campaignId: resourceIdSchema, formatVersion: z.literal(CAMPAIGN_TRANSFER_FORMAT_VERSION),
  recordCount: z.number().int().nonnegative().max(MAX_CAMPAIGN_IMPORT_RECORDS),
  excluded: campaignTransferPackageSchema.shape.excluded, createdAt: utcIsoTimestampSchema,
}).strict();
export const createCampaignExportInputSchema = campaignRevisionMutationSchema;

export type CampaignLifecycleStatus = z.infer<typeof campaignLifecycleStatusSchema>;
export type CampaignSettings = z.infer<typeof campaignSettingsSchema>;
export type CampaignAdministration = z.infer<typeof campaignAdministrationSchema>;
export type CampaignAdministrationPatch = z.infer<typeof campaignAdministrationPatchSchema>;
export type CampaignMembershipMutation = z.infer<typeof campaignMembershipMutationSchema>;
export type CampaignMembershipRoleMutation = z.infer<typeof campaignMembershipRoleMutationSchema>;
export type CampaignRevisionMutation = z.infer<typeof campaignRevisionMutationSchema>;
export type CampaignRoomMutation = z.infer<typeof campaignRoomMutationSchema>;
export type CampaignAdministrationReceipt = z.infer<typeof campaignAdministrationReceiptSchema>;
export type CampaignAdministrationEvent = z.infer<typeof campaignAdministrationEventSchema>;
export type CampaignCheckpoint = z.infer<typeof campaignCheckpointSchema>;
export type CreateCampaignCheckpointInput = z.infer<typeof createCampaignCheckpointInputSchema>;
export type CampaignTimelineHistory = z.infer<typeof campaignTimelineHistorySchema>;
export type ForkCampaignTimelineInput = z.infer<typeof forkCampaignTimelineInputSchema>;
export type CampaignRecap = z.infer<typeof campaignRecapSchema>;
export type CreateCampaignRecapInput = z.infer<typeof createCampaignRecapInputSchema>;
export type CampaignTransferPackage = z.infer<typeof campaignTransferPackageSchema>;
export type CampaignImportReport = z.infer<typeof campaignImportReportSchema>;
export type CampaignImportDryRun = z.infer<typeof campaignImportDryRunSchema>;
export type ApplyCampaignImportInput = z.infer<typeof applyCampaignImportInputSchema>;
export type CampaignExportManifest = z.infer<typeof campaignExportManifestSchema>;
export type CreateCampaignExportInput = z.infer<typeof createCampaignExportInputSchema>;
