import { pointKey, type MapPoint, type MapProjection, type TacticalMap } from "./types.js";

export interface ProjectionVisibility {
  readonly visible: ReadonlySet<string>;
  readonly explored: ReadonlySet<string>;
  readonly revealHiddenTokenIds?: ReadonlySet<string>;
  readonly authoritativePath?: readonly MapPoint[] | null;
  readonly reachable?: readonly MapPoint[];
}

/** Produces a renderer-safe value. Unknown cells and hidden token metadata never cross this boundary. */
export function projectTacticalMap(map: TacticalMap, visibility: ProjectionVisibility): MapProjection {
  const revealedHidden = visibility.revealHiddenTokenIds ?? new Set<string>();
  const tiles: MapProjection["tiles"][number][] = [];
  for (const tile of map.tiles) {
    const key = pointKey(tile.position);
    if (visibility.visible.has(key)) tiles.push({ position: { ...tile.position }, terrain: tile.terrain, visibility: "visible" });
    else if (visibility.explored.has(key)) tiles.push({ position: { ...tile.position }, terrain: "unknown", visibility: "explored" });
  }
  const tokens = map.tokens.flatMap((token) => {
    let footprintVisible = true;
    for (let y = token.position.y; y < token.position.y + token.footprint.height; y += 1) {
      for (let x = token.position.x; x < token.position.x + token.footprint.width; x += 1) {
        if (!visibility.visible.has(pointKey({ x, y }))) footprintVisible = false;
      }
    }
    if (!footprintVisible || (token.hidden && !revealedHidden.has(token.tokenId))) return [];
    const { hidden: _hidden, ...projected } = token;
    void _hidden;
    return [{ ...projected, position: { ...projected.position }, footprint: { ...projected.footprint } }];
  });
  return {
    mapId: map.mapId, width: map.width, height: map.height, grid: { ...map.grid }, tiles, tokens,
    authoritativePath: visibility.authoritativePath?.every((point) => visibility.visible.has(pointKey(point)))
      ? visibility.authoritativePath.map((point) => ({ ...point })) : null,
    reachable: visibility.reachable?.filter((point) => visibility.visible.has(pointKey(point))).map((point) => ({ ...point })) ?? [],
  };
}
