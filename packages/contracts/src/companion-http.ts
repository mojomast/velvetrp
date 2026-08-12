import { z } from "zod";
import {
  companionAdministrationCommandKindSchema,
  companionGrantActorScopeSchema,
  companionGrantConfirmationPolicySchema,
  companionGrantResourceScopeSchema,
  companionManagementProjectionSchema,
  companionCommandFamilySchema,
  MAX_COMPANION_GRANT_COMMAND_FAMILIES,
} from "./companion.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { principalIdSchema } from "./rpg-characters.js";
import { campaignSessionAttachmentSchema } from "./campaigns.js";
import type { AgentJsonObject } from "./agent-execution.js";

const commandControlFields = {
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const companionCreateHttpCommandSchema = z.object({
  kind: z.literal("companion-create"),
  sessionId: campaignSessionAttachmentSchema.shape.sessionId,
  ...commandControlFields,
}).strict();

export const companionGrantCreateHttpCommandSchema = z.object({
  kind: z.literal("grant-create"),
  granteePrincipalId: principalIdSchema,
  allowedCommandFamilies: z.array(companionCommandFamilySchema).min(1).max(MAX_COMPANION_GRANT_COMMAND_FAMILIES)
    .refine((families) => new Set(families).size === families.length, "grant command families must be unique"),
  actorScope: companionGrantActorScopeSchema,
  resourceScope: companionGrantResourceScopeSchema,
  maxSpend: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  maxUses: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  startsAt: utcIsoTimestampSchema,
  expiresAt: utcIsoTimestampSchema,
  confirmationPolicy: companionGrantConfirmationPolicySchema,
  ...commandControlFields,
}).strict().refine((command) => command.expiresAt > command.startsAt, {
  path: ["expiresAt"], message: "grant expiry must follow its start",
});

export const companionGrantRevokeHttpCommandSchema = z.object({
  kind: z.literal("grant-revoke"),
  grantId: resourceIdSchema,
  reason: z.string().trim().min(1).max(500),
  ...commandControlFields,
}).strict();

/** Path-owned campaign and NPC IDs, and caller identity, have no body representation. */
export const companionAdministrationHttpCommandSchema = z.discriminatedUnion("kind", [
  companionCreateHttpCommandSchema,
  companionGrantCreateHttpCommandSchema,
  companionGrantRevokeHttpCommandSchema,
]);

/** Reconstructs the exact path-bound payload canonically persisted by the companion repository. */
export function companionAdministrationRepositoryPayload(
  npcId: string,
  command: CompanionAdministrationHttpCommand,
): AgentJsonObject {
  const npc = resourceIdSchema.parse(npcId);
  if (command.kind === "companion-create") return { npcId: npc, sessionId: command.sessionId };
  if (command.kind === "grant-create") return {
    actorScope: command.actorScope,
    allowedCommandFamilies: command.allowedCommandFamilies,
    confirmationPolicy: command.confirmationPolicy,
    expiresAt: command.expiresAt,
    granteePrincipalId: command.granteePrincipalId,
    maxSpend: command.maxSpend,
    maxUses: command.maxUses,
    npcId: npc,
    resourceScope: command.resourceScope,
    startsAt: command.startsAt,
  };
  return { grantId: command.grantId, npcId: npc, reason: command.reason };
}

export const companionAdministrationHttpGetResponseSchema = z.object({
  companion: companionManagementProjectionSchema,
}).strict();

/** Safe acknowledgement without command, grant, receipt, idempotency, digest, key, or outcome data. */
export const companionAdministrationHttpReceiptSchema = z.object({
  kind: companionAdministrationCommandKindSchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema.min(1),
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, {
  path: ["revisionAfter"], message: "a companion administration command advances revision exactly once",
});

export const companionAdministrationHttpCommandResponseSchema = z.object({
  receipt: companionAdministrationHttpReceiptSchema,
}).strict();

export type CompanionAdministrationHttpCommand = z.infer<typeof companionAdministrationHttpCommandSchema>;
export type CompanionAdministrationHttpGetResponse = z.infer<typeof companionAdministrationHttpGetResponseSchema>;
export type CompanionAdministrationHttpCommandResponse = z.infer<typeof companionAdministrationHttpCommandResponseSchema>;
