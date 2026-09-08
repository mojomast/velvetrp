import { describe, expect, it } from "vitest";
import { coverBetween, gridDistanceFeet, hasLineOfSight, supercoverLine } from "../src/map/geometry.js";
import { findPath, reachableCells } from "../src/map/pathfinding.js";
import { pointKey, tileIndex, type MapTile, type TacticalMap } from "../src/map/types.js";

function mapFrom(rows: readonly string[]): TacticalMap {
  const tiles: MapTile[] = rows.flatMap((row, y) => [...row].map((value, x) => ({
    position: { x, y }, terrain: value === "#" ? "wall" as const : value === "~" ? "rubble" as const : "floor" as const,
    movementCost: 1, blocksMovement: value === "#", blocksSight: value === "#", difficult: value === "~",
  })));
  return { mapId: "test", width: rows[0]!.length, height: rows.length, grid: { kind: "square", feetPerCell: 5 }, tiles, tokens: [], provenance: null };
}

describe("tactical movement", () => {
  it("uses deterministic A* and never cuts blocked corners", () => {
    const map = mapFrom(["....", ".#..", "...."]);
    const first = findPath(map, { x: 0, y: 1 }, { x: 2, y: 1 });
    expect(first).toEqual([{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }]);
    expect(findPath(map, { x: 0, y: 1 }, { x: 2, y: 1 })).toEqual(first);
    expect(findPath(mapFrom([".#", "#."]), { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it("charges difficult terrain and respects footprints and occupied cells", () => {
    const reachable = reachableCells(mapFrom([".~..."]), { x: 0, y: 0 }, 2);
    expect(reachable).toContainEqual({ x: 1, y: 0 });
    expect(reachable).not.toContainEqual({ x: 2, y: 0 });
    const map = mapFrom([".....", ".....", "....."]);
    expect(findPath(map, { x: 0, y: 0 }, { x: 3, y: 0 }, { footprint: { width: 2, height: 1 }, blocked: new Set(["2,0"]) })).toEqual([
      { x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 0 },
    ]);
  });
});

describe("tactical geometry", () => {
  it("measures five-foot square distance and produces corner-inclusive supercover", () => {
    expect(gridDistanceFeet({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(15);
    expect(supercoverLine({ x: 0, y: 0 }, { x: 2, y: 2 }).map(pointKey)).toEqual(["0,0", "1,0", "0,1", "1,1", "2,1", "1,2", "2,2"]);
  });

  it("derives LOS and cover from authoritative opaque tiles", () => {
    const map = mapFrom([".....", "..#..", "....."]);
    const tiles = tileIndex(map);
    expect(hasLineOfSight({ x: 0, y: 1 }, { x: 4, y: 1 }, tiles)).toBe(false);
    expect(coverBetween({ x: 0, y: 1 }, { x: 4, y: 1 }, tiles)).toBe("half");
    expect(hasLineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, tiles)).toBe(true);
  });
});
