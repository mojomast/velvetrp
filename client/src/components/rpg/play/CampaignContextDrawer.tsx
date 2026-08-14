import { Fragment, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActorResourcesHttpGetResponse, CampaignPublishedMaterials, CampaignWorldHttpResponse, EncounterPublic, NpcCastHttp, NpcPresenceMutationHttpRequest, NpcPresenceMutationHttpResponse } from "@velvet/contracts";
import { ApiError, ApiInputError, commandNpcPresence as defaultCommandNpcPresence, getCampaignPresentCast as defaultGetCampaignPresentCast, getCampaignPublishedMaterials as defaultGetCampaignPublishedMaterials } from "../../../api";
import { beginNpcPresenceMutation, clearNpcPresenceMutation, markNpcPresenceAmbiguous, markNpcPresenceReconciliation, reconcileNpcPresenceMutation, releaseNpcPresenceMutation, useNpcPresenceMutation } from "../narrativeMutationRegistry";
import type { CampaignContextWidget } from "./campaignWorkbenchPreferences";

type Audience = "gm" | "player";
type Load<T> = { state: "loading"; stale?: T } | { state: "ready"; value: T } | { state: "error"; stale?: T };
type NamedNpc = { id: string; name: string };
type Objective = { id: string; description: string; progress: number; target: number };
type EncounterView = { encounters: EncounterPublic[]; activeCombat: { round: number; currentCombatant: string | null } | null };
type CastView = { audience: Audience; state: "running" | "stopped"; sessionRevision: number; members: Array<{ id: string; name: string; locationLabel: string | null; locationId: string | null }> };

/** Narrow, role-filtered read/write API consumed by the campaign context drawer. */
export interface CampaignContextDrawerApi {
  getCampaignWorld: (campaignId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  listCampaignNpcs: (campaignId: string, audience: Audience) => Promise<{ data: { npcs: Array<{ npcId: string; publicState: { name: string } }> }; revision: number }>;
  listCampaignQuests: (campaignId: string, audience: Audience) => Promise<{ data: { quests: Array<{ questId: string; status: string }>; objectives: Array<{ objectiveId: string; questId: string; description: string; progress: number; targetProgress: number; completedAt: string | null }> }; revision: number }>;
  getActorResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  listCampaignEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombatState: (combatId: string) => Promise<{ round: number; currentCombatant: string | null }>;
  getCampaignPresentCast?: (campaignId: string, sessionId: string, audience: Audience) => Promise<NpcCastHttp>;
  commandNpcPresence?: (campaignId: string, sessionId: string, npcId: string, input: NpcPresenceMutationHttpRequest) => Promise<NpcPresenceMutationHttpResponse>;
  getCampaignPublishedMaterials?: (campaignId:string)=>Promise<CampaignPublishedMaterials>;
}

export interface CampaignContextDrawerProps {
  campaignId: string;
  sessionId: string;
  selectedActorId: string | null;
  playableActorIds: readonly string[];
  audience: Audience;
  authorizationGeneration: number;
  api: CampaignContextDrawerApi;
  widgets?: readonly CampaignContextWidget[];
}

function status<T>(load: Load<T>, empty: boolean, label: string) {
  if (load.state === "loading" && !load.stale) return <p role="status">Loading {label}...</p>;
  if (load.state === "error" && !load.stale) return <p role="alert">{label} could not be loaded.</p>;
  if (load.state === "loading" && load.stale) return <p role="status">Refreshing {label}; showing stale server data.</p>;
  if (load.state === "error" && load.stale) return <p role="alert">{label} refresh failed; showing stale server data.</p>;
  if (empty) return <p>No {label} available.</p>;
  return null;
}

function safeCast(value: NpcCastHttp, audience: Audience): CastView {
  if (value.audience !== audience) throw new Error("Cast audience mismatch");
  if (value.state === "running") return { audience, state: value.state, sessionRevision: value.sessionRevision, members: value.presentCast.map((npc) => ({
    id: npc.npcId, name: npc.publicState.name, locationLabel: npc.location?.label ?? null,
    locationId: npc.location && "locationId" in npc.location ? npc.location.locationId : null,
  })) };
  return { audience, state: value.state, sessionRevision: value.sessionRevision, members: value.castHistory.map((npc) => ({
    id: npc.npcId, name: npc.publicState.name, locationLabel: npc.lastLocation?.label ?? null,
    locationId: npc.lastLocation && "locationId" in npc.lastLocation ? npc.lastLocation.locationId : null,
  })) };
}

const presenceKey = () => `presence-ui-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

/** Loads and renders only server projections; it performs no authoritative calculations. */
export function CampaignContextDrawer({ campaignId, sessionId, selectedActorId, playableActorIds, audience, authorizationGeneration, api,
  widgets = ["location", "cast", "objectives", "resources", "encounter"] }: CampaignContextDrawerProps) {
  const [world, setWorld] = useState<Load<CampaignWorldHttpResponse>>({ state: "loading" });
  const [roster, setRoster] = useState<Load<NamedNpc[]>>({ state: "loading" });
  const [cast, setCast] = useState<Load<CastView>>({ state: "loading" });
  const [objectives, setObjectives] = useState<Load<Objective[]>>({ state: "loading" });
  const [resources, setResources] = useState<Load<ActorResourcesHttpGetResponse | null>>({ state: "loading" });
  const [encounters, setEncounters] = useState<Load<EncounterView>>({ state: "loading" });
  const [materials,setMaterials]=useState<Load<CampaignPublishedMaterials>>({state:"loading"});
  const [notice, setNotice] = useState<string | null>(null);
  const [placeNpcId, setPlaceNpcId] = useState(""); const [placeLocationId, setPlaceLocationId] = useState("");
  const [moveLocations, setMoveLocations] = useState<Record<string, string>>({}); const [removeNpcId, setRemoveNpcId] = useState<string | null>(null);
  const actorEligible = selectedActorId !== null && playableActorIds.includes(selectedActorId);
  const lock = useNpcPresenceMutation(campaignId, sessionId);
  const statusRef = useRef<HTMLDivElement>(null); const confirmRemoveRef = useRef<HTMLButtonElement>(null);
  const removeOriginRef = useRef<HTMLButtonElement | null>(null); const restoreRemoveFocusRef = useRef(false);
  const mountedRef = useRef(false); const operationGeneration = useRef(0);
  const previousAuthorizationRef = useRef({ audience, campaignId, sessionId });
  const getCast = api.getCampaignPresentCast ?? defaultGetCampaignPresentCast;
  const commandPresence = api.commandNpcPresence ?? defaultCommandNpcPresence;
  const getPublishedMaterials=api.getCampaignPublishedMaterials??defaultGetCampaignPublishedMaterials;

  useLayoutEffect(() => {
    if (audience !== "gm") clearNpcPresenceMutation(campaignId, sessionId);
  }, [audience, campaignId, sessionId]);

  const refreshCast = useCallback(async (explicit = false) => {
    const generation = operationGeneration.current;
    setCast((old) => ({ state: "loading", ...(old.state === "ready" ? { stale: old.value } : old.stale ? { stale: old.stale } : {}) }));
    try {
      const value = safeCast(await getCast(campaignId, sessionId, audience), audience);
      if (!mountedRef.current || operationGeneration.current !== generation) return null;
      setCast({ state: "ready", value });
      const cleared = reconcileNpcPresenceMutation(campaignId, sessionId, value.sessionRevision, explicit);
      if (explicit) setNotice(cleared ? "Present cast refreshed from the server." : "The refreshed cast revision does not yet match the command receipt. No command was repeated.");
      return value;
    } catch {
      if (mountedRef.current && operationGeneration.current === generation) { setCast((old) => ({ state: "error", ...(old.state === "ready" ? { stale: old.value } : old.stale ? { stale: old.stale } : {}) })); if (explicit) setNotice("Present cast refresh failed. No command was repeated."); }
      return null;
    }
  }, [audience, campaignId, getCast, sessionId]);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; operationGeneration.current += 1; }; }, [campaignId, sessionId]);

  useEffect(() => {
    let current = true; operationGeneration.current += 1; setNotice(null); setRemoveNpcId(null);
    setWorld({ state: "loading" }); setRoster({ state: "loading" }); setCast({ state: "loading" }); setObjectives({ state: "loading" }); setResources({ state: "loading" }); setEncounters({ state: "loading" });setMaterials({state:"loading"});
    const previousAuthorization = previousAuthorizationRef.current;
    if (previousAuthorization.audience === "gm" && audience !== "gm") {
      // A downgrade drops the GM-only in-memory lock for privacy. This can forfeit
      // reconciliation state, but the downgrade itself never retries the POST.
      clearNpcPresenceMutation(previousAuthorization.campaignId, previousAuthorization.sessionId);
    }
    previousAuthorizationRef.current = { audience, campaignId, sessionId };
    void refreshCast();
    void api.getCampaignWorld(campaignId).then((value) => { if (current) setWorld({ state: "ready", value: value.data }); }).catch(() => { if (current) setWorld({ state: "error" }); });
    if (audience === "gm") void api.listCampaignNpcs(campaignId, "gm").then((value) => { if (current) setRoster({ state: "ready", value: value.data.npcs.map((npc) => ({ id: npc.npcId, name: npc.publicState.name })) }); }).catch(() => { if (current) setRoster({ state: "error" }); });
    else setRoster({ state: "ready", value: [] });
    void api.listCampaignQuests(campaignId, audience).then((value) => { if (!current) return; const active = new Set(value.data.quests.filter((quest) => quest.status === "active").map((quest) => quest.questId)); setObjectives({ state: "ready", value: value.data.objectives.filter((objective) => active.has(objective.questId) && objective.completedAt === null).map((objective) => ({ id: objective.objectiveId, description: objective.description, progress: objective.progress, target: objective.targetProgress })) }); }).catch(() => { if (current) setObjectives({ state: "error" }); });
    if (actorEligible && selectedActorId) void api.getActorResources(campaignId, selectedActorId).then((value) => { if (current) setResources({ state: "ready", value }); }).catch(() => { if (current) setResources({ state: "error" }); }); else setResources({ state: "ready", value: null });
    void api.listCampaignEncounters(campaignId).then(async ({ encounters: rows }) => { const roomRows = rows.filter((entry) => entry.sessionId === sessionId); const active = roomRows.find((entry) => entry.status === "active" && entry.combatId !== null); let activeCombat: EncounterView["activeCombat"] = null; if (active?.combatId) try { const combat = await api.getCombatState(active.combatId); activeCombat = { round: combat.round, currentCombatant: combat.currentCombatant }; } catch { /* encounter status remains useful */ } if (current) setEncounters({ state: "ready", value: { encounters: roomRows, activeCombat } }); }).catch(() => { if (current) setEncounters({ state: "error" }); });
    void getPublishedMaterials(campaignId).then((value)=>{if(current)setMaterials({state:"ready",value});}).catch(()=>{if(current)setMaterials({state:"error"});});
    return () => { current = false; operationGeneration.current += 1; };
  }, [api, campaignId, sessionId, selectedActorId, actorEligible, audience, authorizationGeneration, refreshCast,getPublishedMaterials]);

  useEffect(() => { if (notice) statusRef.current?.focus(); }, [notice]);
  useEffect(() => {
    if (removeNpcId) confirmRemoveRef.current?.focus();
    else if (restoreRemoveFocusRef.current) { restoreRemoveFocusRef.current = false; const origin = removeOriginRef.current; queueMicrotask(() => { if (origin?.isConnected) origin.focus(); }); }
  }, [removeNpcId]);

  const worldValue = world.state === "ready" ? world.value : world.stale;
  const actorLocation = actorEligible ? worldValue?.currentLocations.find((entry) => entry.actorId === selectedActorId) : undefined;
  const location = worldValue?.visibleLocations.find((entry) => entry.locationId === actorLocation?.locationId);
  const exits = useMemo(() => actorLocation ? (worldValue?.visibleConnections.filter((entry) => entry.fromLocationId === actorLocation.locationId) ?? []) : [], [actorLocation, worldValue]);
  const rosterValue = roster.state === "ready" ? roster.value : roster.stale;
  const loadedCast = cast.state === "ready" ? cast.value : cast.stale;
  const castValue = loadedCast?.audience === audience ? loadedCast : undefined;
  const objectiveValue = objectives.state === "ready" ? objectives.value : objectives.stale;
  const resourceValue = resources.state === "ready" ? resources.value : resources.stale;
  const encounterValue = encounters.state === "ready" ? encounters.value : encounters.stale;
  const materialValue=materials.state==="ready"?materials.value:materials.stale;
  const availableNpcs = rosterValue?.filter((npc) => !castValue?.members.some((member) => member.id === npc.id)) ?? [];
  const canManage = audience === "gm" && castValue?.state === "running";

  function presenceControlLabel(action: "Move" | "Remove", npc: CastView["members"][number], suffix = "") {
    const duplicates = castValue?.members.filter((member) => member.name === npc.name) ?? [];
    const qualifier = duplicates.length > 1 ? `, NPC ${duplicates.findIndex((member) => member.id === npc.id) + 1} of ${duplicates.length}` : "";
    return `${action} ${npc.name}${suffix}${qualifier}`;
  }

  function closeRemoval() { restoreRemoveFocusRef.current = true; setRemoveNpcId(null); }

  async function mutate(npcId: string, mutation: NpcPresenceMutationHttpRequest["mutation"]) {
    if (!canManage || !castValue || lock) return;
    const pending = beginNpcPresenceMutation(campaignId, sessionId, npcId); if (!pending) return;
    const generation = operationGeneration.current;
    setNotice("Submitting one NPC presence command...");
    try {
      const response = await commandPresence(campaignId, sessionId, npcId, { expectedRevision: castValue.sessionRevision, idempotencyKey: presenceKey(), mutation });
      markNpcPresenceReconciliation(pending, response.receipt.revisionAfter);
      if (!mountedRef.current || operationGeneration.current !== generation) return;
      const fresh = await refreshCast();
      if (!mountedRef.current || operationGeneration.current !== generation) return;
      if (fresh && fresh.sessionRevision >= response.receipt.revisionAfter) { setNotice("NPC presence updated from the authoritative present cast."); setRemoveNpcId(null); }
      else setNotice("The command receipt was accepted, but the authoritative cast revision is stale or unavailable. Refresh; the command will not be repeated.");
    } catch (error) {
      const knownNonCommit = error instanceof ApiInputError || (error instanceof ApiError && ["RPG_NPC_PRESENCE_NOT_FOUND", "RPG_NPC_PRESENCE_STALE", "RPG_NPC_PRESENCE_CONFLICT"].includes(error.code ?? ""));
      if (knownNonCommit) {
        releaseNpcPresenceMutation(pending);
      } else {
        markNpcPresenceAmbiguous(pending);
      }
      if (!mountedRef.current || operationGeneration.current !== generation) return;
      if (knownNonCommit && error instanceof ApiError && error.code === "RPG_NPC_PRESENCE_NOT_FOUND") setNotice("NPC presence is unavailable because the NPC or running session was not found. No change was committed.");
      else if (knownNonCommit && error instanceof ApiError && (error.code === "RPG_NPC_PRESENCE_STALE" || error.code === "RPG_NPC_PRESENCE_CONFLICT")) setNotice("Present cast conflict: its revision is stale. No change was committed; refresh before trying again.");
      else if (knownNonCommit) setNotice("The NPC presence command was rejected before dispatch. No change was committed.");
      else setNotice("The NPC presence outcome is uncertain. Refresh the authoritative cast; the command will not be repeated.");
    }
  }

  const widgetContent: Record<CampaignContextWidget, ReactNode> = {
    location: <section><h2>Current location</h2>{status(world, !location, "visible location")}{location && <><p><strong>{location.name}</strong></p><p>{location.description}</p><h3>Visible exits from this location</h3>{exits.length ? <ul>{exits.map((exit) => <li key={exit.connectionId}>{worldValue?.visibleLocations.find((entry) => entry.locationId === exit.toLocationId)?.name ?? "Visible destination"}</li>)}</ul> : <p>No server-visible exits from this origin.</p>}</>}</section>,
    cast: <section className="campaign-cast-management"><h2>{castValue?.state === "stopped" ? "Present at stop/history" : castValue?.state === "running" ? "NPCs present now" : "NPC presence"}</h2>{cast.state === "loading" && !cast.stale && <p role="status">Loading present cast...</p>}{cast.state === "error" && !cast.stale && <p role="alert">Present cast could not be loaded.</p>}{castValue?.state === "running" && castValue.members.length === 0 && <p>No NPCs marked present.</p>}{castValue?.state === "stopped" && castValue.members.length === 0 && <p>No NPCs were present at stop/history.</p>}{castValue?.members.length ? <ul>{castValue.members.map((npc) => <li key={npc.id}><span>{npc.name}{npc.locationLabel ? ` - ${npc.locationLabel}` : ""}</span>{canManage && <span className="campaign-cast-actions"><label>Move {npc.name}<select aria-label={presenceControlLabel("Move", npc, " location")} value={moveLocations[npc.id] ?? npc.locationId ?? ""} onChange={(event) => setMoveLocations((values) => ({ ...values, [npc.id]: event.target.value }))}><option value="">Unknown or undisclosed location</option>{worldValue?.visibleLocations.map((place) => <option key={place.locationId} value={place.locationId}>{place.name}</option>)}</select></label><button type="button" className="ghost" aria-label={presenceControlLabel("Move", npc)} disabled={Boolean(lock)} onClick={() => void mutate(npc.id, { kind: "move", locationId: Object.prototype.hasOwnProperty.call(moveLocations, npc.id) ? moveLocations[npc.id] || null : npc.locationId })}>Move {npc.name}</button><button type="button" className="ghost" aria-label={presenceControlLabel("Remove", npc)} disabled={Boolean(lock)} onClick={(event) => { removeOriginRef.current = event.currentTarget; setRemoveNpcId(npc.id); }}>Remove {npc.name}</button></span>}</li>)}</ul> : null}
      {canManage && availableNpcs.length > 0 && <fieldset className="campaign-cast-place"><legend>Place an NPC</legend><label>NPC<select value={placeNpcId} onChange={(event) => setPlaceNpcId(event.target.value)}><option value="">Choose NPC</option>{availableNpcs.map((npc) => <option key={npc.id} value={npc.id}>{npc.name}</option>)}</select></label><label>Place location<select value={placeLocationId} onChange={(event) => setPlaceLocationId(event.target.value)}><option value="">Unknown or undisclosed location</option>{worldValue?.visibleLocations.map((place) => <option key={place.locationId} value={place.locationId}>{place.name}</option>)}</select></label><button type="button" className="primary" disabled={!placeNpcId || Boolean(lock)} onClick={() => void mutate(placeNpcId, { kind: "place", locationId: placeLocationId || null })}>Place NPC</button></fieldset>}
      {removeNpcId && canManage && <div className="campaign-removal-confirmation" role="group" aria-label="Confirm NPC removal"><p>Remove {castValue.members.find((npc) => npc.id === removeNpcId)?.name} from the present cast?</p><button ref={confirmRemoveRef} type="button" className="primary" disabled={Boolean(lock)} onClick={() => void mutate(removeNpcId, { kind: "remove" }).finally(closeRemoval)}>Confirm remove</button><button type="button" className="ghost" onClick={closeRemoval}>Cancel</button></div>}
    </section>,
    objectives: <section><h2>Active objectives</h2>{status(objectives, !objectiveValue?.length, "active objectives")}{objectiveValue?.length ? <ul>{objectiveValue.map((objective) => <li key={objective.id}>{objective.description} <span>{objective.progress} / {objective.target}</span></li>)}</ul> : null}</section>,
    resources: <section><h2>Party resources</h2>{status(resources, !resourceValue?.resources.length, "party resources")}{resourceValue?.resources.length ? <ul>{resourceValue.resources.map((resource) => <li key={resource.name}>{resource.name}: {resource.current} / {resource.max}</li>)}</ul> : null}</section>,
    encounter: <section><h2>Encounter status</h2>{status(encounters, !encounterValue?.encounters.length, "encounters")}{encounterValue?.encounters.length ? <ul>{encounterValue.encounters.map((entry) => <li key={entry.encounterId}>{entry.name}: {entry.status}</li>)}</ul> : null}{encounterValue?.activeCombat && <p>Active combat: round {encounterValue.activeCombat.round}; current combatant {encounterValue.activeCombat.currentCombatant ?? "not assigned"}.</p>}</section>,
  };
  return <aside id="campaign-context-panel" className="campaign-context-drawer" aria-label="Campaign context" tabIndex={-1}><details open><summary>Campaign context</summary>
    {audience === "gm" && (notice || lock) && <div ref={statusRef} tabIndex={-1} role="alert"><p>{notice ?? "An NPC presence command still requires authoritative reconciliation. No command will be repeated."}</p>{lock && <button type="button" className="ghost" onClick={() => void refreshCast(true)}>Refresh present cast</button>}</div>}
    {widgets.map((widget) => <Fragment key={widget}>{widgetContent[widget]}</Fragment>)}
    <section><h2>Delivered materials</h2>{status(materials,!materialValue?.materials.length,"delivered materials")}{materialValue?.materials.length?<ul>{materialValue.materials.map((item)=><li key={item.resourceId}><strong>{item.title}</strong><p>{item.content}</p></li>)}</ul>:null}</section>
  </details></aside>;
}
