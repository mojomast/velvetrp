import { pointKey, type MapFootprint, type MapPoint, type MapTile } from "./types.js";

export function gridDistanceFeet(from: MapPoint, to: MapPoint): number {
  return Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 5;
}

export function footprintCells(position: MapPoint, footprint: MapFootprint): MapPoint[] {
  const cells: MapPoint[] = [];
  for (let y = position.y; y < position.y + footprint.height; y += 1) {
    for (let x = position.x; x < position.x + footprint.width; x += 1) cells.push({ x, y });
  }
  return cells;
}

/** All grid cells touched by a center-to-center segment, including corner contacts. */
export function supercoverLine(from: MapPoint, to: MapPoint): MapPoint[] {
  const result: MapPoint[] = [{ ...from }];
  const seen = new Set([pointKey(from)]);
  let x = from.x;
  let y = from.y;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  let crossedX = 0;
  let crossedY = 0;
  const add = (point: MapPoint) => {
    const key = pointKey(point);
    if (!seen.has(key)) { seen.add(key); result.push(point); }
  };
  while (x !== to.x || y !== to.y) {
    const compare = (1 + 2 * crossedX) * absY - (1 + 2 * crossedY) * absX;
    if (compare === 0) {
      add({ x: x + stepX, y });
      add({ x, y: y + stepY });
      x += stepX;
      y += stepY;
      crossedX += 1;
      crossedY += 1;
      add({ x, y });
    } else if (compare < 0) {
      x += stepX;
      crossedX += 1;
      add({ x, y });
    } else {
      y += stepY;
      crossedY += 1;
      add({ x, y });
    }
  }
  return result;
}

export function hasLineOfSight(from: MapPoint, to: MapPoint, tiles: ReadonlyMap<string, MapTile>): boolean {
  const line = supercoverLine(from, to);
  return line.slice(1, -1).every((point) => !tiles.get(pointKey(point))?.blocksSight);
}

export type Cover = "none" | "half" | "three-quarters" | "full";

/** Cover is based on opaque cells touched by the supercover ray, excluding endpoints. */
export function coverBetween(from: MapPoint, to: MapPoint, tiles: ReadonlyMap<string, MapTile>): Cover {
  const intervening = supercoverLine(from, to).slice(1, -1);
  if (intervening.length === 0) return "none";
  const blocked = intervening.filter((point) => tiles.get(pointKey(point))?.blocksSight).length;
  if (blocked === 0) return "none";
  if (blocked === intervening.length) return "full";
  return blocked * 2 >= intervening.length ? "three-quarters" : "half";
}
