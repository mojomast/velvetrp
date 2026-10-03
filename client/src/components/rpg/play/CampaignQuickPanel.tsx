import { useEffect, useId, useState } from "react";
import { gameplaySheetEntries, MAX_SHEET_REFERENCES, sheetReferenceKey, type ActorGameplaySheetResponse, type CampaignPlayActor, type SheetContextEntry, type SheetReferenceSection } from "@velvet/contracts";

interface CampaignQuickPanelProps {
  campaignId: string;
  selectedActorId: string | null;
  actors: readonly CampaignPlayActor[];
  getSheet: (actorId: string) => Promise<ActorGameplaySheetResponse>;
  refreshKey?: number;
  canOpenSheet?: boolean;
  onOpenSheet: () => void;
  selectedKeys: ReadonlySet<string>;
  onReference: (entry: SheetContextEntry) => void;
  compact?: boolean;
}

/** One actor-bound read supplies friendly names and exact reference identities to the side rail. */
export function CampaignQuickPanel({ campaignId, selectedActorId, actors, getSheet, refreshKey = 0, canOpenSheet = false, onOpenSheet, selectedKeys, onReference, compact = false }: CampaignQuickPanelProps) {
  const id = useId();
  const [sheet, setSheet] = useState<ActorGameplaySheetResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setSheet(null);
    if (!selectedActorId) { setStatus("ready"); return; }
    setStatus("loading");
    void getSheet(selectedActorId).then((value) => {
      if (!current) return;
      if (value.identity.actorId !== selectedActorId) { setStatus("error"); return; }
      setSheet(value); setStatus("ready");
    }, () => { if (current) setStatus("error"); });
    return () => { current = false; };
  }, [campaignId, selectedActorId, getSheet, refreshKey, retry]);
  const entries = sheet && sheet.identity.actorId === selectedActorId ? gameplaySheetEntries(sheet) : [];
  const actor = actors.find((entry) => entry.actorId === selectedActorId);
  function section(kind: SheetReferenceSection, title: string, empty: string) {
    const all = entries.filter((entry) => entry.reference.section === kind && entry.reference.key !== "capacity");
    return <section aria-label={title}><div className="quick-section-heading"><h3>{title}</h3><span>{all.length}</span></div>
      {all.length ? <ul className="quick-reference-list">{all.slice(0, 6).map((entry, index) => {
        const key = sheetReferenceKey(entry.reference), selected = selectedKeys.has(key);
        const description = `${id}-${kind}-${index}`;
        return <li key={key}><button type="button" aria-label={`Reference ${entry.label}`} aria-describedby={description} aria-pressed={selected}
          disabled={!canOpenSheet || (!selected && selectedKeys.size >= MAX_SHEET_REFERENCES)} onClick={() => onReference(entry)}><span><strong>{entry.label}</strong><span id={description}>{entry.value}</span></span><span aria-hidden="true">{selected ? "✓" : "+"}</span></button></li>;
      })}</ul> : <p className="quick-empty">{empty}</p>}
      {all.length > 6 && <button type="button" className="ghost" onClick={onOpenSheet} disabled={!canOpenSheet}>View all {all.length} in sheet</button>}
    </section>;
  }
  return <aside className="campaign-quick-panel" aria-label="Character quick tools" tabIndex={-1}>
    <header><div><p className="eyebrow">YOUR CHARACTER{compact && sheet ? ` · LEVEL ${sheet.progression.level}` : ""}</p><h2>{actor?.name ?? "No character selected"}</h2>{compact && sheet && <p className="quick-character-class">{sheet.classes.map((entry) => entry.label).join(" · ")}</p>}</div></header>
    <div className="quick-sheet-action"><button type="button" className="primary" disabled={!selectedActorId || !canOpenSheet} onClick={onOpenSheet}>Open character sheet</button></div>
    <p className="quick-panel-note">Select a detail to attach it to your next action. Nothing is spent or rolled.</p>
    {status === "loading" && <p role="status">Refreshing character…</p>}
    {status === "error" && <div className="quick-panel-warning"><p role="status">Character summary is unavailable.</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry character summary</button></div>}
    {sheet && <>{section("resources", "Health & resources", "No resource tracks listed.")}{compact ? <details className="quick-more"><summary>Equipment & effects</summary>{section("inventory", "Inventory quick access", "No carried items.")}{section("effects", "Active effects", "No active effects.")}</details> : <>{section("inventory", "Inventory quick access", "No carried items.")}{section("effects", "Active effects", "No active effects.")}</>}</>}
    {(!compact || actors.length > 1) && <section aria-label="Your characters"><div className="quick-section-heading"><h3>Your characters</h3><span>{actors.length}</span></div><ul className="quick-party-list">{actors.map((member) => <li key={member.actorId}>{member.name}<span>{member.actorId === selectedActorId ? "Acting" : "Available"}</span></li>)}</ul></section>}
  </aside>;
}
