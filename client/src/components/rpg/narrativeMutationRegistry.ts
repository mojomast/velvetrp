import { useSyncExternalStore } from "react";

export type NarrativeLane = "travel" | "npc" | "faction" | "quest" | "story";
export type NarrativeMutationState = {
  campaignId: string;
  lane: NarrativeLane;
  operation: string;
  request: unknown;
  phase: "pending" | "ambiguous" | "confirmed" | "consumed";
  startedAt: string;
  result?: unknown;
  receipt?: { idempotencyKey: string; revisionBefore: number; revisionAfter: number; occurredAt: string };
  refresh: "required" | "partial" | "complete";
};

const PREFIX = "velvet.narrative-mutation.v2:";
const records = new Map<string, NarrativeMutationState | null>();
const listeners = new Map<string, Set<() => void>>();
const recordKey = (campaignId: string, lane: NarrativeLane) => `${campaignId}:${lane}`;
const storageKey = (campaignId: string, lane: NarrativeLane) => `${PREFIX}${campaignId}:${lane}`;

function readStored(campaignId: string, lane: NarrativeLane): NarrativeMutationState | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(campaignId, lane)) ?? "null") as NarrativeMutationState | null;
    if (!parsed || parsed.campaignId !== campaignId || parsed.lane !== lane) return null;
    // A document reload cannot prove whether an in-flight request committed.
    return parsed.phase === "pending" ? { ...parsed, phase: "ambiguous" } : parsed;
  } catch { return null; }
}

function current(campaignId: string, lane: NarrativeLane): NarrativeMutationState | null {
  const key = recordKey(campaignId, lane);
  if (!records.has(key)) records.set(key, readStored(campaignId, lane));
  return records.get(key) ?? null;
}

function publish(value: NarrativeMutationState | null): void {
  if (!value) return;
  const key = recordKey(value.campaignId, value.lane);
  records.set(key, value);
  try { localStorage.setItem(storageKey(value.campaignId, value.lane), JSON.stringify(value)); } catch { /* persistence is best effort */ }
  for (const listener of listeners.get(key) ?? []) listener();
}

function remove(campaignId: string, lane: NarrativeLane): void {
  const key = recordKey(campaignId, lane);
  records.set(key, null);
  try { localStorage.removeItem(storageKey(campaignId, lane)); } catch { /* persistence is best effort */ }
  for (const listener of listeners.get(key) ?? []) listener();
}

export function beginNarrativeMutation(campaignId: string, lane: NarrativeLane, operation: string, request: unknown): NarrativeMutationState | null {
  if (blocksNarrativeMutation(current(campaignId, lane))) return null;
  const value: NarrativeMutationState = { campaignId, lane, operation, request, phase: "pending", startedAt: new Date().toISOString(), refresh: "required" };
  publish(value);
  return value;
}

export function markNarrativeAmbiguous(value: NarrativeMutationState): void { publish({ ...value, phase: "ambiguous", refresh: "required" }); }
export function markNarrativeConfirmed(value: NarrativeMutationState, result: unknown, receipt: NarrativeMutationState["receipt"]): void {
  publish({ ...value, phase: "confirmed", result, receipt, refresh: "required" });
}
export function markNarrativePartial(value: NarrativeMutationState): void { publish({ ...value, phase: "confirmed", refresh: "partial" }); }
export function consumeNarrativeConfirmed(value: NarrativeMutationState): void { publish({ ...value, phase: "consumed", refresh: "complete" }); }
export function clearNarrativeMutation(campaignId: string, lane: NarrativeLane): void { remove(campaignId, lane); }
export function blocksNarrativeMutation(value: NarrativeMutationState | null): boolean { return value !== null && value.phase !== "consumed"; }

export function useNarrativeMutation(campaignId: string, lane: NarrativeLane): NarrativeMutationState | null {
  const key = recordKey(campaignId, lane);
  return useSyncExternalStore((listener) => {
    const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
    return () => { set.delete(listener); if (!set.size) listeners.delete(key); };
  }, () => current(campaignId, lane), () => null);
}

export function resetNarrativeMutationRegistryForTests(): void { records.clear(); listeners.clear(); }

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (!event.key?.startsWith(PREFIX)) return;
  const identity = event.key.slice(PREFIX.length), separator = identity.lastIndexOf(":");
  if (separator < 1) return;
  const campaignId = identity.slice(0, separator), lane = identity.slice(separator + 1) as NarrativeLane, key = recordKey(campaignId, lane);
  records.set(key, readStored(campaignId, lane)); for (const listener of listeners.get(key) ?? []) listener();
});
