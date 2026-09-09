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
    fireEvent.click(screen.getByText("Accessible cells and tokens"));
    expect(screen.getByRole("table", { name: "Tactical map text equivalent" })).toBeTruthy();
    expect(screen.getByText("Visible Hero")).toBeTruthy();
    expect(screen.queryByText(/hidden|secret/i)).toBeNull();
    expect(screen.getByText(/five feet per cell/i)).toBeTruthy();
  });

  it("supports keyboard and text-table selection without inventing actions", () => {
    const selection = vi.fn();
    const view = vi.fn();
    render(<TacticalMapCanvas projection={projection} onSelectionChange={selection} onViewChange={view} />);
    fireEvent.click(screen.getByText("Accessible cells and tokens"));
    const controls = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" });
    fireEvent.keyDown(controls, { key: "Enter" });
    expect(selection).toHaveBeenCalledWith({ x: 1, y: 0 }, null);
    fireEvent.click(screen.getByRole("button", { name: "1, 1" }));
    expect(selection).toHaveBeenLastCalledWith({ x: 0, y: 0 }, projection.tiles[0]);
    expect(view).toHaveBeenCalled();
    expect(screen.getByLabelText("Selected cell details").textContent).toContain("floor, visible");
  });

  it("anchors wheel zoom at the pointer and offers fit, center and native pan controls", () => {
    const onViewChange = vi.fn();
    const { container } = render(<TacticalMapCanvas projection={projection} controlledTokenId="hero" onViewChange={onViewChange} />);
    const canvas = container.querySelector("canvas")!;
    expect(fireEvent.wheel(canvas, { clientX: 120, clientY: 80, deltaY: -1, cancelable: true })).toBe(false);
    const zoomed = onViewChange.mock.calls.at(-1)![0];
    expect((120 - zoomed.pan.x) / zoomed.zoom).toBeCloseTo(120);
    expect((80 - zoomed.pan.y) / zoomed.zoom).toBeCloseTo(80);
    fireEvent.click(screen.getByRole("button", { name: "Fit map" }));
    expect(onViewChange.mock.calls.at(-1)![0]).toMatchObject({ zoom: 4, pan: { x: 160, y: 100 } });
    fireEvent.click(screen.getByRole("button", { name: "Center controlled token" }));
    expect(onViewChange.mock.calls.at(-1)![0].pan).toEqual({ x: 240, y: 100 });
    fireEvent.click(screen.getByText("Camera controls and movement help"));
    fireEvent.click(screen.getByRole("button", { name: "Pan right" }));
    expect(onViewChange.mock.calls.at(-1)![0].pan.x).toBe(160);
    expect(canvas.style.height).toBe("360px");
  });

  it("does not invent details for an unprojected cell", () => {
    render(<TacticalMapCanvas projection={projection} />);
    const controls = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    expect(screen.getByLabelText("Selected cell details").textContent).toBe("No projected cell details are available for this selection.");
  });

  it("keeps secondary controls collapsed and below the primary canvas", () => {
    const { container } = render(<TacticalMapCanvas projection={projection} />);
    const canvas = container.querySelector("canvas")!;
    const help = screen.getByText("Camera controls and movement help").closest("details")!;
    expect(help.open).toBe(false);
    expect(canvas.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pan left", hidden: true }).closest("details")).toBe(help);
    expect(container.querySelectorAll(".tactical-camera-toolbar button")).toHaveLength(4);
  });

  it("uses a DPR backing store without changing the CSS viewport on redraw", () => {
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), ellipse: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn() };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const { container } = render(<TacticalMapCanvas projection={projection} controlledTokenId="hero" />);
    const canvas = container.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent(window, new Event("resize"));
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(canvas.style.height).toBe("360px");
    expect(context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(context.strokeRect).toHaveBeenCalled();
  });
});
