import { describe, expect, it } from "vitest";
import { generateTacticalMap } from "../src/map/generation.js";

describe("tactical map generation", () => {
  it.each(["dungeon", "cave", "arena"] as const)("generates deterministic %s maps with verifiable provenance", (kind) => {
    const first = generateTacticalMap({ kind, seed: "velvet-seed", width: 18, height: 14 });
    const second = generateTacticalMap({ kind, seed: "velvet-seed", width: 18, height: 14 });
    expect(second).toEqual(first);
    expect(first.tiles).toHaveLength(18 * 14);
    expect(first.provenance?.algorithm).toBe(`${kind}-v1`);
    expect(first.provenance?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tiles.filter((tile) => !tile.blocksMovement).length).toBeGreaterThan(0);
  });

  it("changes content hashes with seeds and rejects unsafe dimensions", () => {
    const a = generateTacticalMap({ kind: "arena", seed: "a", width: 15, height: 15 });
    const b = generateTacticalMap({ kind: "arena", seed: "b", width: 15, height: 15 });
    expect(a.provenance?.hash).not.toBe(b.provenance?.hash);
    expect(() => generateTacticalMap({ kind: "cave", seed: "", width: 15, height: 15 })).toThrow(RangeError);
    expect(() => generateTacticalMap({ kind: "cave", seed: "x", width: 4, height: 15 })).toThrow(RangeError);
  });
});
