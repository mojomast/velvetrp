import { campaignRoomActivationReadinessSchema, campaignRoomActivationRequestSchema, campaignRoomActivationResponseSchema, resourceIdSchema, type CampaignRoomActivationRequest } from "@velvet/contracts";

export class ActivationHttpError extends Error {
  constructor(public status: number) { super(`Room activation request failed (${status}).`); }
}
function lane(campaignId: string, sessionId: string) {
  return `/api/rpg/v1/campaigns/${encodeURIComponent(resourceIdSchema.parse(campaignId))}/rooms/${encodeURIComponent(resourceIdSchema.parse(sessionId))}`;
}
async function readResponse(response: Response) {
  if (!response.ok) throw new ActivationHttpError(response.status);
  if (response.status !== 200) throw new Error("Unexpected activation status");
  return response.json() as Promise<unknown>;
}
export async function getActivationReadiness(campaignId: string, sessionId: string) {
  const result = campaignRoomActivationReadinessSchema.parse(await readResponse(await fetch(`${lane(campaignId, sessionId)}/activation-readiness`, { cache: "no-store" })));
  if (result.campaignId !== campaignId || result.sessionId !== sessionId) throw new Error("Readiness identity mismatch");
  return result;
}
export async function activateRoom(campaignId: string, sessionId: string, input: CampaignRoomActivationRequest) {
  const body = campaignRoomActivationRequestSchema.parse(input);
  const result = campaignRoomActivationResponseSchema.parse(await readResponse(await fetch(`${lane(campaignId, sessionId)}/activation-commands`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })));
  if (result.readiness.campaignId !== campaignId || result.readiness.sessionId !== sessionId || result.readiness.expectedRevision !== body.expectedRevision || result.receipt.idempotencyKey !== body.idempotencyKey) throw new Error("Activation receipt identity mismatch");
  return result;
}
