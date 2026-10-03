import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { atlasToolLabels, type AtlasTool } from "./PlaySurface";
import { WorkbenchPreferencesDialog } from "./CommandCenter";
import type { CampaignWorkbenchPreferences } from "./campaignWorkbenchPreferences";
import "./adventureTable.css";

export type AdventureTableView = "story" | "map";
type Props = {
  headingRef: RefObject<HTMLHeadingElement>;
  campaignName: string;
  scene: { label: string; description?: string } | null;
  role: string;
  status: string;
  view: AdventureTableView;
  onView: (view: AdventureTableView) => void;
  tools: readonly AtlasTool[];
  activeTool: AtlasTool | null;
  onTool: (tool: AtlasTool) => void;
  onBack: () => void;
  exitDisabled: boolean;
  story: ReactNode;
  map: ReactNode;
  composer: ReactNode;
  notices: ReactNode;
  character: ReactNode;
  illustration: ReactNode;
  tableControls: ReactNode;
  campaignNav: ReactNode;
  preferences: CampaignWorkbenchPreferences;
  onPreferences: (preferences: CampaignWorkbenchPreferences) => void;
};

/** Labelled line icons: meaning always comes from adjacent text. */
export function TableIcon({ name }: { name: "story" | "map" | "character" | "context" | "dice" | "tools" | "arrow" }) {
  const paths = {
    story: "M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15",
    map: "m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16",
    character: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2",
    context: "M5 3h14v18H5V3Zm4 5h6m-6 4h6m-6 4h4",
    dice: "m12 2 10 6v8l-10 6L2 16V8l10-6Zm0 0 5 13H7L12 2ZM2 8l5 7 5 7 5-7 5-7M2 16l5-1m10 0 5 1",
    tools: "M5 5h.01M12 5h.01M19 5h.01M5 12h.01M12 12h.01M19 12h.01M5 19h.01M12 19h.01M19 19h.01",
    arrow: "M5 12h14m-6-6 6 6-6 6",
  };
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={name === "tools" ? 3 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

/** One story/map viewport and one composer, kept mounted across every tool visit. */
export function AdventureTable({ headingRef, campaignName, scene, role, status, view, onView, tools, activeTool, onTool, onBack, exitDisabled,
  story, map, composer, notices, character, illustration, tableControls, campaignNav, preferences, onPreferences }: Props) {
  const menuRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const displayRef = useRef<HTMLDialogElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const companionRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const primaryTools = ["character", "context", "dice"] as const;
  const secondaryTools = tools.filter((tool) => !primaryTools.some((primary) => primary === tool));

  function fromMenu(tool: AtlasTool) {
    menuRef.current?.close();
    // Restore a visible origin before opening a drawer; its menu item is now hidden.
    menuButtonRef.current?.focus();
    onTool(tool);
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (activeTool || document.querySelector("dialog[open]")) return;
      const editing = event.target instanceof Element && Boolean(event.target.closest("input,textarea,select,[contenteditable=true]"));
      if (event.key === "?" && !editing && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); onTool("help"); }
      if (event.key !== "F6") return;
      const panes = [view === "story" ? storyRef.current : mapRef.current, composerRef.current, companionRef.current]
        .filter((pane): pane is HTMLElement => Boolean(pane && pane.getClientRects().length));
      if (!panes.length) return;
      event.preventDefault();
      const index = panes.findIndex((pane) => pane === document.activeElement || pane.contains(document.activeElement));
      const next = index < 0 ? (event.shiftKey ? panes.length - 1 : 0) : (index + (event.shiftKey ? panes.length - 1 : 1)) % panes.length;
      panes[next]?.focus();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [activeTool, onTool, view]);

  return <main className="adventure-table" data-adventure-table="true">
    <a className="table-skip" href="#table-action" onClick={(event) => { event.preventDefault(); composerRef.current?.focus(); composerRef.current?.scrollIntoView({ block: "nearest" }); }}>Skip to your action</a>
    <header className="table-header">
      <button type="button" className="table-brand" onClick={onBack} disabled={exitDisabled} aria-label="Back to campaign"><span className="table-monogram" aria-hidden="true">V</span><span>VELVET<small>Back to campaign</small></span></button>
      <div className="table-campaign"><span className="table-eyebrow">ADVENTURE TABLE</span><h1 ref={headingRef} tabIndex={-1}>{campaignName}</h1></div>
      <span className="table-role">{role}</span>
      <button ref={menuButtonRef} type="button" className="table-menu-button" aria-haspopup="dialog" onClick={() => menuRef.current?.showModal()}><TableIcon name="tools" />Table tools</button>
    </header>
    <div className="table-layout">
      <section className="table-stage" aria-label="Adventure room">
        <nav className="table-navigation" aria-label="Play tools">
          <div ref={tabsRef} className="table-view-tabs" role="tablist" aria-label="Adventure view" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "story" : event.key === "End" ? "map" : view === "story" ? "map" : "story";
            onView(next); tabsRef.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
          }}>{(["story", "map"] as const).map((mode) => <button type="button" role="tab" data-view={mode} id={`table-${mode}-tab`} key={mode}
            aria-selected={view === mode} aria-controls={`table-${mode}`} tabIndex={view === mode ? 0 : -1} onClick={() => onView(mode)}><TableIcon name={mode} />{mode === "story" ? "Story" : "Map"}</button>)}</div>
          <div className="table-primary-tools">{primaryTools.filter((tool) => tools.includes(tool)).map((tool) => <button type="button" key={tool} data-atlas-tool={tool}
            aria-label={atlasToolLabels[tool]} aria-expanded={activeTool === tool} aria-controls={`atlas-${tool}`} aria-haspopup="dialog" onClick={() => onTool(tool)}><TableIcon name={tool} /><span>{tool === "context" ? "Journal" : atlasToolLabels[tool]}</span></button>)}</div>
        </nav>
        <div className="table-notices">{notices}</div>
        <section ref={storyRef} id="table-story" className="table-story" role="tabpanel" aria-labelledby="table-story-tab" tabIndex={0} hidden={view !== "story"}>
          <div className="table-scene-heading"><div><p className="table-eyebrow">YOUR STORY, ONE CHOICE AT A TIME</p><h2>{scene?.label ?? "Your next chapter"}</h2></div><span className="table-scene-seal" aria-hidden="true">✧</span></div>
          {story}
        </section>
        <section ref={mapRef} id="table-map" className="table-map" role="tabpanel" aria-labelledby="table-map-tab" tabIndex={0} hidden={view !== "map"}>{map}</section>
        <div ref={composerRef} className="table-action" id="table-action" tabIndex={-1}><div className="table-action-status" role="status"><span aria-hidden="true" className="table-status-dot" />{status}</div>{composer}</div>
      </section>
      <aside ref={companionRef} className="table-companion" tabIndex={-1} aria-label="Your adventure companion">
        <div className="table-location-card"><div className="table-compass" aria-hidden="true"><span>N</span>✧</div><p className="table-eyebrow">AT THIS MOMENT</p><h2>{scene?.label ?? "The adventure awaits"}</h2>
          {scene?.description ? <p className="table-location-description">{scene.description}</p> : <p>Follow the story. Explore your surroundings. Choose what happens next.</p>}
          <button type="button" onClick={() => { onView("map"); requestAnimationFrame(() => mapRef.current?.focus()); }}>Explore the map <TableIcon name="arrow" /></button>
        </div>
        {illustration}
        {character}
        <button type="button" className="table-guide-link" data-atlas-tool="help" onClick={() => onTool("help")}><span>New to the table?<strong>Open the player’s guide</strong></span><span aria-hidden="true">↗</span></button>
      </aside>
    </div>
    <dialog ref={menuRef} className="table-dialog" aria-labelledby="table-tools-heading"><header><div><p className="table-eyebrow">AT YOUR TABLE</p><h2 id="table-tools-heading">Table tools</h2></div><button type="button" onClick={() => menuRef.current?.close()} aria-label="Close table tools">Close</button></header>
      <p className="table-dialog-intro">Your story and draft stay here while you explore.</p>
      <nav className="table-tool-grid" aria-label="More play tools">{secondaryTools.map((tool) => <button type="button" key={tool} data-atlas-tool={tool} onClick={() => fromMenu(tool)}>{atlasToolLabels[tool]}<span aria-hidden="true">↗</span></button>)}</nav>
      <div className="table-session-controls">{tableControls}</div>
      <div className="table-menu-footer"><button type="button" onClick={() => { menuRef.current?.close(); menuButtonRef.current?.focus(); displayRef.current?.showModal(); }}>Display</button>{campaignNav}</div>
      <p className="table-keyboard-hint"><kbd>F6</kbd> Move between play areas · <kbd>?</kbd> Player’s guide</p>
    </dialog>
    <WorkbenchPreferencesDialog dialogRef={displayRef} preferences={preferences} onChange={onPreferences} simplified />
  </main>;
}

/** Suggestions are editable intentions, never submitted commands. */
export function FirstTurnGuide({ disabled, onSuggestion, onHelp }: { disabled: boolean; onSuggestion: (text: string) => void; onHelp: () => void }) {
  return <section className="table-first-turn" aria-labelledby="first-turn-heading"><span className="table-first-mark" aria-hidden="true">✦</span><p className="table-eyebrow">MAKE YOUR FIRST MOVE</p><h3 id="first-turn-heading">What will you do?</h3><p>Describe what your character tries. The DM brings the world to life and handles the rules.</p>
    <div className="table-starters" aria-label="First action ideas">{[
      ["Look around", "I take a moment to look around. What stands out?"],
      ["Introduce myself", "I introduce myself to the people here and ask what is happening."],
      ["Find a lead", "I look for a clue about where to go next."],
    ].map(([label, text]) => <button type="button" disabled={disabled} key={label} onClick={() => onSuggestion(text!)}>{label}<span aria-hidden="true">↗</span></button>)}</div>
    <p className="table-starter-hint">Choose an idea to edit, or write your own below. <button type="button" onClick={onHelp}>How to play</button></p>
  </section>;
}
