import { combatEnemyTurnCommandRequestSchema, combatRewardClaimRequestSchema, directCombatPowerCommandRequestSchema, resourceIdSchema } from "@velvet/contracts";
import type {
  ActorEffectsResponse, ActorPowerCommandRequest, ActorPowerCommandResponse, ActorPowersResponse, ActorResourcesHttpGetResponse,
  CampaignRole,
  CombatActionCommandRequest, CombatActionCommandResponse, CombatCommandResultResponse, CombatEnemyTurnCommandRequest, CombatRewardClaimRequest, CombatRewardClaimResponse, CombatRewardClaimResultResponse, CombatRewardGrantPublic, EconomyHttpWalletGetResponse,
  CombatEndCommandResponse, CombatLegalAction, CombatLogEntryPublic, CombatLogResponse, CombatReadResponse, EncounterPublic,
  UseConsumableCommandRequest,UseConsumableCommandResult,UseConsumableLegalAction,DirectCombatPowerCandidate,DirectCombatPowerCommandRequest,DirectCombatPowerCommandResponse,
} from "@velvet/contracts";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {ApiError, resolveCombatEnemyTurn} from "../../../api";
import { CombatLog } from "./CombatLog";
import { EncounterLifecyclePanel } from "./EncounterLifecyclePanel";
import { CombatRewards } from "./CombatRewards";
import { EffectList } from "./EffectList";
import { InitiativeRail } from "./InitiativeRail";
import { LegalActionTray } from "./LegalActionTray";
import { PowerLibraryPanel } from "./PowerLibraryPanel";
import { createClientId } from "../../../utils/clientId";
import { TacticalMapPanel, type TacticalMapPanelApi } from "../map/TacticalMapPanel";

export interface CombatTrackerApi extends Partial<TacticalMapPanelApi> {
  listEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
  getCombatLog: (combatId: string, query: { afterSequence: number; limit: number }) => Promise<CombatLogResponse>;
  resolveAction: (combatId: string, command: CombatActionCommandRequest) => Promise<CombatActionCommandResponse>;
  resolveEnemyTurn?: (combatId: string, command: CombatEnemyTurnCommandRequest) => Promise<CombatActionCommandResponse>;
  getCommandResult: (campaignId: string, combatId: string, idempotencyKey: string) => Promise<CombatCommandResultResponse>;
  getPowers: (actorId: string) => Promise<ActorPowersResponse>;
  getEffects: (actorId: string) => Promise<ActorEffectsResponse>;
  getResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  usePower: (actorId: string, command: ActorPowerCommandRequest) => Promise<ActorPowerCommandResponse>;
  getConsumableActions:(combatId:string)=>Promise<UseConsumableLegalAction[]>;
  useConsumable:(combatId:string,command:UseConsumableCommandRequest)=>Promise<UseConsumableCommandResult>;
  getConsumableResult:(combatId:string,expectedRequest:UseConsumableCommandRequest)=>Promise<UseConsumableCommandResult>;
  getCombatPowerActions:(combatId:string)=>Promise<DirectCombatPowerCandidate[]>;
  useCombatPower:(combatId:string,command:DirectCombatPowerCommandRequest)=>Promise<DirectCombatPowerCommandResponse>;
  getCombatPowerResult:(combatId:string,command:DirectCombatPowerCommandRequest)=>Promise<DirectCombatPowerCommandResponse>;
  listRewards:(combatId:string)=>Promise<CombatRewardGrantPublic[]>;
  claimReward:(combatId:string,rewardBundleId:string,recipientActorId:string,command:CombatRewardClaimRequest)=>Promise<CombatRewardClaimResponse>;
  getRewardClaimResult:(campaignId:string,combatId:string,rewardBundleId:string,recipientActorId:string,command:CombatRewardClaimRequest)=>Promise<CombatRewardClaimResultResponse>;
  getWallet:(campaignId:string,actorId:string)=>Promise<EconomyHttpWalletGetResponse>;
  startEncounter:(encounterId:string,input:{expectedRevision:number;idempotencyKey:string})=>Promise<{combat:CombatReadResponse&{combatId:string}}>;
  endCombat:(combatId:string,input:{expectedRevision:number;idempotencyKey:string})=>Promise<CombatEndCommandResponse>;
}

export interface CombatTrackerPageProps {
  api: CombatTrackerApi;
  campaignId: string;
  sessionId?: string;
  actorRole?: CampaignRole;
  audience?: "gm" | "player";
  controlledActorId?: string;
  initialCombatId?: string;
  onBack: () => void;
  onReturnToRoom?: () => void;
  onUnavailable?: () => void;
  focusHeadingRequest?: number;
  embedded?: boolean;
  blocked?: boolean;
  onLockChange?: (locked: boolean) => void;
  onStateChange?: () => void;
}

type ActionMarker = {
  campaignId: string;
  combatId: string;
  operation: "action";
  phase: "ambiguous" | "confirmed";
  command: CombatActionCommandRequest;
  actionKind: string;
  startedAt: string;
  result?: CombatActionCommandResponse;
};
type PowerMarker = { campaignId: string; actorId: string; phase: "ambiguous" | "confirmed"; command: ActorPowerCommandRequest; startedAt: string; result?: ActorPowerCommandResponse };
type ConsumableMarker={campaignId:string;combatId:string;phase:"ambiguous"|"confirmed";command:UseConsumableCommandRequest;startedAt:string;result?:UseConsumableCommandResult};
type RewardClaimMarker={campaignId:string;combatId:string;rewardBundleId:string;recipientActorId:string;phase:"ambiguous"|"confirmed";command:CombatRewardClaimRequest;startedAt:string;result?:CombatRewardClaimResponse};
type EnemyTurnMarker={campaignId:string;combatId:string;phase:"ambiguous"|"confirmed";command:CombatEnemyTurnCommandRequest;startedAt:string;result?:CombatActionCommandResponse};
type CombatPowerMarker={campaignId:string;combatId:string;phase:"ambiguous"|"confirmed";command:DirectCombatPowerCommandRequest;startedAt:string;result?:DirectCombatPowerCommandResponse};

const combatStorageKey = (campaignId: string) => `velvet.combat-id.v2:${campaignId}`;
const actorStorageKey = (campaignId: string) => `velvet.combat-actor-id.v2:${campaignId}`;
const markerKey = (campaignId: string, combatId: string) => `velvet.combat-action.v2:${campaignId}:${combatId}`;
const powerMarkerKey = (campaignId: string, actorId: string) => `velvet.power-action.v1:${campaignId}:${actorId}`;
const consumableMarkerKey=(campaignId:string,combatId:string)=>`velvet.combat-consumable.v1:${campaignId}:${combatId}`;
const rewardMarkerKey=(campaignId:string,combatId:string)=>`velvet.combat-reward-claim.v1:${campaignId}:${combatId}`;
const enemyTurnMarkerKey=(campaignId:string,combatId:string)=>`velvet.combat-enemy-turn.v1:${campaignId}:${combatId}`;
const combatPowerMarkerKey=(campaignId:string,combatId:string)=>`velvet.combat-power.v1:${campaignId}:${combatId}`;
const readStoredId = (key: string) => { try { const id = localStorage.getItem(key) ?? ""; return resourceIdSchema.safeParse(id).success ? id : ""; } catch { return ""; } };
const writeStoredId = (key: string, id: string) => { try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* optional restoration */ } };
const readMarker = (campaignId: string, combatId: string): ActionMarker | null => {
  if (!combatId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(markerKey(campaignId, combatId)) ?? "null") as Partial<ActionMarker> | null;
    return value?.campaignId === campaignId && value.combatId === combatId && value.operation === "action" && (value.phase === "ambiguous" || value.phase === "confirmed") && typeof value.actionKind === "string" && typeof value.startedAt === "string" && value.command !== undefined ? value as ActionMarker : null;
  } catch { return null; }
};
const writeMarker = (campaignId: string, combatId: string, marker: ActionMarker | null): boolean => { try { const key=markerKey(campaignId,combatId); if(marker){const encoded=JSON.stringify(marker);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;} catch { return false; } };
const readPowerMarker = (campaignId: string, actorId: string): PowerMarker | null => { try { const value=JSON.parse(localStorage.getItem(powerMarkerKey(campaignId,actorId))??"null") as Partial<PowerMarker>|null; return value?.campaignId===campaignId&&value.actorId===actorId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&value.command!==undefined?value as PowerMarker:null; } catch{return null;} };
const writePowerMarker = (campaignId:string,actorId:string,value:PowerMarker|null) => { try { if(value)localStorage.setItem(powerMarkerKey(campaignId,actorId),JSON.stringify(value));else localStorage.removeItem(powerMarkerKey(campaignId,actorId)); } catch{/* durable best effort */} };
const readConsumableMarker=(campaignId:string,combatId:string):ConsumableMarker|null=>{try{const value=JSON.parse(localStorage.getItem(consumableMarkerKey(campaignId,combatId))??"null") as Partial<ConsumableMarker>|null;return value?.campaignId===campaignId&&value.combatId===combatId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&value.command!==undefined?value as ConsumableMarker:null;}catch{return null;}};
const writeConsumableMarker=(campaignId:string,combatId:string,value:ConsumableMarker|null):boolean=>{try{const key=consumableMarkerKey(campaignId,combatId);if(value){const encoded=JSON.stringify(value);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}};
const readRewardMarker=(campaignId:string,combatId:string):RewardClaimMarker|null=>{try{const value=JSON.parse(localStorage.getItem(rewardMarkerKey(campaignId,combatId))??"null") as Partial<RewardClaimMarker>|null;return value?.campaignId===campaignId&&value.combatId===combatId&&resourceIdSchema.safeParse(value.rewardBundleId).success&&resourceIdSchema.safeParse(value.recipientActorId).success&&(value.phase==="ambiguous"||value.phase==="confirmed")&&combatRewardClaimRequestSchema.safeParse(value.command).success&&typeof value.startedAt==="string"?value as RewardClaimMarker:null;}catch{return null;}};
const writeRewardMarker=(campaignId:string,combatId:string,value:RewardClaimMarker|null):boolean=>{try{const key=rewardMarkerKey(campaignId,combatId);if(value){const encoded=JSON.stringify(value);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}};
const readEnemyTurnMarker=(campaignId:string,combatId:string):EnemyTurnMarker|null=>{try{const value=JSON.parse(localStorage.getItem(enemyTurnMarkerKey(campaignId,combatId))??"null") as Partial<EnemyTurnMarker>|null;return value?.campaignId===campaignId&&value.combatId===combatId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&combatEnemyTurnCommandRequestSchema.safeParse(value.command).success&&typeof value.startedAt==="string"?value as EnemyTurnMarker:null;}catch{return null;}};
const writeEnemyTurnMarker=(campaignId:string,combatId:string,value:EnemyTurnMarker|null):boolean=>{try{const key=enemyTurnMarkerKey(campaignId,combatId);if(value){const encoded=JSON.stringify(value);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}};
const readCombatPowerMarker=(campaignId:string,combatId:string):CombatPowerMarker|null=>{try{const value=JSON.parse(localStorage.getItem(combatPowerMarkerKey(campaignId,combatId))??"null") as Partial<CombatPowerMarker>|null;return value?.campaignId===campaignId&&value.combatId===combatId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&directCombatPowerCommandRequestSchema.safeParse(value.command).success&&typeof value.startedAt==="string"?value as CombatPowerMarker:null;}catch{return null;}};
const writeCombatPowerMarker=(campaignId:string,combatId:string,value:CombatPowerMarker|null):boolean=>{try{const key=combatPowerMarkerKey(campaignId,combatId);if(value){const encoded=JSON.stringify(value);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}};
const commandId = () => `combat-ui-${createClientId()}`;
const readCombatId = (campaignId:string,initial?: string) => resourceIdSchema.safeParse(initial).success ? initial! : readStoredId(combatStorageKey(campaignId));

function publicRead(response: CombatActionCommandResponse): CombatReadResponse {
  const { round, currentCombatant, combatants, legalActions, revision } = response.combat;
  return { round, currentCombatant, combatants, legalActions, revision };
}

function OutcomeReceipt({ result }: { result: CombatActionCommandResponse }) {
  const { resolution, receipt } = result;
  return <section className="combat-receipt" aria-labelledby="combat-receipt-heading">
    <div className="combat-panel-heading"><h2 id="combat-receipt-heading">Confirmed action receipt</h2><span>{resolution.kind}</span></div>
    <dl><div><dt>Action</dt><dd>{resolution.kind}</dd></div><div><dt>Revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Round</dt><dd>{resolution.roundBefore} → {resolution.roundAfter}</dd></div><div><dt>Occurred</dt><dd>{receipt.occurredAt}</dd></div><div><dt>Targets</dt><dd>{resolution.targetIds.length ? resolution.targetIds.join(", ") : "None"}</dd></div></dl>
     {resolution.outcomes.length > 0 && <ul>{resolution.outcomes.map((outcome, index) => <li key={`${outcome.kind}-${outcome.targetId}-${index}`}>{outcome.kind === "damage" ? <><strong>Damage:</strong> {outcome.applied} {outcome.damageType} · HP {outcome.hitPointsBefore} → {outcome.hitPointsAfter} · {outcome.statusBefore} → {outcome.statusAfter}{outcome.rulesetId && <> · {outcome.rulesetId} @ {outcome.rulesetVersion} · attack {outcome.attackRoll} + modifiers = {outcome.attackTotal} vs AC {outcome.armorClass}{outcome.critical ? " · critical" : outcome.hit ? " · hit" : " · miss"}</>}</> : outcome.kind === "survival" ? <><strong>Survival:</strong> {outcome.roll ? `d20 ${outcome.roll} · ` : ""}{outcome.successes} successes, {outcome.failures} failures · {outcome.statusAfter}</> : outcome.kind === "status" ? <><strong>Status:</strong> {outcome.statusBefore} → {outcome.statusAfter}</> : <><strong>Contest:</strong> {outcome.contest} · {outcome.success ? "success" : "failure"} · {outcome.attackerRoll} vs {outcome.defenderRoll}</>}</li>)}</ul>}
    <details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </section>;
}
function ConsumableReceipt({result}:{result:UseConsumableCommandResult}){return <section className="combat-receipt" aria-labelledby="consumable-receipt-heading"><div className="combat-panel-heading"><h2 id="consumable-receipt-heading">Confirmed consumable receipt</h2><span>use-consumable</span></div><dl><div><dt>Item</dt><dd>{result.resolution.consumed.item.definitionId}</dd></div><div><dt>Quantity</dt><dd>{result.resolution.consumed.quantity}</dd></div><div><dt>Cost</dt><dd>{result.resolution.actionCost}</dd></div><div><dt>Target</dt><dd>{result.resolution.target.combatantId}</dd></div><div><dt>Revision</dt><dd>{result.receipt.revisionBefore} → {result.receipt.revisionAfter}</dd></div></dl><ul>{result.resolution.outcome.settlements.map((settlement)=><li key={settlement.effectOrdinal}>{settlement.kind}: {settlement.applied}</li>)}</ul></section>}

export function CombatTrackerPage({ api, campaignId, sessionId, actorRole = "gm", audience = "gm", controlledActorId, initialCombatId, onBack, onReturnToRoom, onUnavailable, focusHeadingRequest,
  embedded = false, blocked = false, onLockChange, onStateChange }: CombatTrackerPageProps) {
  const gmWorkspace=(actorRole==="owner"||actorRole==="gm")&&audience==="gm";
  const playerWorkspace=actorRole==="player"&&audience==="player";
  const observerWorkspace=!gmWorkspace&&!playerWorkspace;
  const initialId = useMemo(() => readCombatId(campaignId,initialCombatId), [campaignId,initialCombatId]);
  const [encounters,setEncounters]=useState<EncounterPublic[]>([]);
  const [combatId, setCombatId] = useState(initialId);
  const [combatDraft, setCombatDraft] = useState(initialId);
  const initialActorId=resourceIdSchema.safeParse(controlledActorId).success?controlledActorId!:gmWorkspace?readStoredId(actorStorageKey(campaignId)):"";
  const [actorId, setActorId] = useState(initialActorId);
  const [actorDraft, setActorDraft] = useState(actorId);
  const [combat, setCombat] = useState<CombatReadResponse | null>(null);
  const [consumableActions,setConsumableActions]=useState<UseConsumableLegalAction[]>([]);
  const [combatPowerActions,setCombatPowerActions]=useState<DirectCombatPowerCandidate[]>([]);
  const [entries, setEntries] = useState<CombatLogEntryPublic[]>([]);
  const [rewards,setRewards]=useState<CombatRewardGrantPublic[]>([]);
  const [nextSequence, setNextSequence] = useState<number | null>(null);
  const [powers, setPowers] = useState<ActorPowersResponse | null>(null);
  const [effects, setEffects] = useState<ActorEffectsResponse | null>(null);
  const [wallet,setWallet]=useState<EconomyHttpWalletGetResponse|null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">(initialId ? "loading" : "idle");
  const [stateError, setStateError] = useState("");
  const [logError, setLogError] = useState("");
  const [powerError, setPowerError] = useState("");
  const [effectError, setEffectError] = useState("");
  const [rewardError,setRewardError]=useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [actorLoading, setActorLoading] = useState(false);
  const [marker, setMarkerState] = useState<ActionMarker | null>(() => readMarker(campaignId,initialId));
  const [confirmed, setConfirmed] = useState<CombatActionCommandResponse | null>(() => readMarker(campaignId,initialId)?.result ?? null);
  const [powerMarker,setPowerMarkerState]=useState<PowerMarker|null>(()=>readPowerMarker(campaignId,embedded ? initialActorId : readStoredId(actorStorageKey(campaignId))));
  const [powerResult,setPowerResult]=useState<ActorPowerCommandResponse|null>(()=>readPowerMarker(campaignId,embedded ? initialActorId : readStoredId(actorStorageKey(campaignId)))?.result??null);
  const [powerStatus,setPowerStatus]=useState("");
  const [consumableMarker,setConsumableMarkerState]=useState<ConsumableMarker|null>(()=>readConsumableMarker(campaignId,initialId));
  const [consumableResult,setConsumableResult]=useState<UseConsumableCommandResult|null>(()=>readConsumableMarker(campaignId,initialId)?.result??null);
  const [consumableStatus,setConsumableStatus]=useState("");
  const [rewardMarker,setRewardMarkerState]=useState<RewardClaimMarker|null>(()=>readRewardMarker(campaignId,initialId));
  const [enemyTurnMarker,setEnemyTurnMarkerState]=useState<EnemyTurnMarker|null>(()=>readEnemyTurnMarker(campaignId,initialId));
  const [enemyTurnResult,setEnemyTurnResult]=useState<CombatActionCommandResponse|null>(()=>readEnemyTurnMarker(campaignId,initialId)?.result??null);
  const [combatPowerMarker,setCombatPowerMarkerState]=useState<CombatPowerMarker|null>(()=>readCombatPowerMarker(campaignId,initialId));
  const [combatPowerResult,setCombatPowerResult]=useState<DirectCombatPowerCommandResponse|null>(()=>readCombatPowerMarker(campaignId,initialId)?.result??null);
  const [rewardStatus,setRewardStatus]=useState("");
  const [commandStatus, setCommandStatus] = useState("");
  const [inspected, setInspected] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const actorGenerationRef = useRef(0);
  const combatIdRef = useRef(combatId);
  const actorIdRef = useRef(actorId);
  const rewardMarkerRef=useRef(rewardMarker);
  const authorityRef=useRef(gmWorkspace?2:playerWorkspace?1:0);
  combatIdRef.current = combatId;
  actorIdRef.current = actorId;
  rewardMarkerRef.current=rewardMarker;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const [preparingCommand, setPreparingCommand] = useState(false);
  const stateChangeRef = useRef(onStateChange); stateChangeRef.current = onStateChange;
  const commandLocked = Boolean(marker || powerMarker || consumableMarker || rewardMarker || enemyTurnMarker || combatPowerMarker || preparingCommand);
  useEffect(() => { onLockChange?.(!observerWorkspace && commandLocked); }, [commandLocked, observerWorkspace, onLockChange]);
  useEffect(() => () => onLockChange?.(false), [onLockChange]);
  useEffect(() => { if (combat) stateChangeRef.current?.(); }, [combatId, combat?.revision]);

  const current = useCallback((generation: number, id: string) => mountedRef.current && generationRef.current === generation && combatIdRef.current === id, []);
  const setMarker = useCallback((next: ActionMarker | null, id = combatId): boolean => { const stored=writeMarker(campaignId,id,next); if (stored && mountedRef.current) setMarkerState(next); return stored; }, [campaignId,combatId]);
  const clearRewardMarker=useCallback((id:string)=>{writeRewardMarker(campaignId,id,null);rewardMarkerRef.current=null;if(mountedRef.current)setRewardMarkerState(null);},[campaignId]);

  const loadCombat = useCallback(async (id: string, focusFailure = false) => {
    if (!resourceIdSchema.safeParse(id).success) return false;
    const generation = ++generationRef.current;
    setPhase("loading"); setStateError(""); setLogError(""); setRewardError(""); setLogLoading(true);
    const [stateRead, logRead,consumableRead,powerRead,rewardRead] = await Promise.allSettled([api.getCombat(id), api.getCombatLog(id, { afterSequence: 0, limit: 50 }),observerWorkspace?Promise.resolve([]):api.getConsumableActions(id),observerWorkspace?Promise.resolve([]):api.getCombatPowerActions(id),api.listRewards(id)] as const);
    if (!current(generation, id)) return false;
    if (stateRead.status === "fulfilled") { setCombat(stateRead.value); setPhase("ready"); }
    else { setStateError("Combat state could not be refreshed."); setPhase(combat ? "ready" : "failed"); if (focusFailure) queueMicrotask(() => retryRef.current?.focus()); }
    if (logRead.status === "fulfilled") { setEntries(logRead.value.entries); setNextSequence(logRead.value.nextAfterSequence); }
    else setLogError("Combat log could not be refreshed. Existing events are preserved.");
    if(consumableRead.status==="fulfilled")setConsumableActions(consumableRead.value);
    else {setConsumableActions([]);setStateError("Combat state loaded, but consumable actions could not be refreshed.");}
    if(powerRead.status==="fulfilled")setCombatPowerActions(powerRead.value);else setCombatPowerActions([]);
    if(rewardRead.status==="fulfilled"){
      const authoritativeCombat=stateRead.status==="fulfilled"?stateRead.value:combat;
      const actorIds=new Set(authoritativeCombat?.combatants.flatMap((entry)=>entry.kind==="actor"?[entry.actorId]:[])??[]);
      const duplicateBundles=new Set(rewardRead.value.map((reward)=>reward.rewardBundleId)).size!==rewardRead.value.length;
      if(duplicateBundles||rewardRead.value.some((reward)=>!actorIds.has(reward.recipientActorId))){setRewardError("Reward state failed its combat and recipient binding checks. Existing reward state is preserved.");}
      else {
        setRewards(rewardRead.value);
        const pending=rewardMarkerRef.current,bound=pending?.combatId===id?rewardRead.value.find((reward)=>reward.rewardBundleId===pending.rewardBundleId&&reward.recipientActorId===pending.recipientActorId):undefined;
        if(pending&&bound?.claim.state==="claimed"){
          clearRewardMarker(id);
          setRewardStatus(bound.claim.rewardClaimId===pending.command.rewardClaimId?"Claim settlement confirmed by authoritative reward state.":"The bundle was already settled by a different claim; no claim was replayed.");
        }
      }
    }else setRewardError("Combat rewards could not be refreshed. Existing claimed state is preserved.");
    setLogLoading(false);
    return stateRead.status === "fulfilled" && logRead.status === "fulfilled"&&consumableRead.status==="fulfilled"&&powerRead.status==="fulfilled"&&rewardRead.status==="fulfilled";
  }, [api, clearRewardMarker, combat, current, observerWorkspace]);

  const loadActor = useCallback(async (id: string):Promise<boolean> => {
    if (!resourceIdSchema.safeParse(id).success) return false;
    const generation = ++actorGenerationRef.current; setActorLoading(true); setPowerError(""); setEffectError("");
    const [powerRead, effectRead,resourceRead,walletRead] = await Promise.allSettled([api.getPowers(id), api.getEffects(id),api.getResources(campaignId,id),api.getWallet(campaignId,id)] as const);
    if (!mountedRef.current || generation !== actorGenerationRef.current || id !== actorIdRef.current) return false;
    if (powerRead.status === "fulfilled") setPowers(powerRead.value); else setPowerError("Powers could not be refreshed. Existing power data is preserved.");
    if (effectRead.status === "fulfilled") setEffects(effectRead.value); else setEffectError("Effects could not be refreshed. Existing effect data is preserved.");
    if(walletRead.status==="fulfilled")setWallet(walletRead.value);
    setActorLoading(false);
    return powerRead.status==="fulfilled"&&effectRead.status==="fulfilled"&&resourceRead.status==="fulfilled"&&walletRead.status==="fulfilled";
  }, [api,campaignId]);

  useEffect(() => {
    mountedRef.current = true;
    void api.listEncounters(campaignId).then((value)=>{
      if(!mountedRef.current)return;const available=value.encounters.filter((encounter)=>encounter.combatId!==null&&(!embedded||encounter.sessionId===sessionId));setEncounters(available);
      if(combatId&&available.some((encounter)=>encounter.combatId===combatId))void loadCombat(combatId);
      else if (embedded && available.filter((encounter) => encounter.status === "active").length === 1) {
        const id = available.find((encounter) => encounter.status === "active")!.combatId!;
        openLifecycleCombat(id);
      }
      else { combatIdRef.current="";setCombatId("");setCombatDraft("");writeStoredId(combatStorageKey(campaignId),"");setPhase("idle"); }
    }).catch(()=>{if(mountedRef.current){setStateError("Campaign encounters could not be loaded.");setPhase("failed");}});
    if (actorId&&!observerWorkspace) void loadActor(actorId);
    return () => { mountedRef.current = false; generationRef.current += 1; actorGenerationRef.current += 1; };
    // Route identity initializes this component; explicit forms handle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(()=>{
    const next=gmWorkspace?2:playerWorkspace?1:0;
    if(next<authorityRef.current){
      generationRef.current+=1;actorGenerationRef.current+=1;setMarkerState(null);setConfirmed(null);setPowerMarkerState(null);setPowerResult(null);setConsumableMarkerState(null);setConsumableResult(null);setRewardMarkerState(null);rewardMarkerRef.current=null;setEnemyTurnMarkerState(null);setEnemyTurnResult(null);setCombatPowerMarkerState(null);setCombatPowerResult(null);setCommandStatus("");setPowerStatus("");setConsumableStatus("");setRewardStatus("");setConsumableActions([]);setCombatPowerActions([]);setPowers(null);setEffects(null);setWallet(null);setInspected(null);
      if(!gmWorkspace){const nextActor=resourceIdSchema.safeParse(controlledActorId).success?controlledActorId!:"";actorIdRef.current=nextActor;setActorId(nextActor);setActorDraft(nextActor);}
    }
    authorityRef.current=next;
  },[gmWorkspace,playerWorkspace]);
  useEffect(() => { if ((phase === "ready"||phase==="idle"||phase==="failed") && focusHeadingRequest !== undefined) queueMicrotask(() => headingRef.current?.focus()); }, [focusHeadingRequest, phase]);

  function connectCombat(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(combatDraft).success) return;
    if(!encounters.some((encounter)=>encounter.combatId===combatDraft))return;
    generationRef.current += 1; combatIdRef.current = combatDraft; setCombatId(combatDraft); writeStoredId(combatStorageKey(campaignId), combatDraft); setCombat(null); setEntries([]); setRewards([]); setNextSequence(null);
    const restored = readMarker(campaignId,combatDraft); setMarkerState(restored); setConfirmed(restored?.result ?? null); setCommandStatus("");
    const restoredConsumable=readConsumableMarker(campaignId,combatDraft);setConsumableMarkerState(restoredConsumable);setConsumableResult(restoredConsumable?.result??null);setConsumableStatus("");
    const restoredReward=readRewardMarker(campaignId,combatDraft);rewardMarkerRef.current=restoredReward;setRewardMarkerState(restoredReward);setRewardStatus("");
    const restoredEnemyTurn=readEnemyTurnMarker(campaignId,combatDraft);setEnemyTurnMarkerState(restoredEnemyTurn);setEnemyTurnResult(restoredEnemyTurn?.result??null);
    const restoredCombatPower=readCombatPowerMarker(campaignId,combatDraft);setCombatPowerMarkerState(restoredCombatPower);setCombatPowerResult(restoredCombatPower?.result??null);
    // State publication is asynchronous, so this direct read is bound to the submitted exact ID.
    queueMicrotask(() => { if (mountedRef.current) void loadCombat(combatDraft); });
  }
  function connectActor(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(actorDraft).success) return;
    actorGenerationRef.current += 1; actorIdRef.current = actorDraft; setActorId(actorDraft); writeStoredId(actorStorageKey(campaignId), actorDraft); setPowers(null); setEffects(null);setWallet(null);
    const restored=readPowerMarker(campaignId,actorDraft);setPowerMarkerState(restored);setPowerResult(restored?.result??null);setPowerStatus("");
    queueMicrotask(() => { if (mountedRef.current) void loadActor(actorDraft); });
  }
  function openLifecycleCombat(id: string) {
    setCombatDraft(id); combatIdRef.current=id; setCombatId(id); writeStoredId(combatStorageKey(campaignId),id); setCombat(null); setEntries([]); setRewards([]); setNextSequence(null);
    const action = readMarker(campaignId, id); setMarkerState(action); setConfirmed(action?.result ?? null);
    setConsumableMarkerState(readConsumableMarker(campaignId, id)); setConsumableResult(null);
    const reward = readRewardMarker(campaignId, id); rewardMarkerRef.current = reward; setRewardMarkerState(reward);
    setEnemyTurnMarkerState(readEnemyTurnMarker(campaignId, id)); setEnemyTurnResult(null);
    setCombatPowerMarkerState(readCombatPowerMarker(campaignId, id)); setCombatPowerResult(null);
    queueMicrotask(() => { if (mountedRef.current) void loadCombat(id); });
  }
  async function refreshRoomEncounters() {
    try {
      const value = await api.listEncounters(campaignId);
      if (!mountedRef.current) return;
      setEncounters(value.encounters.filter((entry) => entry.sessionId === sessionId && entry.combatId !== null));
      if (combatId) await loadCombat(combatId);
    } catch { if (mountedRef.current) setStateError("Room encounters could not be refreshed. No command was sent."); }
  }
  async function loadMoreLog() {
    if (!combatId || nextSequence === null || logLoading) return;
    const cursor = nextSequence; setLogLoading(true); setLogError("");
    try {
      const page = await api.getCombatLog(combatId, { afterSequence: cursor, limit: 50 });
      if (!mountedRef.current || combatIdRef.current !== combatId) return;
      setEntries((currentEntries) => [...currentEntries, ...page.entries.filter((entry) => !currentEntries.some((old) => old.sequence === entry.sequence))]);
      setNextSequence(page.nextAfterSequence);
    } catch { if (mountedRef.current) setLogError("Later combat events could not be loaded."); }
    finally { if (mountedRef.current) setLogLoading(false); }
  }
  async function submitAction(action: CombatLegalAction, targetIds: string[]) {
    if (blockedRef.current || (embedded && commandLocked)) return;
    const playerOwnTurn=playerWorkspace&&combat?.combatants.some((entry)=>entry.kind==="actor"&&entry.actorId===controlledActorId&&entry.combatantId===combat.currentCombatant);
    if ((!gmWorkspace&&!playerOwnTurn)||!combat || marker || rewardMarker || !action.targetIds.every((id) => combat.combatants.some((entry) => entry.combatantId === id)) || targetIds.some((id) => !action.targetIds.includes(id))) return;
    const command: CombatActionCommandRequest = { legalActionId: action.legalActionId, targetIds, choices: [], expectedRevision: combat.revision, idempotencyKey: commandId() };
    const pending: ActionMarker = { campaignId,combatId,operation:"action", phase: "ambiguous", command, actionKind: action.kind, startedAt: new Date().toISOString() };
    if(!setMarker(pending)){setCommandStatus("Action was not submitted because its durable safety lock could not be stored. Enable local storage and try again.");return;}
    setConfirmed(null); setCommandStatus("Submitting once. Automatic replay is disabled.");
    try {
      const result = await api.resolveAction(combatId, command);
      const complete: ActionMarker = { ...pending, phase: "confirmed", result };
       if(!setMarker(complete)){if(mountedRef.current)setCommandStatus("Action response arrived, but durable confirmation could not be stored. No POST will be retried; use exact result reconciliation.");return;}
      if (!mountedRef.current) return;
      setMarkerState(complete); setConfirmed(result); setCombat(publicRead(result));
      setCommandStatus("Action confirmed. Refreshing authoritative combat state and log…");
      const refreshed = await loadCombat(combatId);
      if (!mountedRef.current) return;
       if (refreshed && setMarker(null)) { setCommandStatus("Action confirmed; authoritative state and log refreshed."); }
       else if(refreshed) setCommandStatus("Action confirmed, but the durable lock could not be cleared. Use exact result reconciliation before another action.");
      else setCommandStatus("Action confirmed, but refresh was partial. The receipt and write lock are preserved.");
    } catch {
      if (mountedRef.current) setCommandStatus("Action outcome is uncertain or stale. It will not be replayed. Use authoritative refresh before another action.");
    }
  }
  async function reconcile() {
    if (!combatId || !marker) return;
    setCommandStatus("Reading the exact immutable command result; no action will be replayed.");
    try{
      const found=await api.getCommandResult(campaignId,combatId,marker.command.idempotencyKey);
      if(!mountedRef.current||found.operation!=="action")return;
      setConfirmed(found.result);setCombat(publicRead(found.result));
      const refreshed=await loadCombat(combatId,true);if(!mountedRef.current)return;
       if(refreshed&&setMarker(null)){setCommandStatus("Exact command result confirmed; authoritative state and log refreshed.");}
       else if(refreshed)setCommandStatus("Exact result is confirmed, but the durable lock could not be cleared. It remains locked.");
      else setCommandStatus("Exact result is confirmed, but refresh is partial. The response and lock remain preserved.");
    }catch{if(mountedRef.current)setCommandStatus("No exact authorized command result is available. Generic state/log reads cannot clear this lock.");}
  }

  async function submitEnemyTurn(){
    if (blockedRef.current || (embedded && commandLocked)) return;
    if(!gmWorkspace||!combat||enemyTurnMarker||marker||consumableMarker||rewardMarker||combat.combatants.find((entry)=>entry.combatantId===combat.currentCombatant)?.kind!=="enemy")return;
    const command:CombatEnemyTurnCommandRequest={expectedRevision:combat.revision,idempotencyKey:commandId()};
    const pending:EnemyTurnMarker={campaignId,combatId,phase:"ambiguous",command,startedAt:new Date().toISOString()};
    if(!writeEnemyTurnMarker(campaignId,combatId,pending)){setCommandStatus("Enemy turn was not submitted because its durable safety lock could not be stored. Enable local storage and try again.");return;}
    setEnemyTurnMarkerState(pending);setEnemyTurnResult(null);setCommandStatus("Enemy turn submitted once. Automatic replay is disabled.");
    try{
      const result=await (api.resolveEnemyTurn??resolveCombatEnemyTurn)(combatId,command),complete:EnemyTurnMarker={...pending,phase:"confirmed",result};
      if(!writeEnemyTurnMarker(campaignId,combatId,complete)){if(mountedRef.current)setCommandStatus("Enemy turn response arrived, but durable confirmation could not be stored. No POST will be retried; refresh authoritative state.");return;}
      if(!mountedRef.current)return;
      setEnemyTurnMarkerState(complete);setEnemyTurnResult(result);setCombat(publicRead(result));
      const refreshed=await loadCombat(combatId);if(!mountedRef.current)return;
      if(refreshed){writeEnemyTurnMarker(campaignId,combatId,null);setEnemyTurnMarkerState(null);setCommandStatus("Enemy turn confirmed; authoritative combat state and log refreshed.");}
      else setCommandStatus("Enemy turn confirmed, but refresh is partial. The receipt and lock are preserved.");
    }catch{if(mountedRef.current)setCommandStatus("Enemy turn delivery is ambiguous. It will not be replayed; refresh authoritative state while the lock remains.");}
  }
  async function reconcileEnemyTurn(){
    if(!enemyTurnMarker)return;
    setCommandStatus("Refreshing authoritative combat state and log; no enemy turn will be replayed.");
    const refreshed=await loadCombat(combatId,true);if(!mountedRef.current)return;
    // Command-result reads identify only an action, not this server-owned endpoint or request frame.
    setCommandStatus(refreshed?"Authoritative combat state refreshed, but this enemy-turn delivery cannot be proven exact. The lock remains and no POST was replayed.":"Authoritative refresh was partial. The enemy-turn lock remains and no POST was replayed.");
  }

  async function submitConsumable(action:UseConsumableLegalAction){
    if (blockedRef.current || preparingCommand || (embedded && commandLocked)) return;
    const playerCombatant=playerWorkspace?combat?.combatants.find((entry)=>entry.kind==="actor"&&entry.actorId===controlledActorId):null;
    if(observerWorkspace||(playerWorkspace&&(!playerCombatant||playerCombatant.combatantId!==combat?.currentCombatant||action.actingCombatantId!==playerCombatant.combatantId))||!combat||marker||consumableMarker||rewardMarker||action.quantity!==1||action.actionCost!=="action")return;
    const acting=combat.combatants.find((entry)=>entry.combatantId===action.actingCombatantId),target=combat.combatants.find((entry)=>entry.combatantId===action.target.combatantId);
    if(acting?.kind!=="actor"||!target||action.target.actorBacked!==(target.kind==="actor"))return;
    setPreparingCommand(true); setConsumableStatus("Reading authoritative actor revisions before one committed submission.");
    try{
      const actingState=await api.getResources(campaignId,acting.actorId);
      const targetState=target.kind!=="actor"?null:target.actorId===acting.actorId?actingState:await api.getResources(campaignId,target.actorId);
      if(!mountedRef.current||combatIdRef.current!==combatId||blockedRef.current)return;
      const command:UseConsumableCommandRequest={legalActionId:action.legalActionId,inventoryEntryId:action.inventoryEntryId,item:action.item,quantity:1,
        targetCombatantId:action.target.combatantId,targetActorBacked:action.target.actorBacked,expectedCombatRevision:combat.revision,
        expectedActingM15Revision:actingState.revision,expectedTargetM15Revision:targetState?.revision??null,idempotencyKey:commandId()};
      const pending:ConsumableMarker={campaignId,combatId,phase:"ambiguous",command,startedAt:new Date().toISOString()};
      if(!writeConsumableMarker(campaignId,combatId,pending)){
        setConsumableStatus("Consumable was not submitted because the durable safety lock could not be stored. Enable local storage and try again.");return;
      }
      setConsumableMarkerState(pending);setConsumableResult(null);
      setConsumableStatus("Consumable command submitted once. Automatic replay is disabled.");
      try{
        const result=await api.useConsumable(combatId,command),confirmedMarker:ConsumableMarker={...pending,phase:"confirmed",result};
        if(!writeConsumableMarker(campaignId,combatId,confirmedMarker)){if(mountedRef.current)setConsumableStatus("Consumable response arrived, but its durable confirmation could not be stored. No POST will be retried; use exact result reconciliation.");return;}
        if(!mountedRef.current)return;
        setConsumableMarkerState(confirmedMarker);setConsumableResult(result);
        const refreshed=await loadCombat(combatId);if(!mountedRef.current)return;
        if(refreshed){writeConsumableMarker(campaignId,combatId,null);setConsumableMarkerState(null);setConsumableStatus("Consumable confirmed; authoritative combat, log, and actions refreshed.");}
        else setConsumableStatus("Consumable confirmed, but refresh is partial. The receipt and lock are preserved.");
      }catch(error){if(!mountedRef.current)return;if(error instanceof ApiError&&error.status>=400&&error.status<500){
          writeConsumableMarker(campaignId,combatId,null);setConsumableMarkerState(null);setConsumableStatus("Consumable was rejected before commitment. The lock was cleared and authoritative state is refreshing.");void loadCombat(combatId);
        }else setConsumableStatus("Consumable outcome is ambiguous. It will not be replayed; read the exact result to reconcile.");}
    }catch{if(mountedRef.current)setConsumableStatus("Actor revisions could not be loaded. No consumable command was submitted.");}
    finally { if (mountedRef.current) setPreparingCommand(false); }
  }
  async function submitCombatPower(action:DirectCombatPowerCandidate){
    if (blockedRef.current || (embedded && commandLocked)) return;
    const playerOwnTurn=playerWorkspace&&combat?.combatants.some((entry)=>entry.kind==="actor"&&entry.actorId===controlledActorId&&entry.combatantId===combat.currentCombatant);
    if((!gmWorkspace&&!playerOwnTurn)||!combat||marker||consumableMarker||rewardMarker||combatPowerMarker||observerWorkspace)return;
    const command:DirectCombatPowerCommandRequest={legalActionId:action.legalActionId,expectedCombatRevision:action.revisions.combat,expectedSourceM15Revision:action.revisions.sourceM15,expectedSourceM16Revision:action.revisions.sourceM16,expectedTargetM15Revision:action.revisions.targetM15,expectedTargetM16Revision:action.revisions.targetM16,idempotencyKey:commandId()};
    const pending:CombatPowerMarker={campaignId,combatId,phase:"ambiguous",command,startedAt:new Date().toISOString()};
    if(!writeCombatPowerMarker(campaignId,combatId,pending)){setCommandStatus("Combat power was not submitted because its durable safety lock could not be stored. Enable local storage and try again.");return;}
    setCombatPowerMarkerState(pending);setCombatPowerResult(null);setCommandStatus("Combat power submitted once. Automatic replay is disabled.");
    try{const result=await api.useCombatPower(combatId,command),complete:CombatPowerMarker={...pending,phase:"confirmed",result};
      if(!writeCombatPowerMarker(campaignId,combatId,complete)){if(mountedRef.current)setCommandStatus("Combat power response arrived, but durable confirmation could not be stored. No POST will be retried; use exact result reconciliation.");return;}
      if(!mountedRef.current)return;setCombatPowerMarkerState(complete);setCombatPowerResult(result);setCommandStatus("Combat power confirmed. Refreshing authoritative combat state and actions.");
      const refreshed=await loadCombat(combatId);if(!mountedRef.current)return;if(refreshed&&writeCombatPowerMarker(campaignId,combatId,null)){setCombatPowerMarkerState(null);setCommandStatus("Combat power confirmed; authoritative combat state and actions refreshed.");}else setCommandStatus("Combat power confirmed, but refresh is partial. The receipt and durable lock are preserved.");
    }catch(error){if(!mountedRef.current)return;if(error instanceof ApiError&&error.status>=400&&error.status<500){writeCombatPowerMarker(campaignId,combatId,null);setCombatPowerMarkerState(null);setCommandStatus("Combat power was rejected before commitment. The lock was cleared and authoritative state is refreshing.");void loadCombat(combatId);}else setCommandStatus("Combat power outcome is uncertain. It will not be replayed; read the exact result to reconcile.");}
  }
  async function reconcileCombatPower(){
    if(!combatPowerMarker||observerWorkspace)return;setCommandStatus("Reading the exact immutable combat-power result; no POST will be replayed.");
    try{const result=await api.getCombatPowerResult(combatId,combatPowerMarker.command);if(!mountedRef.current||combatIdRef.current!==combatId)return;setCombatPowerResult(result);
      const refreshed=await loadCombat(combatId,true);if(!mountedRef.current)return;if(refreshed&&writeCombatPowerMarker(campaignId,combatId,null)){setCombatPowerMarkerState(null);setCommandStatus("Exact combat-power result confirmed; authoritative combat state and actions refreshed.");}else setCommandStatus("Exact combat-power result confirmed, but refresh is partial. The durable lock remains preserved.");
    }catch{if(mountedRef.current)setCommandStatus("No exact authorized combat-power result is available. The persistent lock remains and no POST was replayed.");}
  }
  async function reconcileConsumable(){
    if(!consumableMarker)return;setConsumableStatus("Reading the exact immutable consumable result; no POST will be replayed.");
    try{const result=await api.getConsumableResult(combatId,consumableMarker.command);if(!mountedRef.current)return;
      setConsumableResult(result);const refreshed=await loadCombat(combatId,true);if(!mountedRef.current)return;
      if(refreshed){writeConsumableMarker(campaignId,combatId,null);setConsumableMarkerState(null);setConsumableStatus("Exact consumable result confirmed; authoritative combat, log, and actions refreshed.");}
      else setConsumableStatus("Exact consumable result confirmed, but refresh is partial. The lock remains preserved.");
    }catch{if(mountedRef.current)setConsumableStatus("No exact authorized consumable result is available. The persistent lock remains.");}
  }

  async function reconcileRewardClaim(definitiveRejection=false){
    const pending=rewardMarkerRef.current;
    if(!pending||pending.combatId!==combatId)return;
    setRewardStatus("Reading the exact immutable claim result; the claim POST will not be replayed.");
    try{
      const exact=await api.getRewardClaimResult(campaignId,combatId,pending.rewardBundleId,pending.recipientActorId,pending.command);
      if(!mountedRef.current||combatIdRef.current!==combatId)return;
      clearRewardMarker(combatId);
      setRewards((currentRewards)=>currentRewards.map((reward)=>reward.rewardBundleId===exact.reward.rewardBundleId?exact.reward:reward));
      setRewardStatus("Exact settlement confirmed. Refreshing authoritative reward state and recipient wallet…");
      const [combatRefreshed,walletRefreshed]=await Promise.all([loadCombat(combatId,true),actorIdRef.current===pending.recipientActorId
        ?loadActor(pending.recipientActorId):api.getWallet(campaignId,pending.recipientActorId).then(()=>true,()=>false)]);
      if(!mountedRef.current)return;
      // An immutable settlement receipt is stronger than a lagging generic unclaimed projection.
      setRewards((currentRewards)=>currentRewards.map((reward)=>reward.rewardBundleId===exact.reward.rewardBundleId?exact.reward:reward));
      setRewardStatus(combatRefreshed&&walletRefreshed?"Exact claim result confirmed; authoritative rewards and recipient wallet refreshed."
        :"Exact claim result confirmed, but an authoritative reward or wallet refresh was partial. The claim lock was cleared without replay.");
      return;
    }catch(error){
      if(!(error instanceof ApiError&&error.status===404)){if(mountedRef.current)setRewardStatus("Exact authorized claim result is unavailable. The claim stays locked and no POST will be replayed.");return;}
    }
    setRewardStatus("No exact committed result was found. Reading authoritative reward state without replaying the claim POST.");
    try{
      const [currentCombat,currentRewards]=await Promise.all([api.getCombat(combatId),api.listRewards(combatId)]);
      if(!mountedRef.current||combatIdRef.current!==combatId)return;
      const actorIds=new Set(currentCombat.combatants.flatMap((entry)=>entry.kind==="actor"?[entry.actorId]:[]));
      if(new Set(currentRewards.map((reward)=>reward.rewardBundleId)).size!==currentRewards.length||currentRewards.some((reward)=>!actorIds.has(reward.recipientActorId)))throw new Error("reward binding mismatch");
      setCombat(currentCombat);setRewards(currentRewards);
      const bound=currentRewards.find((reward)=>reward.rewardBundleId===pending.rewardBundleId&&reward.recipientActorId===pending.recipientActorId);
      if(bound?.claim.state==="claimed"){
        clearRewardMarker(combatId);
        const walletRefreshed=actorIdRef.current===pending.recipientActorId?await loadActor(pending.recipientActorId):false;
        if(!mountedRef.current)return;
        setRewardStatus(`${bound.claim.rewardClaimId===pending.command.rewardClaimId?"Claim settlement confirmed":"Bundle settlement conflict confirmed"} by authoritative reward state.${actorIdRef.current===pending.recipientActorId?(walletRefreshed?" Wallet refreshed.":" Wallet refresh was partial."):""}`);
      }else if(definitiveRejection){
        clearRewardMarker(combatId);
        setRewardStatus("The claim was rejected before settlement. Authoritative state remains unclaimed; review and explicitly start a new claim intent.");
      }else setRewardStatus("The bundle remains authoritatively unclaimed, but the prior delivery is still ambiguous. The claim stays locked and will not be replayed.");
    }catch{if(mountedRef.current)setRewardStatus("Authoritative reward reconciliation is unavailable. The claim stays locked and no POST will be replayed.");}
  }

  async function submitRewardClaim(reward:CombatRewardGrantPublic){
    if (blockedRef.current || (embedded && commandLocked)) return;
    const currentReward=rewards.find((value)=>value.rewardBundleId===reward.rewardBundleId&&value.recipientActorId===reward.recipientActorId);
    const actorBound=combat?.combatants.some((entry)=>entry.kind==="actor"&&entry.actorId===reward.recipientActorId);
    if(observerWorkspace||!combat||rewardMarkerRef.current||currentReward?.claim.state!=="unclaimed"||!actorBound||actorId!==reward.recipientActorId)return;
    const command:CombatRewardClaimRequest={rewardClaimId:commandId(),expectedRevision:combat.revision,idempotencyKey:commandId()};
    const pending:RewardClaimMarker={campaignId,combatId,rewardBundleId:reward.rewardBundleId,recipientActorId:reward.recipientActorId,phase:"ambiguous",command,startedAt:new Date().toISOString()};
    if(!writeRewardMarker(campaignId,combatId,pending)){
      setRewardStatus("The reward was not claimed because its durable safety lock could not be stored. Enable local storage and try again.");return;
    }
    rewardMarkerRef.current=pending;setRewardMarkerState(pending);setRewardStatus("Claim submitted once. The bundle remains unclaimed in this UI until settlement is confirmed.");
    try{
      const result=await api.claimReward(combatId,reward.rewardBundleId,reward.recipientActorId,command);
      const confirmedMarker:RewardClaimMarker={...pending,phase:"confirmed",result};
      if(!writeRewardMarker(campaignId,combatId,confirmedMarker)){if(mountedRef.current)setRewardStatus("A claim response arrived, but durable confirmation could not be stored. No POST will be retried; reconcile from reward state.");return;}
      if(!mountedRef.current)return;
      rewardMarkerRef.current=confirmedMarker;setRewardMarkerState(confirmedMarker);
      setRewards((currentRewards)=>currentRewards.map((value)=>value.rewardBundleId===result.reward.rewardBundleId?result.reward:value));
      setRewardStatus("Settlement response confirmed. Refreshing authoritative reward state and recipient wallet…");
      const [combatRefreshed,walletRefreshed]=await Promise.all([loadCombat(combatId),loadActor(reward.recipientActorId)]);
      if(!mountedRef.current)return;
      setRewardStatus(combatRefreshed&&walletRefreshed?"Claim settlement confirmed; authoritative rewards and recipient wallet refreshed.":"Claim settlement is confirmed, but an authoritative refresh was partial. Use reward reconciliation before another claim.");
    }catch(error){
      if(!mountedRef.current)return;
      if(error instanceof ApiError&&error.status===409){setRewardStatus("The claim was stale or conflicted. Reconciling authoritative reward state without replaying the POST…");await reconcileRewardClaim(true);}
      else if(error instanceof ApiError&&error.status>=400&&error.status<500){clearRewardMarker(combatId);setRewardStatus("The claim was rejected before settlement. Refreshing rewards; no POST was replayed.");void loadCombat(combatId);}
      else setRewardStatus("Claim delivery is ambiguous. The bundle is not presented as owned; the claim stays locked until authoritative reconciliation.");
    }
  }

  async function submitPower(plan:ActorPowersResponse["legalCommands"][number],targetIds:string[]){
    if (blockedRef.current || (embedded && commandLocked)) return;
    if(observerWorkspace||!powers||!actorId||powerMarker)return;const command:ActorPowerCommandRequest={powerRef:plan.powerRef,targetIds,choices:[],expectedRevision:powers.revision,idempotencyKey:commandId()};
    const pending:PowerMarker={campaignId,actorId,phase:"ambiguous",command,startedAt:new Date().toISOString()};writePowerMarker(campaignId,actorId,pending);setPowerMarkerState(pending);setPowerResult(null);setPowerStatus("Power command submitted once. It is separate from combat and will not be replayed automatically.");
    try{const result=await api.usePower(actorId,command);const complete:PowerMarker={...pending,phase:"confirmed",result};writePowerMarker(campaignId,actorId,complete);if(!mountedRef.current)return;setPowerMarkerState(complete);setPowerResult(result);const refreshed=await loadActor(actorId);if(!mountedRef.current)return;if(refreshed){writePowerMarker(campaignId,actorId,null);setPowerMarkerState(null);setPowerStatus("Power response confirmed; powers, effects, and resources refreshed.");}else setPowerStatus("Power response confirmed, but actor refresh is partial. The response and lock are preserved.");}
    catch{if(mountedRef.current)setPowerStatus("Power outcome is ambiguous. Authoritative actor lanes may be refreshed, but this persistent lock cannot be cleared by generic reads.");}
  }

  const labels = useMemo(() => new Map(combat?.combatants.map((entry,index) => [entry.combatantId, entry.displayName ?? (entry.kind === "actor" ? `Ally ${index + 1}` : `Enemy ${index + 1}`)]) ?? []), [combat]);
  const inspectedCombatant = combat?.combatants.find((entry) => entry.combatantId === inspected) ?? null;
  const currentEnemy=combat?.combatants.find((entry)=>entry.combatantId===combat.currentCombatant)?.kind==="enemy";
  const controlledCombatant=combat?.combatants.find((entry)=>entry.kind==="actor"&&entry.actorId===controlledActorId)??null;
  const playerTurn=playerWorkspace&&controlledCombatant?.combatantId===combat?.currentCombatant;
  const visibleLegalActions=gmWorkspace||playerTurn?combat?.legalActions??[]:[];
  const visibleConsumables=gmWorkspace?consumableActions:playerTurn&&controlledCombatant?consumableActions.filter((action)=>action.actingCombatantId===controlledCombatant.combatantId):[];
  const visibleCombatPowers=gmWorkspace||playerTurn?combatPowerActions:[];
  const activeEncounter=encounters.find((encounter)=>encounter.combatId===combatId&&encounter.sessionId===sessionId);
  const tacticalApi=api.getTacticalMap&&api.generateTacticalMap&&api.previewTacticalMapMove&&api.moveTacticalMapToken?api as TacticalMapPanelApi:null;
  const showMap=!embedded&&!observerWorkspace&&tacticalApi&&combat&&activeEncounter&&controlledCombatant&&resourceIdSchema.safeParse(sessionId).success&&resourceIdSchema.safeParse(controlledActorId).success;
  const Container = embedded ? "fieldset" : "main";
  const Heading = embedded ? "h2" : "h1";

  return <Container disabled={embedded ? blocked : undefined} className={embedded ? "atlas-combat-embedded" : "combat-page"} aria-labelledby="combat-heading"><div className="combat-shell">
    <header className="combat-header"><div>{!embedded && <button type="button" className="back-link" onClick={onReturnToRoom??onBack}>← {onReturnToRoom?"Return to room":"Back"}</button>}<p className="eyebrow">LIVE SERVER COMBAT</p><Heading ref={headingRef} tabIndex={-1} id="combat-heading">Combat tracker</Heading></div>{combat && <div className="combat-round"><span>Round</span><strong>{combat.round}</strong><small>Revision {combat.revision}</small></div>}</header>
    {embedded && <p>{blocked ? "Combat controls are locked while the room is read-only or another operation needs completion." : "Actions and rewards stay at the table. Use the main map's Combat grid for movement; GM tools start and complete prepared encounters."}</p>}
    {embedded && <button type="button" onClick={() => void refreshRoomEncounters()}>Refresh room encounters</button>}
    {(embedded||gmWorkspace)&&(!initialCombatId||!combatId)&&<form className="combat-binding" onSubmit={connectCombat}><label>Campaign encounter<select value={combatDraft} onChange={(event) => setCombatDraft(event.target.value)}><option value="">Choose a combat</option>{encounters.map((encounter)=><option key={encounter.encounterId} value={encounter.combatId??""}>{encounter.name} · {encounter.status}</option>)}</select></label><button type="submit" className="ghost" disabled={!encounters.some((encounter)=>encounter.combatId===combatDraft) || commandLocked}>Load combat</button><p>Combat identity comes only from this {embedded ? "room's" : "campaign's"} authorized encounter list.</p></form>}
    {!embedded&&gmWorkspace&&!enemyTurnMarker&&<EncounterLifecyclePanel campaignId={campaignId} api={api} onCombatReady={openLifecycleCombat} onRewards={(result) => { if (result.encounter.combatId) openLifecycleCombat(result.encounter.combatId); setRewards(result.rewards); }} />}
    {!observerWorkspace&&marker && <section className={`combat-lock ${marker.phase === "ambiguous" ? "is-warning" : ""}`} role="alert"><p><strong>{marker.phase === "confirmed" ? "Confirmed action awaiting complete refresh" : "Action outcome unresolved"}.</strong> {marker.actionKind} was issued once at {marker.startedAt}. Controls remain locked and no automatic replay is allowed.</p><button type="button" className="ghost" onClick={() => void reconcile()}>Refresh authoritative state & log</button></section>}
    {!observerWorkspace&&commandStatus && <p className="combat-command-status" role="status">{commandStatus}</p>}
    {!observerWorkspace&&confirmed && <OutcomeReceipt result={confirmed} />}
    {gmWorkspace&&enemyTurnMarker&&<section className={`combat-lock ${enemyTurnMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{enemyTurnMarker.phase==="confirmed"?"Confirmed enemy turn awaiting complete refresh":"Enemy turn outcome unresolved"}.</strong> The server-owned turn was issued once at {enemyTurnMarker.startedAt}. Command-result reads cannot prove this endpoint's exact request, so no replay is allowed.</p><button type="button" className="ghost" onClick={()=>void reconcileEnemyTurn()}>Refresh authoritative combat state &amp; log</button></section>}
    {gmWorkspace&&enemyTurnResult&&<OutcomeReceipt result={enemyTurnResult}/>}
    {!observerWorkspace&&consumableMarker&&<section className={`combat-lock ${consumableMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{consumableMarker.phase==="confirmed"?"Confirmed consumable awaiting complete refresh":"Consumable outcome unresolved"}.</strong> The command was issued once at {consumableMarker.startedAt}. Controls remain locked and no automatic replay is allowed.</p><button type="button" className="ghost" onClick={()=>void reconcileConsumable()}>Read exact result & refresh</button></section>}
    {!observerWorkspace&&consumableStatus&&<p className="combat-command-status" role="status">{consumableStatus}</p>}
    {!observerWorkspace&&consumableResult&&<ConsumableReceipt result={consumableResult}/>}
    {!observerWorkspace&&combatPowerMarker&&<section className={`combat-lock ${combatPowerMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{combatPowerMarker.phase==="confirmed"?"Confirmed combat power awaiting complete refresh":"Combat power outcome unresolved"}.</strong> The exact request was issued once at {combatPowerMarker.startedAt}. It will not be replayed automatically.</p><button type="button" className="ghost" onClick={()=>void reconcileCombatPower()}>Read exact combat-power result &amp; refresh</button></section>}
    {!observerWorkspace&&combatPowerResult&&<section className="combat-receipt" aria-labelledby="combat-power-receipt-heading"><div className="combat-panel-heading"><h2 id="combat-power-receipt-heading">Confirmed combat-power receipt</h2><span>{combatPowerResult.result.powerName}</span></div><p>Revision {combatPowerResult.result.revisionBefore} → {combatPowerResult.result.revisionAfter}</p></section>}
    {!observerWorkspace&&rewardMarker&&<section className={`combat-lock ${rewardMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{rewardMarker.phase==="confirmed"?"Confirmed claim awaiting authoritative refresh":"Reward claim outcome unresolved"}.</strong> Bundle <code>{rewardMarker.rewardBundleId}</code> was submitted once at {rewardMarker.startedAt}. It is not presented as owned unless an exact result or authoritative state says claimed.</p><button type="button" className="ghost" onClick={()=>void reconcileRewardClaim()}>Read exact claim result &amp; refresh</button></section>}
    {!observerWorkspace&&rewardStatus&&<p className="combat-command-status" role="status">{rewardStatus}</p>}
    {phase === "idle" && <section className="combat-welcome"><h2>Connect a combat</h2><p>Combat state and paginated events will load without issuing an action.</p></section>}
    {phase === "loading" && !combat && <section className="combat-welcome" role="status">Loading authoritative combat state…</section>}
    {phase === "failed" && !combat && <section className="combat-welcome" role="alert"><p>{stateError}</p><div className="button-row"><button ref={retryRef} type="button" className="ghost" onClick={() => void loadCombat(combatId, true)}>Retry combat</button>{onUnavailable && <button type="button" className="ghost" onClick={onUnavailable}>Leave combat</button>}</div></section>}
    {combat && <div className="combat-layout">
      <InitiativeRail combatants={combat.combatants} currentCombatant={combat.currentCombatant} selectedCombatant={inspected} onInspect={setInspected} />
      <section className="combat-main-column">
        <section className="combat-panel current-turn" aria-live="polite"><div><span>Current turn</span><strong><bdi dir="auto">{combat.currentCombatant ? labels.get(combat.currentCombatant) ?? "Current combatant" : "Combat complete"}</bdi></strong></div>{stateError && <p role="alert">{stateError}</p>}{inspectedCombatant && <dl><div><dt>Team</dt><dd>{inspectedCombatant.team}</dd></div><div><dt>Status</dt><dd>{inspectedCombatant.status}</dd></div><div><dt>Hit points</dt><dd>{inspectedCombatant.hitPoints} / {inspectedCombatant.maximumHitPoints}{(inspectedCombatant.temporaryHitPoints ?? 0) > 0 ? ` · ${inspectedCombatant.temporaryHitPoints} temporary` : ""}</dd></div>{(inspectedCombatant.conditions?.length ?? 0) > 0 && <div><dt>Conditions</dt><dd>{inspectedCombatant.conditions?.map((condition) => condition.condition.replaceAll("_", " ")).join(", ")}</dd></div>}{inspectedCombatant.kind === "actor" && inspectedCombatant.deathSaves && <div><dt>Death saves</dt><dd>{inspectedCombatant.deathSaves.successes} successes / {inspectedCombatant.deathSaves.failures} failures</dd></div>}{inspectedCombatant.status === "unconscious" && <div><dt>Recovery</dt><dd>Await a server-authorized death save or stabilization.</dd></div>}{inspectedCombatant.status === "stable" && <div><dt>Recovery</dt><dd>Stable. This combatant is no longer making death saves.</dd></div>}{inspectedCombatant.status === "dead" && <div><dt>Recovery</dt><dd>Dead. No recovery action is available in this combat.</dd></div>}</dl>}</section>
        {rewardError&&<p className="combat-inline-error" role="alert">{rewardError}</p>}
        <CombatRewards rewards={rewards} claimableActorId={observerWorkspace?null:actorId} claimingBundleId={observerWorkspace?null:rewardMarker?.rewardBundleId} locked={Boolean(rewardMarker||enemyTurnMarker||(embedded&&commandLocked))} onClaim={observerWorkspace?undefined:(reward)=>void submitRewardClaim(reward)}/>
        {!observerWorkspace&&actorId&&wallet&&<p className="combat-authority-note">Loaded actor wallet revision {wallet.revision}. Wallet balances refresh after this actor's confirmed reward settlement.</p>}
        <CombatLog entries={entries} nextAfterSequence={nextSequence} loading={logLoading} error={logError} onLoadMore={() => void loadMoreLog()} onRetry={() => void loadCombat(combatId)} />
        {showMap&&<TacticalMapPanel campaignId={campaignId} sessionId={sessionId!} actorId={controlledActorId!} audience={audience} mode="combat" encounterId={activeEncounter.encounterId} combatantId={controlledCombatant.combatantId} api={tacticalApi} readOnly={!gmWorkspace&&!playerTurn}/>}
        {gmWorkspace&&!controlledActorId&&<form className="combat-binding actor-combat-binding" onSubmit={connectActor}><label>Actor ID for powers & effects<input value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} autoComplete="off" /></label><button type="submit" className="ghost" disabled={!resourceIdSchema.safeParse(actorDraft).success}>Load actor lanes</button><p>Actor identity is entered explicitly because combat state does not expose a safe actor-workspace binding.</p></form>}
        {!observerWorkspace&&powerMarker&&<section className={`combat-lock ${powerMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{powerMarker.phase==="confirmed"?"Confirmed power awaiting complete actor refresh":"Power outcome unresolved"}.</strong> No automatic replay is allowed. Generic actor refresh does not prove an ambiguous result.</p><button type="button" className="ghost" onClick={()=>void loadActor(actorId)}>Refresh actor powers, effects & resources</button></section>}
        {!observerWorkspace&&<div className="combat-actor-lanes"><PowerLibraryPanel powers={powers} loading={actorLoading} error={powerError} disabled={Boolean(powerMarker||(embedded&&commandLocked))} commandStatus={powerStatus} result={powerResult} onUse={(plan,targets)=>void submitPower(plan,targets)} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /><EffectList effects={effects} loading={actorLoading} error={effectError} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /></div>}
      </section>
      {gmWorkspace&&<aside className="combat-enemy-turn"><h2>Enemy turn</h2>{currentEnemy?<><p>The server selects the enemy action, targets, rolls, and damage.</p><button type="button" className="primary" disabled={Boolean(marker||consumableMarker||rewardMarker||enemyTurnMarker||combatPowerMarker||(embedded&&commandLocked))} onClick={()=>void submitEnemyTurn()}>Resolve enemy turn</button></>:<p>Enemy turn controls appear only while an enemy is the current combatant.</p>}</aside>}
       {!observerWorkspace&&<LegalActionTray legalActions={visibleLegalActions} consumableActions={visibleConsumables} powerActions={visibleCombatPowers} combatantLabels={labels} disabled={Boolean(marker||consumableMarker||rewardMarker||enemyTurnMarker||combatPowerMarker||(embedded&&commandLocked)||(gmWorkspace&&currentEnemy)||(!gmWorkspace&&!playerTurn))} busy={(marker?.phase === "ambiguous" && commandStatus.startsWith("Submitting"))||(enemyTurnMarker?.phase==="ambiguous")} onSubmit={(action, targets) => void submitAction(action, targets)} onUseConsumable={(action)=>void submitConsumable(action)} onUsePower={(action)=>void submitCombatPower(action)} />}
    </div>}
   </div></Container>;
}
