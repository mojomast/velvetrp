import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import "./playSurface.css";

export type AtlasTool = "character" | "inventory" | "advancement" | "travel" | "dice" | "context" | "combat" | "gm" | "security" | "create" | "director" | "help";
export const atlasToolLabels: Record<AtlasTool, string> = {
  character: "Character", inventory: "Inventory & equipment", advancement: "Advancement", travel: "Travel", dice: "Dice", context: "Field journal", combat: "Combat & rewards", gm: "GM tools", security: "Rules & safety", create: "Create character", director: "Director", help: "Help",
};

/** The atlas owns geometry, never game state. Drawers overlay the map, not the conversation. */
export function PlaySurface({ headingRef, title, role, phase, actor, tools, activeTool, onTool, onBack, exitDisabled,
  map, conversation, activity, composer, drawers }: {
  headingRef: RefObject<HTMLHeadingElement>; title: string; role: string; phase: string; actor: ReactNode;
  tools: readonly AtlasTool[]; activeTool: AtlasTool | null; onTool: (tool: AtlasTool) => void;
  onBack: () => void; exitDisabled: boolean; map: ReactNode; conversation: ReactNode; activity: ReactNode;
  composer: ReactNode; drawers: ReactNode;
}) {
  const mapRef = useRef<HTMLElement>(null);
  const mapRegionRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const drawerOpen = activeTool !== null;
  useEffect(() => {
    const region = mapRegionRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (region) region.inert = drawerOpen;
  }, [drawerOpen]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const editing = event.target instanceof Element && Boolean(event.target.closest("input,textarea,select,[contenteditable=true]"));
      if (document.querySelector("dialog[open]")) return;
      if (event.key === "?" && !editing && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); onTool("help");
      }
      if (event.key !== "F6") return;
      const drawer = rootRef.current?.querySelector<HTMLElement>(".atlas-drawer-slot:not([hidden]) [role=dialog]");
      // While a drawer overlays the map, the obscured map controls are not a valid region.
      const regions = [drawerOpen ? null : mapRef.current, conversationRef.current, drawer].filter((node): node is HTMLElement => Boolean(node));
      const current = regions.findIndex((node) => node.contains(document.activeElement));
      const next = current < 0 ? (event.shiftKey ? regions.length - 1 : 0) : (current + (event.shiftKey ? regions.length - 1 : 1)) % regions.length;
      event.preventDefault(); regions[next]?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [drawerOpen, onTool]);

  return <main ref={rootRef} className="living-atlas" aria-labelledby="atlas-title">
    <header className="atlas-masthead">
      <button type="button" className="atlas-exit" disabled={exitDisabled} onClick={onBack} aria-label="Back to campaign">Exit table</button>
      <div className="atlas-title"><span className="atlas-kicker">VELVET / LIVING ATLAS</span><h1 id="atlas-title" ref={headingRef} tabIndex={-1}>{title}</h1></div>
      <div className="atlas-session"><span>{role} access from server</span><strong role="status">{phase}</strong></div>
    </header>
    <nav className="atlas-tools" aria-label="In-room tools">{tools.map((tool) => <button type="button" key={tool}
      data-atlas-tool={tool} aria-expanded={activeTool === tool || (tool === "character" && (activeTool === "inventory" || activeTool === "advancement"))} aria-controls={`atlas-${tool === "character" && (activeTool === "inventory" || activeTool === "advancement") ? activeTool : tool}`} onClick={() => onTool(tool)}>{atlasToolLabels[tool]}</button>)}</nav>
    <div className="atlas-table">
      <section className="atlas-stage" aria-label="Living map" ref={mapRef} tabIndex={-1}>
        <div className="atlas-map-region" ref={mapRegionRef}>
          <header className="atlas-scene-heading"><div><span className="atlas-kicker">THE WORLD BEFORE YOU</span><h2>Here be stories.</h2></div>{actor}</header>
          <div className="atlas-map-scroll">{map}</div>
          <div className="atlas-map-caption"><span>Explore. Choose. Leave a trace.</span><span>Only what your character may know.</span></div>
        </div>
        {drawers}
      </section>
      <section className="atlas-conversation-dock" aria-label="Campaign narration and actions" ref={conversationRef} tabIndex={-1}>
        <div className="atlas-conversation-body">{conversation}</div>
        <div className="atlas-activity" aria-label="Turn controls and recovery">{activity}</div>
        <div className="atlas-composer">{composer}</div>
      </section>
    </div>
  </main>;
}

/** Non-modal: the map and composer remain keyboard reachable while a tool is open. */
export function AtlasDrawer({ tool, open, onClose, children }: { tool: AtlasTool; open: boolean; onClose: () => void; children: ReactNode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) headingRef.current?.focus({ preventScroll: true }); }, [open]);
  return <div id={`atlas-${tool}`} className="atlas-drawer-slot" hidden={!open}>
    <aside className="atlas-drawer" role="dialog" aria-modal="false" aria-labelledby={`atlas-${tool}-heading`} tabIndex={-1}>
      <header className="atlas-drawer-heading"><div><span className="atlas-kicker">AT THE TABLE</span><h2 ref={headingRef} tabIndex={-1} id={`atlas-${tool}-heading`}>{atlasToolLabels[tool]}</h2></div>
        <button type="button" onClick={onClose} aria-label={`Close ${atlasToolLabels[tool]}`}>Close</button></header>
      <div className="atlas-drawer-content">{children}</div>
    </aside>
  </div>;
}
