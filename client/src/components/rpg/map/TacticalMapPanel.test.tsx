import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TacticalMapPanel, type TacticalMapPanelApi } from "./TacticalMapPanel";
import { ApiError, getTacticalMap } from "../../../api";

const projection = { mapId: "map", width: 3, height: 2, grid: { kind: "square" as const, feetPerCell: 5 as const }, tiles: [
  { position: { x: 0, y: 0 }, terrain: "floor" as const, visibility: "visible" as const }, { position: { x: 1, y: 0 }, terrain: "floor" as const, visibility: "visible" as const }],
  tokens: [{ tokenId: "token", label: "Hero", position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const }], authoritativePath: null, reachable: [{ x: 0, y: 0 }, { x: 1, y: 0 }] };
const snapshot = { campaignId: "campaign", sessionId: "session", encounterId: null, mode: "exploration" as const, mapRevision: 2, tokenRevision: 4, controlledTokenId: "token", movement: { policy: "exploration-60-feet" as const, budgetFeet: 60 }, projection };
function api(overrides: Partial<TacticalMapPanelApi> = {}): TacticalMapPanelApi { return { getTacticalMap: vi.fn().mockResolvedValue(snapshot), generateTacticalMap: vi.fn(), previewTacticalMapMove: vi.fn().mockResolvedValue({ ...snapshot, previewId: "preview", pathCostFeet: 5, projection: { ...projection, authoritativePath: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } }), moveTacticalMapToken: vi.fn().mockResolvedValue({ receipt: { mapId: "map", tokenId: "token", previewId: "preview", idempotencyKey: "key", mapRevision: 2, tokenRevisionBefore: 4, tokenRevisionAfter: 5, destination: { x: 1, y: 0 }, occurredAt: "2030-01-01T00:00:00.000Z" }, snapshot: { ...snapshot, tokenRevision: 5 } }), ...overrides }; }
const props = { campaignId: "campaign", sessionId: "session", actorId: "actor", audience: "player" as const, mode: "exploration" as const, encounterId: null, combatantId: null };
const location = { locationId: "harbor", revision: 7, name: "Harbor Steps", description: "Wet stone beside the ferry." };
const locationError = (code: "RPG_TACTICAL_MAP_LOCATION_MISMATCH" | "RPG_TACTICAL_MAP_STALE") => new ApiError(409, "rejected", [], false, { type: "https://velvet.local/problems/tactical-map", title: "Rejected", detail: "rejected", status: 409, code, requestId: "request", error: "rejected" });
const roster = { encounterId: "encounter", combatId: "encounter", revision: 1, combatants: [{ kind: "actor" as const, actorId: "actor", combatantId: "selected-combatant", team: "allies" as const }, { kind: "enemy" as const, combatantId: "enemy", team: "enemies" as const, template: null }] };
async function reviewRoster() {
  await screen.findByRole("group", { name: "Combat roster placement" }, { timeout: 5000 });
  for (const [index, entry] of roster.combatants.entries()) {
    for (const [field, value] of Object.entries({ x: String(index + 2), y: "2", width: "1", height: "1", visibility: index ? "hidden" : "visible", disposition: index ? "hostile" : "friendly" })) fireEvent.change(screen.getByLabelText(`${entry.combatantId} ${field}`), { target: { value } });
  }
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("TacticalMapPanel", () => {
  it.each(["arena", "dungeon", "cave"])("opts into grounded %s generation with the actor location revision and reserved spawn", async (kind) => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValueOnce(new ApiError(404, "missing")).mockResolvedValue({ ...snapshot, locationBinding: { locationId: "harbor" } }), generateTacticalMap: vi.fn().mockResolvedValue(snapshot) });
    render(<TacticalMapPanel {...props} audience="gm" location={location} api={client} />);
    await screen.findByRole("button", { name: "Generate tactical map" });
    expect(screen.getByRole("heading", { name: "Harbor Steps" })).toBeTruthy();
    expect(screen.getByText(location.description)).toBeTruthy();
    expect((screen.getByLabelText("Exact seed") as HTMLInputElement).value).toBe("velvet-map:harbor");
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: kind } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Generate tactical map" }));
    await screen.findByRole("group", { name: "Tactical map controls" });
    expect(client.generateTacticalMap).toHaveBeenCalledExactlyOnceWith("campaign", "session", expect.objectContaining({ kind, grounding: { actorId: "actor", expectedLocationId: "harbor", expectedLocationRevision: 7 }, tokens: [expect.objectContaining({ actorId: "actor", position: { x: 1, y: 1 } })] }));
  });

  it("requires explicit replacement review after a location mismatch and never auto-generates", async () => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(locationError("RPG_TACTICAL_MAP_LOCATION_MISMATCH")), generateTacticalMap: vi.fn().mockResolvedValue(snapshot) });
    render(<TacticalMapPanel {...props} audience="gm" location={location} api={client} />);
    const button = await screen.findByRole("button", { name: "Generate tactical map" });
    expect(screen.getByText("Review replacement map")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.focus(window);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    await waitFor(() => expect(client.getTacticalMap).toHaveBeenCalledTimes(2));
    expect(client.generateTacticalMap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Generate tactical map" }));
    await waitFor(() => expect(client.generateTacticalMap).toHaveBeenCalledTimes(1));
    await screen.findByText("Review replacement map");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(client.generateTacticalMap).toHaveBeenCalledTimes(1);
  });

  it.each(["RPG_TACTICAL_MAP_LOCATION_MISMATCH", "RPG_TACTICAL_MAP_STALE"] as const)("requires new world evidence after generation rejects %s", async (code) => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(new ApiError(404, "missing")), generateTacticalMap: vi.fn().mockRejectedValue(locationError(code)) });
    const rendered = render(<TacticalMapPanel {...props} audience="gm" location={location} api={client} />);
    await screen.findByRole("button", { name: "Generate tactical map" });
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Generate tactical map" }));
    await screen.findByText(code === "RPG_TACTICAL_MAP_STALE" ? /Actor location revision is stale/ : /This map is not prepared/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    const locked = await screen.findByRole("button", { name: "Generate tactical map" });
    expect((locked as HTMLButtonElement).disabled).toBe(true);
    expect(client.generateTacticalMap).toHaveBeenCalledTimes(1);
    rendered.rerender(<TacticalMapPanel {...props} audience="gm" location={{ ...location, revision: 8 }} api={client} />);
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).closest("fieldset")?.disabled).toBe(false));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(client.generateTacticalMap).toHaveBeenCalledTimes(1);
  });

  it("hides mismatched snapshots and does not disclose generation setup to players", async () => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, locationBinding: { locationId: "secret-old-location" } }) });
    const { container } = render(<TacticalMapPanel {...props} location={location} api={client} />);
    await screen.findByText(/This map is not prepared/);
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByLabelText("Exact seed")).toBeNull();
    expect(screen.queryByLabelText("Layout")).toBeNull();
    expect(container.textContent).not.toMatch(/secret-old-location|velvet-map:harbor/);
  });

  it("blocks generation during a world refresh and invalidates consent when layout changes", async () => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(new ApiError(404, "missing")) });
    const rendered = render(<TacticalMapPanel {...props} audience="gm" location={location} api={client} />);
    await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Layout"), { target: { value: "cave" } });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    rendered.rerender(<TacticalMapPanel {...props} audience="gm" location={location} api={client} commandsBlocked />);
    expect((screen.getByRole("button", { name: "Generate tactical map" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Generate tactical map" }));
    expect(client.generateTacticalMap).not.toHaveBeenCalled();
  });
  it.each(["button", "focus", "prop"])("retains canvas and camera during a %s GET refresh while locking actions", async (trigger) => {
    let resolve!: (value: typeof snapshot) => void;
    const get = vi.fn().mockResolvedValueOnce(snapshot).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const client = api({ getTacticalMap: get });
    const rendered = render(<TacticalMapPanel {...props} api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    const canvas = rendered.container.querySelector("canvas");
    fireEvent.keyDown(controls, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByText("Camera controls and movement help"));
    fireEvent.click(screen.getByRole("button", { name: "Pan left" }));
    const camera = screen.getByLabelText("Map camera").textContent;
    if (trigger === "button") fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    else if (trigger === "focus") fireEvent.focus(window);
    else rendered.rerender(<TacticalMapPanel {...props} api={client} refreshKey={1} />);
    expect(rendered.container.querySelector("canvas")).toBe(canvas);
    expect(screen.getByLabelText("Map camera").textContent).toBe(camera);
    expect(screen.getByText(/Map cursor: 2, 1/)).toBeTruthy();
    fireEvent.keyDown(controls, { key: "Enter" });
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
    await act(async () => resolve({ ...snapshot, tokenRevision: 5 }));
    expect(rendered.container.querySelector("canvas")).toBe(canvas);
    expect(screen.getByLabelText("Map camera").textContent).toBe(camera);
    expect(screen.getByText(/Map cursor: 2, 1/)).toBeTruthy();
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
  });

  it.each(["actor", "audience", "session", "encounter"])("immediately removes the old projection at a %s boundary and ignores its pending GET", async (boundary) => {
    let resolve!: (value: typeof snapshot) => void;
    const client = api({ getTacticalMap: vi.fn().mockResolvedValueOnce(snapshot).mockImplementation(() => new Promise((done) => { resolve = done; })) });
    const rendered = render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByRole("group", { name: "Tactical map controls" });
    const canvas = rendered.container.querySelector("canvas");
    fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    const oldResolve = resolve;
    rendered.rerender(<TacticalMapPanel {...props} api={client} {...(boundary === "actor" ? { actorId: "other" } : boundary === "audience" ? { audience: "gm" as const } : boundary === "session" ? { sessionId: "other" } : { mode: "combat" as const, encounterId: "other", combatantId: "other" })} />);
    expect(canvas?.isConnected).toBe(false);
    expect(rendered.container.querySelector("canvas")).toBeNull();
    await act(async () => oldResolve(snapshot));
    expect(rendered.container.querySelector("canvas")).toBeNull();
  });
  it("generates, reloads, and moves a verified combat token using server revisions", async () => {
    const combat = { ...snapshot, mode: "combat" as const, encounterId: "encounter", movement: { policy: "combat-current-turn-speed" as const, budgetFeet: 15 } };
    const client = api({ readCombatRoster: vi.fn().mockResolvedValue(roster), getTacticalMap: vi.fn().mockRejectedValueOnce(new ApiError(404, "missing")).mockResolvedValue(combat), generateTacticalMap: vi.fn().mockResolvedValue(combat), previewTacticalMapMove: vi.fn().mockResolvedValue({ ...combat, previewId: "combat-preview", pathCostFeet: 5, projection: { ...projection, authoritativePath: [{ x: 1, y: 0 }] } }), moveTacticalMapToken: vi.fn().mockResolvedValue({ snapshot: { ...combat, tokenRevision: 5 } }) });
    render(<TacticalMapPanel {...props} audience="gm" mode="combat" encounterId="encounter" combatantId="selected-combatant" api={client} />);
    await reviewRoster();
    fireEvent.click(await screen.findByRole("button", { name: "Generate tactical map" }));
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    expect(client.generateTacticalMap).toHaveBeenCalledTimes(1);
    expect(client.generateTacticalMap).toHaveBeenCalledWith("campaign", "session", expect.objectContaining({ mode: "combat", encounterId: "encounter", tokens: [expect.objectContaining({ actorId: "actor", combatantId: "selected-combatant", hidden: false }), expect.objectContaining({ actorId: null, combatantId: "enemy", hidden: true })] }));
    expect(client.getTacticalMap).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm move" }));
    await screen.findByText(/Token moved/);
    expect(client.moveTacticalMapToken).toHaveBeenCalledWith("campaign", "session", "combat", expect.objectContaining({ actorId: "actor", previewId: "combat-preview", expectedMapRevision: 2, expectedTokenRevision: 4 }));
  });
  it("refuses a map belonging to a stale encounter", async () => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, mode: "combat", encounterId: "old" }) });
    render(<TacticalMapPanel {...props} mode="combat" encounterId="new" combatantId="combatant" api={client} />);
    await screen.findByText(/Tactical map encounter binding is stale/);
    expect(screen.queryByRole("group", { name: "Tactical map controls" })).toBeNull();
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
  });
  beforeEach(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)); afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("requires a server preview before one explicit move and renders the text equivalent", async () => {
    const client = api(); render(<TacticalMapPanel {...props} api={client} />); await screen.findByText(/60 feet available/); fireEvent.click(screen.getByText("Accessible cells and tokens")); expect(screen.getByRole("table", { name: "Tactical map text equivalent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm move" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "2, 1" })); await screen.findByText(/Preview: 5 feet/);
    expect(client.previewTacticalMapMove).toHaveBeenCalledWith("campaign", "session", "exploration", { actorId: "actor", destination: { x: 1, y: 0 }, expectedMapRevision: 2, expectedTokenRevision: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" })); await screen.findByText(/Token moved/); expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1);
    expect(client.moveTacticalMapToken).toHaveBeenCalledWith("campaign", "session", "exploration", expect.objectContaining({ actorId: "actor", destination: { x: 1, y: 0 }, previewId: "preview", expectedMapRevision: 2, expectedTokenRevision: 4 }));
  });

  it("never retries an ambiguous command and recovery performs one GET only", async () => {
    const client = api({ moveTacticalMapToken: vi.fn().mockRejectedValue(new TypeError("network")) }); render(<TacticalMapPanel {...props} api={client} />); await screen.findByText(/60 feet available/);
    fireEvent.click(screen.getByText("Accessible cells and tokens"));
    fireEvent.click(screen.getByRole("button", { name: "2, 1" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm move" })); await screen.findByText(/outcome is uncertain/);
    expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" })); await waitFor(() => expect(client.getTacticalMap).toHaveBeenCalledTimes(2)); expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1);
  });
  it("allows inspection but never previews or moves with read-only access", async () => {
    const client = api(); render(<TacticalMapPanel {...props} readOnly api={client} />);
    await screen.findByText(/60 feet available/);
    fireEvent.click(screen.getByText("Accessible cells and tokens"));
    fireEvent.click(screen.getByRole("button", { name: "2, 1" }));
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
    expect(screen.getByText(/Read-only map:/)).toBeTruthy();
  });
  it("does not preview when the server provides no movement allowance", async () => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, movement: null }) });
    render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByText(/Movement unavailable/);
    fireEvent.click(screen.getByText("Accessible cells and tokens"));
    fireEvent.click(screen.getByRole("button", { name: "2, 1" }));
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
  });
  it("inspects tokens by keyboard without requesting a move or changing control", async () => {
    const client = api(); render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByText(/60 feet available/);
    const controls = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "Enter" });
    expect(screen.getByText(/Hero: friendly. Your controlled token/)).toBeTruthy();
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    await screen.findByText(/Preview: 5 feet/);
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
  });
  it("discards an outstanding preview when access becomes read-only", async () => {
    let resolve!: (value: unknown) => void;
    const client = api({ previewTacticalMapMove: vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; })) });
    const view = render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByText(/60 feet available/);
    const controls = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    view.rerender(<TacticalMapPanel {...props} readOnly api={client} />);
    resolve({ ...snapshot, previewId: "late", pathCostFeet: 5, projection: { ...projection, authoritativePath: [{ x: 1, y: 0 }] } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm move" })).toBeNull());
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
  });
  it.each([
    { ...snapshot, controlledTokenId: null },
    { ...snapshot, movement: { ...snapshot.movement, budgetFeet: 0 } },
  ])("does not preview without server control and positive budget", async (value) => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue(value) });
    render(<TacticalMapPanel {...props} api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
  });
  it("reports a hostile target without transferring control or previewing into its footprint", async () => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, projection: { ...projection, tokens: [...projection.tokens, { ...projection.tokens[0], tokenId: "enemy", label: "Guard", disposition: "hostile", position: { x: 1, y: 0 } }] } }) });
    render(<TacticalMapPanel {...props} api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    expect(screen.getByText(/Guard: hostile. Inspection target only/)).toBeTruthy();
    expect(screen.getByText(/Selected token: Hero/)).toBeTruthy();
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
  });
  it("locks a stale move until a read-only refresh without replaying it", async () => {
    const client = api({ moveTacticalMapToken: vi.fn().mockRejectedValue(new ApiError(409, "stale")) });
    render(<TacticalMapPanel {...props} api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm move" }));
    await screen.findByText(/preview became stale/);
    fireEvent.keyDown(controls, { key: "Enter" });
    expect(client.previewTacticalMapMove).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Confirm move" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    await screen.findByText(/Authoritative tactical map refreshed/);
    expect(client.moveTacticalMapToken).toHaveBeenCalledTimes(1);
  });
  it("refreshes external turn budgets by focus, invalidating the preview without a mutation", async () => {
    const combat = { ...snapshot, mode: "combat" as const, encounterId: "encounter", movement: { policy: "combat-current-turn-speed" as const, budgetFeet: 15 } };
    const client = api({ getTacticalMap: vi.fn().mockResolvedValueOnce(combat).mockResolvedValue({ ...combat, movement: { ...combat.movement, budgetFeet: 0 } }), previewTacticalMapMove: vi.fn().mockResolvedValue({ ...combat, previewId: "preview", pathCostFeet: 5, projection: { ...projection, authoritativePath: [{ x: 1, y: 0 }] } }) });
    render(<TacticalMapPanel {...props} mode="combat" encounterId="encounter" combatantId="selected-combatant" api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    await screen.findByRole("button", { name: "Confirm move" });
    fireEvent.focus(window);
    await screen.findByText(/0 feet available/);
    expect(screen.queryByRole("button", { name: "Confirm move" })).toBeNull();
    const refreshed = screen.getByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(refreshed, { key: "ArrowRight" }); fireEvent.keyDown(refreshed, { key: "Enter" });
    expect(client.previewTacticalMapMove).toHaveBeenCalledTimes(1);
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
    expect(client.generateTacticalMap).not.toHaveBeenCalled();
    expect(screen.getByText(/Selected token: Hero/)).toBeTruthy();
  });
  it("polls only reads and aborts in-flight reads and timers on unmount", async () => {
    const client = api();
    const view = render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByText(/60 feet available/);
    vi.useFakeTimers();
    // Re-register the timer under the fake clock through an explicit refresh.
    fireEvent.click(screen.getByRole("button", { name: "Refresh tactical map" }));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(client.getTacticalMap).toHaveBeenCalledTimes(3);
    const signal = vi.mocked(client.getTacticalMap).mock.calls.at(-1)![4]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { vi.advanceTimersByTime(60_000); fireEvent.focus(window); });
    expect(client.getTacticalMap).toHaveBeenCalledTimes(3);
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
    expect(client.moveTacticalMapToken).not.toHaveBeenCalled();
    expect(client.generateTacticalMap).not.toHaveBeenCalled();
  });
  it("uses abortable no-store transport for the production shared getter", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot)));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<TacticalMapPanel {...props} api={api({ getTacticalMap })} />);
    await screen.findByText(/60 feet available/);
    expect(fetcher).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor", { cache: "no-store", signal: expect.any(AbortSignal) });
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
  it("fails closed on duplicate projected token identities", async () => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, projection: { ...projection, tokens: [...projection.tokens, ...projection.tokens] } }) });
    render(<TacticalMapPanel {...props} api={client} />);
    await screen.findByText(/token control is ambiguous/);
    expect(screen.queryByRole("group", { name: "Tactical map controls" })).toBeNull();
  });
  it.each(["explored", "unreachable"])("does not preview an %s destination", async (scenario) => {
    const client = api({ getTacticalMap: vi.fn().mockResolvedValue({ ...snapshot, projection: { ...projection, reachable: scenario === "unreachable" ? [] : projection.reachable, tiles: projection.tiles.map((tile) => ({ ...tile, visibility: scenario === "explored" ? "explored" : "visible" })) } }) });
    render(<TacticalMapPanel {...props} api={client} />);
    const controls = await screen.findByRole("group", { name: "Tactical map controls" });
    fireEvent.keyDown(controls, { key: "ArrowRight" }); fireEvent.keyDown(controls, { key: "Enter" });
    expect(client.previewTacticalMapMove).not.toHaveBeenCalled();
  });
  it("requires all reviewed spawns and rejects a roster transition before generation", async () => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(new ApiError(404, "missing")), readCombatRoster: vi.fn().mockResolvedValueOnce(roster).mockResolvedValue({ ...roster, revision: 2 }) });
    render(<TacticalMapPanel {...props} audience="gm" mode="combat" encounterId="encounter" combatantId="selected-combatant" api={client} />);
    expect((await screen.findByRole("button", { name: "Generate tactical map" }) as HTMLButtonElement).disabled).toBe(true);
    await reviewRoster();
    fireEvent.click(screen.getByRole("button", { name: "Generate tactical map" }));
    await screen.findByText(/Encounter roster changed/);
    expect(client.generateTacticalMap).not.toHaveBeenCalled();
  });
  it("does not replay uncertain full-roster generation on focus or double submit", async () => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(new ApiError(404, "missing")), readCombatRoster: vi.fn().mockResolvedValue(roster), generateTacticalMap: vi.fn().mockRejectedValue(new TypeError("network")) });
    render(<TacticalMapPanel {...props} audience="gm" mode="combat" encounterId="encounter" combatantId="selected-combatant" api={client} />);
    await reviewRoster();
    const button = screen.getByRole("button", { name: "Generate tactical map" });
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText(/generation outcome is uncertain/);
    fireEvent.focus(window);
    expect(client.generateTacticalMap).toHaveBeenCalledTimes(1);
    expect(client.getTacticalMap).toHaveBeenCalledTimes(1);
  });
  it.each([{ audience: "player" as const, readOnly: false }, { audience: "gm" as const, readOnly: true }])("does not expose DM roster editing without write access", async (access) => {
    const client = api({ getTacticalMap: vi.fn().mockRejectedValue(new ApiError(404, "missing")), readCombatRoster: vi.fn() });
    render(<TacticalMapPanel {...props} {...access} mode="combat" encounterId="encounter" combatantId="selected-combatant" api={client} />);
    await screen.findByText(/No tactical map projection/);
    expect(screen.queryByRole("button", { name: "Generate tactical map" })).toBeNull();
    expect(client.readCombatRoster).not.toHaveBeenCalled();
  });
});
