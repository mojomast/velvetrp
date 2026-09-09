import { tacticalMapSnapshotSchema, type TacticalMapMode } from "@velvet/contracts";
import { ApiError } from "../../../api";

/** Scoped read adapter: the shared getter currently cannot forward an AbortSignal. */
export async function readTacticalMap(campaignId: string, sessionId: string, mode: TacticalMapMode, actorId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/rpg/v1/campaigns/${encodeURIComponent(campaignId)}/rooms/${encodeURIComponent(sessionId)}/tactical-maps/${mode}/actors/${encodeURIComponent(actorId)}`, { cache: "no-store", signal });
  if (response.status !== 200) throw new ApiError(response.status, "Tactical map unavailable");
  const value = tacticalMapSnapshotSchema.parse(await response.json());
  if (value.campaignId !== campaignId || value.sessionId !== sessionId || value.mode !== mode) throw new Error("Tactical map binding mismatch");
  return value;
}
