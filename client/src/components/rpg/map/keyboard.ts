import type { TacticalMapViewState } from "./models";

export function applyTacticalMapKey(view: TacticalMapViewState, key: string, width: number, height: number): TacticalMapViewState {
  const cursor = view.cursor ?? { x: 0, y: 0 };
  const clamp = (value: number, maximum: number) => Math.max(0, Math.min(Math.max(0, maximum - 1), value));
  if (key === "+" || key === "=") return { ...view, zoom: Math.min(4, Number((view.zoom + 0.25).toFixed(2))) };
  if (key === "-") return { ...view, zoom: Math.max(0.5, Number((view.zoom - 0.25).toFixed(2))) };
  if (key === "Enter" || key === " ") return { ...view, cursor, selected: cursor };
  const offset = key === "ArrowLeft" ? { x: -1, y: 0 }
    : key === "ArrowRight" ? { x: 1, y: 0 }
      : key === "ArrowUp" ? { x: 0, y: -1 }
        : key === "ArrowDown" ? { x: 0, y: 1 } : null;
  if (!offset) return view;
  return { ...view, cursor: { x: clamp(cursor.x + offset.x, width), y: clamp(cursor.y + offset.y, height) } };
}
