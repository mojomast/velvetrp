import type {
  AuthoritativeMapTile,
  AuthoritativeMapToken,
  AuthoritativeTacticalMap,
  MapFootprint,
  MapGenerationProvenance,
  MapPoint,
  TacticalMapProjection,
} from "@velvet/contracts";

export type MapTile = AuthoritativeMapTile;
export type MapToken = AuthoritativeMapToken;
export type TacticalMap = AuthoritativeTacticalMap;
export type MapProjection = TacticalMapProjection;
export type MapTerrain = AuthoritativeMapTile["terrain"];
export type { MapFootprint, MapGenerationProvenance, MapPoint };

export function pointKey(point: MapPoint): string { return `${point.x},${point.y}`; }

export function tileIndex(map: Pick<TacticalMap, "tiles">): ReadonlyMap<string, MapTile> {
  return new Map(map.tiles.map((tile) => [pointKey(tile.position), tile]));
}
