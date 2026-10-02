import { useContext, useId, useMemo, useState, type ReactNode } from "react";
import { gameplaySheetEntries, MAX_SHEET_REFERENCES, sheetReferenceKey, sheetSectionLabels, type ActorGameplaySheetResponse, type SheetContextEntry, type SheetReferenceSection } from "@velvet/contracts";
import { AtlasDrawerSideControl, DrawerModalContext, type AtlasDrawerSide } from "./PlaySurface";
import "./sheetContext.css";

export interface GameplaySheetDrawerProps {
  sheet: ActorGameplaySheetResponse;
  canReference: boolean;
  selectedKeys?: ReadonlySet<string>;
  onClose: () => void;
  onReference: (entry: SheetContextEntry) => void;
  onCompose?: () => void;
  onRefresh?: () => void;
  actions?: ReactNode;
  notice?: string;
  closeButtonRef?: React.RefObject<HTMLButtonElement>;
  side?: AtlasDrawerSide;
  onSideChange?: (side: AtlasDrawerSide) => void;
}

/** Every meaningful sheet entry is a native toggle; selecting references never edits the player's words. */
export function GameplaySheetDrawer({ sheet, canReference, selectedKeys = new Set(), onClose, onReference, onCompose, onRefresh,
  closeButtonRef, side = "right", onSideChange, actions, notice }: GameplaySheetDrawerProps) {
  const id = useId();
  const modal = useContext(DrawerModalContext);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const entries = useMemo(() => gameplaySheetEntries(sheet), [sheet]);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = entries.filter((entry) => terms.every((term) => `${sheetSectionLabels[entry.reference.section]} ${entry.label} ${entry.value}`.toLocaleLowerCase().includes(term)));
  const atLimit = selectedKeys.size >= MAX_SHEET_REFERENCES;
  const sections = Object.keys(sheetSectionLabels) as SheetReferenceSection[];
  function toggle(entry: SheetContextEntry) {
    const selected = selectedKeys.has(sheetReferenceKey(entry.reference));
    if (!canReference || (!selected && atLimit)) return;
    onReference(entry);
    setAnnouncement(`${entry.label} ${selected ? "removed from" : "added to"} your action context.`);
  }
  function cards(section: SheetReferenceSection) {
    const items = matches.filter((entry) => entry.reference.section === section);
    return items.length ? <ul className="sheet-reference-grid">{items.map((entry) => {
      const key = sheetReferenceKey(entry.reference), selected = selectedKeys.has(key);
      const duplicates = entries.filter((other) => other.reference.section === section && other.label === entry.label);
      const label = duplicates.length > 1 ? `${entry.label} (${duplicates.indexOf(entry) + 1})` : entry.label;
      const descriptionId = `${id}-entry-${entries.indexOf(entry)}`;
      return <li key={key}><button type="button" className="sheet-reference" aria-label={`Reference ${label}`} aria-describedby={descriptionId} aria-pressed={selected}
        disabled={!canReference || (atLimit && !selected)} onClick={() => toggle(entry)}>
        <span className="sheet-reference-copy"><strong>{label}</strong><span id={descriptionId}>{entry.value}</span></span>
        <span className="sheet-reference-mark" aria-hidden="true">{selected ? "✓ Added" : "+ Add"}</span>
      </button></li>;
    })}</ul> : <p className="gameplay-sheet-empty">{query ? "No matching entries." : "Nothing listed yet."}</p>;
  }
  return <aside className="gameplay-sheet-drawer sheet-context-drawer" role="dialog" aria-modal={modal} aria-labelledby={`${id}-title`} tabIndex={-1}>
    <header><div><p className="eyebrow">YOUR CHARACTER · LEVEL {sheet.progression.level}</p><h2 id={`${id}-title`}>{sheet.identity.name}&apos;s character sheet</h2></div>
      <div className="atlas-drawer-controls"><AtlasDrawerSideControl tool="character" side={side} onSideChange={onSideChange} />
        <button ref={closeButtonRef} type="button" aria-label="Close character sheet" onClick={onClose}>Close</button></div></header>
    {actions}
    <div className="sheet-context-intro"><p>Select any entry to give the DM precise context alongside your words. Choose several, then return to your draft.</p>
      <p className="sheet-context-note">References are shared with your declaration. Selecting one never rolls, casts, or spends anything—even an unavailable spell can be discussed.</p>
      {!canReference && <p role="status">References are available when play is ready and your character is selected.</p>}
    </div>
    <div className="sheet-context-filters"><label htmlFor={`${id}-search`}>Find in character sheet</label><div className="sheet-search-row"><input id={`${id}-search`} type="search" placeholder="Try rope, Strength, spell, or health…" value={query} onChange={(event) => setQuery(event.target.value)} />
      {query && <button type="button" onClick={() => { setQuery(""); document.getElementById(`${id}-search`)?.focus(); }}>Clear search</button>}</div>
      <label className="sheet-jump">Jump to section<select value="" onChange={(event) => { const target = document.getElementById(`${id}-${event.target.value}`); if (target) { target.scrollIntoView?.({ block: "start" }); target.focus({ preventScroll: true }); } }}><option value="">Choose a section…</option>{sections.filter((section) => section !== "calculations" && (!query || matches.some((entry) => entry.reference.section === section))).map((section) => <option key={section} value={section}>{sheetSectionLabels[section]}</option>)}</select></label>
      <p className="sheet-context-note" role="status">{query ? `${matches.length} matching entries` : `${entries.length} referenceable entries`}</p>
    </div>
    <div className="sheet-context-sections">{sections.filter((section) => section !== "calculations" && (!query || matches.some((entry) => entry.reference.section === section))).map((section) => <section key={section} aria-labelledby={`${id}-${section}`}>
      <h3 tabIndex={-1} id={`${id}-${section}`}>{sheetSectionLabels[section]} <span>{matches.filter((entry) => entry.reference.section === section).length}</span></h3>{cards(section)}
    </section>)}
      {(!query || matches.some((entry) => entry.reference.section === "calculations")) && <details className="sheet-calculations" open={query ? true : undefined}><summary>How stats were calculated</summary>{cards("calculations")}</details>}
      {matches.length === 0 && <p className="sheet-no-results">No entries match “{query}”. Try an item name, a statistic, or clear the search.</p>}
    </div>
    <footer className="sheet-context-footer"><div><strong>{selectedKeys.size} / {MAX_SHEET_REFERENCES} references selected</strong><p role="status" aria-atomic="true">{announcement || notice || "Your writing stays exactly as you left it."}</p>{atLimit && <p>Remove a selection to add another.</p>}</div>
      <div className="button-row">{onRefresh && <button type="button" onClick={onRefresh}>Refresh sheet</button>}<button type="button" className="primary" onClick={onCompose ?? onClose}>Back to draft{selectedKeys.size ? ` (${selectedKeys.size})` : ""}</button></div></footer>
  </aside>;
}
