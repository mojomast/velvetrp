import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { applyTacticalMapKey } from "./keyboard";
import { INITIAL_MAP_VIEW, tacticalPointKey, type TacticalMapPoint, type TacticalMapProjection, type TacticalMapViewState } from "./models";

const TILE_SIZE = 40;
const TERRAIN_COLORS: Record<TacticalMapProjection["tiles"][number]["terrain"], string> = {
  unknown: "#20242a", floor: "#b4a58e", wall: "#474c54", door: "#775335", water: "#39779b",
  rubble: "#7e7568", sand: "#c5a969", grass: "#65894d", stone: "#888681",
};

export interface TacticalMapCanvasProps {
  readonly projection: TacticalMapProjection;
  readonly label?: string;
  readonly onSelectionChange?: (point: TacticalMapPoint, tile: TacticalMapProjection["tiles"][number] | null) => void;
  readonly onViewChange?: (view: TacticalMapViewState) => void;
  readonly controlledTokenId?: string | null;
}

/** Draws a server projection. It performs no visibility, pathfinding, or rules calculations. */
export function TacticalMapCanvas({ projection, label = "Tactical map", onSelectionChange, onViewChange, controlledTokenId }: TacticalMapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [view, setView] = useState<TacticalMapViewState>(INITIAL_MAP_VIEW);
  const [sizeRevision, setSizeRevision] = useState(0);
  const descriptionId = useId();
  const tiles = new Map(projection.tiles.map((tile) => [tacticalPointKey(tile.position), tile]));
  const controlledToken = projection.tokens.find((token) => token.tokenId === controlledTokenId);
  const selectedTile = view.selected ? tiles.get(tacticalPointKey(view.selected)) : undefined;
  const viewport = () => ({ width: canvasRef.current?.clientWidth || 640, height: canvasRef.current?.clientHeight || 360 });

  useEffect(() => {
    const resize = () => setSizeRevision((value) => value + 1);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    if (canvasRef.current?.parentElement) observer?.observe(canvasRef.current.parentElement);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const { width, height } = viewport();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#11151a";
    context.fillRect(0, 0, width, height);
    const size = TILE_SIZE * view.zoom;
    for (const tile of projection.tiles) {
      const x = view.pan.x + tile.position.x * size;
      const y = view.pan.y + tile.position.y * size;
      context.fillStyle = TERRAIN_COLORS[tile.terrain];
      context.globalAlpha = tile.visibility === "visible" ? 1 : 0.55;
      context.fillRect(x, y, size, size);
      // Redundant terrain symbols remain legible without relying on color alone.
      const mark = { unknown: "?", floor: ".", wall: "#", door: "=", water: "~", rubble: "^", sand: ":", grass: '"', stone: "+" }[tile.terrain];
      context.fillStyle = "#101820";
      context.font = `bold ${Math.max(10, size * .4)}px monospace`;
      context.textAlign = "center";
      context.fillText(mark, x + size / 2, y + size * .65);
      if (tile.visibility !== "visible") {
        context.strokeStyle = "#abb2bb";
        context.beginPath(); context.moveTo(x, y + size); context.lineTo(x + size, y); context.stroke();
      }
      context.strokeStyle = "rgba(255,255,255,.22)";
      context.strokeRect(x, y, size, size);
    }
    context.globalAlpha = 1;
    if (projection.reachable.length > 0) {
      context.fillStyle = "rgba(83, 201, 135, .3)";
      for (const point of projection.reachable) context.fillRect(view.pan.x + point.x * size, view.pan.y + point.y * size, size, size);
    }
    if (projection.authoritativePath && projection.authoritativePath.length > 1) {
      context.beginPath();
      context.strokeStyle = "#f6d365";
      context.lineWidth = Math.max(2, view.zoom * 3);
      projection.authoritativePath.forEach((point, index) => {
        const x = view.pan.x + (point.x + 0.5) * size;
        const y = view.pan.y + (point.y + 0.5) * size;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
    }
    for (const token of projection.tokens) {
      const x = view.pan.x + token.position.x * size;
      const y = view.pan.y + token.position.y * size;
      context.fillStyle = token.disposition === "friendly" ? "#45a7e8" : token.disposition === "hostile" ? "#d55252" : "#d1a64d";
      context.beginPath();
      context.ellipse(x + token.footprint.width * size / 2, y + token.footprint.height * size / 2,
        token.footprint.width * size * 0.38, token.footprint.height * size * 0.38, 0, 0, Math.PI * 2);
      context.fill();
      if (token.tokenId === controlledTokenId) {
        context.strokeStyle = "#fff2ad"; context.lineWidth = 3;
        context.strokeRect(x + 3, y + 3, token.footprint.width * size - 6, token.footprint.height * size - 6);
      }
      context.fillStyle = "#fff";
      context.font = `bold ${Math.max(10, size * .25)}px sans-serif`;
      context.textAlign = "center";
      context.fillText(token.label.slice(0, 3), x + token.footprint.width * size / 2, y + token.footprint.height * size / 2 + size * .08);
    }
    const selected = view.cursor ?? view.selected;
    if (selected) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 3;
      context.strokeRect(view.pan.x + selected.x * size + 2, view.pan.y + selected.y * size + 2, size - 4, size - 4);
    }
  }, [projection, view, sizeRevision, controlledTokenId]);

  const updateView = (next: TacticalMapViewState) => { setView(next); onViewChange?.(next); };
  const zoomAt = (zoom: number, x = viewport().width / 2, y = viewport().height / 2) => {
    const nextZoom = Math.max(0.05, Math.min(4, zoom));
    updateView({ ...view, zoom: nextZoom, pan: { x: x - (x - view.pan.x) * nextZoom / view.zoom, y: y - (y - view.pan.y) * nextZoom / view.zoom } });
  };
  const fit = () => {
    const { width, height } = viewport();
    const zoom = Math.min(4, (width - 32) / (projection.width * TILE_SIZE), (height - 32) / (projection.height * TILE_SIZE));
    updateView({ ...view, zoom, pan: { x: (width - projection.width * TILE_SIZE * zoom) / 2, y: (height - projection.height * TILE_SIZE * zoom) / 2 } });
  };
  const select = (point: TacticalMapPoint) => {
    const bounded = { x: Math.max(0, Math.min(projection.width - 1, point.x)), y: Math.max(0, Math.min(projection.height - 1, point.y)) };
    const next = { ...view, cursor: bounded, selected: bounded };
    updateView(next);
    onSelectionChange?.(bounded, tiles.get(tacticalPointKey(bounded)) ?? null);
  };
  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>): TacticalMapPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    const size = TILE_SIZE * view.zoom;
    return { x: Math.floor((event.clientX - rect.left - view.pan.x) / size), y: Math.floor((event.clientY - rect.top - view.pan.y) / size) };
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = applyTacticalMapKey(view, event.key, projection.width, projection.height);
    if (next === view) return;
    event.preventDefault();
    if (next.zoom !== view.zoom) { zoomAt(next.zoom); return; }
    updateView(next);
    if (next.selected !== view.selected && next.selected) onSelectionChange?.(next.selected, tiles.get(tacticalPointKey(next.selected)) ?? null);
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(view.zoom * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX - rect.left, event.clientY - rect.top);
    };
    // React delegates wheel events passively; a native listener prevents page scroll while zooming.
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [view, onViewChange]);

  return <section className="tactical-map-stage" aria-label={label}>
    <div className="button-row tactical-camera-toolbar"><button type="button" onClick={() => zoomAt(view.zoom + 0.25)}>Zoom in</button><button type="button" onClick={() => zoomAt(view.zoom - 0.25)}>Zoom out</button><button type="button" onClick={fit}>Fit map</button><button type="button" aria-label="Center controlled token" disabled={!controlledToken} onClick={() => { if (controlledToken) updateView({ ...view, pan: { x: viewport().width / 2 - (controlledToken.position.x + controlledToken.footprint.width / 2) * TILE_SIZE * view.zoom, y: viewport().height / 2 - (controlledToken.position.y + controlledToken.footprint.height / 2) * TILE_SIZE * view.zoom } }); }}>Center token</button></div>
    <div role="group" aria-label={`${label} controls`} aria-describedby={descriptionId} tabIndex={0} onKeyDown={onKeyDown}>
      <canvas ref={canvasRef} aria-hidden="true" style={{ width: "100%", height: 360, display: "block", touchAction: "none" }}
        onPointerDown={(event) => { event.currentTarget.parentElement?.focus(); dragRef.current = { x: event.clientX, y: event.clientY, panX: view.pan.x, panY: view.pan.y }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerMove={(event) => { if (dragRef.current) updateView({ ...view, pan: { x: dragRef.current.panX + event.clientX - dragRef.current.x, y: dragRef.current.panY + event.clientY - dragRef.current.y } }); }}
        onPointerCancel={() => { dragRef.current = null; }}
        onPointerUp={(event) => { const drag = dragRef.current; dragRef.current = null; if (drag && Math.abs(event.clientX - drag.x) < 4 && Math.abs(event.clientY - drag.y) < 4) select(pointFromEvent(event)); }} />
    </div>
    <p role="status">{view.cursor ? `Map cursor: ${view.cursor.x + 1}, ${view.cursor.y + 1}. Press Enter to select.` : "Select a cell to inspect or preview movement."}</p>
    <p role="status" aria-label="Selected cell details">{view.selected ? selectedTile ? `Cell ${view.selected.x + 1}, ${view.selected.y + 1}: ${selectedTile.terrain}, ${selectedTile.visibility}.` : "No projected cell details are available for this selection." : "No cell selected."}</p>
    <details className="tactical-camera-details"><summary>Camera controls and movement help</summary>
      <p id={descriptionId}>Square grid, five feet per cell. Arrow keys move the map cursor; Enter selects; plus and minus zoom. Drag to pan, or use the pan buttons. Selecting a cell never moves a token: review the server path and confirm separately.</p>
      <div className="button-row" role="group" aria-label="Pan map">{([{ name: "left", x: 80, y: 0 }, { name: "right", x: -80, y: 0 }, { name: "up", x: 0, y: 80 }, { name: "down", x: 0, y: -80 }]).map((direction) => <button type="button" key={direction.name} onClick={() => updateView({ ...view, pan: { x: view.pan.x + direction.x, y: view.pan.y + direction.y } })}>Pan {direction.name}</button>)}</div>
      <button type="button" onClick={() => updateView(INITIAL_MAP_VIEW)}>Reset map view</button>
      <p aria-label="Map camera">Zoom: {Math.round(view.zoom * 100)}%. Pan: {Math.round(view.pan.x)}, {Math.round(view.pan.y)} pixels.</p>
    </details>
    <details className="tactical-map-legend"><summary>Map legend</summary><p>Terrain: . floor; # wall; = door; ~ water; ^ rubble; : sand; double quote grass; + stone; ? unknown. Diagonal slash: previously explored, not currently visible. Blank space: no projected terrain.</p><p>Blue tokens: friendly; red: hostile; gold: neutral. Pale square: your controlled token. White cell outline: cursor. Green cells: server-projected reachable cells; gold line: server-previewed path. Reachability is not a confirmed move.</p></details>
    <details><summary>Accessible cells and tokens</summary><table aria-label={`${label} text equivalent`}>
      <caption>Server-visible map cells and tokens</caption>
      <thead><tr><th scope="col">Cell</th><th scope="col">Terrain</th><th scope="col">Visibility</th><th scope="col">Occupants</th></tr></thead>
      <tbody>{projection.tiles.map((tile) => {
        const occupants = projection.tokens.filter((token) => tile.position.x >= token.position.x && tile.position.x < token.position.x + token.footprint.width
          && tile.position.y >= token.position.y && tile.position.y < token.position.y + token.footprint.height);
        return <tr key={tacticalPointKey(tile.position)}><th scope="row"><button type="button" onClick={() => select(tile.position)}>{tile.position.x + 1}, {tile.position.y + 1}</button></th>
          <td>{tile.terrain}</td><td>{tile.visibility}</td><td>{occupants.map((token) => token.label).join(", ") || "None"}</td></tr>;
      })}</tbody>
    </table></details>
  </section>;
}
