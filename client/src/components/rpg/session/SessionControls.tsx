import { useEffect, useRef, useState } from "react";
import { restHttpRequestSchema, resourceIdSchema, idempotencyKeySchema } from "@velvet/contracts";
import type { CampaignPlayBootstrap, EncounterPublic, RestHttpRequest } from "@velvet/contracts";
import { ApiError, ApiInputError, commandActorRest, endCombat, getCombatCommandResult, startEncounter } from "../../../api";
import type { CampaignPlayApi } from "../play/CampaignPlayPage";
import "./sessionControls.css";
import { createClientId } from "../../../utils/clientId";

export interface SessionCommandApi {
  startEncounter?: typeof startEncounter;
  commandActorRest?: typeof commandActorRest;
  endCombat?: typeof endCombat;
  getCombatCommandResult?: typeof getCombatCommandResult;
}
type Review = { target: string; label: string; revision: number } & ({ kind: "start" } | { kind: "end" } | { kind: "rest"; type: RestHttpRequest["type"] });
type Pending = { review: Review; idempotencyKey: string; confirmed: boolean };
const storageKey = (campaignId: string, sessionId: string) => `velvet.session-controls.v1:${campaignId}:${sessionId}`;

/** Start/rest recovery reuses the persisted exact request; completion recovery is read-only. */
export function SessionControls({ bootstrap, api, blocked, onLockChange, onRefresh, onCombat }: {
  bootstrap: CampaignPlayBootstrap; api: CampaignPlayApi; blocked: boolean;
  onLockChange: (locked: boolean) => void; onRefresh: () => Promise<unknown>; onCombat?: () => void;
}) {
  const { campaignId, sessionId } = bootstrap;
  const key = storageKey(campaignId, sessionId);
  const storageInvalid = useRef(false);
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null") as Pending | null;
      if (!value) return null;
      const r = value.review;
      if (!resourceIdSchema.safeParse(r.target).success || !idempotencyKeySchema.safeParse(value.idempotencyKey).success
        || typeof r.label !== "string" || !Number.isInteger(r.revision) || r.revision < 0 || typeof value.confirmed !== "boolean"
        || (r.kind !== "start" && r.kind !== "end" && (r.kind !== "rest" || !restHttpRequestSchema.safeParse({ type: r.type, expectedRevision: r.revision, idempotencyKey: value.idempotencyKey }).success))) throw new Error("Invalid recovery record");
      return value;
    } catch { storageInvalid.current = true; return null; }
  });
  const [encounters, setEncounters] = useState<EncounterPublic[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const reviewRef = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const allowed = (bootstrap.principal.role === "gm" || bootstrap.principal.role === "owner") && bootstrap.session.active;
  const authority = useRef({ allowed, blocked }); authority.current = { allowed, blocked };
  const active = encounters?.filter((e) => e.status === "active") ?? [];
  const actor = bootstrap.playableActors.find((a) => a.actorId === (review?.kind === "rest" ? review.target : ""));
  const locked = storageInvalid.current || busy || pending !== null || review !== null;
  useEffect(() => { onLockChange(allowed && locked); }, [allowed, locked, onLockChange]);
  useEffect(() => { if (review) reviewRef.current?.focus(); }, [review]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setEncounters(null);
    if (allowed) void api.listCampaignEncounters(campaignId).then(({ encounters: rows }) => {
      if (current) setEncounters(rows.filter((e) => e.sessionId === sessionId));
    }).catch(() => { if (current) setNotice("Session readiness could not be loaded. Refresh before running commands."); });
    return () => { current = false; };
  }, [api, campaignId, sessionId, allowed, bootstrap.expectedRevision]);

  function persist(value: Pending | null, expectedKey = value?.idempotencyKey) {
    const existing = localStorage.getItem(key);
    if (existing && (JSON.parse(existing) as Pending).idempotencyKey !== expectedKey) {
      storageInvalid.current = true;
      throw new Error("Another saved operation must be recovered first");
    }
    if (value) {
      const encoded = JSON.stringify(value); localStorage.setItem(key, encoded);
      if (localStorage.getItem(key) !== encoded) throw new Error("Recovery storage unavailable");
    } else localStorage.removeItem(key);
    if (alive.current) setPending(value);
  }
  async function refresh() {
    const { encounters: rows } = await api.listCampaignEncounters(campaignId);
    await onRefresh();
    if (alive.current) setEncounters(rows.filter((e) => e.sessionId === sessionId));
    return rows.filter((e) => e.sessionId === sessionId);
  }
  async function prepare(kind: "start" | "end" | RestHttpRequest["type"], target: string, label: string) {
    if (!allowed || blocked || locked || busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      const latest = await api.getCampaignPlayBootstrap(campaignId, sessionId);
      const rows = (await api.listCampaignEncounters(campaignId)).encounters.filter((e) => e.sessionId === sessionId);
      if (!alive.current || !authority.current.allowed || authority.current.blocked) return;
      if (latest.campaignId !== campaignId || latest.sessionId !== sessionId || !latest.session.active || !["gm", "owner"].includes(latest.principal.role)) throw new Error("Permission changed");
      setEncounters(rows);
      if (kind === "start") {
        const encounter = rows.find((e) => e.encounterId === target && e.status === "preparing" && e.combatId === null);
        if (!encounter || rows.some((e) => e.status === "active")) throw new Error("Encounter not ready");
        setReview({ kind: "start", target, label: encounter.name, revision: encounter.revision });
      } else if (kind === "end") {
        const encounter = rows.find((e) => e.combatId === target && e.status === "active");
        if (!encounter || rows.filter((e) => e.status === "active").length !== 1) throw new Error("Ambiguous encounter");
        const combat = await api.getCombatState(target);
        if (combat.revision === undefined) throw new Error("Missing combat revision");
        if (alive.current && authority.current.allowed && !authority.current.blocked) setReview({ kind: "end", target, label: encounter.name, revision: combat.revision });
      } else {
        if (rows.some((e) => e.status === "active") || !latest.playableActors.some((a) => a.actorId === target)) throw new Error("Actor not eligible");
        const resources = await api.getActorResources(campaignId, target);
        if (alive.current && authority.current.allowed && !authority.current.blocked) setReview({ kind: "rest", target, label, revision: resources.revision, type: kind });
      }
    } catch { if (alive.current) setNotice("Readiness or permission changed. No command was sent; refresh and review again."); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function execute(recover = false) {
    if (!allowed || blocked || storageInvalid.current || busyRef.current || (!recover && (!review || pending))) return;
    const operation = recover ? pending : review ? { review, idempotencyKey: createClientId(), confirmed: false } : null;
    if (!operation) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      // Persist before dispatch. Neither failed reads nor a remount may mint a replacement key.
      persist(operation);
      const r = operation.review;
      const request = { expectedRevision: r.revision, idempotencyKey: operation.idempotencyKey };
      if (!operation.confirmed) {
        if (r.kind === "start") {
          const response = await (api.startEncounter ?? startEncounter)(r.target, request);
          if (response.combat.combatId !== r.target || response.receipt.idempotencyKey !== request.idempotencyKey || response.receipt.revisionBefore !== r.revision
            || response.receipt.revisionAfter !== r.revision + 1 || response.combat.revision !== response.receipt.revisionAfter) throw new Error("Unbound receipt");
        } else if (r.kind === "end") {
          const result = recover ? await (api.getCombatCommandResult ?? getCombatCommandResult)(campaignId, r.target, operation.idempotencyKey) : null;
          if (recover && result?.operation !== "end") throw new Error("Missing or wrong operation");
          const response = result?.operation === "end" ? result.result : await (api.endCombat ?? endCombat)(r.target, request);
          if (response.encounter.sessionId !== sessionId || response.encounter.encounterId !== r.target || response.encounter.combatId !== r.target
            || response.encounter.status !== "completed" || response.receipt.idempotencyKey !== request.idempotencyKey || response.receipt.revisionBefore !== r.revision
            || response.receipt.revisionAfter !== r.revision + 1 || response.encounter.revision !== response.receipt.revisionAfter) throw new Error("Unbound receipt");
        } else {
          if (!bootstrap.playableActors.some((a) => a.actorId === r.target)) throw new Error("Actor control unavailable");
          const response = await (api.commandActorRest ?? commandActorRest)(campaignId, r.target, { ...request, type: r.type });
          if (response.receipt.idempotencyKey !== request.idempotencyKey || response.receipt.revisionBefore !== r.revision
            || response.receipt.revisionAfter !== r.revision + 1 || response.actorState.revision !== response.receipt.revisionAfter
            || response.receipt.kind !== (r.type === "take_short_rest" ? "short" : "long")) throw new Error("Unbound receipt");
        }
        operation.confirmed = true; persist(operation);
      }
      if (operation.review.kind === "rest") {
        const resources = await api.getActorResources(campaignId, operation.review.target);
        if (resources.revision < operation.review.revision + 1) throw new Error("Stale resources after receipt");
      }
      const rows = await refresh();
      if (operation.review.kind !== "rest" && !rows.some((e) => e.encounterId === operation.review.target && e.combatId === operation.review.target
        && e.revision >= operation.review.revision + 1 && (operation.review.kind === "end" ? e.status === "completed" : e.status !== "preparing"))) throw new Error("Stale encounter after receipt");
      persist(null, operation.idempotencyKey);
      if (alive.current) { setReview(null); setNotice(operation.review.kind === "start" ? "Encounter start confirmed. Session and map context refreshed; run turns in Combat." : operation.review.kind === "end" ? "Encounter completion confirmed. Review and claim rewards in Combat; nothing was claimed automatically." : "Rest confirmed by the server. Character resources refreshed."); }
    } catch (error) {
      const rejected = !recover && !operation.confirmed && (error instanceof ApiInputError || (error instanceof ApiError
        && ["RPG_COMBAT_STALE", "RPG_ENCOUNTER_STALE", "RPG_ACTOR_REST_STALE", "RPG_ACTOR_REST_CONFLICT"].includes(error.code ?? "")));
      if (rejected) {
        try { persist(null, operation.idempotencyKey); } catch { /* Keep the persisted exact operation if storage cannot be cleared. */ }
        if (alive.current) { setReview(null); setEncounters(null); setNotice("Server rejected the command without committing. Refresh session readiness and review again."); }
        return;
      }
      if (alive.current) setNotice(operation.confirmed ? "Command confirmed, but refresh failed. Refresh confirmed operation; do not submit again." : "Outcome uncertain or rejected. Keep this exact operation for recovery; no new command key will be created.");
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  if (!allowed) return null;
  return <section className="session-controls" aria-labelledby="session-controls-heading">
    <header><div><p className="eyebrow">DM SESSION</p><h2 id="session-controls-heading">Run this scene</h2></div><button type="button" disabled={busy || !!review || !!pending} onClick={() => void refresh().catch(() => setNotice("Session refresh failed."))}>Refresh session readiness</button></header>
    <ol aria-label="Session lifecycle"><li>Exploration</li><li aria-current={active.length ? "step" : undefined}>Encounter</li><li>Resolution</li><li>Recovery</li></ol>
    {blocked && <p>Finish the adventure turn, approval, or reconciliation before using session controls.</p>}
    {storageInvalid.current && <p role="alert">Recovery storage is unreadable. Commands are locked to avoid duplicating an unknown operation. Restore the saved recovery record before continuing.</p>}
    {!encounters ? <p>Encounter readiness unavailable or loading.</p> : <>
      <div className="session-control-grid"><section><h3>{active.length ? "Encounter in progress" : "Exploration and preparation"}</h3>
        {active.length > 1 && <p role="alert">Multiple active encounters: inline completion is locked. Resolve encounter identity in Combat.</p>}
        {encounters.filter((e) => e.status !== "completed").map((e) => <p key={e.encounterId}><strong>{e.name}</strong>: {e.status}{e.status === "preparing" && e.combatId === null && <button type="button" disabled={blocked || locked || active.length > 0} onClick={() => void prepare("start", e.encounterId, e.name)}>Review start of {e.name}</button>}{e.status === "active" && e.combatId && <button type="button" disabled={blocked || locked || active.length !== 1} onClick={() => void prepare("end", e.combatId!, e.name)}>Review completion of {e.name}</button>}</p>)}
        {!encounters.length && <p>No encounters prepared for this room.</p>}
        <button type="button" disabled={!onCombat || blocked || locked} onClick={onCombat}>Prepare / run encounter in Combat</button><p>Create encounters, run turns, and choose attacks in the Combat workspace. Start a prepared encounter here after review.</p>
      </section><section><h3>Resolution</h3><p>{encounters.filter((e) => e.status === "completed").map((e) => e.name).join(", ") || "No completed encounters in this room."}</p><button type="button" disabled={!onCombat || blocked || locked} onClick={onCombat}>Review / claim rewards in Combat</button><p>Choose the completed encounter and recipient there. Completion does not claim rewards.</p></section>
      <section><h3>Camp and recovery</h3><p>Rest each controlled character explicitly. No camp, time advance, or AI narration is created.</p>{bootstrap.playableActors.map((a) => <div key={a.actorId}><strong>{a.name}</strong><div className="button-row"><button type="button" disabled={blocked || locked || active.length > 0} onClick={() => void prepare("take_short_rest", a.actorId, a.name)}>Short rest for {a.name}</button><button type="button" disabled={blocked || locked || active.length > 0} onClick={() => void prepare("take_long_rest", a.actorId, a.name)}>Long rest for {a.name}</button></div></div>)}{!bootstrap.playableActors.length && <p>No server-controlled characters available.</p>}{active.length > 0 && <p>Complete the encounter before recovery.</p>}</section></div>
    </>}
    {review && !pending && <section ref={reviewRef} tabIndex={-1} className="session-review" aria-label="Review session operation"><h3>{review.kind === "start" ? `Start ${review.label}?` : review.kind === "end" ? `Complete ${review.label}?` : `${review.type === "take_short_rest" ? "Short" : "Long"} rest for ${actor?.name ?? review.label}?`}</h3><p>Reviewed server revision {review.revision}. {review.kind === "start" ? "Activates the prepared combatants in this room. No attacks or narration are requested." : review.kind === "end" ? "Ends this encounter and makes reward bundles available for separate claims." : "The server determines legal recovery. This affects only this character, not the whole party."}</p><button type="button" disabled={busy || blocked} onClick={() => void execute()}>Confirm {review.kind === "start" ? "encounter start" : review.kind === "end" ? "encounter completion" : "rest"}</button><button type="button" disabled={busy} onClick={() => setReview(null)}>Cancel review</button></section>}
    {pending && <div className="session-review"><p>{pending.review.label}: {pending.confirmed ? "Receipt confirmed; reads still required." : "Exact operation retained across reloads. Completion recovery reads its receipt; start/rest recovery resends only the identical idempotent request."}</p><button type="button" disabled={busy || blocked} onClick={() => void execute(true)}>{pending.confirmed ? "Refresh confirmed operation" : "Recover exact operation"}</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
