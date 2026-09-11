import type { CombatEndCommandResponse, CombatReadResponse, EncounterCreateRequest, EncounterPublic, EncounterSetupCandidatesResponse, GenerationDraftGetResponse } from "@velvet/contracts";
import { useEffect, useRef, useState } from "react";
import { applyEncounterGenerationDraft, createCampaignEncounter, createEncounterGenerationDraft, getEncounterSetupCandidates } from "../../../api";
import { createClientId } from "../../../utils/clientId";

export interface EncounterLifecycleApi {
  listEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
  getSetupCandidates?: (campaignId: string) => Promise<EncounterSetupCandidatesResponse>;
  createEncounter?: (campaignId: string, input: EncounterCreateRequest) => Promise<EncounterPublic>;
  startEncounter: (encounterId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<{ combat: CombatReadResponse & { combatId: string } }>;
  endCombat: (combatId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<CombatEndCommandResponse>;
}

type Pending = { campaignId: string; encounterId: string; combatId: string | null; operation: "start" | "end"; startedAt: string }
  | { campaignId: string; operation: "create"; request: EncounterCreateRequest; startedAt: string };
const key = (campaignId: string) => `velvet.encounter-lifecycle.v1:${campaignId}`;
const commandId = () => `encounter-ui-${createClientId()}`;
const enemyKey = (enemy: EncounterSetupCandidatesResponse["enemies"][number]) => `${enemy.template.packId}\u0000${enemy.template.packVersion}\u0000${enemy.template.definitionId}`;
const matchesCreatedEncounter = (encounter: EncounterPublic, request: EncounterCreateRequest) => encounter.sessionId === request.sessionId
  && encounter.name === request.name && encounter.status === "preparing" && encounter.combatId === null
  && JSON.stringify(encounter.combatants.map((entry) => entry.kind === "actor" ? { kind: entry.kind, actorId: entry.actorId, team: entry.team } : { kind: entry.kind, template: entry.template, team: entry.team }))
    === JSON.stringify(request.combatants);
const readPending = (campaignId: string): Pending | null => {
  try { const value = JSON.parse(localStorage.getItem(key(campaignId)) ?? "null") as (Partial<Pending> & { encounterId?: unknown }) | null; return value?.campaignId === campaignId && typeof value.startedAt === "string" && ((typeof value.encounterId === "string" && (value.operation === "start" || value.operation === "end")) || (value.operation === "create" && value.request !== undefined)) ? value as Pending : null; } catch { return null; }
};
const writePending = (campaignId: string, value: Pending | null) => { try { if (value) localStorage.setItem(key(campaignId), JSON.stringify(value)); else localStorage.removeItem(key(campaignId)); } catch { /* generic reads remain available if storage is unavailable */ } };

export function EncounterLifecyclePanel({ campaignId, api, onCombatReady, onRewards }: { campaignId: string; api: EncounterLifecycleApi; onCombatReady: (combatId: string) => void; onRewards: (response: CombatEndCommandResponse) => void }) {
  const [encounters, setEncounters] = useState<EncounterPublic[]>([]);
  const [candidates, setCandidates] = useState<EncounterSetupCandidatesResponse | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedActorIds, setSelectedActorIds] = useState<string[]>([]);
  const [selectedEnemy, setSelectedEnemy] = useState("");
  const [name, setName] = useState("New encounter");
  const [pending, setPending] = useState<Pending | null>(() => readPending(campaignId));
  const [status, setStatus] = useState("");
  const [brief, setBrief] = useState("");
  const [visibleLocation, setVisibleLocation] = useState("");
  const [tone, setTone] = useState("");
  const [difficulty, setDifficulty] = useState<"easy" | "standard" | "hard">("standard");
  const [exclusions, setExclusions] = useState("");
  const [pinnedEnemies, setPinnedEnemies] = useState<string[]>([]);
  const [draft, setDraft] = useState<GenerationDraftGetResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const mounted = useRef(true);
  const refresh = async (explicit = false) => {
    try {
      const [value, available] = await Promise.all([api.listEncounters(campaignId), (api.getSetupCandidates ?? getEncounterSetupCandidates)(campaignId)]);
      if (!mounted.current) return;
      setEncounters(value.encounters);
      setCandidates(available);
      setSelectedSessionId((current) => available.sessions.some((session) => session.sessionId === current) ? current : available.sessions[0]?.sessionId ?? "");
      setSelectedActorIds((current) => current.filter((actorId) => available.actors.some((actor) => actor.actorId === actorId)));
      setSelectedEnemy((current) => available.enemies.some((enemy) => enemyKey(enemy) === current) ? current : available.enemies[0] ? enemyKey(available.enemies[0]) : "");
      const saved = readPending(campaignId);
      if (saved) {
        const current = "encounterId" in saved ? value.encounters.find((entry) => entry.encounterId === saved.encounterId) : undefined;
        const created = saved.operation === "create" && value.encounters.some((entry) => matchesCreatedEncounter(entry, saved.request));
        if (created || (saved.operation === "start" && current?.status === "active" && current.combatId)
          || (saved.operation === "end" && current?.status === "completed")) {
          writePending(campaignId, null); setPending(null); setStatus(saved.operation === "start" ? "Start confirmed by authoritative encounter state." : "Completion confirmed by authoritative encounter state.");
        } else { setPending(saved); setStatus("A lifecycle command may still be in flight. It will not be replayed; refresh authoritative candidate and encounter state to reconcile."); }
      } else if (explicit) setStatus("Authoritative encounter list refreshed.");
    } catch { if (mounted.current) setStatus("Encounter lifecycle state could not be refreshed."); }
  };
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; // Lifecycle is reset only with its campaign route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);
  const begin = (value: Pending) => { writePending(campaignId, value); setPending(value); };
  async function create() {
    if (pending || !candidates || !selectedSessionId || selectedActorIds.length === 0 || !selectedEnemy || !name.trim()) return;
    let current: EncounterSetupCandidatesResponse;
    try { current = await (api.getSetupCandidates ?? getEncounterSetupCandidates)(campaignId); } catch { if (mounted.current) setStatus("Encounter setup candidates could not be refreshed before creation."); return; }
    const enemy = current.enemies.find((entry) => enemyKey(entry) === selectedEnemy);
    if (!current.sessions.some((session) => session.sessionId === selectedSessionId) || selectedActorIds.some((actorId) => !current.actors.some((actor) => actor.actorId === actorId)) || !enemy) {
      if (mounted.current) { setCandidates(current); setStatus("Selected setup candidates are stale. Choose from the refreshed authorized candidates."); }
      return;
    }
    const request: EncounterCreateRequest = { sessionId: selectedSessionId, name: name.trim(), combatants: [
      ...selectedActorIds.map((actorId) => ({ kind: "actor" as const, actorId, team: current.teams.actor })),
      { kind: "enemy" as const, template: enemy.template, team: current.teams.enemy },
    ], idempotencyKey: commandId() };
    const lock: Pending = { campaignId, operation: "create", request, startedAt: new Date().toISOString() };
    begin(lock); setStatus("Creation submitted once. It will not be replayed automatically.");
    try { const created = await (api.createEncounter ?? createCampaignEncounter)(campaignId, request); if (!mounted.current) return; if (!matchesCreatedEncounter(created, request)) { setStatus("Creation outcome is unresolved. Refresh authoritative candidate and encounter state; no POST will be replayed."); return; } writePending(campaignId, null); setPending(null); setStatus("Preparing encounter created with the selected authorized teams."); void refresh(); }
    catch { if (mounted.current) setStatus("Creation outcome is unresolved. Refresh authoritative candidate and encounter state; no POST will be replayed."); }
  }
  async function start(encounter: EncounterPublic) {
    if (pending || encounter.status !== "preparing") return;
    const lock = { campaignId, encounterId: encounter.encounterId, combatId: null, operation: "start" as const, startedAt: new Date().toISOString() };
    begin(lock); setStatus("Start submitted once. It will not be replayed automatically.");
    try { const result = await api.startEncounter(encounter.encounterId, { expectedRevision: encounter.revision, idempotencyKey: commandId() }); if (!mounted.current) return; writePending(campaignId, null); setPending(null); setStatus("Encounter started with the exact preparing revision."); onCombatReady(result.combat.combatId); void refresh(); }
    catch { if (mounted.current) setStatus("Start outcome is unresolved. Refresh authoritative encounter state; no POST will be replayed."); }
  }
  async function complete(encounter: EncounterPublic) {
    if (pending || encounter.status !== "active" || !encounter.combatId) return;
    setStatus("Reading the authoritative combat revision before one completion command.");
    try {
      const combat = await api.getCombat(encounter.combatId); if (!mounted.current) return;
      const lock = { campaignId, encounterId: encounter.encounterId, combatId: encounter.combatId, operation: "end" as const, startedAt: new Date().toISOString() };
      begin(lock); setStatus("Completion submitted once. It will not be replayed automatically.");
      const result = await api.endCombat(encounter.combatId, { expectedRevision: combat.revision, idempotencyKey: commandId() }); if (!mounted.current) return;
      writePending(campaignId, null); setPending(null); setStatus("Encounter completed. Reward bundles are ready for explicit settlement."); onRewards(result); void refresh();
    }     catch { if (mounted.current) setStatus("Completion outcome is unresolved. Refresh authoritative encounter state; no POST will be replayed."); }
  }
  async function generateDraft() {
    if (generating || !candidates || !selectedSessionId || selectedActorIds.length === 0 || pinnedEnemies.length === 0
      || !brief.trim() || !visibleLocation.trim() || !tone.trim()) return;
    const pinned = pinnedEnemies.flatMap((key) => { const found = candidates.enemies.find((enemy) => enemyKey(enemy) === key); return found ? [found.template] : []; });
    setGenerating(true); setDraft(null); setGenerationStatus("Generating one reviewed draft. It is not replayed automatically.");
    try {
      const response = await createEncounterGenerationDraft({
        campaignId, sessionId: selectedSessionId, brief: brief.trim(), visibleLocation: visibleLocation.trim(), tone: tone.trim(), difficulty,
        partyActorIds: selectedActorIds, pinnedEnemyTemplates: pinned,
        exclusions: exclusions.split(",").map((value) => value.trim()).filter((value) => value.length > 0),
        idempotencyKey: commandId(),
      });
      if (!mounted.current) return;
      setDraft(response); setGenerationStatus("Draft staged for review. Applying it commits one encounter at the named session.");
    } catch { if (mounted.current) setGenerationStatus("Draft generation outcome is unknown. Refresh authoritative state; no retry was made."); }
    finally { if (mounted.current) setGenerating(false); }
  }
  async function applyDraft() {
    if (generating || !draft) return;
    setGenerating(true); setGenerationStatus("Applying the exact reviewed draft once. It is not replayed automatically.");
    try {
      const result = await applyEncounterGenerationDraft(draft.draft.draftId, { expectedRevision: draft.draft.revision, idempotencyKey: commandId() });
      if (!mounted.current) return;
      setDraft(null); setGenerationStatus(`Encounter applied at ${result.application.encounterId}.`); void refresh();
    } catch { if (mounted.current) setGenerationStatus("Apply outcome is unknown. Refresh authoritative state; no retry was made."); }
    finally { if (mounted.current) setGenerating(false); }
  }
  return <section className="combat-panel encounter-lifecycle" aria-labelledby="encounter-lifecycle-heading">
    <div className="combat-panel-heading"><h2 id="encounter-lifecycle-heading">Encounter lifecycle</h2><button type="button" className="ghost" onClick={() => void refresh(true)}>Refresh encounters</button></div>
    <p className="combat-authority-note">Choose only server-authorized sessions, actors, and pinned enemy templates. Teams are fixed by the candidate projection.</p>
    {candidates && <form className="encounter-setup" onSubmit={(event) => { event.preventDefault(); void create(); }}><h3>Prepare encounter</h3>{candidates.sessions.length === 0 || candidates.actors.length === 0 || candidates.enemies.length === 0 ? <p className="combat-empty">No safe encounter setup candidates are available.</p> : <><label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} /></label><label>Session<select value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>{candidates.sessions.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.sessionId}</option>)}</select></label><fieldset><legend>Allies</legend>{candidates.actors.map((actor) => <label key={actor.actorId}><input type="checkbox" checked={selectedActorIds.includes(actor.actorId)} onChange={() => setSelectedActorIds((current) => current.includes(actor.actorId) ? current.filter((id) => id !== actor.actorId) : [...current, actor.actorId])} />{actor.label}</label>)}</fieldset><label>Enemy template<select value={selectedEnemy} onChange={(event) => setSelectedEnemy(event.target.value)}>{candidates.enemies.map((enemy) => <option key={enemyKey(enemy)} value={enemyKey(enemy)}>{enemy.label}</option>)}</select></label><button type="submit" disabled={Boolean(pending) || selectedActorIds.length === 0}>Create preparing encounter</button></>}</form>}
{candidates && candidates.enemies.length > 0 && <section className="encounter-generation" aria-labelledby="encounter-generation-heading"><h3 id="encounter-generation-heading">Generate an encounter draft</h3><p className="field-help">Generation stages strict, reviewable content at the selected session and party. Applying is the only step that commits an encounter; neither step is retried automatically.</p><form className="encounter-generation-form" onSubmit={(event) => { event.preventDefault(); void generateDraft(); }}><label>Brief<textarea required value={brief} maxLength={2000} onChange={(event) => setBrief(event.target.value)} /></label><label>Visible location<input required value={visibleLocation} maxLength={500} onChange={(event) => setVisibleLocation(event.target.value)} /></label><label>Tone<input required value={tone} maxLength={200} onChange={(event) => setTone(event.target.value)} /></label><label>Difficulty<select value={difficulty} onChange={(event) => setDifficulty(event.target.value as typeof difficulty)}><option value="easy">Easy</option><option value="standard">Standard</option><option value="hard">Hard</option></select></label><label>Exclusions (comma separated)<input value={exclusions} maxLength={2000} onChange={(event) => setExclusions(event.target.value)} /></label><fieldset><legend>Pinned enemy templates</legend>{candidates.enemies.map((enemy) => <label className="checkbox" key={enemyKey(enemy)}><input type="checkbox" checked={pinnedEnemies.includes(enemyKey(enemy))} onChange={() => setPinnedEnemies((current) => current.includes(enemyKey(enemy)) ? current.filter((key) => key !== enemyKey(enemy)) : [...current, enemyKey(enemy)])} />{enemy.label}</label>)}</fieldset><button type="submit" disabled={generating || !selectedSessionId || selectedActorIds.length === 0 || pinnedEnemies.length === 0 || !brief.trim() || !visibleLocation.trim() || !tone.trim()}>Generate reviewed draft</button></form>{draft && <div className="encounter-generation-review"><h4>Review draft {draft.draft.draftId} · revision {draft.draft.revision}</h4><dl className="command-detail-list"><div><dt>Name</dt><dd>{draft.encounter.name}</dd></div><div><dt>Enemies</dt><dd>{draft.encounter.enemyCount}</dd></div><div><dt>Terrain</dt><dd>{draft.encounter.terrain}</dd></div><div><dt>Motives</dt><dd>{draft.encounter.motives}</dd></div><div><dt>Reward narrative</dt><dd>{draft.encounter.rewardNarrative}</dd></div></dl>{draft.validationIssues.length > 0 && <ul className="combat-empty">{draft.validationIssues.map((issue, index) => <li key={index}>{issue.severity}: {issue.message}</li>)}</ul>}<div className="button-row"><button type="button" disabled={generating} onClick={() => void applyDraft()}>Apply exact draft</button><button type="button" className="ghost" onClick={() => setDraft(null)}>Discard review</button></div></div>}{generationStatus && <p className="combat-command-status" role="status">{generationStatus}</p>}</section>}
    {pending && <p className="combat-lock is-warning" role="alert">{pending.operation === "create" ? "Creation" : pending.operation === "start" ? "Start" : "Completion"} was issued once at {pending.startedAt}. <button type="button" className="ghost" onClick={() => void refresh(true)}>Reconcile from authoritative reads</button></p>}
    {status && <p className="combat-command-status" role="status">{status}</p>}
    {encounters.length === 0 ? <p className="combat-empty">No authorized encounters are available.</p> : <ul className="encounter-lifecycle-list">{encounters.map((encounter) => <li key={encounter.encounterId}><div><strong>{encounter.name}</strong><span>{encounter.status} · revision {encounter.revision}</span></div>{encounter.status === "preparing" ? <button type="button" disabled={Boolean(pending)} onClick={() => void start(encounter)}>Start encounter</button> : encounter.status === "active" && encounter.combatId ? <div className="button-row"><button type="button" className="ghost" onClick={() => onCombatReady(encounter.combatId!)}>Open combat</button><button type="button" disabled={Boolean(pending)} onClick={() => void complete(encounter)}>Complete encounter</button></div> : <span>Completed</span>}</li>)}</ul>}
  </section>;
}
