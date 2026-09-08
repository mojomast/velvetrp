import { useCallback, useEffect, useRef, useState } from "react";
import type { TacticalMapGenerateRequest, TacticalMapMode, TacticalMapMoveRequest, TacticalMapMoveResponse, TacticalMapPreviewRequest, TacticalMapPreviewResponse, TacticalMapSnapshot } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { TacticalMapCanvas } from "./TacticalMapCanvas";

export interface TacticalMapPanelApi {
  getTacticalMap: (campaignId: string, sessionId: string, mode: TacticalMapMode, actorId: string) => Promise<TacticalMapSnapshot>;
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
}

const commandKey = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `map-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Canvas declares destinations; only server snapshots and previews can enable a move. */
export function TacticalMapPanel({ campaignId, sessionId, actorId, audience, mode, encounterId, combatantId, api }: Props) {
  const [snapshot, setSnapshot] = useState<TacticalMapSnapshot | null>(null);
  const [preview, setPreview] = useState<TacticalMapPreviewResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "previewing" | "moving" | "ambiguous" | "error">("loading");
  const [notice, setNotice] = useState(""); const [seed, setSeed] = useState("velvet-map"); const [kind, setKind] = useState<"dungeon" | "cave" | "arena">("arena");
  const generation = useRef(0);

  const refresh = useCallback(async (explicit = false) => {
    const request = ++generation.current; setPreview(null); setState("loading"); if (explicit) setNotice("Refreshing authoritative map; no command is being repeated.");
    try { const value = await api.getTacticalMap(campaignId, sessionId, mode, actorId); if (request !== generation.current) return; setSnapshot(value); setState("ready"); if (explicit) setNotice("Authoritative tactical map refreshed."); }
    catch (error) { if (request !== generation.current) return; setSnapshot(null); if (error instanceof ApiError && error.status === 404) { setState("missing"); setNotice("No active tactical map exists for this room and mode."); } else { setState("error"); setNotice("Tactical map could not be loaded."); } }
  }, [actorId, api, campaignId, mode, sessionId]);

  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]);

  async function select(destination: { x: number; y: number }) {
    if (!snapshot || !["ready", "error"].includes(state)) return; const request = ++generation.current; setPreview(null); setState("previewing"); setNotice("Requesting authoritative path and movement limits...");
    try { const value = await api.previewTacticalMapMove(campaignId, sessionId, mode, { actorId, destination, expectedMapRevision: snapshot.mapRevision, expectedTokenRevision: snapshot.tokenRevision });
      if (request !== generation.current) return; setPreview(value); setSnapshot(value); setState("ready"); setNotice(`Preview: ${value.pathCostFeet} feet. Confirm to issue one move command.`); }
    catch (error) { if (request !== generation.current) return; setState("error"); setNotice(error instanceof ApiError && error.status === 409 ? "That destination is not legal in the latest authoritative state. Refresh or choose another visible cell." : "Path preview failed. No move command was issued."); }
  }

  async function confirm() {
    if (!preview || state !== "ready") return; const request = ++generation.current; setState("moving"); setNotice("Submitting one revision-bound move command...");
    try { const value = await api.moveTacticalMapToken(campaignId, sessionId, mode, { actorId, destination: preview.projection.authoritativePath!.at(-1)!, previewId: preview.previewId,
        expectedMapRevision: preview.mapRevision, expectedTokenRevision: preview.tokenRevision, idempotencyKey: commandKey() });
      if (request !== generation.current) return; setSnapshot(value.snapshot); setPreview(null); setState("ready"); setNotice("Token moved and exploration refreshed from the server."); }
    catch (error) { if (request !== generation.current) return; setState("ambiguous"); setNotice(error instanceof ApiError && error.status === 409
      ? "The preview became stale and no move was accepted. Refresh before choosing again."
      : "The move outcome is uncertain. Refresh authoritative state; this command will not be repeated."); }
  }

  async function generate() {
    if (audience !== "gm" || state === "moving") return; const request = ++generation.current; setState("moving"); setNotice("Creating one deterministic authoritative map...");
    try { await api.generateTacticalMap(campaignId, sessionId, { mode, encounterId: mode === "combat" ? encounterId : null, kind, seed, width: 12, height: 10,
        tokens: [{ tokenId: actorId, actorId, combatantId: mode === "combat" ? combatantId : null, label: "Controlled actor", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false }], idempotencyKey: commandKey() });
      if (request !== generation.current) return; await refresh(true); }
    catch { if (request !== generation.current) return; setState("ambiguous"); setNotice("Map generation outcome is uncertain. Refresh authoritative state; generation will not be repeated."); }
  }

  return <section className="tactical-map-panel" aria-labelledby="tactical-map-heading"><header><div><p className="eyebrow">LOCAL TACTICAL SPACE</p><h2 id="tactical-map-heading">Tactical map</h2></div><span>{mode}</span></header>
    <p role="status">{notice || (state === "loading" ? "Loading tactical map..." : "Server-owned movement and visibility.")}</p>
    {snapshot && <><p>Map revision {snapshot.mapRevision}; token revision {snapshot.tokenRevision}. {snapshot.movement ? `${snapshot.movement.budgetFeet} feet available by ${snapshot.movement.policy}.` : "Movement unavailable."}</p>
      <TacticalMapCanvas projection={preview?.projection ?? snapshot.projection} onSelectionChange={(point) => void select(point)} />
      {preview && <div className="tactical-map-confirm" role="group" aria-label="Confirm tactical movement"><p>The highlighted server path costs {preview.pathCostFeet} feet.</p><button type="button" className="primary" disabled={state !== "ready"} onClick={() => void confirm()}>Confirm move</button><button type="button" className="ghost" disabled={state !== "ready"} onClick={() => { setPreview(null); setSnapshot({ ...preview, projection: { ...preview.projection, authoritativePath: null } }); setNotice("Move preview cancelled. No command was issued."); }}>Cancel preview</button></div>}</>}
    {(state === "ambiguous" || state === "error") && <button type="button" className="ghost" onClick={() => void refresh(true)}>Refresh tactical map</button>}
    {state === "missing" && audience === "gm" && <fieldset><legend>Generate deterministic map</legend><label>Layout<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="arena">Arena</option><option value="dungeon">Dungeon</option><option value="cave">Cave</option></select></label><label>Exact seed<input value={seed} maxLength={256} onChange={(event) => setSeed(event.target.value)} /></label><button type="button" className="primary" disabled={!seed || (mode === "combat" && (!encounterId || !combatantId))} onClick={() => void generate()}>Generate tactical map</button></fieldset>}
  </section>;
}
