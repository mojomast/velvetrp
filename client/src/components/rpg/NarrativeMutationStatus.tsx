import { ApiError } from "../../api";
import type { NarrativeMutationState } from "./narrativeMutationRegistry";

const DEFINITE_CODES = new Set([
  "RPG_WORLD_STALE", "RPG_TRAVEL_CONFLICT", "RPG_NPC_CONFLICT", "RPG_FACTION_CONFLICT",
  "RPG_QUEST_STALE", "RPG_QUEST_CONFLICT", "RPG_STORY_STALE", "RPG_STORY_CONFLICT",
]);

export function isDefiniteNarrativeRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code !== null && DEFINITE_CODES.has(error.code);
}

export function receiptFrom(result: unknown): NarrativeMutationState["receipt"] {
  if (typeof result !== "object" || result === null || !("receipt" in result)) return undefined;
  const receipt = (result as { receipt?: unknown }).receipt;
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const value = receipt as Record<string, unknown>;
  return typeof value.idempotencyKey === "string" && typeof value.revisionBefore === "number"
    && typeof value.revisionAfter === "number" && typeof value.occurredAt === "string"
    ? value as NonNullable<NarrativeMutationState["receipt"]> : undefined;
}

export function NarrativeMutationStatus({ mutation, onRefresh }: { mutation: NarrativeMutationState | null; onRefresh?: () => void }) {
  if (!mutation) return null;
  const blocking = mutation.phase !== "consumed";
  return <section className={blocking ? "studio-lock" : "studio-receipt"} role={blocking ? "alert" : "status"}>
    <h2>{mutation.phase === "ambiguous" || mutation.phase === "pending" ? "Command outcome unresolved" : mutation.refresh === "partial" ? "Confirmed command; refresh partial" : "Confirmed command receipt"}</h2>
    <p><strong>{mutation.operation}</strong> was submitted once at <time>{mutation.startedAt}</time>. {blocking ? "Duplicate and automatic replay are blocked." : "Authoritative role-filtered state was refreshed."}</p>
    {mutation.receipt && <dl><div><dt>Revision</dt><dd>{mutation.receipt.revisionBefore} → {mutation.receipt.revisionAfter}</dd></div><div><dt>Occurred</dt><dd>{mutation.receipt.occurredAt}</dd></div><div><dt>Receipt key</dt><dd><code>{mutation.receipt.idempotencyKey}</code></dd></div></dl>}
    {mutation.result !== undefined && <details><summary>Exact confirmed server response</summary><pre>{JSON.stringify(mutation.result, null, 2)}</pre></details>}
    {blocking && onRefresh && <button type="button" className="ghost" onClick={onRefresh}>Refresh authoritative state</button>}
  </section>;
}
