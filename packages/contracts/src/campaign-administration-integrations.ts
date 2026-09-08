import { z } from "zod";
import { campaignIdSchema } from "./rpg-characters.js";
import { campaignRoleSchema, resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

const boundarySchema = z.string().trim().min(1).max(200);
export const sessionZeroSafetyPolicySchema = z.object({
  revision: revisionSchema,
  hardLimits: z.array(boundarySchema).max(32),
  veils: z.array(boundarySchema).max(32),
  pvpPolicy: z.enum(["disallowed", "fade-to-black", "explicit-consent", "allowed"]),
  romancePolicy: z.enum(["disallowed", "fade-to-black", "explicit-consent", "allowed"]),
  lethalityPolicy: z.enum(["nonlethal-default", "consent-required", "rules-as-written"]),
  paused: z.boolean(),
}).strict();

export const administrationIntegrationReceiptSchema = z.object({
  commandId: resourceIdSchema,
  campaignId: campaignIdSchema,
  operation: z.enum(["associate-vendor", "set-buy-policy", "select-ruleset", "update-safety", "pause", "resume", "skip", "rewind"]),
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  outcome: z.string().trim().min(1).max(500),
  checkpointWorkflowRequired: z.boolean().optional(),
}).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1);

const commandBase = { expectedRevision: revisionSchema, idempotencyKey: idempotencyKeySchema };
export const vendorAssociationCommandSchema = z.object({ ...commandBase, npcId: resourceIdSchema, shopId: resourceIdSchema }).strict();
export const shopBuyPolicyCommandSchema = z.object({ ...commandBase, shopId: resourceIdSchema, stockId: resourceIdSchema,
  payoutUnitMinor: z.number().int().safe().min(0) }).strict();
export const rulesetSelectionCommandSchema = z.object({ ...commandBase, rulesetId: resourceIdSchema,
  version: z.string().trim().min(1).max(100), digest: z.string().regex(/^[0-9a-f]{64}$/), migrationConfirmed: z.literal(true) }).strict();
export const sessionZeroSafetyUpdateCommandSchema = sessionZeroSafetyPolicySchema.omit({ revision: true, paused: true })
  .extend(commandBase).strict();
export const safetyActionCommandSchema = z.object({ ...commandBase,
  action: z.enum(["pause", "resume", "skip", "rewind"]), confirmed: z.literal(true) }).strict();

const rulesetCapabilitySchema = z.object({ capabilityId: z.string(), label: z.string(), supported: z.boolean(), detail: z.string().optional() }).strict();
export const administrationRulesetIdentitySchema = z.object({ rulesetId: resourceIdSchema, name: z.string(), version: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/), capabilities: z.array(rulesetCapabilitySchema),
  migration: z.enum(["none", "compatible", "destructive", "unknown"]), migrationSummary: z.string().optional() }).strict();

export const campaignAdministrationIntegrationsSchema = z.object({
  campaignId: campaignIdSchema,
  actorRole: campaignRoleSchema,
  revision: revisionSchema,
  commerce: z.object({
    npcs: z.array(z.object({ npcId: resourceIdSchema, name: z.string() }).strict()),
    shops: z.array(z.object({ shopId: resourceIdSchema, name: z.string(), stock: z.array(z.object({ stockId: resourceIdSchema, label: z.string() }).strict()) }).strict()),
    associations: z.array(z.object({ npcId: resourceIdSchema, shopId: resourceIdSchema, revision: revisionSchema }).strict()),
    buyPolicies: z.array(z.object({ shopId: resourceIdSchema, stockId: resourceIdSchema, payoutUnitMinor: z.number().int().safe().min(0), revision: revisionSchema }).strict()),
  }).strict(),
  rulesets: z.object({ current: administrationRulesetIdentitySchema, available: z.array(administrationRulesetIdentitySchema),
    rulesProfileId: z.string().nullable(), mechanicallyEmpty: z.boolean(), selectionWarning: z.string() }).strict(),
  generation: z.object({
    jobs: z.array(z.object({ jobId: resourceIdSchema, state: z.enum(["running", "uncertain", "failed", "succeeded"]), attempt: z.number().int().min(1), requestDigest: z.string().regex(/^[0-9a-f]{64}$/), updatedAt: utcIsoTimestampSchema, draftId: resourceIdSchema.nullable() }).strict()),
    drafts: z.array(z.object({ draftId: resourceIdSchema, jobId: resourceIdSchema.nullable(), state: z.enum(["staged", "approved", "applied", "abandoned"]), revision: revisionSchema, createdAt: utcIsoTimestampSchema, artifactCount: z.number().int().min(0) }).strict()),
    retrySupported: z.literal(false),
  }).strict(),
  safety: sessionZeroSafetyPolicySchema,
  recentSafetyRequests: z.array(administrationIntegrationReceiptSchema).max(20),
}).strict();

export const administrationIntegrationCommandResponseSchema = z.object({ receipt: administrationIntegrationReceiptSchema,
  administration: campaignAdministrationIntegrationsSchema }).strict();

export type CampaignAdministrationIntegrations = z.infer<typeof campaignAdministrationIntegrationsSchema>;
export type AdministrationIntegrationReceipt = z.infer<typeof administrationIntegrationReceiptSchema>;
export type SessionZeroSafetyPolicy = z.infer<typeof sessionZeroSafetyPolicySchema>;
export type VendorAssociationCommand = z.infer<typeof vendorAssociationCommandSchema>;
export type ShopBuyPolicyCommand = z.infer<typeof shopBuyPolicyCommandSchema>;
export type RulesetSelectionCommand = z.infer<typeof rulesetSelectionCommandSchema>;
export type SessionZeroSafetyUpdateCommand = z.infer<typeof sessionZeroSafetyUpdateCommandSchema>;
export type SafetyActionCommand = z.infer<typeof safetyActionCommandSchema>;
