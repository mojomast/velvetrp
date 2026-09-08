import { describe, expect, it } from "vitest";
import { applyTacticalMapKey } from "./keyboard";
import { INITIAL_MAP_VIEW } from "./models";

describe("tactical map keyboard model", () => {
  it("moves, clamps, selects, and zooms deterministically", () => {
    let view = applyTacticalMapKey(INITIAL_MAP_VIEW, "ArrowRight", 2, 2);
    expect(view.cursor).toEqual({ x: 1, y: 0 });
    view = applyTacticalMapKey(view, "ArrowRight", 2, 2);
    expect(view.cursor).toEqual({ x: 1, y: 0 });
    view = applyTacticalMapKey(view, "ArrowDown", 2, 2);
    view = applyTacticalMapKey(view, "Enter", 2, 2);
    expect(view.selected).toEqual({ x: 1, y: 1 });
    for (let index = 0; index < 20; index += 1) view = applyTacticalMapKey(view, "+", 2, 2);
    expect(view.zoom).toBe(4);
    for (let index = 0; index < 20; index += 1) view = applyTacticalMapKey(view, "-", 2, 2);
    expect(view.zoom).toBe(0.5);
  });

  it("returns the same state for non-control keys", () => {
    expect(applyTacticalMapKey(INITIAL_MAP_VIEW, "a", 10, 10)).toBe(INITIAL_MAP_VIEW);
  });
});
