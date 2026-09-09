import {
  apiProblemSchema,
  campaignStartingLocationDesignationRequestSchema,
  campaignStartingLocationDesignationResponseSchema,
  campaignStartingLocationReadResponseSchema,
  campaignWorldHttpResponseSchema,
  resourceIdSchema,
  type CampaignStartingLocationDesignationRequest,
} from "@velvet/contracts";

export class CampaignStartingLocationHttpError extends Error {
  constructor(public status: number, public code: string | null) {
    super(code ?? `Starting-location request failed (${status}).`);
  }
}

function lane(campaignId: string, suffix: string): string {
  const id = resourceIdSchema.parse(campaignId);
  return `/api/rpg/v1/campaigns/${encodeURIComponent(id)}/${suffix}`;
}

async function body(response: Response): Promise<unknown> {
  const value = await response.json();
  if (!response.ok) {
    const problem = apiProblemSchema.safeParse(value);
    throw new CampaignStartingLocationHttpError(response.status, problem.success ? problem.data.code : null);
  }
  if (response.status !== 200) throw new Error("Unexpected starting-location response status");
  return value;
}

export async function getCampaignStartingLocation(campaignId: string) {
  const result = campaignStartingLocationReadResponseSchema.parse(await body(await fetch(lane(campaignId, "starting-location"), {
    cache: "no-store",
  })));
  if (result.campaignId !== campaignId) throw new Error("Starting-location read identity mismatch");
  return result;
}

export async function designateCampaignStartingLocation(campaignId: string, input: CampaignStartingLocationDesignationRequest) {
  const request = campaignStartingLocationDesignationRequestSchema.parse(input);
  const result = campaignStartingLocationDesignationResponseSchema.parse(await body(await fetch(lane(campaignId, "starting-location-commands"), {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })));
  if (result.campaignId !== campaignId || result.startingLocation.locationId !== request.locationId
    || result.receipt.idempotencyKey !== request.idempotencyKey || result.receipt.revisionBefore !== request.expectedRevision) {
    throw new Error("Starting-location response did not match the exact command");
  }
  return result;
}

export async function getCampaignStartingLocationWorld(campaignId: string) {
  const response = await fetch(lane(campaignId, "world"), { cache: "no-store" });
  const value = await body(response);
  return campaignWorldHttpResponseSchema.parse(value);
}

export const campaignStartingLocationApi = {
  getCampaignStartingLocation,
  designateCampaignStartingLocation,
  getCampaignStartingLocationWorld,
};

export type CampaignStartingLocationApi = typeof campaignStartingLocationApi;
