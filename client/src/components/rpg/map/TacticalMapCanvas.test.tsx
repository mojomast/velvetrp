import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TacticalMapCanvas } from "./TacticalMapCanvas";
import type { TacticalMapProjection } from "./models";

const projection: TacticalMapProjection = {
  mapId: "projected", width: 2, height: 1, grid: { kind: "square", feetPerCell: 5 },
  tiles: [{ position: { x: 0, y: 0 }, terrain: "floor", visibility: "visible" }],
  tokens: [{ tokenId: "hero", label: "Visible Hero", position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "friendly" }],
  authoritativePath: [{ x: 0, y: 0 }], reachable: [{ x: 0, y: 0 }],
};

describe("TacticalMapCanvas", () => {
  beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("provides a semantic text equivalent containing projection data only", () => {
    render(<TacticalMapCanvas projection={projection} />);
    expect(screen.getByRole("table", { name: "Tactical map text equivalent" })).toBeTruthy();
    expect(screen.getByText("Visible Hero")).toBeTruthy();
    expect(screen.queryByText(/hidden|secret/i)).toBeNull();
    expect(screen.getByText(/five feet per cell/i)).toBeTruthy();
  });

  it("supports keyboard and text-table selection without inventing actions", () => {
    const selection = vi.fn();
    const view = vi.fn();
    render(<TacticalMapCanvas projection={projection} onSelectionChange={selection} onViewChange={view} />);
    const controls = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" });
    fireEvent.keyDown(controls, { key: "Enter" });
    expect(selection).toHaveBeenCalledWith({ x: 1, y: 0 }, null);
    fireEvent.click(screen.getByRole("button", { name: "1, 1" }));
    expect(selection).toHaveBeenLastCalledWith({ x: 0, y: 0 }, projection.tiles[0]);
    expect(view).toHaveBeenCalled();
  });
});
