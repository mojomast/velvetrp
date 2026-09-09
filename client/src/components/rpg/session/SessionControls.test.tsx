import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignPlayBootstrap, EncounterPublic } from "@velvet/contracts";
import { SessionControls } from "./SessionControls";
import { ApiError } from "../../../api";
import type { CampaignPlayApi } from "../play/CampaignPlayPage";

const bootstrap: CampaignPlayBootstrap = { campaignId: "campaign", sessionId: "room", expectedRevision: 7,
  session: { attached: true, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true },
  dm: { mode: "human", revision: 0 }, principal: { role: "gm", control: "controlled" }, capabilities: { campaignDice: { canView: true, canRoll: true } },
  playableActors: [{ actorId: "aria", name: "Aria" }] };
const encounter: EncounterPublic = { encounterId: "battle", combatId: "battle", sessionId: "room", name: "Harbor ambush", status: "active", revision: 3,
  combatants: [], createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
const key = "velvet.session-controls.v1:campaign:room";
function fixture(rows: EncounterPublic[] = []) {
  const api = { listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: rows }), getCampaignPlayBootstrap: vi.fn().mockResolvedValue(bootstrap),
    startEncounter: vi.fn().mockImplementation(async (id, request) => {
      vi.mocked(api.listCampaignEncounters).mockResolvedValue({ encounters: [{ ...encounter, revision: request.expectedRevision + 1 }] });
      return { combat: { combatId: id, revision: request.expectedRevision + 1 }, receipt: { idempotencyKey: request.idempotencyKey, revisionBefore: request.expectedRevision, revisionAfter: request.expectedRevision + 1 } };
    }),
    getCombatState: vi.fn().mockResolvedValue({ revision: 3 }), getActorResources: vi.fn().mockResolvedValue({ revision: 4, resources: [] }),
    endCombat: vi.fn().mockImplementation(async (_id, request) => {
      vi.mocked(api.listCampaignEncounters).mockResolvedValue({ encounters: [{ ...encounter, status: "completed", revision: 4 }] });
      return { encounter: { ...encounter, status: "completed", revision: 4 }, rewards: [], receipt: { ...request, revisionBefore: 3, revisionAfter: 4 } };
    }),
    commandActorRest: vi.fn().mockImplementation(async (_campaign, _actor, request) => {
      vi.mocked(api.getActorResources).mockResolvedValue({ revision: 5, resources: [] });
      return { actorState: { resources: [], revision: 5 }, receipt: { kind: request.type === "take_short_rest" ? "short" : "long", idempotencyKey: request.idempotencyKey, revisionBefore: 4, revisionAfter: 5 } };
    }),
    getCombatCommandResult: vi.fn(),
  } as unknown as CampaignPlayApi;
  return { bootstrap, api, blocked: false, onLockChange: vi.fn(), onRefresh: vi.fn().mockResolvedValue(undefined), onCombat: vi.fn() };
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
describe("SessionControls", () => {
  it.each(["player", "observer"] as const)("does not expose or load DM commands for %s", (role) => {
    const props = fixture(); render(<SessionControls {...props} bootstrap={{ ...bootstrap, principal: { ...bootstrap.principal, role } }} />);
    expect(screen.queryByRole("region", { name: "Run this scene" })).toBeNull(); expect(props.api.listCampaignEncounters).not.toHaveBeenCalled();
  });
  it("hides stopped-room controls and blocks commands during adventure approval", async () => {
    const props = fixture(); const view = render(<SessionControls {...props} bootstrap={{ ...bootstrap, session: { ...bootstrap.session, active: false } }} />);
    expect(screen.queryByRole("region", { name: "Run this scene" })).toBeNull();
    view.rerender(<SessionControls {...props} blocked />);
    expect((await screen.findByRole("button", { name: "Short rest for Aria" }) as HTMLButtonElement).disabled).toBe(true);
    expect(props.api.commandActorRest).not.toHaveBeenCalled();
  });
  it("uses named navigation, scopes encounters to this room, and never starts automatically", async () => {
    const props = fixture([{ ...encounter, sessionId: "other" }]); render(<SessionControls {...props} />);
    await screen.findByText("No encounters prepared for this room.");
    expect(screen.queryByText("Harbor ambush")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Prepare / run encounter in Combat" }));
    expect(props.onCombat).toHaveBeenCalledOnce(); expect(props.api.endCombat).not.toHaveBeenCalled();
  });
  it("starts a prepared encounter only after review, recovering with its exact request", async () => {
    const props = fixture([{ ...encounter, status: "preparing", combatId: null }]);
    vi.mocked(props.api.startEncounter!).mockRejectedValueOnce(new Error("lost response"));
    const view = render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review start of Harbor ambush" }));
    await screen.findByRole("button", { name: "Confirm encounter start" }); expect(props.api.startEncounter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm encounter start" })); await screen.findByText(/Outcome uncertain/);
    view.unmount(); render(<SessionControls {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Recover exact operation" })); await screen.findByText(/Encounter start confirmed/);
    const calls = vi.mocked(props.api.startEncounter!).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(calls[0]).toEqual(["battle", { expectedRevision: 3, idempotencyKey: expect.any(String) }]);
  });
  it("reviews combat completion, prevents double submission, and refreshes after success", async () => {
    const props = fixture([encounter]); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review completion of Harbor ambush" }));
    const confirm = await screen.findByRole("button", { name: "Confirm encounter completion" });
    expect(props.api.endCombat).not.toHaveBeenCalled();
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByText(/Encounter completion confirmed/);
    expect(props.api.endCombat).toHaveBeenCalledExactlyOnceWith("battle", { expectedRevision: 3, idempotencyKey: expect.any(String) });
    expect(props.onRefresh).toHaveBeenCalledOnce(); expect(localStorage.getItem(key)).toBeNull();
  });
  it("recovers uncertain completion only through the exact receipt GET across remount", async () => {
    const props = fixture([encounter]); vi.mocked(props.api.endCombat!).mockRejectedValue(new Error("lost response"));
    const view = render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review completion of Harbor ambush" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm encounter completion" }));
    await screen.findByText(/Outcome uncertain/);
    const saved = JSON.parse(localStorage.getItem(key)!);
    vi.mocked(props.api.getCombatCommandResult!).mockResolvedValue({ operation: "end", result: { encounter: { ...encounter, status: "completed", revision: 4 }, rewards: [], receipt: { idempotencyKey: saved.idempotencyKey, revisionBefore: 3, revisionAfter: 4, occurredAt: encounter.createdAt } } });
    vi.mocked(props.api.listCampaignEncounters).mockResolvedValue({ encounters: [{ ...encounter, status: "completed", revision: 4 }] });
    view.unmount(); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Recover exact operation" }));
    await screen.findByText(/Encounter completion confirmed/);
    expect(props.api.endCombat).toHaveBeenCalledOnce();
    expect(props.api.getCombatCommandResult).toHaveBeenCalledWith("campaign", "battle", saved.idempotencyKey);
  });
  it("does not clear an uncertain lock on missing or mismatched receipt", async () => {
    localStorage.setItem(key, JSON.stringify({ review: { kind: "end", target: "battle", label: "Harbor ambush", revision: 3 }, idempotencyKey: "exact-key", confirmed: false }));
    const props = fixture([encounter]); vi.mocked(props.api.getCombatCommandResult!).mockRejectedValue(new Error("404"));
    render(<SessionControls {...props} />); fireEvent.click(screen.getByRole("button", { name: "Recover exact operation" }));
    await screen.findByText(/Outcome uncertain/); expect(localStorage.getItem(key)).not.toBeNull(); expect(props.api.endCombat).not.toHaveBeenCalled();
  });
  it.each(["Short", "Long"])("runs a reviewed %s rest for the actual controlled actor", async (kind) => {
    const props = fixture(); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: `${kind} rest for Aria` }));
    await screen.findByRole("region", { name: "Review session operation" }); expect(props.api.commandActorRest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm rest" }));
    await screen.findByText(/Rest confirmed by the server/);
    expect(props.api.commandActorRest).toHaveBeenCalledExactlyOnceWith("campaign", "aria", { type: kind === "Short" ? "take_short_rest" : "take_long_rest", expectedRevision: 4, idempotencyKey: expect.any(String) });
    expect(props.api.getActorResources).toHaveBeenCalledTimes(2); expect(props.onRefresh).toHaveBeenCalledOnce();
  });
  it("recovers rest using the identical persisted request, not a replacement key", async () => {
    const props = fixture(); vi.mocked(props.api.commandActorRest!).mockRejectedValueOnce(new Error("lost response"));
    render(<SessionControls {...props} />); fireEvent.click(await screen.findByRole("button", { name: "Short rest for Aria" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm rest" })); await screen.findByText(/Outcome uncertain/);
    fireEvent.click(screen.getByRole("button", { name: "Recover exact operation" })); await screen.findByText(/Rest confirmed by the server/);
    const calls = vi.mocked(props.api.commandActorRest!).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
  });
  it("retries reads only after a confirmed operation with failed refresh", async () => {
    const props = fixture(); props.onRefresh.mockRejectedValueOnce(new Error("offline")); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Long rest for Aria" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm rest" }));
    await screen.findByText(/Command confirmed, but refresh failed/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh confirmed operation" })); await screen.findByText(/Rest confirmed by the server/);
    expect(props.api.commandActorRest).toHaveBeenCalledOnce();
  });
  it("fails closed on unavailable recovery storage", async () => {
    const props = fixture(); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Short rest for Aria" })); await screen.findByRole("button", { name: "Confirm rest" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    fireEvent.click(screen.getByRole("button", { name: "Confirm rest" })); await screen.findByText(/Outcome uncertain/);
    expect(props.api.commandActorRest).not.toHaveBeenCalled();
  });
  it("releases a proven stale rejection but requires fresh review", async () => {
    const props = fixture(); const error = new ApiError(409, "stale"); error.code = "RPG_ACTOR_REST_STALE";
    vi.mocked(props.api.commandActorRest!).mockRejectedValue(error); render(<SessionControls {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Short rest for Aria" })); fireEvent.click(await screen.findByRole("button", { name: "Confirm rest" }));
    await screen.findByText(/Server rejected the command without committing/);
    expect(localStorage.getItem(key)).toBeNull(); expect(screen.queryByRole("button", { name: "Confirm rest" })).toBeNull();
    expect(props.api.commandActorRest).toHaveBeenCalledOnce();
  });
  it("never replays completion when a receipt lookup returns no operation", async () => {
    localStorage.setItem(key, JSON.stringify({ review: { kind: "end", target: "battle", label: "Harbor ambush", revision: 3 }, idempotencyKey: "exact-key", confirmed: false }));
    const props = fixture([encounter]); vi.mocked(props.api.getCombatCommandResult!).mockResolvedValue(null as never);
    render(<SessionControls {...props} />); fireEvent.click(screen.getByRole("button", { name: "Recover exact operation" }));
    await screen.findByText(/Outcome uncertain/); expect(props.api.endCombat).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).not.toBeNull();
  });
  it("rejects stale actor permission before opening a review", async () => {
    const props = fixture(); vi.mocked(props.api.getCampaignPlayBootstrap).mockResolvedValue({ ...bootstrap, playableActors: [] });
    render(<SessionControls {...props} />); fireEvent.click(await screen.findByRole("button", { name: "Short rest for Aria" }));
    await screen.findByText(/Readiness or permission changed/); expect(props.api.commandActorRest).not.toHaveBeenCalled();
  });
  it("locks ambiguous encounters and blocks rest during combat", async () => {
    const props = fixture([encounter, { ...encounter, encounterId: "second", combatId: "second", name: "Second fight" }]);
    render(<SessionControls {...props} />); await screen.findByText(/Multiple active encounters/);
    expect((screen.getByRole("button", { name: "Review completion of Harbor ambush" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Short rest for Aria" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(props.onLockChange).toHaveBeenCalledWith(false));
  });
});
