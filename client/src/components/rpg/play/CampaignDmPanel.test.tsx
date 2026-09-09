import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignDmHistory, CampaignDmRun, CampaignPlayBootstrap } from "@velvet/contracts";
import { CampaignDmPanel, type CampaignDmApi } from "./CampaignDmPanel";

const bootstrap: CampaignPlayBootstrap = { campaignId: "campaign", sessionId: "room", expectedRevision: 1, dm: { mode: "human", revision: 0 }, session: { attached: true, attachedAt: "2030-01-01T00:00:00.000Z", active: true, adventureEligible: true }, principal: { role: "owner", control: "all" }, capabilities: { campaignDice: { canView: true, canRoll: true } }, playableActors: [{ actorId: "actor", name: "Aria" }] };
const run: CampaignDmRun = { runId: "run", campaignId: "campaign", sessionId: "room", intent: "open", mode: "human", modeRevision: 0, revision: 1, state: "awaiting-approval", narration: null, receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" };
function fixture(mode: "human" | "ai" = "human", runs: CampaignDmRun[] = []) {
  const history: CampaignDmHistory = { control: { campaignId: "campaign", mode, revision: 0 }, runs };
  const api: CampaignDmApi = {
    commandCampaignDmSceneBinding: vi.fn().mockImplementation(async (_campaign, request) => request),
    getBindingStory: vi.fn().mockResolvedValue({ revision: 12, data: { storylines: [{ storylineId: "story", title: "Harbor mystery" }], nodes: [{ nodeId: "scene", storylineId: "story", title: "Open the sluice", status: "revealed" }] } }),
    getBindingQuests: vi.fn().mockResolvedValue({ revision: 99, data: { quests: [{ questId: "quest", title: "Save the harbor" }], objectives: [{ questId: "quest", objectiveId: "objective", description: "Restore the gate" }] } }),
    listCampaignEncounters: vi.fn().mockResolvedValue({ encounters: [{ encounterId: "encounter", sessionId: "room", name: "Gate guardians", status: "active" }, { encounterId: "elsewhere", sessionId: "other-room", name: "Private other room fight", status: "active" }] }),
    getCampaignDmHistory: vi.fn().mockImplementation(async () => ({ ...history, runs: [...history.runs] })),
    getCampaignDmPreparationReadiness: vi.fn(),
    getCampaignDmRun: vi.fn().mockImplementation(async () => history.runs[0]),
    getCampaignDmProposal: vi.fn().mockResolvedValue({ run, proposal: { candidateId: "candidate", digest: "a".repeat(64), action: "reveal-node", label: "Reveal the harbor" } }),
    commandCampaignDmBeat: vi.fn().mockImplementation(async () => { history.runs = [run]; return run; }),
    commandCampaignDmDecision: vi.fn().mockImplementation(async () => { history.runs = [{ ...run, state: "completed" }]; return history.runs[0]; }),
    commandCampaignDmMode: vi.fn().mockImplementation(async (_campaign, input) => { history.control = { campaignId: "campaign", mode: input.mode, revision: input.expectedRevision + 1 }; return history.control; }),
    resumeCampaignDmRun: vi.fn(),
  };
  const props = { bootstrap, api, blocked: false, canAct: true, onHistory: vi.fn(), onLockChange: vi.fn(), onStateChange: vi.fn() };
  return { props, api, history };
}
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
describe("Campaign DM controls", () => {
  it("loads named GM choices only on demand and binds fresh story revision after explicit review", async () => {
    const { props, api } = fixture(); render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    expect(api.getBindingStory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Prepare scene resolution (GM only)"));
    fireEvent.click(screen.getByText("Load scene preparation choices"));
    await screen.findByRole("option", { name: "Harbor mystery: Open the sluice" });
    expect(screen.queryByRole("option", { name: /Private other room/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Scene"), { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("Resolution evidence"), { target: { value: "quest-objective:objective" } });
    const prior = await api.getBindingStory("campaign"); vi.mocked(api.getBindingStory).mockResolvedValue({ ...prior, revision: 15 });
    fireEvent.click(screen.getByText("Review scene binding"));
    await screen.findByText(/Fresh story revision: 15/);
    expect(api.commandCampaignDmSceneBinding).not.toHaveBeenCalled();
    expect(props.onLockChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByText("Confirm scene binding"));
    await waitFor(() => expect(api.commandCampaignDmSceneBinding).toHaveBeenCalledWith("campaign", { nodeId: "scene", evidence: { kind: "quest-objective", targetId: "objective" }, expectedStoryRevision: 15, idempotencyKey: expect.any(String) }));
    await waitFor(() => expect(props.onLockChange).toHaveBeenLastCalledWith(false));
    expect(api.commandCampaignDmBeat).not.toHaveBeenCalled();
  });
  it("retains the exact encounter binding after ambiguity and reload, and GET never clears or replays it", async () => {
    const { props, api } = fixture(); vi.mocked(api.commandCampaignDmSceneBinding).mockRejectedValue(new Error("lost"));
    const view = render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Prepare scene resolution (GM only)")); fireEvent.click(screen.getByText("Load scene preparation choices"));
    await screen.findByLabelText("Scene");
    fireEvent.change(screen.getByLabelText("Scene"), { target: { value: "scene" } });
    fireEvent.change(screen.getByLabelText("Resolution evidence"), { target: { value: "encounter:encounter" } });
    fireEvent.click(screen.getByText("Review scene binding")); await screen.findByText("Confirm scene binding");
    fireEvent.click(screen.getByText("Confirm scene binding")); await screen.findByText("Recover exact DM request");
    const request = vi.mocked(api.commandCampaignDmSceneBinding).mock.calls[0]![1];
    expect(request.evidence).toEqual({ kind: "encounter", targetId: "encounter" });
    view.unmount(); render(<CampaignDmPanel {...props} />); await screen.findByText("Recover exact DM request");
    fireEvent.click(screen.getByText("Refresh DM state")); await act(async () => window.dispatchEvent(new Event("focus")));
    expect(api.commandCampaignDmSceneBinding).toHaveBeenCalledOnce();
    expect(props.onLockChange).toHaveBeenLastCalledWith(true);
    expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Recover exact DM request"));
    await waitFor(() => expect(api.commandCampaignDmSceneBinding).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.commandCampaignDmSceneBinding).mock.calls[1]![1]).toEqual(request);
  });
  it("withholds all preparation reads and writes from players even with a saved GM binding", async () => {
    const { props, api } = fixture("ai");
    localStorage.setItem("velvet.dm.v1:campaign:room", JSON.stringify({ kind: "binding", request: { nodeId: "scene", evidence: { kind: "encounter", targetId: "encounter" }, expectedStoryRevision: 12, idempotencyKey: "binding-key" } }));
    render(<CampaignDmPanel {...props} bootstrap={{ ...bootstrap, principal: { role: "player", control: "controlled" } }} />);
    await screen.findByText("Recover exact DM request");
    expect(screen.queryByText("Prepare scene resolution (GM only)")).toBeNull();
    fireEvent.click(screen.getByText("Recover exact DM request"));
    expect(api.getBindingStory).not.toHaveBeenCalled(); expect(api.getBindingQuests).not.toHaveBeenCalled();
    expect(api.listCampaignEncounters).not.toHaveBeenCalled(); expect(api.commandCampaignDmSceneBinding).not.toHaveBeenCalled();
  });
  it("explains semantic binding and public rendering blockers without exposing private story text", async () => {
    const { props } = fixture("human", [{ ...run, state: "blocked", blockers: ["scene-resolution-requires-gm-binding-or-human-adjudication", "story-public-rendering-required"] }]);
    render(<CampaignDmPanel {...props} />);
    await screen.findByText(/take over and adjudicate the scene manually/);
    expect(screen.getByText(/do not reveal secrets to remove this blocker/)).toBeTruthy();
    expect(screen.queryByText(/scene-resolution-requires-gm-binding-or-human-adjudication/)).toBeNull();
  });
  it("allows a player to request an AI beat but not a human suggestion", async () => {
    const { props, api, history } = fixture("ai");
    const view = render(<CampaignDmPanel {...props} bootstrap={{ ...bootstrap, principal: { role: "player", control: "controlled" } }} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Open scene")); await waitFor(() => expect(api.commandCampaignDmBeat).toHaveBeenCalledOnce());
    expect(api.getCampaignDmProposal).not.toHaveBeenCalled();
    view.unmount(); localStorage.clear(); history.control.mode = "human"; history.runs = [];
    render(<CampaignDmPanel {...props} bootstrap={{ ...bootstrap, principal: { role: "player", control: "controlled" } }} />);
    await screen.findByRole("heading", { name: "Human DM" });
    expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Review AI delegation")).toBeNull();
  });
  it("recovers the exact mode request after reload without dispatching a beat", async () => {
    const { props, api } = fixture(); vi.mocked(api.commandCampaignDmMode).mockRejectedValueOnce(new Error("lost"));
    const view = render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Review AI delegation") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Review AI delegation")); fireEvent.click(screen.getByText("Confirm AI delegation"));
    await screen.findByText("Recover exact mode request");
    const original = vi.mocked(api.commandCampaignDmMode).mock.calls[0]![1]; view.unmount();
    render(<CampaignDmPanel {...props} />); await screen.findByText("Recover exact mode request");
    expect(api.commandCampaignDmMode).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Recover exact mode request"));
    await waitFor(() => expect(api.commandCampaignDmMode).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.commandCampaignDmMode).mock.calls[1]![1]).toEqual(original);
    expect(api.commandCampaignDmBeat).not.toHaveBeenCalled();
  });
  it("recovers an ambiguous approval with its original run revision and key", async () => {
    const { props, api } = fixture("human", [run]); vi.mocked(api.commandCampaignDmDecision).mockRejectedValue(new Error("lost"));
    const view = render(<CampaignDmPanel {...props} />); await screen.findByText("Approve exact proposal");
    fireEvent.click(screen.getByText("Approve exact proposal")); await screen.findByText("Recover exact DM request");
    const original = vi.mocked(api.commandCampaignDmDecision).mock.calls[0]![3]; view.unmount();
    render(<CampaignDmPanel {...props} />); await screen.findByText("Recover exact DM request");
    expect(api.commandCampaignDmDecision).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Recover exact DM request"));
    await waitFor(() => expect(api.commandCampaignDmDecision).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.commandCampaignDmDecision).mock.calls[1]![3]).toEqual(original);
  });
  it("locks unreadable recovery storage without automatically posting", async () => {
    localStorage.setItem("velvet.dm.v1:campaign:room", "not-json");
    const { props, api } = fixture("ai"); render(<CampaignDmPanel {...props} />);
    await screen.findByText(/Recovery storage is unreadable/);
    expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(true);
    expect(api.commandCampaignDmBeat).not.toHaveBeenCalled();
  });
  it("requires explicit delegation review and confirmation without starting provider work", async () => {
    const { props, api } = fixture(); render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Review AI delegation") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Review AI delegation"));
    expect(api.commandCampaignDmMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm AI delegation"));
    await waitFor(() => expect(api.commandCampaignDmMode).toHaveBeenCalledOnce());
    expect(api.commandCampaignDmMode).toHaveBeenCalledWith("campaign", { mode: "ai", expectedRevision: 0, idempotencyKey: expect.any(String) });
    expect(api.commandCampaignDmBeat).not.toHaveBeenCalled(); expect(api.resumeCampaignDmRun).not.toHaveBeenCalled();
  });
  it("opens a human suggestion, privately reviews it, and explicitly approves the exact revision", async () => {
    const { props, api } = fixture(); render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Open scene"));
    await screen.findByText("Reveal the harbor");
    expect(api.commandCampaignDmBeat).toHaveBeenCalledWith("campaign", "room", { intent: "open", expectedModeRevision: 0, idempotencyKey: expect.any(String) });
    expect(api.commandCampaignDmDecision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Approve exact proposal"));
    await waitFor(() => expect(api.commandCampaignDmDecision).toHaveBeenCalledWith("campaign", "room", "run", { decision: "approved", expectedRevision: 1, idempotencyKey: expect.any(String) }));
    await waitFor(() => expect(props.onLockChange).toHaveBeenLastCalledWith(false));
  });
  it("never fetches private proposals for a player, including on refresh", async () => {
    const { props, api } = fixture("ai", [run]); render(<CampaignDmPanel {...props} bootstrap={{ ...bootstrap, principal: { role: "player", control: "controlled" } }} />);
    await screen.findByText(/Director run: awaiting-approval/);
    fireEvent.click(screen.getByText("Refresh DM state"));
    await waitFor(() => expect(api.getCampaignDmHistory).toHaveBeenCalledTimes(2));
    expect(api.getCampaignDmProposal).not.toHaveBeenCalled(); expect(screen.queryByText("Approve exact proposal")).toBeNull();
  });
  it("retains an ambiguous beat across reload and only explicitly replays its identical key", async () => {
    const { props, api } = fixture("ai"); vi.mocked(api.commandCampaignDmBeat).mockRejectedValue(new Error("lost"));
    const view = render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Open scene")); await screen.findByText("Recover exact DM request");
    const request = vi.mocked(api.commandCampaignDmBeat).mock.calls[0]![2]; view.unmount();
    render(<CampaignDmPanel {...props} />); await screen.findByText("Recover exact DM request");
    fireEvent.click(screen.getByText("Refresh DM state"));
    await waitFor(() => expect(api.getCampaignDmHistory).toHaveBeenCalledTimes(3));
    expect(api.commandCampaignDmBeat).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Recover exact DM request"));
    await waitFor(() => expect(api.commandCampaignDmBeat).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.commandCampaignDmBeat).mock.calls[1]![2]).toEqual(request);
  });
  it("keeps takeover available even while the beat POST is still in flight", async () => {
    const { props, api } = fixture("ai"); vi.mocked(api.commandCampaignDmBeat).mockReturnValue(new Promise(() => undefined));
    render(<CampaignDmPanel {...props} />);
    await waitFor(() => expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Open scene"));
    fireEvent.click(screen.getByText("Take over")); fireEvent.click(screen.getByText("Confirm human takeover"));
    await waitFor(() => expect(api.commandCampaignDmMode).toHaveBeenCalledOnce());
    expect(api.commandCampaignDmBeat).toHaveBeenCalledOnce();
  });
  it("does not resume planning on mount or focus and leaves unknown outcomes locked", async () => {
    const { props, api } = fixture("ai", [{ ...run, state: "unknown" }]);
    localStorage.setItem("velvet.dm.v1:campaign:room", JSON.stringify({ kind: "run", runId: "run" }));
    render(<CampaignDmPanel {...props} />); await screen.findByText(/An outcome is unknown/);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(api.commandCampaignDmBeat).not.toHaveBeenCalled(); expect(api.resumeCampaignDmRun).not.toHaveBeenCalled();
    expect(screen.queryByText("Resume saved run")).toBeNull(); expect(props.onLockChange).toHaveBeenLastCalledWith(true);
  });
  it("binds continue evidence only when supplied and prevents a second opening", async () => {
    const { props, api } = fixture("ai", [{ ...run, state: "completed" }]);
    render(<CampaignDmPanel {...props} evidenceTurnId="committed-turn" />);
    await waitFor(() => expect((screen.getByText("Continue scene") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Continue scene"));
    expect(api.commandCampaignDmBeat).toHaveBeenCalledWith("campaign", "room", expect.objectContaining({ intent: "continue", evidenceTurnId: "committed-turn" }));
  });
  it("blocks beats behind room locks but allows an explicit takeover", async () => {
    const { props, api } = fixture("ai"); render(<CampaignDmPanel {...props} blocked />);
    await waitFor(() => expect((screen.getByText("Take over") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByText("Open scene") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Take over")); fireEvent.click(screen.getByText("Confirm human takeover"));
    await waitFor(() => expect(api.commandCampaignDmMode).toHaveBeenCalledOnce());
  });
});
