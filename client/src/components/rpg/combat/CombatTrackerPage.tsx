import { resourceIdSchema } from "@velvet/contracts";
import type {
  ActorEffectsResponse, ActorPowerCommandRequest, ActorPowerCommandResponse, ActorPowersResponse, ActorResourcesHttpGetResponse,
  CombatActionCommandRequest, CombatActionCommandResponse, CombatCommandResultResponse,
  CombatLegalAction, CombatLogEntryPublic, CombatLogResponse, CombatReadResponse, EncounterPublic,
  UseConsumableCommandRequest,UseConsumableCommandResult,UseConsumableLegalAction,
} from "@velvet/contracts";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {ApiError} from "../../../api";
import { CombatLog } from "./CombatLog";
import { EffectList } from "./EffectList";
import { InitiativeRail } from "./InitiativeRail";
import { LegalActionTray } from "./LegalActionTray";
import { PowerLibraryPanel } from "./PowerLibraryPanel";

export interface CombatTrackerApi {
  listEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
  getCombatLog: (combatId: string, query: { afterSequence: number; limit: number }) => Promise<CombatLogResponse>;
  resolveAction: (combatId: string, command: CombatActionCommandRequest) => Promise<CombatActionCommandResponse>;
  getCommandResult: (campaignId: string, combatId: string, idempotencyKey: string) => Promise<CombatCommandResultResponse>;
  getPowers: (actorId: string) => Promise<ActorPowersResponse>;
  getEffects: (actorId: string) => Promise<ActorEffectsResponse>;
  getResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  usePower: (actorId: string, command: ActorPowerCommandRequest) => Promise<ActorPowerCommandResponse>;
  getConsumableActions:(combatId:string)=>Promise<UseConsumableLegalAction[]>;
  useConsumable:(combatId:string,command:UseConsumableCommandRequest)=>Promise<UseConsumableCommandResult>;
  getConsumableResult:(combatId:string,expectedRequest:UseConsumableCommandRequest)=>Promise<UseConsumableCommandResult>;
}

export interface CombatTrackerPageProps {
  api: CombatTrackerApi;
  campaignId: string;
  initialCombatId?: string;
  onBack: () => void;
  onUnavailable?: () => void;
  focusHeadingRequest?: number;
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

const combatStorageKey = (campaignId: string) => `velvet.combat-id.v2:${campaignId}`;
const actorStorageKey = (campaignId: string) => `velvet.combat-actor-id.v2:${campaignId}`;
const markerKey = (campaignId: string, combatId: string) => `velvet.combat-action.v2:${campaignId}:${combatId}`;
const powerMarkerKey = (campaignId: string, actorId: string) => `velvet.power-action.v1:${campaignId}:${actorId}`;
const consumableMarkerKey=(campaignId:string,combatId:string)=>`velvet.combat-consumable.v1:${campaignId}:${combatId}`;
const readStoredId = (key: string) => { try { const id = localStorage.getItem(key) ?? ""; return resourceIdSchema.safeParse(id).success ? id : ""; } catch { return ""; } };
const writeStoredId = (key: string, id: string) => { try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* optional restoration */ } };
const readMarker = (campaignId: string, combatId: string): ActionMarker | null => {
  if (!combatId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(markerKey(campaignId, combatId)) ?? "null") as Partial<ActionMarker> | null;
    return value?.campaignId === campaignId && value.combatId === combatId && value.operation === "action" && (value.phase === "ambiguous" || value.phase === "confirmed") && typeof value.actionKind === "string" && typeof value.startedAt === "string" && value.command !== undefined ? value as ActionMarker : null;
  } catch { return null; }
};
const writeMarker = (campaignId: string, combatId: string, marker: ActionMarker | null) => { try { if (marker) localStorage.setItem(markerKey(campaignId, combatId), JSON.stringify(marker)); else localStorage.removeItem(markerKey(campaignId, combatId)); } catch { /* best-effort durable write lock */ } };
const readPowerMarker = (campaignId: string, actorId: string): PowerMarker | null => { try { const value=JSON.parse(localStorage.getItem(powerMarkerKey(campaignId,actorId))??"null") as Partial<PowerMarker>|null; return value?.campaignId===campaignId&&value.actorId===actorId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&value.command!==undefined?value as PowerMarker:null; } catch{return null;} };
const writePowerMarker = (campaignId:string,actorId:string,value:PowerMarker|null) => { try { if(value)localStorage.setItem(powerMarkerKey(campaignId,actorId),JSON.stringify(value));else localStorage.removeItem(powerMarkerKey(campaignId,actorId)); } catch{/* durable best effort */} };
const readConsumableMarker=(campaignId:string,combatId:string):ConsumableMarker|null=>{try{const value=JSON.parse(localStorage.getItem(consumableMarkerKey(campaignId,combatId))??"null") as Partial<ConsumableMarker>|null;return value?.campaignId===campaignId&&value.combatId===combatId&&(value.phase==="ambiguous"||value.phase==="confirmed")&&value.command!==undefined?value as ConsumableMarker:null;}catch{return null;}};
const writeConsumableMarker=(campaignId:string,combatId:string,value:ConsumableMarker|null):boolean=>{try{const key=consumableMarkerKey(campaignId,combatId);if(value){const encoded=JSON.stringify(value);localStorage.setItem(key,encoded);return localStorage.getItem(key)===encoded;}localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}};
const commandId = () => `combat-ui-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
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
    {resolution.outcomes.length > 0 && <ul>{resolution.outcomes.map((outcome, index) => <li key={`${outcome.kind}-${outcome.targetId}-${index}`}>{outcome.kind === "damage" ? <><strong>Damage:</strong> {outcome.applied} {outcome.damageType} · HP {outcome.hitPointsBefore} → {outcome.hitPointsAfter} · {outcome.statusBefore} → {outcome.statusAfter}</> : <><strong>Status:</strong> {outcome.statusBefore} → {outcome.statusAfter}</>}</li>)}</ul>}
    <details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </section>;
}
function ConsumableReceipt({result}:{result:UseConsumableCommandResult}){return <section className="combat-receipt" aria-labelledby="consumable-receipt-heading"><div className="combat-panel-heading"><h2 id="consumable-receipt-heading">Confirmed consumable receipt</h2><span>use-consumable</span></div><dl><div><dt>Item</dt><dd>{result.resolution.consumed.item.definitionId}</dd></div><div><dt>Quantity</dt><dd>{result.resolution.consumed.quantity}</dd></div><div><dt>Cost</dt><dd>{result.resolution.actionCost}</dd></div><div><dt>Target</dt><dd>{result.resolution.target.combatantId}</dd></div><div><dt>Revision</dt><dd>{result.receipt.revisionBefore} → {result.receipt.revisionAfter}</dd></div></dl><ul>{result.resolution.outcome.settlements.map((settlement)=><li key={settlement.effectOrdinal}>{settlement.kind}: {settlement.applied}</li>)}</ul></section>}

export function CombatTrackerPage({ api, campaignId, initialCombatId, onBack, onUnavailable, focusHeadingRequest }: CombatTrackerPageProps) {
  const initialId = useMemo(() => readCombatId(campaignId,initialCombatId), [campaignId,initialCombatId]);
  const [encounters,setEncounters]=useState<EncounterPublic[]>([]);
  const [combatId, setCombatId] = useState(initialId);
  const [combatDraft, setCombatDraft] = useState(initialId);
  const [actorId, setActorId] = useState(() => readStoredId(actorStorageKey(campaignId)));
  const [actorDraft, setActorDraft] = useState(actorId);
  const [combat, setCombat] = useState<CombatReadResponse | null>(null);
  const [consumableActions,setConsumableActions]=useState<UseConsumableLegalAction[]>([]);
  const [entries, setEntries] = useState<CombatLogEntryPublic[]>([]);
  const [nextSequence, setNextSequence] = useState<number | null>(null);
  const [powers, setPowers] = useState<ActorPowersResponse | null>(null);
  const [effects, setEffects] = useState<ActorEffectsResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">(initialId ? "loading" : "idle");
  const [stateError, setStateError] = useState("");
  const [logError, setLogError] = useState("");
  const [powerError, setPowerError] = useState("");
  const [effectError, setEffectError] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [actorLoading, setActorLoading] = useState(false);
  const [marker, setMarkerState] = useState<ActionMarker | null>(() => readMarker(campaignId,initialId));
  const [confirmed, setConfirmed] = useState<CombatActionCommandResponse | null>(() => readMarker(campaignId,initialId)?.result ?? null);
  const [powerMarker,setPowerMarkerState]=useState<PowerMarker|null>(()=>readPowerMarker(campaignId,readStoredId(actorStorageKey(campaignId))));
  const [powerResult,setPowerResult]=useState<ActorPowerCommandResponse|null>(()=>readPowerMarker(campaignId,readStoredId(actorStorageKey(campaignId)))?.result??null);
  const [powerStatus,setPowerStatus]=useState("");
  const [consumableMarker,setConsumableMarkerState]=useState<ConsumableMarker|null>(()=>readConsumableMarker(campaignId,initialId));
  const [consumableResult,setConsumableResult]=useState<UseConsumableCommandResult|null>(()=>readConsumableMarker(campaignId,initialId)?.result??null);
  const [consumableStatus,setConsumableStatus]=useState("");
  const [commandStatus, setCommandStatus] = useState("");
  const [inspected, setInspected] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const actorGenerationRef = useRef(0);
  const combatIdRef = useRef(combatId);
  const actorIdRef = useRef(actorId);
  combatIdRef.current = combatId;
  actorIdRef.current = actorId;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const current = useCallback((generation: number, id: string) => mountedRef.current && generationRef.current === generation && combatIdRef.current === id, []);
  const setMarker = useCallback((next: ActionMarker | null, id = combatId) => { writeMarker(campaignId,id, next); if (mountedRef.current) setMarkerState(next); }, [campaignId,combatId]);

  const loadCombat = useCallback(async (id: string, focusFailure = false) => {
    if (!resourceIdSchema.safeParse(id).success) return false;
    const generation = ++generationRef.current;
    setPhase("loading"); setStateError(""); setLogError(""); setLogLoading(true);
    const [stateRead, logRead,consumableRead] = await Promise.allSettled([api.getCombat(id), api.getCombatLog(id, { afterSequence: 0, limit: 50 }),api.getConsumableActions(id)] as const);
    if (!current(generation, id)) return false;
    if (stateRead.status === "fulfilled") { setCombat(stateRead.value); setPhase("ready"); }
    else { setStateError("Combat state could not be refreshed."); setPhase(combat ? "ready" : "failed"); if (focusFailure) queueMicrotask(() => retryRef.current?.focus()); }
    if (logRead.status === "fulfilled") { setEntries(logRead.value.entries); setNextSequence(logRead.value.nextAfterSequence); }
    else setLogError("Combat log could not be refreshed. Existing events are preserved.");
    if(consumableRead.status==="fulfilled")setConsumableActions(consumableRead.value);
    else {setConsumableActions([]);setStateError("Combat state loaded, but consumable actions could not be refreshed.");}
    setLogLoading(false);
    return stateRead.status === "fulfilled" && logRead.status === "fulfilled"&&consumableRead.status==="fulfilled";
  }, [api, combat, current]);

  const loadActor = useCallback(async (id: string):Promise<boolean> => {
    if (!resourceIdSchema.safeParse(id).success) return false;
    const generation = ++actorGenerationRef.current; setActorLoading(true); setPowerError(""); setEffectError("");
    const [powerRead, effectRead,resourceRead] = await Promise.allSettled([api.getPowers(id), api.getEffects(id),api.getResources(campaignId,id)] as const);
    if (!mountedRef.current || generation !== actorGenerationRef.current || id !== actorIdRef.current) return false;
    if (powerRead.status === "fulfilled") setPowers(powerRead.value); else setPowerError("Powers could not be refreshed. Existing power data is preserved.");
    if (effectRead.status === "fulfilled") setEffects(effectRead.value); else setEffectError("Effects could not be refreshed. Existing effect data is preserved.");
    setActorLoading(false);
    return powerRead.status==="fulfilled"&&effectRead.status==="fulfilled"&&resourceRead.status==="fulfilled";
  }, [api,campaignId]);

  useEffect(() => {
    mountedRef.current = true;
    void api.listEncounters(campaignId).then((value)=>{
      if(!mountedRef.current)return;const available=value.encounters.filter((encounter)=>encounter.combatId!==null);setEncounters(available);
      if(combatId&&available.some((encounter)=>encounter.combatId===combatId))void loadCombat(combatId);
      else { combatIdRef.current="";setCombatId("");setCombatDraft("");writeStoredId(combatStorageKey(campaignId),"");setPhase("idle"); }
    }).catch(()=>{if(mountedRef.current){setStateError("Campaign encounters could not be loaded.");setPhase("failed");}});
    if (actorId) void loadActor(actorId);
    return () => { mountedRef.current = false; generationRef.current += 1; actorGenerationRef.current += 1; };
    // Route identity initializes this component; explicit forms handle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if ((phase === "ready"||phase==="idle"||phase==="failed") && focusHeadingRequest !== undefined) queueMicrotask(() => headingRef.current?.focus()); }, [focusHeadingRequest, phase]);

  function connectCombat(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(combatDraft).success) return;
    if(!encounters.some((encounter)=>encounter.combatId===combatDraft))return;
    generationRef.current += 1; combatIdRef.current = combatDraft; setCombatId(combatDraft); writeStoredId(combatStorageKey(campaignId), combatDraft); setCombat(null); setEntries([]); setNextSequence(null);
    const restored = readMarker(campaignId,combatDraft); setMarkerState(restored); setConfirmed(restored?.result ?? null); setCommandStatus("");
    const restoredConsumable=readConsumableMarker(campaignId,combatDraft);setConsumableMarkerState(restoredConsumable);setConsumableResult(restoredConsumable?.result??null);setConsumableStatus("");
    // State publication is asynchronous, so this direct read is bound to the submitted exact ID.
    queueMicrotask(() => { if (mountedRef.current) void loadCombat(combatDraft); });
  }
  function connectActor(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(actorDraft).success) return;
    actorGenerationRef.current += 1; actorIdRef.current = actorDraft; setActorId(actorDraft); writeStoredId(actorStorageKey(campaignId), actorDraft); setPowers(null); setEffects(null);
    const restored=readPowerMarker(campaignId,actorDraft);setPowerMarkerState(restored);setPowerResult(restored?.result??null);setPowerStatus("");
    queueMicrotask(() => { if (mountedRef.current) void loadActor(actorDraft); });
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
    if (!combat || marker || !action.targetIds.every((id) => combat.combatants.some((entry) => entry.combatantId === id)) || targetIds.some((id) => !action.targetIds.includes(id))) return;
    const command: CombatActionCommandRequest = { legalActionId: action.legalActionId, targetIds, choices: [], expectedRevision: combat.revision, idempotencyKey: commandId() };
    const pending: ActionMarker = { campaignId,combatId,operation:"action", phase: "ambiguous", command, actionKind: action.kind, startedAt: new Date().toISOString() };
    setMarker(pending); setConfirmed(null); setCommandStatus("Submitting once. Automatic replay is disabled.");
    try {
      const result = await api.resolveAction(combatId, command);
      const complete: ActionMarker = { ...pending, phase: "confirmed", result };
      writeMarker(campaignId,combatId, complete);
      if (!mountedRef.current) return;
      setMarkerState(complete); setConfirmed(result); setCombat(publicRead(result));
      setCommandStatus("Action confirmed. Refreshing authoritative combat state and log…");
      const refreshed = await loadCombat(combatId);
      if (!mountedRef.current) return;
      if (refreshed) { setMarker(null); setCommandStatus("Action confirmed; authoritative state and log refreshed."); }
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
      if(refreshed){setMarker(null);setCommandStatus("Exact command result confirmed; authoritative state and log refreshed.");}
      else setCommandStatus("Exact result is confirmed, but refresh is partial. The response and lock remain preserved.");
    }catch{if(mountedRef.current)setCommandStatus("No exact authorized command result is available. Generic state/log reads cannot clear this lock.");}
  }

  async function submitConsumable(action:UseConsumableLegalAction){
    if(!combat||marker||consumableMarker||action.quantity!==1||action.actionCost!=="action"||action.effectPlan.effects.some(({effect})=>effect.kind==="modifier"))return;
    const acting=combat.combatants.find((entry)=>entry.combatantId===action.actingCombatantId),target=combat.combatants.find((entry)=>entry.combatantId===action.target.combatantId);
    if(acting?.kind!=="actor"||!target||action.target.actorBacked!==(target.kind==="actor"))return;
    setConsumableStatus("Reading authoritative actor revisions before one committed submission.");
    try{
      const actingState=await api.getResources(campaignId,acting.actorId);
      const targetState=target.kind!=="actor"?null:target.actorId===acting.actorId?actingState:await api.getResources(campaignId,target.actorId);
      if(!mountedRef.current||combatIdRef.current!==combatId)return;
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
  }
  async function reconcileConsumable(){
    if(!consumableMarker)return;setConsumableStatus("Reading the exact immutable consumable result; no POST will be replayed.");
    try{const result=await api.getConsumableResult(combatId,consumableMarker.command);if(!mountedRef.current)return;
      setConsumableResult(result);const refreshed=await loadCombat(combatId,true);if(!mountedRef.current)return;
      if(refreshed){writeConsumableMarker(campaignId,combatId,null);setConsumableMarkerState(null);setConsumableStatus("Exact consumable result confirmed; authoritative combat, log, and actions refreshed.");}
      else setConsumableStatus("Exact consumable result confirmed, but refresh is partial. The lock remains preserved.");
    }catch{if(mountedRef.current)setConsumableStatus("No exact authorized consumable result is available. The persistent lock remains.");}
  }

  async function submitPower(plan:ActorPowersResponse["legalCommands"][number],targetIds:string[]){
    if(!powers||!actorId||powerMarker)return;const command:ActorPowerCommandRequest={powerRef:plan.powerRef,targetIds,choices:[],expectedRevision:powers.revision,idempotencyKey:commandId()};
    const pending:PowerMarker={campaignId,actorId,phase:"ambiguous",command,startedAt:new Date().toISOString()};writePowerMarker(campaignId,actorId,pending);setPowerMarkerState(pending);setPowerResult(null);setPowerStatus("Power command submitted once. It is separate from combat and will not be replayed automatically.");
    try{const result=await api.usePower(actorId,command);const complete:PowerMarker={...pending,phase:"confirmed",result};writePowerMarker(campaignId,actorId,complete);if(!mountedRef.current)return;setPowerMarkerState(complete);setPowerResult(result);const refreshed=await loadActor(actorId);if(!mountedRef.current)return;if(refreshed){writePowerMarker(campaignId,actorId,null);setPowerMarkerState(null);setPowerStatus("Power response confirmed; powers, effects, and resources refreshed.");}else setPowerStatus("Power response confirmed, but actor refresh is partial. The response and lock are preserved.");}
    catch{if(mountedRef.current)setPowerStatus("Power outcome is ambiguous. Authoritative actor lanes may be refreshed, but this persistent lock cannot be cleared by generic reads.");}
  }

  const labels = useMemo(() => new Map(combat?.combatants.map((entry) => [entry.combatantId, entry.kind === "actor" ? entry.actorId : entry.template?.definitionId ?? "Enemy"]) ?? []), [combat]);
  const inspectedCombatant = combat?.combatants.find((entry) => entry.combatantId === inspected) ?? null;

  return <main className="combat-page" aria-labelledby="combat-heading"><div className="combat-shell">
    <header className="combat-header"><div><button type="button" className="back-link" onClick={onBack}>← Back</button><p className="eyebrow">LIVE SERVER COMBAT</p><h1 ref={headingRef} tabIndex={-1} id="combat-heading">Combat tracker</h1></div>{combat && <div className="combat-round"><span>Round</span><strong>{combat.round}</strong><small>Revision {combat.revision}</small></div>}</header>
    <form className="combat-binding" onSubmit={connectCombat}><label>Campaign encounter<select value={combatDraft} onChange={(event) => setCombatDraft(event.target.value)}><option value="">Choose a combat</option>{encounters.map((encounter)=><option key={encounter.encounterId} value={encounter.combatId??""}>{encounter.name} · {encounter.status}</option>)}</select></label><button type="submit" className="ghost" disabled={!encounters.some((encounter)=>encounter.combatId===combatDraft) || Boolean(marker)}>Load combat</button><p>Combat identity comes only from this campaign's authorized encounter list and is restored only within this campaign.</p></form>
    {marker && <section className={`combat-lock ${marker.phase === "ambiguous" ? "is-warning" : ""}`} role="alert"><p><strong>{marker.phase === "confirmed" ? "Confirmed action awaiting complete refresh" : "Action outcome unresolved"}.</strong> {marker.actionKind} was issued once at {marker.startedAt}. Controls remain locked and no automatic replay is allowed.</p><button type="button" className="ghost" onClick={() => void reconcile()}>Refresh authoritative state & log</button></section>}
    {commandStatus && <p className="combat-command-status" role="status">{commandStatus}</p>}
    {confirmed && <OutcomeReceipt result={confirmed} />}
    {consumableMarker&&<section className={`combat-lock ${consumableMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{consumableMarker.phase==="confirmed"?"Confirmed consumable awaiting complete refresh":"Consumable outcome unresolved"}.</strong> The command was issued once at {consumableMarker.startedAt}. Controls remain locked and no automatic replay is allowed.</p><button type="button" className="ghost" onClick={()=>void reconcileConsumable()}>Read exact result & refresh</button></section>}
    {consumableStatus&&<p className="combat-command-status" role="status">{consumableStatus}</p>}
    {consumableResult&&<ConsumableReceipt result={consumableResult}/>}
    {phase === "idle" && <section className="combat-welcome"><h2>Connect a combat</h2><p>Combat state and paginated events will load without issuing an action.</p></section>}
    {phase === "loading" && !combat && <section className="combat-welcome" role="status">Loading authoritative combat state…</section>}
    {phase === "failed" && !combat && <section className="combat-welcome" role="alert"><p>{stateError}</p><div className="button-row"><button ref={retryRef} type="button" className="ghost" onClick={() => void loadCombat(combatId, true)}>Retry combat</button>{onUnavailable && <button type="button" className="ghost" onClick={onUnavailable}>Leave combat</button>}</div></section>}
    {combat && <div className="combat-layout">
      <InitiativeRail combatants={combat.combatants} currentCombatant={combat.currentCombatant} selectedCombatant={inspected} onInspect={setInspected} />
      <section className="combat-main-column">
        <section className="combat-panel current-turn" aria-live="polite"><div><span>Current turn</span><strong><bdi dir="auto">{combat.currentCombatant ? labels.get(combat.currentCombatant) ?? combat.currentCombatant : "Combat complete"}</bdi></strong></div>{stateError && <p role="alert">{stateError}</p>}{inspectedCombatant && <dl><div><dt>Team</dt><dd>{inspectedCombatant.team}</dd></div><div><dt>Status</dt><dd>{inspectedCombatant.status}</dd></div><div><dt>Hit points</dt><dd>{inspectedCombatant.hitPoints} / {inspectedCombatant.maximumHitPoints}</dd></div></dl>}</section>
        <CombatLog entries={entries} nextAfterSequence={nextSequence} loading={logLoading} error={logError} onLoadMore={() => void loadMoreLog()} onRetry={() => void loadCombat(combatId)} />
        <form className="combat-binding actor-combat-binding" onSubmit={connectActor}><label>Actor ID for powers & effects<input value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} autoComplete="off" /></label><button type="submit" className="ghost" disabled={!resourceIdSchema.safeParse(actorDraft).success}>Load actor lanes</button><p>Actor identity is entered explicitly because combat state does not expose a safe actor-workspace binding.</p></form>
        {powerMarker&&<section className={`combat-lock ${powerMarker.phase==="ambiguous"?"is-warning":""}`} role="alert"><p><strong>{powerMarker.phase==="confirmed"?"Confirmed power awaiting complete actor refresh":"Power outcome unresolved"}.</strong> No automatic replay is allowed. Generic actor refresh does not prove an ambiguous result.</p><button type="button" className="ghost" onClick={()=>void loadActor(actorId)}>Refresh actor powers, effects & resources</button></section>}
        <div className="combat-actor-lanes"><PowerLibraryPanel powers={powers} loading={actorLoading} error={powerError} disabled={Boolean(powerMarker)} commandStatus={powerStatus} result={powerResult} onUse={(plan,targets)=>void submitPower(plan,targets)} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /><EffectList effects={effects} loading={actorLoading} error={effectError} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /></div>
      </section>
      <LegalActionTray legalActions={combat.legalActions} consumableActions={consumableActions} combatantLabels={labels} disabled={Boolean(marker||consumableMarker)} busy={marker?.phase === "ambiguous" && commandStatus.startsWith("Submitting")} onSubmit={(action, targets) => void submitAction(action, targets)} onUseConsumable={(action)=>void submitConsumable(action)} />
    </div>}
  </div></main>;
}
