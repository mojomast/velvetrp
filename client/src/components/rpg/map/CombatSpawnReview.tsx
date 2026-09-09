import { useEffect, useState } from "react";
import type { TacticalMapGenerationToken } from "@velvet/contracts";
import { readCombatRoster, reviewedSpawns, type CombatRoster, type SpawnReview } from "./combatRoster";
import "./combatSpawnReview.css";

export type CombatRosterReader = typeof readCombatRoster;
export function CombatSpawnReview({ campaignId, sessionId, encounterId, actorId, combatantId, readRoster, onReview, grounded = false }: {
  campaignId: string; sessionId: string; encounterId: string; actorId: string; combatantId: string | null;
  readRoster: CombatRosterReader; onReview: (value: { roster: CombatRoster; tokens: TacticalMapGenerationToken[] } | null) => void;
  grounded?: boolean;
}) {
  const [roster, setRoster] = useState<CombatRoster | null>(null);
  const [review, setReview] = useState<Record<string, SpawnReview>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setRoster(null); setReview({}); setError(""); onReview(null);
    void readRoster(campaignId, sessionId, encounterId, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      const matches = value.combatants.filter((entry) => entry.kind === "actor" && entry.actorId === actorId);
      if (value.encounterId !== encounterId || matches.length !== 1 || matches[0]!.combatantId !== combatantId) throw new Error("Selected actor binding is missing or ambiguous");
      setRoster(value);
    }).catch(() => { if (!controller.signal.aborted) setError("Authoritative roster unavailable, ambiguous, or stale. Refresh combat binding before preparing spawns."); });
    return () => controller.abort();
  }, [campaignId, sessionId, encounterId, actorId, combatantId, readRoster, onReview]);
  if (!roster) return <p role="status">{error || "Loading authoritative encounter roster..."}</p>;
  return <fieldset className="combat-spawn-review" aria-label="Combat roster placement"><legend>Review every combatant spawn</legend>
    <p>12 columns by 10 rows, five feet per cell. Choose each footprint, disposition, and visibility explicitly. The server validates terrain and collision before saving; no local placement is persisted.</p>
    {grounded && <p>World-grounded v2 reserves walkable terrain for every footprint. Keep all footprints inside columns 2-11 and rows 2-9, clear of the outer wall. Maximum 64 tokens.</p>}
    {roster.combatants.map((entry) => {
      const value = review[entry.combatantId] ?? { x: "", y: "", width: "", height: "", visibility: "", disposition: "" };
      const change = (patch: Partial<SpawnReview>) => { const next = { ...review, [entry.combatantId]: { ...value, ...patch } }; setReview(next); const tokens = reviewedSpawns(roster, next, grounded); onReview(tokens ? { roster, tokens } : null); };
      return <fieldset key={entry.combatantId}><legend>{entry.kind === "actor" ? entry.actorId : entry.combatantId} ({entry.team})</legend>
        {(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{field === "x" ? "Column" : field === "y" ? "Row" : field === "width" ? "Footprint width" : "Footprint height"}<input aria-label={`${entry.combatantId} ${field}`} type="number" min={1} max={field === "x" || field === "width" ? 12 : 10} value={value[field]} onChange={(event) => change({ [field]: event.target.value })} /></label>)}
        <label>Visibility<select aria-label={`${entry.combatantId} visibility`} value={value.visibility} onChange={(event) => change({ visibility: event.target.value as SpawnReview["visibility"] })}><option value="">Choose visibility</option><option value="visible">Visible when in sight</option><option value="hidden">Hidden from players</option></select></label>
        <label>Disposition<select aria-label={`${entry.combatantId} disposition`} value={value.disposition} onChange={(event) => change({ disposition: event.target.value as SpawnReview["disposition"] })}><option value="">Choose disposition</option><option value="friendly">Friendly</option><option value="neutral">Neutral</option><option value="hostile">Hostile</option></select></label>
      </fieldset>;
    })}
    {!reviewedSpawns(roster, review, grounded) && <p>Complete every spawn with non-overlapping, in-bounds footprints and explicit visibility and disposition.</p>}
  </fieldset>;
}
