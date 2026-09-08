import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
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
}

/** Draws a server projection. It performs no visibility, pathfinding, or rules calculations. */
export function TacticalMapCanvas({ projection, label = "Tactical map", onSelectionChange, onViewChange }: TacticalMapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [view, setView] = useState<TacticalMapViewState>(INITIAL_MAP_VIEW);
  const descriptionId = useId();
  const tiles = new Map(projection.tiles.map((tile) => [tacticalPointKey(tile.position), tile]));

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const width = Math.max(320, canvas.clientWidth || 640);
    const height = Math.max(180, canvas.clientHeight || 360);
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
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
    }
    const selected = view.selected;
    if (selected) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 3;
      context.strokeRect(view.pan.x + selected.x * size + 2, view.pan.y + selected.y * size + 2, size - 4, size - 4);
    }
  }, [projection, view]);

  const updateView = (next: TacticalMapViewState) => { setView(next); onViewChange?.(next); };
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
    updateView(next);
    if (next.selected !== view.selected && next.selected) onSelectionChange?.(next.selected, tiles.get(tacticalPointKey(next.selected)) ?? null);
  };
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    updateView({ ...view, zoom: Math.max(0.5, Math.min(4, view.zoom * (event.deltaY < 0 ? 1.1 : 0.9))) });
  };

  return <section aria-label={label}>
    <p id={descriptionId}>Square grid, five feet per cell. Arrow keys move the map cursor; Enter selects; plus and minus zoom.</p>
    <div role="group" aria-label={`${label} controls`} aria-describedby={descriptionId} tabIndex={0} onKeyDown={onKeyDown}>
      <canvas ref={canvasRef} aria-hidden="true" style={{ width: "100%", minHeight: 360, display: "block", touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={(event) => { dragRef.current = { x: event.clientX, y: event.clientY, panX: view.pan.x, panY: view.pan.y }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onPointerMove={(event) => { if (dragRef.current) updateView({ ...view, pan: { x: dragRef.current.panX + event.clientX - dragRef.current.x, y: dragRef.current.panY + event.clientY - dragRef.current.y } }); }}
        onPointerUp={(event) => { const drag = dragRef.current; dragRef.current = null; if (drag && Math.abs(event.clientX - drag.x) < 4 && Math.abs(event.clientY - drag.y) < 4) select(pointFromEvent(event)); }} />
    </div>
    <table aria-label={`${label} text equivalent`}>
      <caption>Server-visible map cells and tokens</caption>
      <thead><tr><th scope="col">Cell</th><th scope="col">Terrain</th><th scope="col">Visibility</th><th scope="col">Occupants</th></tr></thead>
      <tbody>{projection.tiles.map((tile) => {
        const occupants = projection.tokens.filter((token) => tile.position.x >= token.position.x && tile.position.x < token.position.x + token.footprint.width
          && tile.position.y >= token.position.y && tile.position.y < token.position.y + token.footprint.height);
        return <tr key={tacticalPointKey(tile.position)}><th scope="row"><button type="button" onClick={() => select(tile.position)}>{tile.position.x + 1}, {tile.position.y + 1}</button></th>
          <td>{tile.terrain}</td><td>{tile.visibility}</td><td>{occupants.map((token) => token.label).join(", ") || "None"}</td></tr>;
      })}</tbody>
    </table>
  </section>;
}
