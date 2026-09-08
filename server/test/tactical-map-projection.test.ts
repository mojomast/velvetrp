import { describe, expect, it } from "vitest";
import { projectTacticalMap } from "../src/map/projection.js";
import { lineOfEffectBetween } from "../src/map/geometry.js";
import { pointKey, tileIndex } from "../src/map/types.js";
import type { TacticalMap } from "../src/map/types.js";

const map: TacticalMap = {
  mapId: "secret", width: 3, height: 1, grid: { kind: "square", feetPerCell: 5 }, provenance: null,
  tiles: [
    { position: { x: 0, y: 0 }, terrain: "floor", movementCost: 1, blocksMovement: false, blocksSight: false, difficult: false },
    { position: { x: 1, y: 0 }, terrain: "wall", movementCost: 1, blocksMovement: true, blocksSight: true, difficult: false },
    { position: { x: 2, y: 0 }, terrain: "floor", movementCost: 1, blocksMovement: false, blocksSight: false, difficult: false },
  ],
  tokens: [
    { tokenId: "hero", label: "Hero", position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false },
    { tokenId: "trap", label: "Mimic", position: { x: 1, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "hostile", hidden: true },
  ],
};

describe("tactical map projection", () => {
  it("resolves clear, partial, and full cover on the authoritative grid ray", () => {
    const clear = tileIndex({ tiles: [map.tiles[0]!, { ...map.tiles[2]!, position: { x: 2, y: 0 } }] });
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 2, y: 0 }, clear)).toMatchObject({ supported: false, lineOfEffect: "blocked" });
    const partial = new Map([
      ["0,0", map.tiles[0]!], ["1,0", map.tiles[1]!],
      ["2,0", { ...map.tiles[2]!, position: { x: 2, y: 0 }, blocksSight: false, blocksMovement: false }],
      ["3,0", { ...map.tiles[2]!, position: { x: 3, y: 0 }, blocksSight: false, blocksMovement: false }],
    ]);
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 3, y: 0 }, partial)).toMatchObject({ supported: true, cover: "three-quarters", lineOfEffect: "blocked" });
    partial.set("2,0", map.tiles[1]!);
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 3, y: 0 }, partial)).toMatchObject({ supported: true, cover: "full", lineOfEffect: "blocked", blockedBy: [{ x: 1, y: 0 }, { x: 2, y: 0 }] });
  });

  it("changes legality evidence when the attacker repositions and fails closed for unsupported geometry", () => {
    const tiles = new Map(map.tiles.map((tile) => [pointKey(tile.position), tile]));
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 2, y: 0 }, tiles).cover).toBe("full");
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 0, y: 0 }, tiles).lineOfEffect).toBe("clear");
    tiles.delete("1,0");
    expect(lineOfEffectBetween({ x: 0, y: 0 }, { x: 2, y: 0 }, tiles).supported).toBe(false);
  });

  it("does not leak unexplored topology, movement rules, or hidden tokens", () => {
    const projection = projectTacticalMap(map, {
      visible: new Set(["0,0"]), explored: new Set(["0,0", "1,0"]),
      authoritativePath: [{ x: 0, y: 0 }, { x: 1, y: 0 }], reachable: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
    });
    expect(projection.tiles).toEqual([
      { position: { x: 0, y: 0 }, terrain: "floor", visibility: "visible" },
      { position: { x: 1, y: 0 }, terrain: "unknown", visibility: "explored" },
    ]);
    expect(projection.tokens.map((token) => token.tokenId)).toEqual(["hero"]);
    expect(projection.authoritativePath).toBeNull();
    expect(projection.reachable).toEqual([{ x: 0, y: 0 }]);
    expect(JSON.stringify(projection)).not.toMatch(/blocksSight|blocksMovement|difficult|hidden|Mimic|2,0/);
  });

  it("reveals hidden tokens only through an explicit server allowlist", () => {
    const projection = projectTacticalMap(map, { visible: new Set(["1,0"]), explored: new Set(), revealHiddenTokenIds: new Set(["trap"]) });
    expect(projection.tokens).toEqual([{ tokenId: "trap", label: "Mimic", position: { x: 1, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "hostile" }]);
  });

  it("does not reveal a token through only part of its footprint", () => {
    const largeMap: TacticalMap = { ...map, tokens: [{ ...map.tokens[0]!, footprint: { width: 2, height: 1 } }] };
    expect(projectTacticalMap(largeMap, { visible: new Set(["0,0"]), explored: new Set() }).tokens).toEqual([]);
  });
});
