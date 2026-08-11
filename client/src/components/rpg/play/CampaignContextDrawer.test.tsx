import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import { beginNpcPresenceMutation, releaseNpcPresenceMutation, resetNpcPresenceMutationRegistryForTests } from "../narrativeMutationRegistry";
import { CampaignContextDrawer, type CampaignContextDrawerApi } from "./CampaignContextDrawer";

const at = "2030-01-01T00:00:00.000Z";
type PresenceProblemCode = "RPG_NPC_PRESENCE_NOT_FOUND" | "RPG_NPC_PRESENCE_STALE" | "RPG_NPC_PRESENCE_CONFLICT";
const presenceProblem = (status: number, code: PresenceProblemCode) => ({ type: "https://velvet.local/problems/npc-presence", title: "NPC presence rejected", status, detail: "rejected", code, requestId: "request", error: "rejected" });
const playerNpc = (name = "Mira") => ({ npcId: "npc", publicState: { name }, revision: 1, presentAt: at, updatedAt: at, location: { label: "Gate" } });
const gmNpc = (name = "Mira") => ({ ...playerNpc(name), location: { locationId: "gate", label: "Gate" }, personaId: "persona-secret", principals: ["principal-secret"], privateState: { goals: "secret goal", gmNotes: "secret note", merchantState: null } });
const running = (audience: "gm" | "player", revision = 5, members: Array<ReturnType<typeof playerNpc> | ReturnType<typeof gmNpc>> = audience === "gm" ? [gmNpc()] : [playerNpc()]) => ({ audience, state: "running" as const, sessionRevision: revision, presentCast: members });

function api(overrides: Partial<CampaignContextDrawerApi> = {}): CampaignContextDrawerApi {
  return {
    getCampaignPresentCast: vi.fn().mockResolvedValue(running("player")), commandNpcPresence: vi.fn(),
    getCampaignWorld: vi.fn().mockResolvedValue({ revision: 1, data: { currentLocations: [{ actorId: "actor", locationId: "gate", revision: 1, updatedAt: at }], visibleLocations: [{ locationId: "gate", parentLocationId: null, name: "Gate", description: "Old stones" }, { locationId: "road", parentLocationId: null, name: "Road", description: "North" }], visibleConnections: [{ connectionId: "north", fromLocationId: "gate", toLocationId: "road" }] } }),
    listCampaignNpcs: vi.fn().mockResolvedValue({ revision: 1, data: { npcs: [{ npcId: "npc", publicState: { name: "Roster Mira" } }, { npcId: "tala", publicState: { name: "Tala" } }] } }),
    listCampaignQuests: vi.fn().mockResolvedValue({ revision: 1, data: { quests: [{ questId: "quest", status: "active" }], objectives: [{ objectiveId: "objective", questId: "quest", description: "Open the gate", progress: 1, targetProgress: 2, completedAt: null }] } }),
    getActorResources: vi.fn().mockResolvedValue({ resources: [{ name: "health", current: 8, max: 10 }], revision: 1 }),
    listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [] }), getCombatState: vi.fn(), ...overrides,
  };
}

const props = { campaignId: "campaign", sessionId: "session", selectedActorId: "actor", playableActorIds: ["actor"], authorizationGeneration: 1 } as const;

describe("CampaignContextDrawer NPC presence", () => {
  afterEach(() => { cleanup(); localStorage.clear(); resetNpcPresenceMutationRegistryForTests(); });

  it("renders only the authoritative player cast, not the management roster or private fields", async () => {
    const client = api(); render(<CampaignContextDrawer {...props} audience="player" api={client} />);
    await screen.findByText(/Mira - Gate/); expect(screen.queryByText("Roster Mira")).toBeNull(); expect(screen.queryByText("Tala")).toBeNull();
    expect(client.listCampaignNpcs).not.toHaveBeenCalled(); expect(screen.getByText("Road")).toBeTruthy(); expect(screen.getByText(/Open the gate/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/persona-secret|principal-secret|secret goal|secret note/);
  });

  it("distinguishes running empty presence from stopped cast history", async () => {
    const client = api({ getCampaignPresentCast: vi.fn().mockResolvedValueOnce(running("player", 5, [])).mockResolvedValueOnce({ audience: "player", state: "stopped", sessionRevision: 6, castHistory: [{ ...playerNpc("At Stop"), location: undefined, lastLocation: { label: "Road" }, leftAt: at }] }) });
    const { rerender } = render(<CampaignContextDrawer {...props} audience="player" api={client} />);
    await screen.findByText("No NPCs marked present.");
    rerender(<CampaignContextDrawer {...props} sessionId="stopped-session" audience="player" authorizationGeneration={2} api={client} />);
    await screen.findByRole("heading", { name: "Present at stop/history" }); expect(screen.getByText(/At Stop - Road/)).toBeTruthy(); expect(screen.queryByText(/present now/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Move|Remove|Place/ })).toBeNull(); expect(document.body.textContent).not.toMatch(/persona-secret|principal-secret|secret goal|secret note/);
  });

  it("provides labeled GM place and move controls and reconciles one POST with exactly one GET", async () => {
    localStorage.clear();
    const reconciled = running("gm", 7, [gmNpc(), { ...gmNpc("Tala"), npcId: "tala", location: { locationId: "road", label: "Road" } }]);
    const get = vi.fn().mockResolvedValueOnce(running("gm")).mockResolvedValueOnce(reconciled);
    const command = vi.fn().mockResolvedValue({ receipt: { kind: "place", revisionBefore: 5, revisionAfter: 6, occurredAt: at } });
    const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />);
    await screen.findByRole("button", { name: "Place NPC" }); fireEvent.change(screen.getByLabelText("NPC"), { target: { value: "tala" } }); fireEvent.change(screen.getByLabelText("Place location"), { target: { value: "road" } }); fireEvent.click(screen.getByRole("button", { name: "Place NPC" }));
    await screen.findByText("NPC presence updated from the authoritative present cast.");
    expect(command).toHaveBeenCalledTimes(1); expect(command).toHaveBeenCalledWith("campaign", "session", "tala", expect.objectContaining({ expectedRevision: 5, mutation: { kind: "place", locationId: "road" } })); expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Move Mira location")).toBeTruthy(); expect(localStorage.length).toBe(0);
  });

  it("requires explicit removal confirmation and restores focus on cancel", async () => {
    const client = api({ getCampaignPresentCast: vi.fn().mockResolvedValue(running("gm")) }); render(<CampaignContextDrawer {...props} audience="gm" api={client} />);
    const origin = await screen.findByRole("button", { name: "Remove Mira" }); fireEvent.click(origin); const confirm = screen.getByRole("button", { name: "Confirm remove" }); expect(document.activeElement).toBe(confirm); expect(client.commandNpcPresence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" })); await waitFor(() => expect(document.activeElement).toBe(origin));
  });

  it.each([
    [404, "RPG_NPC_PRESENCE_NOT_FOUND" as const, /unavailable.*not found.*No change was committed/i],
    [409, "RPG_NPC_PRESENCE_STALE" as const, /conflict.*stale.*No change was committed/i],
    [409, "RPG_NPC_PRESENCE_CONFLICT" as const, /conflict.*stale.*No change was committed/i],
  ])("releases exact %s non-commits without refreshing or retaining a lock", async (status, code, message) => {
    const get = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new ApiError(status, "typed rejection", [], false, presenceProblem(status, code)));
    render(<CampaignContextDrawer {...props} audience="gm" api={api({ getCampaignPresentCast: get, commandNpcPresence: command })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(message);
    expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(false); expect(screen.queryByRole("button", { name: "Refresh present cast" })).toBeNull();
  });

  it.each([404, 409])("keeps an untyped %i outcome ambiguous", async (status) => {
    const get = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new ApiError(status, "untyped rejection"));
    render(<CampaignContextDrawer {...props} audience="gm" api={api({ getCampaignPresentCast: get, commandNpcPresence: command })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/outcome is uncertain/);
    expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a typed 5xx outcome ambiguous without replaying the POST", async () => {
    const get = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new ApiError(503, "upstream failed"));
    render(<CampaignContextDrawer {...props} audience="gm" api={api({ getCampaignPresentCast: get, commandNpcPresence: command })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/outcome is uncertain/);
    expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByRole("button", { name: "Refresh present cast" })).toBeTruthy();
  });

  it("restores focus to the originating remove button after confirmation resolves", async () => {
    const command = vi.fn().mockRejectedValue(new ApiError(409, "stale", [], false, presenceProblem(409, "RPG_NPC_PRESENCE_STALE"))); const client = api({ getCampaignPresentCast: vi.fn().mockResolvedValue(running("gm")), commandNpcPresence: command });
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />); const origin = await screen.findByRole("button", { name: "Remove Mira" }); fireEvent.click(origin); fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await screen.findByText(/conflict.*stale/i); await waitFor(() => expect(document.activeElement).toBe(origin)); expect(command).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale receipt lock and never repeats the POST", async () => {
    const get = vi.fn().mockResolvedValue(running("gm", 5)); const command = vi.fn().mockResolvedValue({ receipt: { kind: "move", revisionBefore: 5, revisionAfter: 6, occurredAt: at } }); const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />); const select = await screen.findByLabelText("Move Mira location"); fireEvent.change(select, { target: { value: "road" } }); fireEvent.click(screen.getByRole("button", { name: "Move Mira" }));
    await screen.findByText(/revision is stale or unavailable/); expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2); fireEvent.click(screen.getByRole("button", { name: "Refresh present cast" })); await waitFor(() => expect(get).toHaveBeenCalledTimes(3)); expect(command).toHaveBeenCalledTimes(1); expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not reconcile or retry an ambiguous write until explicit refresh", async () => {
    const get = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new TypeError("network uncertain")); const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />); fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/outcome is uncertain/); expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh present cast" })); await waitFor(() => expect(get).toHaveBeenCalledTimes(2)); expect(command).toHaveBeenCalledTimes(1); await screen.findByText("Present cast refreshed from the server.");
  });

  it("retains an ambiguous lock across back-style unmount and remount while GET never repeats the POST", async () => {
    const get = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new TypeError("network uncertain")); const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    const first = render(<CampaignContextDrawer {...props} audience="gm" api={client} />); fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/outcome is uncertain/); first.unmount();
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />); const move = await screen.findByRole("button", { name: "Move Mira" }); expect((move as HTMLButtonElement).disabled).toBe(true); expect(get).toHaveBeenCalledTimes(2); expect(command).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh present cast" })); await waitFor(() => expect(get).toHaveBeenCalledTimes(3)); expect(command).toHaveBeenCalledTimes(1); await waitFor(() => expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("clears a retained GM lock on a fresh player mount without exposing or replaying it", async () => {
    const gmGet = vi.fn().mockResolvedValue(running("gm")); const command = vi.fn().mockRejectedValue(new TypeError("network uncertain")); const gmClient = api({ getCampaignPresentCast: gmGet, commandNpcPresence: command });
    const manager = render(<CampaignContextDrawer {...props} audience="gm" api={gmClient} />); fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/outcome is uncertain/); manager.unmount();

    const playerGet = vi.fn().mockResolvedValue(running("player")); render(<CampaignContextDrawer {...props} audience="player" api={api({ getCampaignPresentCast: playerGet, commandNpcPresence: command })} />);
    const replacement = beginNpcPresenceMutation("campaign", "session", "replacement"); expect(replacement).not.toBeNull(); releaseNpcPresenceMutation(replacement!);
    await screen.findByText(/Mira - Gate/); expect(screen.queryByText(/presence command|authoritative reconciliation|outcome is uncertain/i)).toBeNull(); expect(screen.queryByRole("button", { name: /Move|Remove|Place|Refresh present cast/ })).toBeNull();
    expect(playerGet).toHaveBeenCalledTimes(1); expect(command).toHaveBeenCalledTimes(1);
  });

  it("reconciles a receipt-backed lock from a newer authoritative revision after remount", async () => {
    const get = vi.fn().mockResolvedValueOnce(running("gm", 5)).mockResolvedValueOnce(running("gm", 5)).mockResolvedValueOnce(running("gm", 8));
    const command = vi.fn().mockResolvedValue({ receipt: { kind: "move", revisionBefore: 5, revisionAfter: 6, occurredAt: at } }); const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    const first = render(<CampaignContextDrawer {...props} audience="gm" api={client} />); fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/revision is stale or unavailable/); first.unmount();
    render(<CampaignContextDrawer {...props} audience="gm" api={client} />); await waitFor(() => expect((screen.getByRole("button", { name: "Move Mira" }) as HTMLButtonElement).disabled).toBe(false)); expect(get).toHaveBeenCalledTimes(3); expect(command).toHaveBeenCalledTimes(1);
  });

  it("submits null after explicitly selecting the empty move location", async () => {
    const get = vi.fn().mockResolvedValueOnce(running("gm", 5)).mockResolvedValueOnce(running("gm", 6)); const command = vi.fn().mockResolvedValue({ receipt: { kind: "move", revisionBefore: 5, revisionAfter: 6, occurredAt: at } });
    render(<CampaignContextDrawer {...props} audience="gm" api={api({ getCampaignPresentCast: get, commandNpcPresence: command })} />); const select = await screen.findByLabelText("Move Mira location"); fireEvent.change(select, { target: { value: "" } }); fireEvent.click(screen.getByRole("button", { name: "Move Mira" }));
    await screen.findByText("NPC presence updated from the authoritative present cast."); expect(command).toHaveBeenCalledWith("campaign", "session", "npc", expect.objectContaining({ mutation: { kind: "move", locationId: null } }));
  });

  it("adds nonprivate positional qualifiers to duplicate-name control labels", async () => {
    const duplicate = { ...gmNpc(), npcId: "npc-two" }; render(<CampaignContextDrawer {...props} audience="gm" api={api({ getCampaignPresentCast: vi.fn().mockResolvedValue(running("gm", 5, [gmNpc(), duplicate])) })} />);
    expect(await screen.findByRole("button", { name: "Move Mira, NPC 1 of 2" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Move Mira, NPC 2 of 2" })).toBeTruthy();
    expect(screen.getByLabelText("Move Mira location, NPC 1 of 2")).toBeTruthy(); expect(screen.getByRole("button", { name: "Remove Mira, NPC 2 of 2" })).toBeTruthy(); expect(screen.getAllByText("Move Mira", { selector: "button" })).toHaveLength(2);
  });

  it("clears GM projections immediately on audience downgrade", async () => {
    let resolvePlayer!: (value: ReturnType<typeof running>) => void; const player = new Promise<ReturnType<typeof running>>((resolve) => { resolvePlayer = resolve; });
    const get = vi.fn().mockResolvedValueOnce(running("gm", 5, [gmNpc("GM projection")])).mockReturnValueOnce(player); const client = api({ getCampaignPresentCast: get });
    const { rerender } = render(<CampaignContextDrawer {...props} audience="gm" api={client} />); await screen.findByRole("button", { name: "Remove GM projection" });
    rerender(<CampaignContextDrawer {...props} audience="player" authorizationGeneration={2} api={client} />); await waitFor(() => expect(screen.queryAllByText(/GM projection/)).toHaveLength(0)); resolvePlayer(running("player", 5, [])); await screen.findByText("No NPCs marked present."); expect(client.listCampaignNpcs).toHaveBeenCalledTimes(1);
  });

  it("invalidates a deferred POST on audience downgrade without refreshing or repopulating its lock", async () => {
    let resolveCommand!: (value: { receipt: { kind: "move"; revisionBefore: number; revisionAfter: number; occurredAt: string } }) => void;
    const deferred = new Promise<{ receipt: { kind: "move"; revisionBefore: number; revisionAfter: number; occurredAt: string } }>((resolve) => { resolveCommand = resolve; });
    const get = vi.fn().mockResolvedValueOnce(running("gm")).mockResolvedValueOnce(running("player", 5, [])).mockResolvedValueOnce(running("gm"));
    const command = vi.fn().mockReturnValue(deferred); const client = api({ getCampaignPresentCast: get, commandNpcPresence: command });
    const { rerender } = render(<CampaignContextDrawer {...props} audience="gm" api={client} />); fireEvent.click(await screen.findByRole("button", { name: "Move Mira" })); await screen.findByText(/Submitting one NPC presence command/);
    rerender(<CampaignContextDrawer {...props} audience="player" authorizationGeneration={2} api={client} />); await screen.findByText("No NPCs marked present.");
    resolveCommand({ receipt: { kind: "move", revisionBefore: 5, revisionAfter: 6, occurredAt: at } }); await Promise.resolve(); await Promise.resolve();
    expect(command).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2); expect(screen.queryByText(/updated from|receipt was accepted|outcome is uncertain/)).toBeNull();
    rerender(<CampaignContextDrawer {...props} audience="gm" authorizationGeneration={3} api={client} />); const move = await screen.findByRole("button", { name: "Move Mira" }); expect((move as HTMLButtonElement).disabled).toBe(false); expect(get).toHaveBeenCalledTimes(3);
  });
});
