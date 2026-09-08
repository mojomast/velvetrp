import { describe, expect, expectTypeOf, it } from "vitest";
import {
  authoritativeTacticalMapSchema, projectedMapTokenSchema, tacticalMapGenerateRequestSchema,
  tacticalMapMoveRequestSchema, tacticalMapProjectionSchema,
  type TacticalMapProjection,
} from "../src/tactical-map.js";

const floor = { position: { x: 0, y: 0 }, terrain: "floor", movementCost: 1, blocksMovement: false, blocksSight: false, difficult: false } as const;

describe("tactical map contracts", () => {
  it("accepts strict square five-foot authoritative maps", () => {
    const map = { mapId: "map", width: 2, height: 2, grid: { kind: "square", feetPerCell: 5 }, tiles: [floor], tokens: [], provenance: null } as const;
    expect(authoritativeTacticalMapSchema.parse(map)).toEqual(map);
    expect(authoritativeTacticalMapSchema.safeParse({ ...map, grid: { kind: "hex", feetPerCell: 5 } }).success).toBe(false);
    expect(authoritativeTacticalMapSchema.safeParse({ ...map, feetPerCell: 10 }).success).toBe(false);
  });

  it("rejects duplicate/out-of-bounds cells and footprints", () => {
    const base = { mapId: "map", width: 1, height: 1, grid: { kind: "square", feetPerCell: 5 }, tokens: [], provenance: null };
    expect(authoritativeTacticalMapSchema.safeParse({ ...base, tiles: [floor, floor] }).success).toBe(false);
    expect(authoritativeTacticalMapSchema.safeParse({ ...base, tiles: [{ ...floor, position: { x: 1, y: 0 } }] }).success).toBe(false);
    expect(authoritativeTacticalMapSchema.safeParse({ ...base, tiles: [floor], tokens: [{ tokenId: "large", label: "Large", position: { x: 0, y: 0 }, footprint: { width: 2, height: 1 }, disposition: "hostile", hidden: false }] }).success).toBe(false);
  });

  it("makes projections incapable of carrying hidden mechanics", () => {
    const projection = { mapId: "map", width: 2, height: 2, grid: { kind: "square", feetPerCell: 5 }, tiles: [{ position: { x: 0, y: 0 }, terrain: "unknown", visibility: "explored" }], tokens: [], authoritativePath: null, reachable: [] } as const;
    expect(tacticalMapProjectionSchema.parse(projection)).toEqual(projection);
    expect(projectedMapTokenSchema.safeParse({ tokenId: "x", label: "X", position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "hostile", hidden: true }).success).toBe(false);
    expect(tacticalMapProjectionSchema.safeParse({ ...projection, tiles: [{ ...floor, visibility: "visible" }] }).success).toBe(false);
    expect(tacticalMapProjectionSchema.safeParse({ ...projection, tiles: [{ position: { x: 2, y: 0 }, terrain: "floor", visibility: "visible" }] }).success).toBe(false);
    expectTypeOf<TacticalMapProjection["grid"]["feetPerCell"]>().toEqualTypeOf<5>();
  });

  it("binds generation and movement to strict modes, revisions, previews, and idempotency", () => {
    const generation = { mode: "combat", encounterId: "encounter", kind: "arena", seed: "exact-seed", width: 10, height: 10,
      tokens: [{ tokenId: "hero", label: "Hero", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly", hidden: false, actorId: "actor", combatantId: "combatant" }], idempotencyKey: "generate-one" };
    expect(tacticalMapGenerateRequestSchema.parse(generation)).toEqual(generation);
    expect(tacticalMapGenerateRequestSchema.safeParse({ ...generation, mode: "exploration" }).success).toBe(false);
    const move = { actorId: "actor", destination: { x: 2, y: 2 }, previewId: "preview", expectedMapRevision: 0, expectedTokenRevision: 0, idempotencyKey: "move-one" };
    expect(tacticalMapMoveRequestSchema.parse(move)).toEqual(move);
    expect(tacticalMapMoveRequestSchema.safeParse({ ...move, retry: true }).success).toBe(false);
  });
});
