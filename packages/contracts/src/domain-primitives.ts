import { z } from "zod";

export const resourceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const utcIsoTimestampSchema = z.string().datetime({ offset: false, precision: 3 });
export const campaignRoleSchema = z.enum(["owner", "gm", "player", "observer"]);
export const campaignMemberRoleSchema = z.enum(["gm", "player", "observer"]);

export type ResourceId = z.infer<typeof resourceIdSchema>;
export type UtcIsoTimestamp = z.infer<typeof utcIsoTimestampSchema>;
export type CampaignRole = z.infer<typeof campaignRoleSchema>;
export type CampaignMemberRole = z.infer<typeof campaignMemberRoleSchema>;
