import { z } from "zod";

const labelText = z.string().trim().min(1).max(500);

/** A bounded, provider-safe explanation attached to exactly one opaque candidate selector. */
export const providerCandidateLabelSchema = z.object({
  action: labelText.max(80),
  source: labelText.max(200).nullable(),
  target: labelText.max(200).nullable(),
  cost: labelText.max(200).nullable(),
  consequence: labelText,
}).strict();

export type ProviderCandidateLabel = z.infer<typeof providerCandidateLabelSchema>;
