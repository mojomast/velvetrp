import { z } from "zod";
import { canonicalSha256DigestSchema } from "./agent-execution.js";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";

/** Versioned, server-owned policy used for every AI-selected mutation. */
export const CONFIRMATION_POLICY_VERSION = "v1" as const;
/** Migration-only attestations are readable but are never executable. */
export const LEGACY_CONFIRMATION_POLICY_VERSION = "legacy-v40-backfill-v1" as const;
export const confirmationPolicyVersionSchema = z.enum([CONFIRMATION_POLICY_VERSION, LEGACY_CONFIRMATION_POLICY_VERSION]);

/** Closed consequential-change taxonomy. Unknown/ambiguous mutations fail into `ambiguous-consequential-change`. */
export const confirmationPolicyCategorySchema = z.enum([
  "currency-transfer", "purchase", "important-item-loss", "important-item-consume", "important-item-gift",
  "ambiguous-limited-resource-use", "rest-timing", "companion-change", "combat-start",
  "combat-action-consequential", "generated-world-change", "generated-quest-change", "generated-story-change",
  "gm-override", "deterministic-roll", "ambiguous-consequential-change",
]);
export const confirmationAuthorizerSchema = z.enum(["controller", "gm"]);

const opaqueIdentifier = /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b[0-9a-f]{32,}\b)/i;
/** Human-readable text that cannot carry UUID or digest-like private identities. */
export const safeConfirmationDisplayTextSchema = z.string().trim().min(1).max(500)
  .refine((value) => !opaqueIdentifier.test(value), "confirmation display text cannot contain opaque identifiers");

/** Closed public consequence vocabulary with no exact argument or identity slots. */
export const safeConsequenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("combat-impact"), text: safeConfirmationDisplayTextSchema.max(160) }).strict(),
  z.object({ kind: z.literal("roll-recorded"), text: safeConfirmationDisplayTextSchema.max(160) }).strict(),
  z.object({ kind: z.literal("attribute-change"), text: safeConfirmationDisplayTextSchema.max(160) }).strict(),
  z.object({ kind: z.literal("campaign-change"), text: safeConfirmationDisplayTextSchema.max(160) }).strict(),
]);

export const safeProposalSummarySchema = z.object({
  summary: safeConfirmationDisplayTextSchema,
  consequences: z.array(safeConsequenceSchema).min(1).max(12),
}).strict();

/** Public policy projection. Exact arguments, domain IDs, digests, and principals remain private. */
export const roleSafeConfirmationPolicySchema = z.object({
  version: confirmationPolicyVersionSchema,
  category: confirmationPolicyCategorySchema,
  requiresConfirmation: z.boolean(),
  requiredAuthorizer: confirmationAuthorizerSchema,
  review: safeProposalSummarySchema,
}).strict();

/** Private immutable proposal attestation persisted beside legacy proposal rows. */
export const confirmationPolicyAttestationSchema = roleSafeConfirmationPolicySchema.extend({
  proposedCommandDigest: canonicalSha256DigestSchema,
  observedDomains: z.array(z.object({ domain: z.string().min(1).max(64), revision: revisionSchema }).strict())
    .min(1).max(16).refine((values) => new Set(values.map((value) => value.domain)).size === values.length),
  attestedAt: utcIsoTimestampSchema,
}).strict();

export type ConfirmationPolicyCategory = z.infer<typeof confirmationPolicyCategorySchema>;
export type ConfirmationAuthorizer = z.infer<typeof confirmationAuthorizerSchema>;
export type SafeProposalSummary = z.infer<typeof safeProposalSummarySchema>;
export type RoleSafeConfirmationPolicy = z.infer<typeof roleSafeConfirmationPolicySchema>;
export type ConfirmationPolicyAttestation = z.infer<typeof confirmationPolicyAttestationSchema>;
