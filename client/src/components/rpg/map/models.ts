import type { MapPoint, TacticalMapProjection as ContractTacticalMapProjection } from "@velvet/contracts";

export type TacticalMapPoint = MapPoint;
export type TacticalMapProjection = ContractTacticalMapProjection;

export interface TacticalMapViewState {
  readonly pan: TacticalMapPoint;
  readonly zoom: number;
  readonly cursor: TacticalMapPoint | null;
  readonly selected: TacticalMapPoint | null;
}

export const INITIAL_MAP_VIEW: TacticalMapViewState = { pan: { x: 0, y: 0 }, zoom: 1, cursor: null, selected: null };
export function tacticalPointKey(point: TacticalMapPoint): string { return `${point.x},${point.y}`; }
