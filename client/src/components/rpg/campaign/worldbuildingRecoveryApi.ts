import { campaignContentGenerationRecoverySchema, campaignContentGenerationRequestSchema, type CampaignContentGenerationRequest } from "@velvet/contracts";

/** Read-only reconciliation: this endpoint never calls a model, despite accepting a POST body. */
export async function reconcileWorldbuildingGeneration(input: CampaignContentGenerationRequest) {
  const body = campaignContentGenerationRequestSchema.parse(input);
  const response = await fetch("/api/rpg/v1/campaign-content-drafts/reconcile", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`Generation status could not be reconciled (${response.status}). No paid retry was dispatched.`);
  const result = campaignContentGenerationRecoverySchema.parse(await response.json());
  if (result.campaignId !== body.campaignId || result.idempotencyKey !== body.idempotencyKey) throw new Error("Generation reconciliation did not match the retained request.");
  return result;
}
