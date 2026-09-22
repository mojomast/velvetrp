import { Fragment, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActorResourcesHttpGetResponse, CampaignPublishedMaterials, CampaignWorldHttpResponse, CombatReadResponse, EncounterPublic, NpcCastHttp, NpcPresenceMutationHttpRequest, NpcPresenceMutationHttpResponse } from "@velvet/contracts";
import { ApiError, ApiInputError, commandNpcPresence as defaultCommandNpcPresence, getCampaignPresentCast as defaultGetCampaignPresentCast, getCampaignPublishedMaterials as defaultGetCampaignPublishedMaterials } from "../../../api";
import { beginNpcPresenceMutation, clearNpcPresenceMutation, markNpcPresenceAmbiguous, markNpcPresenceReconciliation, reconcileNpcPresenceMutation, releaseNpcPresenceMutation, useNpcPresenceMutation } from "../narrativeMutationRegistry";
import type { CampaignContextWidget } from "./campaignWorkbenchPreferences";
import { CampaignRouteMap } from "./CampaignRouteMap";
import { TacticalMapPanel, type TacticalMapPanelApi } from "../map/TacticalMapPanel";
import { createClientId } from "../../../utils/clientId";

type Audience = "gm" | "player";
type Load<T> = { state: "loading"; stale?: T } | { state: "ready"; value: T } | { state: "error"; stale?: T };
type NamedNpc = { id: string; name: string };
type Objective = { id: string; description: string; progress: number; target: number };
type EncounterView = { encounters: EncounterPublic[]; activeCombat: { encounterId: string; round: number; currentCombatant: string | null; actorId: string | null; combatantId: string | null } | null };
type CastView = { audience: Audience; state: "running" | "stopped"; sessionRevision: number; members: Array<{ id: string; name: string; locationLabel: string | null; locationId: string | null }> };

/** Narrow, role-filtered read/write API consumed by the campaign context drawer. */
export interface CampaignContextDrawerApi extends Partial<TacticalMapPanelApi> {
  getCampaignWorld: (campaignId: string, sessionId?: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  listCampaignNpcs: (campaignId: string, audience: Audience) => Promise<{ data: { npcs: Array<{ npcId: string; publicState: { name: string } }> }; revision: number }>;
  listCampaignQuests: (campaignId: string, audience: Audience) => Promise<{ data: { quests: Array<{ questId: string; status: string }>; objectives: Array<{ objectiveId: string; questId: string; description: string; progress: number; targetProgress: number; completedAt: string | null }> }; revision: number }>;
  getActorResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  listCampaignEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombatState: (combatId: string) => Promise<Pick<CombatReadResponse, "round" | "currentCombatant"> & Partial<CombatReadResponse>>;
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
  refreshKey?: number;
  onPrefillDeclaration?: (declaration: string) => void;
  onOpenWorld?: () => void;
  onOpenCombat?: () => void;
  mapsOnly?: boolean;
  hideMaps?: boolean;
  readOnly?: boolean;
  commandsBlocked?: boolean;
  /** Emits the active scene identity (current location, or the room) for the play surface. */
  onSceneResolved?: (scene: { sceneKey: string; label: string; description?: string } | null) => void;
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

const presenceKey = () => `presence-ui-${createClientId()}`;

/** Loads and renders only server projections; it performs no authoritative calculations. */
export function CampaignContextDrawer(props: CampaignContextDrawerProps) {
  // Refreshes reuse this tree; authority and viewpoint changes must not reuse private projections.
  return <BoundCampaignContextDrawer key={JSON.stringify([props.campaignId, props.sessionId, props.selectedActorId, [...props.playableActorIds].sort(), props.audience, props.authorizationGeneration])} {...props} />;
}

function refreshing<T>(old: Load<T>): Load<T> {
  return { state: "loading", stale: old.state === "ready" ? old.value : old.stale };
}

function BoundCampaignContextDrawer({ campaignId, sessionId, selectedActorId, playableActorIds, audience, authorizationGeneration, api,
  widgets = ["location", "cast", "objectives", "resources", "encounter"], refreshKey = 0, onPrefillDeclaration = () => undefined, onOpenWorld = () => undefined, onOpenCombat, mapsOnly = false, hideMaps = false, readOnly = false, commandsBlocked = false, onSceneResolved = () => undefined }: CampaignContextDrawerProps) {
  const [combatRefresh, setCombatRefresh] = useState(0);
  const [mapMode, setMapMode] = useState<"exploration" | "combat">("exploration");
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
  const tacticalActorId = actorEligible ? selectedActorId : playableActorIds[0] ?? null;
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
    setWorld(refreshing); setRoster(refreshing); setCast(refreshing); setObjectives(refreshing); setResources(refreshing); setEncounters(refreshing); setMaterials(refreshing);
    const previousAuthorization = previousAuthorizationRef.current;
    if (previousAuthorization.audience === "gm" && audience !== "gm") {
      // A downgrade drops the GM-only in-memory lock for privacy. This can forfeit
      // reconciliation state, but the downgrade itself never retries the POST.
      clearNpcPresenceMutation(previousAuthorization.campaignId, previousAuthorization.sessionId);
    }
    previousAuthorizationRef.current = { audience, campaignId, sessionId };
    void refreshCast();
    void api.getCampaignWorld(campaignId, sessionId).then((value) => { if (current) setWorld({ state: "ready", value: value.data }); }).catch(() => { if (current) setWorld({ state: "error" }); });
    if (audience === "gm") void api.listCampaignNpcs(campaignId, "gm").then((value) => { if (current) setRoster({ state: "ready", value: value.data.npcs.map((npc) => ({ id: npc.npcId, name: npc.publicState.name })) }); }).catch(() => { if (current) setRoster({ state: "error" }); });
    else setRoster({ state: "ready", value: [] });
    void api.listCampaignQuests(campaignId, audience).then((value) => { if (!current) return; const active = new Set(value.data.quests.filter((quest) => quest.status === "active").map((quest) => quest.questId)); setObjectives({ state: "ready", value: value.data.objectives.filter((objective) => active.has(objective.questId) && objective.completedAt === null).map((objective) => ({ id: objective.objectiveId, description: objective.description, progress: objective.progress, target: objective.targetProgress })) }); }).catch(() => { if (current) setObjectives({ state: "error" }); });
    if (actorEligible && selectedActorId) void api.getActorResources(campaignId, selectedActorId).then((value) => { if (current) setResources({ state: "ready", value }); }).catch(() => { if (current) setResources({ state: "error" }); }); else setResources({ state: "ready", value: null });
    void api.listCampaignEncounters(campaignId).then(async ({ encounters: rows }) => {
      const roomRows = rows.filter((entry) => entry.sessionId === sessionId);
      const activeRows = roomRows.filter((entry) => entry.status === "active" && entry.combatId !== null);
      const active = activeRows.length === 1 ? activeRows[0] : undefined;
      let activeCombat: EncounterView["activeCombat"] = null;
      if (active?.combatId) try {
        const combat = await api.getCombatState(active.combatId);
        const latest = (await api.listCampaignEncounters(campaignId)).encounters.filter((entry) => entry.sessionId === sessionId && entry.status === "active");
        const stable = latest.length === 1 && latest[0]!.encounterId === active.encounterId && latest[0]!.combatId === active.combatId && latest[0]!.revision === active.revision;
        const matches = active.combatants.filter((entry) => entry.kind === "actor" && entry.actorId === selectedActorId);
        const liveMatches = combat.combatants?.filter((entry) => entry.kind === "actor" && entry.actorId === selectedActorId) ?? [];
        const verified = stable && actorEligible && matches.length === 1 && liveMatches.length === 1 && matches[0]!.combatantId === liveMatches[0]!.combatantId;
        if (stable) activeCombat = { encounterId: active.encounterId, round: combat.round, currentCombatant: combat.currentCombatant, actorId: selectedActorId, combatantId: verified ? matches[0]!.combatantId : null };
      } catch { /* Missing runtime evidence never grants map control. */ }
      if (current) setEncounters({ state: "ready", value: { encounters: roomRows, activeCombat } });
    }).catch(() => { if (current) setEncounters({ state: "error" }); });
    void getPublishedMaterials(campaignId).then((value)=>{if(current)setMaterials({state:"ready",value});}).catch(()=>{if(current)setMaterials({state:"error"});});
    return () => { current = false; operationGeneration.current += 1; };
  }, [api, campaignId, sessionId, selectedActorId, actorEligible, audience, authorizationGeneration, refreshCast,getPublishedMaterials,refreshKey,combatRefresh]);

  useEffect(() => { if (notice) statusRef.current?.focus(); }, [notice]);
  useEffect(() => {
    if (removeNpcId) confirmRemoveRef.current?.focus();
    else if (restoreRemoveFocusRef.current) { restoreRemoveFocusRef.current = false; const origin = removeOriginRef.current; queueMicrotask(() => { if (origin?.isConnected) origin.focus(); }); }
  }, [removeNpcId]);

  const worldValue = world.state === "ready" ? world.value : world.stale;
  const actorLocation = actorEligible ? worldValue?.currentLocations.find((entry) => entry.actorId === selectedActorId) : undefined;
  const location = worldValue?.visibleLocations.find((entry) => entry.locationId === actorLocation?.locationId);
  const tacticalLocations = worldValue?.currentLocations.filter((entry) => entry.actorId === tacticalActorId) ?? [];
  const tacticalLocation = tacticalLocations.length === 1 ? tacticalLocations[0] : undefined;
  const tacticalPlace = worldValue?.visibleLocations.find((entry) => entry.locationId === tacticalLocation?.locationId);
  const exits = useMemo(() => actorLocation ? (worldValue?.visibleConnections.filter((entry) => entry.fromLocationId === actorLocation.locationId) ?? []) : [], [actorLocation, worldValue]);
  const sceneLocationId = actorLocation?.locationId ?? null;
  const sceneLocationName = location?.name ?? null;
  const sceneLocationDescription = location?.description?.trim() || null;
  const sceneCallbackRef = useRef(onSceneResolved); sceneCallbackRef.current = onSceneResolved;
  useEffect(() => {
    // Ground the active scene in the acting character's location row; fall back
    // to the room only while no authoritative location is known.
    if (sceneLocationId) sceneCallbackRef.current({ sceneKey: `location:${sceneLocationId}`, label: sceneLocationName?.trim() || "Current scene",
      ...(sceneLocationDescription ? { description: sceneLocationDescription } : {}) });
    else sceneCallbackRef.current({ sceneKey: `session:${sessionId}`, label: "This room" });
  }, [sceneLocationId, sceneLocationName, sceneLocationDescription, sessionId]);
  const rosterValue = roster.state === "ready" ? roster.value : roster.stale;
  const loadedCast = cast.state === "ready" ? cast.value : cast.stale;
  const castValue = loadedCast?.audience === audience ? loadedCast : undefined;
  const objectiveValue = objectives.state === "ready" ? objectives.value : objectives.stale;
  const resourceValue = resources.state === "ready" ? resources.value : resources.stale;
  const encounterValue = encounters.state === "ready" ? encounters.value : encounters.stale;
  const combatBinding = encounterValue?.activeCombat?.actorId === selectedActorId ? encounterValue.activeCombat : null;
  const materialValue=materials.state==="ready"?materials.value:materials.stale;
  const availableNpcs = rosterValue?.filter((npc) => !castValue?.members.some((member) => member.id === npc.id)) ?? [];
  const canManage = !readOnly && !commandsBlocked && cast.state === "ready" && world.state === "ready" && audience === "gm" && castValue?.state === "running";
  const tacticalApi = useMemo(() => api.getTacticalMap && api.generateTacticalMap && api.previewTacticalMapMove && api.moveTacticalMapToken
    ? { getTacticalMap: api.getTacticalMap, generateTacticalMap: api.generateTacticalMap, previewTacticalMapMove: api.previewTacticalMapMove, moveTacticalMapToken: api.moveTacticalMapToken, readCombatRoster: api.readCombatRoster } : null,
  [api.generateTacticalMap, api.getTacticalMap, api.moveTacticalMapToken, api.previewTacticalMapMove, api.readCombatRoster]);

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

  const maps = <section className="campaign-map-workspace" aria-label="Campaign maps">
    <details className="campaign-map-guidance"><summary>Maps and movement</summary><p>{readOnly ? "Spectator / read-only access. Explore the known world without issuing commands." : "Your acting character selects the controlled token. Choose an actor in the action composer to change it."}</p></details>
    <details open={!mapsOnly || !tacticalActorId || !tacticalApi}><summary>World routes and travel</summary>{status(world, false, "world map")}{worldValue && <CampaignRouteMap world={worldValue} selectedActorId={actorEligible ? selectedActorId : null} onPrefillDeclaration={onPrefillDeclaration} onOpenWorld={onOpenWorld} canPrefill={!readOnly && !commandsBlocked && actorEligible && world.state === "ready"} />}</details>
    <div className="button-row" role="group" aria-label="Local map mode"><button type="button" aria-pressed={mapMode === "exploration"} onClick={() => setMapMode("exploration")}>Exploration grid</button><button type="button" aria-pressed={mapMode === "combat"} onClick={() => setMapMode("combat")}>Combat grid</button></div>
    {mapMode === "combat" && <details className="tactical-combat-details"><summary>Combat readiness</summary>
    {mapMode === "combat" && <p>{encounterValue?.activeCombat ? `Round ${encounterValue.activeCombat.round}; current combatant: ${encounterValue.activeCombat.currentCombatant ?? "not assigned"}. Server previews enforce turn and movement limits.` : "No active combat in this room. Start an encounter using combat controls."}</p>}
    {mapMode === "combat" && <div aria-label="Combat readiness"><p>{encounters.state === "ready" && combatBinding?.combatantId ? `Verified selected combatant: ${combatBinding.combatantId}. ${combatBinding.currentCombatant === combatBinding.combatantId ? "Your character has the current turn. Preview movement using the server budget below; use combat controls for actions and ending the turn." : "Another combatant has the turn. You may inspect or prepare the map; movement still requires a server allowance."}` : "Selected actor binding is missing, ambiguous, stale, or still loading. Combat map commands are locked. Refresh combat binding or review combat controls."}</p><button type="button" onClick={() => { setEncounters(refreshing); setCombatRefresh((value) => value + 1); }}>Refresh combat binding</button>{onOpenCombat && <button type="button" onClick={onOpenCombat}>Open combat controls</button>}</div>}
    </details>}
    {tacticalApi && tacticalActorId ? worldValue === undefined && world.state === "loading" ? <p role="status">Loading the authoritative world viewpoint; the tactical map will load once it arrives.</p> : <>{worldValue === undefined && <p role="status">The authoritative world viewpoint is unavailable. The tactical map loads independently; location-grounded generation stays unavailable until it refreshes.</p>}
      <TacticalMapPanel key={tacticalLocation?.locationId ?? "unlocated"} location={tacticalLocation ? { locationId: tacticalLocation.locationId, revision: tacticalLocation.revision, name: tacticalPlace?.name, description: tacticalPlace?.description } : undefined} onRefreshLocation={() => { setWorld(refreshing); setCombatRefresh((value) => value + 1); }} refreshKey={refreshKey + combatRefresh} commandsBlocked={commandsBlocked || (worldValue !== undefined && world.state !== "ready") || tacticalLocations.length > 1 || (mapMode === "combat" && encounters.state !== "ready")} campaignId={campaignId} sessionId={sessionId} actorId={tacticalActorId} audience={audience} readOnly={readOnly || (mapMode === "combat" && !combatBinding?.combatantId)}
        mode={mapMode} encounterId={combatBinding?.encounterId ?? null} combatantId={combatBinding?.combatantId ?? null} api={tacticalApi} /></>
      : <p>{!tacticalActorId ? "No controlled actor is available for a tactical viewpoint. Known world routes remain available above; no token movement can be issued." : "Tactical map services are unavailable in this view."}</p>}
  </section>;
  if (mapsOnly) return maps;
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
    {!hideMaps && maps}
    <section><h2>Delivered materials</h2>{status(materials,!materialValue?.materials.length,"delivered materials")}{materialValue?.materials.length?<ul>{materialValue.materials.map((item)=><li key={item.resourceId}><strong>{item.title}</strong><p>{item.content}</p></li>)}</ul>:null}</section>
  </details></aside>;
}
