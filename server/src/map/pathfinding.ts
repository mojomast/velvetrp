import { footprintCells } from "./geometry.js";
import { pointKey, tileIndex, type MapFootprint, type MapPoint, type TacticalMap } from "./types.js";

const DIRECTIONS = [
  { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 },
  { x: -1, y: -1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 },
] as const;

export interface MovementOptions {
  readonly footprint?: MapFootprint;
  readonly blocked?: ReadonlySet<string>;
}

function movementCost(map: TacticalMap, position: MapPoint, footprint: MapFootprint, blocked: ReadonlySet<string>): number | null {
  const tiles = tileIndex(map);
  let cost = 1;
  for (const cell of footprintCells(position, footprint)) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height || blocked.has(pointKey(cell))) return null;
    const tile = tiles.get(pointKey(cell));
    if (!tile || tile.blocksMovement) return null;
    cost = Math.max(cost, tile.movementCost * (tile.difficult ? 2 : 1));
  }
  return cost;
}

function canStep(map: TacticalMap, from: MapPoint, to: MapPoint, footprint: MapFootprint, blocked: ReadonlySet<string>): number | null {
  const cost = movementCost(map, to, footprint, blocked);
  if (cost === null) return null;
  if (from.x !== to.x && from.y !== to.y) {
    if (movementCost(map, { x: to.x, y: from.y }, footprint, blocked) === null) return null;
    if (movementCost(map, { x: from.x, y: to.y }, footprint, blocked) === null) return null;
  }
  return cost;
}

function comparePoints(left: MapPoint, right: MapPoint): number { return left.y - right.y || left.x - right.x; }

export function findPath(map: TacticalMap, start: MapPoint, goal: MapPoint, options: MovementOptions = {}): MapPoint[] | null {
  const footprint = options.footprint ?? { width: 1, height: 1 };
  const blocked = options.blocked ?? new Set<string>();
  if (movementCost(map, start, footprint, blocked) === null || movementCost(map, goal, footprint, blocked) === null) return null;
  const open = new Map<string, MapPoint>([[pointKey(start), start]]);
  const previous = new Map<string, MapPoint>();
  const scores = new Map<string, number>([[pointKey(start), 0]]);
  while (open.size > 0) {
    const current = [...open.values()].sort((a, b) => {
      const aScore = (scores.get(pointKey(a)) ?? Infinity) + Math.max(Math.abs(goal.x - a.x), Math.abs(goal.y - a.y));
      const bScore = (scores.get(pointKey(b)) ?? Infinity) + Math.max(Math.abs(goal.x - b.x), Math.abs(goal.y - b.y));
      return aScore - bScore || (scores.get(pointKey(a)) ?? 0) - (scores.get(pointKey(b)) ?? 0) || comparePoints(a, b);
    })[0]!;
    const currentKey = pointKey(current);
    open.delete(currentKey);
    if (currentKey === pointKey(goal)) {
      const path = [{ ...current }];
      let cursor = previous.get(currentKey);
      while (cursor) { path.push({ ...cursor }); cursor = previous.get(pointKey(cursor)); }
      return path.reverse();
    }
    for (const direction of DIRECTIONS) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const cost = canStep(map, current, next, footprint, blocked);
      if (cost === null) continue;
      const tentative = scores.get(currentKey)! + cost;
      const key = pointKey(next);
      if (tentative < (scores.get(key) ?? Infinity)) {
        previous.set(key, current);
        scores.set(key, tentative);
        open.set(key, next);
      }
    }
  }
  return null;
}

export function reachableCells(map: TacticalMap, start: MapPoint, budget: number, options: MovementOptions = {}): MapPoint[] {
  const footprint = options.footprint ?? { width: 1, height: 1 };
  const blocked = options.blocked ?? new Set<string>();
  if (budget < 0 || movementCost(map, start, footprint, blocked) === null) return [];
  const costs = new Map<string, number>([[pointKey(start), 0]]);
  const pending = new Map<string, MapPoint>([[pointKey(start), start]]);
  while (pending.size > 0) {
    const current = [...pending.values()].sort((a, b) => (costs.get(pointKey(a))! - costs.get(pointKey(b))!) || comparePoints(a, b))[0]!;
    pending.delete(pointKey(current));
    for (const direction of DIRECTIONS) {
      const next = { x: current.x + direction.x, y: current.y + direction.y };
      const step = canStep(map, current, next, footprint, blocked);
      if (step === null) continue;
      const cost = costs.get(pointKey(current))! + step;
      const key = pointKey(next);
      if (cost <= budget && cost < (costs.get(key) ?? Infinity)) { costs.set(key, cost); pending.set(key, next); }
    }
  }
  return [...costs.keys()].map((key) => { const [x, y] = key.split(",").map(Number); return { x: x!, y: y! }; }).sort(comparePoints);
}
