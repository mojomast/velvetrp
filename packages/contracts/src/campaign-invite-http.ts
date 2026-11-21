import { z } from "zod";
import { campaignMemberRoleSchema, resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";

/** Opaque invite tokens are single-use bearer values, never principal identities. */
export const campaignInviteTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._~:-]+$/);

/** Invites may grant a membership role but never the campaign owner role. */
export const campaignInviteCreateRequestSchema = z
  .object({
    role: campaignMemberRoleSchema,
    expectedRevision: expectedRevisionSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const campaignInviteCreateResponseSchema = z
  .object({
    inviteId: resourceIdSchema,
    role: campaignMemberRoleSchema,
    expiresAt: utcIsoTimestampSchema,
    token: campaignInviteTokenSchema,
  })
  .strict();

/** Redemption accepts only the bearer token; every other field is rejected. */
export const campaignInviteRedeemRequestSchema = z
  .object({
    token: campaignInviteTokenSchema,
  })
  .strict();

/** Redemption reveals the issued principal identity and role, never session material. */
export const campaignInviteRedeemResponseSchema = z
  .object({
    principalId: resourceIdSchema,
    role: campaignMemberRoleSchema,
  })
  .strict();

export type CampaignInviteCreateRequest = z.infer<typeof campaignInviteCreateRequestSchema>;
export type CampaignInviteCreateResponse = z.infer<typeof campaignInviteCreateResponseSchema>;
export type CampaignInviteRedeemRequest = z.infer<typeof campaignInviteRedeemRequestSchema>;
export type CampaignInviteRedeemResponse = z.infer<typeof campaignInviteRedeemResponseSchema>;
