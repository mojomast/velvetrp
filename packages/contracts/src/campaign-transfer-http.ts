import { z } from "zod";
import {
  campaignAdministrationReceiptSchema,
  campaignAdministrationSchema,
  campaignImportDryRunSchema,
  campaignTransferPackageSchema,
} from "./campaign-administration.js";
import { idempotencyKeySchema } from "./rpg-commands.js";
import { utcIsoTimestampSchema } from "./domain-primitives.js";

/** GET export accepts one required, literal query option. */
export const campaignTransferHttpExportQuerySchema = z.object({
  includeMessages: z.enum(["true", "false"]),
}).strict();

// Sessions, messages, and characters predate the resource-id convention. Keep
// these opaque while still bounding attacker-controlled legacy identifiers.
export const campaignTransferArchiveOpaqueIdSchema = z.string().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "archive ID cannot contain control characters");
export const campaignTransferArchivedMessageSchema = z.object({
  id: campaignTransferArchiveOpaqueIdSchema,
  role: z.enum(["system", "user", "character"]),
  speakerCharacterId: campaignTransferArchiveOpaqueIdSchema.nullable(),
  content: z.string().max(200_000),
  parentId: campaignTransferArchiveOpaqueIdSchema.nullable(),
  swipeGroupId: campaignTransferArchiveOpaqueIdSchema.nullable(),
  swipeIndex: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  status: z.enum(["final", "aborted"]),
  createdAt: utcIsoTimestampSchema,
}).strict();
export const campaignTransferMessageArchiveRoomSchema = z.object({
  sessionId: campaignTransferArchiveOpaqueIdSchema,
  activeLeafId: campaignTransferArchiveOpaqueIdSchema.nullable(),
  messages: z.array(campaignTransferArchivedMessageSchema).max(10_000),
}).strict().superRefine((room, context) => {
  const byId = new Map<string, number>();
  room.messages.forEach((message, index) => {
    if (byId.has(message.id)) context.addIssue({ code: "custom", path: ["messages", index, "id"],
      message: "message IDs must be unique within a room" });
    else byId.set(message.id, index);
  });
  if (room.activeLeafId !== null && !byId.has(room.activeLeafId)) context.addIssue({ code: "custom",
    path: ["activeLeafId"], message: "active leaf must resolve within its room" });
  room.messages.forEach((message, index) => {
    if (message.parentId !== null && !byId.has(message.parentId)) context.addIssue({ code: "custom",
      path: ["messages", index, "parentId"], message: "parent must resolve within its room" });
    const visited = new Set<string>();
    let cursor: string | null = message.id;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        context.addIssue({ code: "custom", path: ["messages", index, "parentId"],
          message: "message parents must be acyclic" });
        break;
      }
      visited.add(cursor);
      const cursorIndex: number | undefined = byId.get(cursor);
      cursor = cursorIndex === undefined ? null : room.messages[cursorIndex]!.parentId;
    }
  });
});
export const campaignTransferMessageArchiveSchema = z.discriminatedUnion("included", [
  z.object({ included: z.literal(false) }).strict(),
  z.object({ included: z.literal(true), rooms: z.array(campaignTransferMessageArchiveRoomSchema).max(1000) }).strict(),
]);
export const campaignTransferHttpExportDocumentSchema = z.object({
  package: campaignTransferPackageSchema,
  messages: campaignTransferMessageArchiveSchema,
}).strict().superRefine((document, context) => {
  if (!document.messages.included) return;
  const attachmentIds = document.package.records.roomAttachments.map((room) => room.sessionId);
  const uniqueAttachments = new Set(attachmentIds);
  const roomIds = document.messages.rooms.map((room) => room.sessionId);
  const uniqueRooms = new Set(roomIds);
  if (uniqueRooms.size !== roomIds.length) context.addIssue({ code: "custom", path: ["messages", "rooms"],
    message: "archive room IDs must be unique" });
  const messageIds = document.messages.rooms.flatMap((room) => room.messages.map((message) => message.id));
  if (new Set(messageIds).size !== messageIds.length) context.addIssue({ code: "custom", path: ["messages", "rooms"],
    message: "archive message IDs must be globally unique" });
  if (uniqueAttachments.size !== attachmentIds.length || attachmentIds.length !== roomIds.length
    || attachmentIds.some((id) => !uniqueRooms.has(id)) || roomIds.some((id) => !uniqueAttachments.has(id))) {
    context.addIssue({ code: "custom", path: ["messages", "rooms"],
      message: "archive rooms must exactly match package room attachments" });
  }
});

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
export type CampaignTransferHttpExportQuery = z.infer<typeof campaignTransferHttpExportQuerySchema>;
export type CampaignTransferHttpExportDocument = z.infer<typeof campaignTransferHttpExportDocumentSchema>;
