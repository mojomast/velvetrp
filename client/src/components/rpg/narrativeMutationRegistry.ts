import { useSyncExternalStore } from "react";

export type NarrativeLane = "travel" | "npc" | "faction" | "quest" | "story";
export type PublicNarrativeReceipt = { idempotencyKey: string; revisionBefore: number; revisionAfter: number; occurredAt: string };
export type NarrativeMutationIdentity = { resourceId?: string; idempotencyKey: string; expectedRevision: number };
export type NarrativeMutationState = {
  campaignId: string;
  lane: NarrativeLane;
  operation: string;
  resourceId?: string;
  idempotencyKey: string;
  expectedRevision: number;
  resultingRevision?: number;
  phase: "pending" | "ambiguous" | "confirmed" | "consumed";
  startedAt: string;
  receipt?: PublicNarrativeReceipt;
  refresh: "required" | "partial" | "complete";
  /** Never persisted or rendered; removed immediately when authorization changes. */
  memoryResult?: unknown;
};

type PersistedNarrativeMutation = Omit<NarrativeMutationState, "memoryResult">;
const PREFIX = "velvet.narrative-mutation.v3:";
const LEGACY_UNSAFE_PREFIX = "velvet.narrative-mutation.v2:";
const records = new Map<string, NarrativeMutationState | null>();
const listeners = new Map<string, Set<() => void>>();
export type NpcPresenceMutationLock = { campaignId: string; sessionId: string; npcId: string; resultingRevision?: number; phase: "pending" | "ambiguous" | "reconciling" };
const presenceRecords = new Map<string, NpcPresenceMutationLock>();
const presenceListeners = new Map<string, Set<() => void>>();
const presenceKey = (campaignId: string, sessionId: string) => `${campaignId}\u0000${sessionId}`;
const recordKey = (campaignId: string, lane: NarrativeLane) => `${campaignId}:${lane}`;
const storageKey = (campaignId: string, lane: NarrativeLane) => `${PREFIX}${campaignId}:${lane}`;
const publicReceipt=(value:unknown):PublicNarrativeReceipt|undefined=>{if(typeof value!=="object"||value===null)return undefined;const item=value as Record<string,unknown>;return typeof item.idempotencyKey==="string"&&typeof item.revisionBefore==="number"&&typeof item.revisionAfter==="number"&&typeof item.occurredAt==="string"?{idempotencyKey:item.idempotencyKey,revisionBefore:item.revisionBefore,revisionAfter:item.revisionAfter,occurredAt:item.occurredAt}:undefined;};
const persisted = (value:NarrativeMutationState): PersistedNarrativeMutation => ({campaignId:value.campaignId,lane:value.lane,operation:value.operation,
  ...(value.resourceId?{resourceId:value.resourceId}:{}),idempotencyKey:value.idempotencyKey,expectedRevision:value.expectedRevision,
  ...(value.resultingRevision!==undefined?{resultingRevision:value.resultingRevision}:{}),phase:value.phase,startedAt:value.startedAt,
  ...(publicReceipt(value.receipt)?{receipt:publicReceipt(value.receipt)}:{}),refresh:value.refresh});

function validStored(value: unknown, campaignId: string, lane: NarrativeLane): PersistedNarrativeMutation | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<PersistedNarrativeMutation>;
  if (item.campaignId !== campaignId || item.lane !== lane || typeof item.operation !== "string"
    || typeof item.idempotencyKey !== "string" || typeof item.expectedRevision !== "number"
    || typeof item.startedAt !== "string" || !["pending", "ambiguous", "confirmed", "consumed"].includes(item.phase ?? "")) return null;
  // Whitelist reconstruction ensures unknown/private keys from storage never enter memory.
  return { campaignId, lane, operation: item.operation, ...(typeof item.resourceId === "string" ? { resourceId: item.resourceId } : {}),
    idempotencyKey: item.idempotencyKey, expectedRevision: item.expectedRevision,
    ...(typeof item.resultingRevision === "number" ? { resultingRevision: item.resultingRevision } : {}),
    phase: item.phase!, startedAt: item.startedAt, ...(publicReceipt(item.receipt) ? { receipt: publicReceipt(item.receipt) } : {}),
    refresh: item.refresh === "partial" || item.refresh === "complete" ? item.refresh : "required" };
}
function readStored(campaignId: string, lane: NarrativeLane): NarrativeMutationState | null {
  try { const parsed = validStored(JSON.parse(localStorage.getItem(storageKey(campaignId, lane)) ?? "null"), campaignId, lane);
    return parsed === null ? null : parsed.phase === "pending" ? { ...parsed, phase: "ambiguous" } : parsed; } catch { return null; }
}
function current(campaignId: string, lane: NarrativeLane): NarrativeMutationState | null { const key=recordKey(campaignId,lane);if(!records.has(key))records.set(key,readStored(campaignId,lane));return records.get(key)??null; }
function notify(key:string){for(const listener of listeners.get(key)??[])listener();}
function publish(value:NarrativeMutationState){const key=recordKey(value.campaignId,value.lane);records.set(key,value);try{localStorage.setItem(storageKey(value.campaignId,value.lane),JSON.stringify(persisted(value)));}catch{/* best effort */}notify(key);}
function remove(campaignId:string,lane:NarrativeLane){const key=recordKey(campaignId,lane);records.set(key,null);try{localStorage.removeItem(storageKey(campaignId,lane));}catch{/* best effort */}notify(key);}

export function beginNarrativeMutation(campaignId:string,lane:NarrativeLane,operation:string,identity:NarrativeMutationIdentity):NarrativeMutationState|null{if(blocksNarrativeMutation(current(campaignId,lane)))return null;const value:NarrativeMutationState={campaignId,lane,operation,...identity,phase:"pending",startedAt:new Date().toISOString(),refresh:"required"};publish(value);return value;}
export function markNarrativeAmbiguous(value:NarrativeMutationState){publish({...value,memoryResult:undefined,phase:"ambiguous",refresh:"required"});}
export function markNarrativeConfirmed(value:NarrativeMutationState,result:unknown,receipt:PublicNarrativeReceipt|undefined){publish({...value,memoryResult:result,receipt,resultingRevision:receipt?.revisionAfter,phase:"confirmed",refresh:"required"});}
export function markNarrativePartial(value:NarrativeMutationState){publish({...value,phase:"confirmed",refresh:"partial"});}
export function consumeNarrativeConfirmed(value:NarrativeMutationState){publish({...value,phase:"consumed",refresh:"complete"});}
export function clearNarrativeMutation(campaignId:string,lane:NarrativeLane){remove(campaignId,lane);}
export function blocksNarrativeMutation(value:NarrativeMutationState|null){return value!==null&&value.phase!=="consumed";}

/** Removes all in-memory private results while retaining only safe replay locks and receipts. */
export function sanitizeCampaignNarrativeMutations(campaignId:string):void{for(const lane of ["travel","npc","faction","quest","story"] as const){const value=current(campaignId,lane)??readStored(campaignId,lane);if(value)publish({...value,memoryResult:undefined});else remove(campaignId,lane);}}
export function useNarrativeMutation(campaignId:string,lane:NarrativeLane):NarrativeMutationState|null{const key=recordKey(campaignId,lane);return useSyncExternalStore((listener)=>{const set=listeners.get(key)??new Set();set.add(listener);listeners.set(key,set);return()=>{set.delete(listener);if(!set.size)listeners.delete(key);};},()=>current(campaignId,lane),()=>null);}
export function resetNarrativeMutationRegistryForTests(){records.clear();listeners.clear();}

function notifyPresence(key: string) { for (const listener of presenceListeners.get(key) ?? []) listener(); }
export function beginNpcPresenceMutation(campaignId: string, sessionId: string, npcId: string): NpcPresenceMutationLock | null {
  const key = presenceKey(campaignId, sessionId); if (presenceRecords.has(key)) return null;
  const value: NpcPresenceMutationLock = { campaignId, sessionId, npcId, phase: "pending" }; presenceRecords.set(key, value); notifyPresence(key); return value;
}
export function markNpcPresenceAmbiguous(value: NpcPresenceMutationLock): void { const key = presenceKey(value.campaignId, value.sessionId); if (presenceRecords.get(key) !== value) return; const next = { ...value, phase: "ambiguous" as const }; presenceRecords.set(key, next); notifyPresence(key); }
export function markNpcPresenceReconciliation(value: NpcPresenceMutationLock, resultingRevision: number): void { const key = presenceKey(value.campaignId, value.sessionId); if (presenceRecords.get(key) !== value) return; const next = { ...value, resultingRevision, phase: "reconciling" as const }; presenceRecords.set(key, next); notifyPresence(key); }
export function reconcileNpcPresenceMutation(campaignId: string, sessionId: string, revision: number, explicitAmbiguousRefresh = false): boolean {
  const key = presenceKey(campaignId, sessionId), value = presenceRecords.get(key); if (!value) return true;
  if ((value.resultingRevision === undefined || revision < value.resultingRevision) && !(explicitAmbiguousRefresh && value.phase === "ambiguous")) return false;
  presenceRecords.delete(key); notifyPresence(key); return true;
}
export function clearNpcPresenceMutation(campaignId: string, sessionId: string): void { const key = presenceKey(campaignId, sessionId); presenceRecords.delete(key); notifyPresence(key); }
export function releaseNpcPresenceMutation(value: NpcPresenceMutationLock): void { const key = presenceKey(value.campaignId, value.sessionId); if (presenceRecords.get(key) !== value) return; presenceRecords.delete(key); notifyPresence(key); }
export function useNpcPresenceMutation(campaignId: string, sessionId: string): NpcPresenceMutationLock | null { const key = presenceKey(campaignId, sessionId); return useSyncExternalStore((listener) => { const set = presenceListeners.get(key) ?? new Set(); set.add(listener); presenceListeners.set(key, set); return () => { set.delete(listener); if (!set.size) presenceListeners.delete(key); }; }, () => presenceRecords.get(key) ?? null, () => null); }
export function resetNpcPresenceMutationRegistryForTests(): void { presenceRecords.clear(); presenceListeners.clear(); }

if(typeof window!=="undefined"){
  // One-time cleanup of the previous unsafe format that could contain full payloads.
  try{for(let index=localStorage.length-1;index>=0;index--){const key=localStorage.key(index);if(key?.startsWith(LEGACY_UNSAFE_PREFIX))localStorage.removeItem(key);}}catch{/* inaccessible storage */}
  window.addEventListener("storage",(event)=>{if(!event.key?.startsWith(PREFIX))return;const identity=event.key.slice(PREFIX.length),separator=identity.lastIndexOf(":");if(separator<1)return;const campaignId=identity.slice(0,separator),lane=identity.slice(separator+1) as NarrativeLane,key=recordKey(campaignId,lane);records.set(key,readStored(campaignId,lane));notify(key);});
}
