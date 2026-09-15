import { useCallback, useEffect, useRef, useState } from "react";
import type { TacticalMapGenerateRequest, TacticalMapMode, TacticalMapMoveRequest, TacticalMapMoveResponse, TacticalMapPreviewRequest, TacticalMapPreviewResponse, TacticalMapSnapshot } from "@velvet/contracts";
import { ApiError, getTacticalMap } from "../../../api";
import { TacticalMapCanvas } from "./TacticalMapCanvas";
import { CombatSpawnReview, type CombatRosterReader } from "./CombatSpawnReview";
import { readCombatRoster, type CombatRoster } from "./combatRoster";
import { readTacticalMap } from "./readTacticalMap";
import { createClientId } from "../../../utils/clientId";

export interface TacticalMapPanelApi {
  getTacticalMap: (campaignId: string, sessionId: string, mode: TacticalMapMode, actorId: string, signal?: AbortSignal) => Promise<TacticalMapSnapshot>;
  readCombatRoster?: CombatRosterReader;
  generateTacticalMap: (campaignId: string, sessionId: string, input: TacticalMapGenerateRequest) => Promise<TacticalMapSnapshot>;
  previewTacticalMapMove: (campaignId: string, sessionId: string, mode: TacticalMapMode, input: TacticalMapPreviewRequest) => Promise<TacticalMapPreviewResponse>;
  moveTacticalMapToken: (campaignId: string, sessionId: string, mode: TacticalMapMode, input: TacticalMapMoveRequest) => Promise<TacticalMapMoveResponse>;
}

interface Props {
  campaignId: string;
  sessionId: string;
  actorId: string;
  audience: "gm" | "player";
  mode: TacticalMapMode;
  encounterId: string | null;
  combatantId: string | null;
  api: TacticalMapPanelApi;
  readOnly?: boolean;
  refreshKey?: number;
  commandsBlocked?: boolean;
  location?: { locationId: string; revision: number; name?: string; description?: string };
  onRefreshLocation?: () => void;
}

const commandKey = createClientId;

/** Canvas declares destinations; only server snapshots and previews can enable a move. */
export function TacticalMapPanel(props: Props) {
  return <BoundTacticalMapPanel key={JSON.stringify([props.campaignId, props.sessionId, props.actorId, props.audience, props.mode, props.location?.locationId, props.mode === "combat" ? props.encounterId : null, props.mode === "combat" ? props.combatantId : null])} {...props} />;
}

function BoundTacticalMapPanel({ campaignId, sessionId, actorId, audience, mode, encounterId, combatantId, api, readOnly = false, refreshKey = 0, commandsBlocked = false, location, onRefreshLocation }: Props) {
  const accessReadOnly = readOnly;
  readOnly = readOnly || commandsBlocked;
  const locationId = location?.locationId; const locationRevision = location?.revision;
  const bindingMissing = mode === "combat" && (!encounterId || !combatantId);
  const matchesBinding = (value: TacticalMapSnapshot) => value.campaignId === campaignId && value.sessionId === sessionId && value.mode === mode && value.encounterId === (mode === "combat" ? encounterId : null)
    && (!value.locationBinding || value.locationBinding.locationId === locationId)
    && new Set(value.projection.tokens.map((token) => token.tokenId)).size === value.projection.tokens.length
    && (!value.controlledTokenId || value.projection.tokens.filter((token) => token.tokenId === value.controlledTokenId).length === 1);
  const [snapshot, setSnapshot] = useState<TacticalMapSnapshot | null>(null);
  const [preview, setPreview] = useState<TacticalMapPreviewResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "mismatch" | "previewing" | "moving" | "ambiguous" | "error">("loading");
  const [notice, setNotice] = useState(""); const [seed, setSeed] = useState(() => locationId ? `velvet-map:${locationId}`.slice(0, 256) : "velvet-map"); const [kind, setKind] = useState<"dungeon" | "cave" | "arena" | "underwater">("arena");
  const generation = useRef(0);
  const busy = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const [spawnReview, setSpawnReview] = useState<{ roster: CombatRoster; tokens: TacticalMapGenerateRequest["tokens"] } | null>(null);
  const reviewSpawns = useCallback((value: { roster: CombatRoster; tokens: TacticalMapGenerateRequest["tokens"] } | null) => { setSpawnReview(value); setReplaceReviewed(false); }, []);
  const [replaceReviewed, setReplaceReviewed] = useState(false);
  const [locationRefreshRequired, setLocationRefreshRequired] = useState(false);
  const readRoster = api.readCombatRoster ?? readCombatRoster;
  const [selection, setSelection] = useState("");
  const locationMismatch = useCallback(() => {
    setSnapshot(null); setPreview(null); setSpawnReview(null); setReplaceReviewed(false); setState("mismatch");
    setNotice("This map is not prepared for the actor's current location. Refresh world location, then explicitly review a replacement. No map will be generated automatically.");
  }, []);

  const refresh = useCallback(async (explicit = false) => {
    readController.current?.abort(); const controller = new AbortController(); readController.current = controller;
    const request = ++generation.current; busy.current = false; setSelection(""); setPreview(null); setSpawnReview(null); setReplaceReviewed(false); setState("loading"); setNotice("Refreshing authoritative map; actions are locked and the previous view is stale. No command is being repeated.");
    // Preserve injected APIs; replace only the shared, non-abortable implementation.
    const read = api.getTacticalMap === getTacticalMap ? readTacticalMap : api.getTacticalMap;
    try { const value = await read(campaignId, sessionId, mode, actorId, controller.signal); if (request !== generation.current || controller.signal.aborted) return;
      if (value.campaignId !== campaignId || value.sessionId !== sessionId || value.mode !== mode || value.encounterId !== (mode === "combat" ? encounterId : null)) { setSnapshot(null); setState("error"); setNotice("Tactical map encounter binding is stale or missing. Refresh combat binding before continuing."); return; }
      if (value.locationBinding && value.locationBinding.locationId !== locationId) { locationMismatch(); return; }
      if (new Set(value.projection.tokens.map((token) => token.tokenId)).size !== value.projection.tokens.length || (value.controlledTokenId && value.projection.tokens.filter((token) => token.tokenId === value.controlledTokenId).length !== 1)) { setSnapshot(null); setState("error"); setNotice("Tactical map token control is ambiguous. Commands are locked until an authoritative refresh."); return; }
      setSnapshot(value); setState("ready"); setNotice(explicit ? "Authoritative tactical map refreshed." : "Server-owned movement and visibility."); }
    catch (error) { if (request !== generation.current || controller.signal.aborted) return; setSnapshot(null); if (error instanceof ApiError && error.status === 409 && error.code === "RPG_TACTICAL_MAP_LOCATION_MISMATCH") { locationMismatch(); } else if (error instanceof ApiError && error.status === 404) { setState("missing"); setNotice("No tactical map projection is available for this actor, room, and mode."); } else { setState("error"); setNotice("Tactical map could not be loaded."); } }
  }, [actorId, api, campaignId, mode, sessionId, encounterId, combatantId, audience, locationId, locationRevision, locationMismatch]);

  useEffect(() => { void refresh(); return () => { generation.current += 1; readController.current?.abort(); }; }, [refresh, refreshKey]);
  useEffect(() => { setLocationRefreshRequired(false); }, [locationId, locationRevision, refreshKey]);
  useEffect(() => {
    // GET only: never replay previews, moves, generation, or turn-economy writes.
    const update = () => { if (document.visibilityState !== "hidden" && !busy.current && state === "ready") void refresh(true); };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", update); };
  }, [refresh, state]);
  useEffect(() => { if (readOnly) { if (busy.current) { generation.current += 1; readController.current?.abort(); } setPreview(null); busy.current = false; setState((value) => value === "previewing" || value === "moving" ? "ambiguous" : value); } }, [readOnly]);

  async function select(destination: { x: number; y: number }) {
    if (!snapshot || busy.current || state !== "ready") return;
    const token = snapshot.projection.tokens.find((item) => destination.x >= item.position.x && destination.x < item.position.x + item.footprint.width && destination.y >= item.position.y && destination.y < item.position.y + item.footprint.height);
    setPreview(null);
    setSelection(token ? `${token.label}: ${token.disposition}. ${token.tokenId === snapshot.controlledTokenId ? "Your controlled token." : "Inspection target only; selecting this token does not grant control or declare an attack."}` : `Destination: ${destination.x + 1}, ${destination.y + 1}.`);
    if (token || readOnly || bindingMissing || !matchesBinding(snapshot) || !snapshot.controlledTokenId || !snapshot.movement || snapshot.movement.budgetFeet <= 0) return;
    const tile = snapshot.projection.tiles.find((item) => item.position.x === destination.x && item.position.y === destination.y);
    if (!tile || tile.visibility !== "visible" || !snapshot.projection.reachable.some((point) => point.x === destination.x && point.y === destination.y)) { setSelection("That cell is not currently visible and reachable. No movement preview requested."); return; }
    const request = ++generation.current; busy.current = true; setState("previewing"); setNotice("Requesting authoritative path and movement limits...");
    try { const value = await api.previewTacticalMapMove(campaignId, sessionId, mode, { actorId, destination, expectedMapRevision: snapshot.mapRevision, expectedTokenRevision: snapshot.tokenRevision });
      if (request !== generation.current) return; busy.current = false;
      if (value.locationBinding && value.locationBinding.locationId !== locationId) { locationMismatch(); return; }
      if (!matchesBinding(value) || value.projection.mapId !== snapshot.projection.mapId || value.controlledTokenId !== snapshot.controlledTokenId || value.mapRevision !== snapshot.mapRevision || value.tokenRevision !== snapshot.tokenRevision || !value.movement || value.movement.budgetFeet <= 0 || value.pathCostFeet > value.movement.budgetFeet || value.projection.authoritativePath?.at(-1)?.x !== destination.x || value.projection.authoritativePath?.at(-1)?.y !== destination.y) { setPreview(null); setSnapshot(null); setState("error"); setNotice("Preview encounter binding is stale. Refresh combat binding before continuing."); return; }
      setPreview(value); setSnapshot(value); setState("ready"); setNotice(`Preview: ${value.pathCostFeet} feet. Confirm to issue one move command.`); }
    catch (error) { if (request !== generation.current) return; busy.current = false; if (error instanceof ApiError && error.status === 409 && error.code === "RPG_TACTICAL_MAP_LOCATION_MISMATCH") { locationMismatch(); return; } setState("error"); setNotice(error instanceof ApiError && error.status === 409 ? "That destination is not legal in the latest authoritative state. Refresh or choose another visible cell." : "Path preview failed. No move command was issued."); }
  }

  async function confirm() {
    if (readOnly || bindingMissing || busy.current || !preview?.controlledTokenId || !matchesBinding(preview) || !preview.movement || preview.movement.budgetFeet <= 0 || !preview.projection.authoritativePath?.length || state !== "ready") return; const request = ++generation.current; busy.current = true; setState("moving"); setNotice("Submitting one revision-bound move command...");
    try { const value = await api.moveTacticalMapToken(campaignId, sessionId, mode, { actorId, destination: preview.projection.authoritativePath!.at(-1)!, previewId: preview.previewId,
        expectedMapRevision: preview.mapRevision, expectedTokenRevision: preview.tokenRevision, idempotencyKey: commandKey() });
      if (request !== generation.current) return; busy.current = false; setPreview(null);
      if (value.snapshot.locationBinding && value.snapshot.locationBinding.locationId !== locationId) { locationMismatch(); return; }
      if (!matchesBinding(value.snapshot)) { setSnapshot(null); setState("ambiguous"); setNotice("Move response binding changed. Refresh authoritative state; this command will not be repeated."); return; }
      setSnapshot(value.snapshot); setState("ready"); setNotice("Token moved and exploration refreshed from the server."); }
    catch (error) { if (request !== generation.current) return; busy.current = false; if (error instanceof ApiError && error.status === 409 && error.code === "RPG_TACTICAL_MAP_LOCATION_MISMATCH") { locationMismatch(); return; } setState("ambiguous"); setNotice(error instanceof ApiError && error.status === 409
      ? "The preview became stale and no move was accepted. Refresh before choosing again."
      : "The move outcome is uncertain. Refresh authoritative state; this command will not be repeated."); }
  }

  async function generate() {
     if (readOnly || locationRefreshRequired || audience !== "gm" || busy.current || !["missing", "mismatch"].includes(state) || (state === "mismatch" && !location) || !seed || !replaceReviewed || (mode === "combat" && (!encounterId || !combatantId || !spawnReview || (location && spawnReview.tokens.length > 64)))) return; const request = ++generation.current; busy.current = true; setState("moving"); setNotice("Creating one deterministic authoritative map...");
    try {
      if (mode === "combat") {
        const controller = new AbortController(); readController.current = controller;
        const latest = await readRoster(campaignId, sessionId, encounterId!, controller.signal);
        if (request !== generation.current || controller.signal.aborted) return;
        if (latest.encounterId !== spawnReview!.roster.encounterId || latest.combatId !== spawnReview!.roster.combatId || latest.revision !== spawnReview!.roster.revision || JSON.stringify(latest.combatants) !== JSON.stringify(spawnReview!.roster.combatants)) { busy.current = false; setSpawnReview(null); setState("error"); setNotice("Encounter roster changed. Refresh and review all spawns again; no generation was issued."); return; }
      }
      await api.generateTacticalMap(campaignId, sessionId, { mode, encounterId: mode === "combat" ? encounterId : null, kind, seed, width: 12, height: 10,
        ...(location ? { grounding: { actorId, expectedLocationId: location.locationId, expectedLocationRevision: location.revision } } : {}),
        tokens: mode === "combat" ? spawnReview!.tokens : [{ tokenId: actorId, actorId, combatantId: null, label: "Controlled actor", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false }], idempotencyKey: commandKey() });
      if (request !== generation.current) return; await refresh(true); }
    catch (error) { if (request !== generation.current) return; busy.current = false; setReplaceReviewed(false);
      if (error instanceof ApiError && error.status === 409 && error.code === "RPG_TACTICAL_MAP_LOCATION_MISMATCH") { setLocationRefreshRequired(true); locationMismatch(); return; }
      if (error instanceof ApiError && error.status === 409 && error.code === "RPG_TACTICAL_MAP_STALE") { setLocationRefreshRequired(true); setState("error"); setNotice("Actor location revision is stale. Refresh world location and review generation again. No command will be repeated."); return; }
      setState("ambiguous"); setNotice("Map generation outcome is uncertain. Refresh authoritative state; generation will not be repeated."); }
  }

  return <section className="tactical-map-panel" aria-labelledby="tactical-map-heading"><header><h2 id="tactical-map-heading">{location?.name ?? "Tactical map"}</h2><span>{mode}</span></header>
    {location?.description && <details className="tactical-location-description"><summary>About this location</summary><p>{location.description}</p></details>}
    {snapshot && <>
      <TacticalMapCanvas key={snapshot.projection.mapId} controlledTokenId={snapshot.controlledTokenId} projection={preview?.projection ?? { ...snapshot.projection, authoritativePath: null }} onSelectionChange={(point) => void select(point)} />
      {preview && <div className="tactical-map-confirm" role="group" aria-label="Confirm tactical movement"><p>The highlighted server path costs {preview.pathCostFeet} feet.</p><button type="button" className="primary" disabled={readOnly || state !== "ready"} onClick={() => void confirm()}>Confirm move</button><button type="button" className="ghost" disabled={readOnly || state !== "ready"} onClick={() => { setPreview(null); setSnapshot({ ...preview, projection: { ...preview.projection, authoritativePath: null } }); setNotice("Move preview cancelled. No command was issued."); }}>Cancel preview</button></div>}
      <p role="status" aria-label="Map selection">{selection || "Select a token to inspect it, or an empty visible cell to preview movement."}</p>
      <details className="tactical-movement-details"><summary>Movement allowance and map revisions</summary><p>Map revision {snapshot.mapRevision}; token revision {snapshot.tokenRevision}. {snapshot.movement ? `${snapshot.movement.budgetFeet} feet available by ${snapshot.movement.policy}.` : "Movement unavailable."}</p>
        <p>{snapshot.controlledTokenId ? `Selected token: ${snapshot.projection.tokens.find((token) => token.tokenId === snapshot.controlledTokenId)?.label ?? "Controlled actor"}.` : "No controlled token on this map. Select a participating actor with a placed token."} {!readOnly && snapshot.movement ? "Choose a destination, review the server path, then confirm. Dragging pans the map; it does not move tokens." : mode === "combat" ? "Movement requires an eligible combatant and an available turn budget. Refresh after the turn changes." : "Inspect the map without issuing movement."}</p>
      </details></>}
    <p className="tactical-map-notice" role="status">{commandsBlocked ? "Refreshing world or combat binding; map commands are locked." : notice || (state === "loading" ? "Loading tactical map..." : "Server-owned movement and visibility.")}</p>
    {accessReadOnly && <p>Read-only map: inspect cells and tokens. Movement and generation are unavailable with your current access.</p>}
    {onRefreshLocation && <button type="button" className="ghost" disabled={commandsBlocked || state === "moving" || state === "previewing"} onClick={onRefreshLocation}>Refresh world location</button>}
    <button type="button" className="ghost" disabled={["loading", "moving", "previewing"].includes(state)} onClick={() => void refresh(true)}>Refresh tactical map</button>
    {state === "missing" && mode === "combat" && !combatantId && <p>A combat map must be prepared with verified actor-to-combatant bindings. Use combat controls; the current turn does not identify your actor.</p>}
    {["missing", "mismatch"].includes(state) && audience !== "gm" && <p>Your GM can prepare a map for this room. Refresh after it is ready.</p>}
    {["missing", "mismatch"].includes(state) && audience === "gm" && !accessReadOnly && <details open className="tactical-map-setup"><summary>{state === "mismatch" ? "Review replacement map" : "Prepare a map"}</summary><fieldset disabled={commandsBlocked || locationRefreshRequired || (state === "mismatch" && !location)}><legend>Generate deterministic map</legend><label>Layout<select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setReplaceReviewed(false); }}><option value="arena">Arena</option><option value="dungeon">Dungeon</option><option value="cave">Cave</option><option value="underwater">Underwater</option></select></label><label>Exact seed<input value={seed} maxLength={256} onChange={(event) => { setSeed(event.target.value); setReplaceReviewed(false); }} /></label>
      {location ? <p>World-grounded v2: the server reserves walkable terrain for the reviewed token footprints. All placed actors must share this location. At most 64 tokens.</p> : <p>No exact actor location is available. This uses an ungrounded legacy layout; refresh world location before preparing a location-bound map.</p>}
      {mode === "combat" && encounterId && <CombatSpawnReview campaignId={campaignId} sessionId={sessionId} encounterId={encounterId} actorId={actorId} combatantId={combatantId} readRoster={readRoster} onReview={reviewSpawns} grounded={Boolean(location)} />}
      <p>An unavailable actor projection does not prove that no map exists. Generation replaces any active map for this room and mode. Existing token placements will not be retained.</p>
      <label><input type="checkbox" checked={replaceReviewed} onChange={(event) => setReplaceReviewed(event.target.checked)} />I authorize creating or replacing this room's map with the reviewed layout and tokens.</label>
      <button type="button" className="primary" disabled={readOnly || locationRefreshRequired || !seed || !replaceReviewed || (state === "mismatch" && !location) || (mode === "combat" && (!encounterId || !combatantId || !spawnReview || (Boolean(location) && spawnReview.tokens.length > 64)))} onClick={() => void generate()}>Generate tactical map</button></fieldset></details>}
  </section>;
}
