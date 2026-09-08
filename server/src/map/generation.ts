import { createHash } from "node:crypto";
import type { MapTerrain, MapTile, TacticalMap } from "./types.js";

export type MapGeneratorKind = "dungeon" | "cave" | "arena";

export interface GenerateMapOptions {
  readonly kind: MapGeneratorKind;
  readonly seed: string;
  readonly width: number;
  readonly height: number;
}

function randomSource(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function wall(position: { x: number; y: number }): MapTile {
  return { position, terrain: "wall", movementCost: 1, blocksMovement: true, blocksSight: true, difficult: false };
}

function open(position: { x: number; y: number }, terrain: MapTerrain = "floor", difficult = false): MapTile {
  return { position, terrain, movementCost: 1, blocksMovement: false, blocksSight: false, difficult };
}

function dungeon(width: number, height: number, random: () => number): MapTile[] {
  const cells = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  const rooms: { x: number; y: number; width: number; height: number }[] = [];
  const attempts = Math.max(4, Math.floor(width * height / 80));
  for (let index = 0; index < attempts; index += 1) {
    const roomWidth = Math.min(width - 2, 3 + Math.floor(random() * Math.max(1, Math.min(6, width - 4))));
    const roomHeight = Math.min(height - 2, 3 + Math.floor(random() * Math.max(1, Math.min(6, height - 4))));
    const x = 1 + Math.floor(random() * Math.max(1, width - roomWidth - 1));
    const y = 1 + Math.floor(random() * Math.max(1, height - roomHeight - 1));
    if (rooms.some((room) => x <= room.x + room.width && x + roomWidth >= room.x && y <= room.y + room.height && y + roomHeight >= room.y)) continue;
    const room = { x, y, width: roomWidth, height: roomHeight };
    const previous = rooms.at(-1);
    rooms.push(room);
    for (let yy = y; yy < y + roomHeight; yy += 1) for (let xx = x; xx < x + roomWidth; xx += 1) cells[yy]![xx] = true;
    if (previous) {
      let cx = Math.floor(previous.x + previous.width / 2);
      let cy = Math.floor(previous.y + previous.height / 2);
      const targetX = Math.floor(x + roomWidth / 2);
      const targetY = Math.floor(y + roomHeight / 2);
      while (cx !== targetX) { cells[cy]![cx] = true; cx += Math.sign(targetX - cx); }
      while (cy !== targetY) { cells[cy]![cx] = true; cy += Math.sign(targetY - cy); }
      cells[cy]![cx] = true;
    }
  }
  if (rooms.length === 0) for (let y = 1; y < height - 1; y += 1) for (let x = 1; x < width - 1; x += 1) cells[y]![x] = true;
  return gridTiles(width, height, (x, y) => cells[y]![x] ? open({ x, y }) : wall({ x, y }));
}

function cave(width: number, height: number, random: () => number): MapTile[] {
  let cells = Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => x > 0 && y > 0 && x < width - 1 && y < height - 1 && random() > 0.43));
  for (let pass = 0; pass < 4; pass += 1) {
    cells = cells.map((row, y) => row.map((_cell, x) => {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return false;
      let openNeighbors = 0;
      for (let yy = y - 1; yy <= y + 1; yy += 1) for (let xx = x - 1; xx <= x + 1; xx += 1) if (cells[yy]?.[xx]) openNeighbors += 1;
      return openNeighbors >= 5;
    }));
  }
  cells[Math.floor(height / 2)]![Math.floor(width / 2)] = true;
  return gridTiles(width, height, (x, y) => cells[y]![x] ? open({ x, y }, random() < 0.08 ? "rubble" : "stone", random() < 0.08) : wall({ x, y }));
}

function arena(width: number, height: number, random: () => number): MapTile[] {
  return gridTiles(width, height, (x, y) => {
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return wall({ x, y });
    const pillar = x > 1 && y > 1 && x < width - 2 && y < height - 2 && (x + y) % 6 === 0 && random() < 0.28;
    return pillar ? wall({ x, y }) : open({ x, y }, "sand");
  });
}

function gridTiles(width: number, height: number, create: (x: number, y: number) => MapTile): MapTile[] {
  const tiles: MapTile[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) tiles.push(create(x, y));
  return tiles;
}

export function generateTacticalMap(options: GenerateMapOptions): TacticalMap {
  if (!options.seed || !Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width < 5 || options.height < 5 || options.width > 500 || options.height > 500) {
    throw new RangeError("Map generation requires a seed and integer dimensions from 5 to 500");
  }
  const random = randomSource(`${options.kind}:${options.seed}:${options.width}x${options.height}`);
  const tiles = options.kind === "dungeon" ? dungeon(options.width, options.height, random)
    : options.kind === "cave" ? cave(options.width, options.height, random)
      : arena(options.width, options.height, random);
  const algorithm = `${options.kind}-v1` as const;
  const content = { algorithm, seed: options.seed, width: options.width, height: options.height, tiles };
  const hash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return {
    mapId: `generated-${hash.slice(0, 16)}`,
    width: options.width,
    height: options.height,
    grid: { kind: "square", feetPerCell: 5 },
    tiles,
    tokens: [],
    provenance: { algorithm, seed: options.seed, parameters: { width: options.width, height: options.height }, hash },
  };
}
