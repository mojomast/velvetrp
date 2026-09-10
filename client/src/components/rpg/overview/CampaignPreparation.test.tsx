import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../api";
import { CampaignPreparation } from "./CampaignPreparation";

vi.mock("../../../api", async importOriginal => ({ ...await importOriginal<typeof api>(),
  getCampaignDetail: vi.fn(), getCampaignAdministration: vi.fn(), getCampaignAdministrationIntegrations: vi.fn(),
  listCampaignRooms: vi.fn(), listCampaignCharacters: vi.fn(), setupSrd51Starter: vi.fn(), setupOriginalStarter: vi.fn(), setupMechanicsStarter: vi.fn(),
  updateCampaignAdministration: vi.fn(), updateCampaignSessionZeroSafety: vi.fn(), startSession: vi.fn(), attachCampaignRoom: vi.fn(),
}));
const stamp = "2030-01-01T00:00:00.000Z";
const props = { campaignId: "campaign-one", mechanics: true, initialStage: 0, onRead: vi.fn(), onBuilder: vi.fn() };
const policy = { revision: 7, paused: true, hardLimits: ["No torture"], veils: ["Injury"], pvpPolicy: "disallowed" as const, romancePolicy: "explicit-consent" as const, lethalityPolicy: "consent-required" as const };
const room = { sessionId: "opaque-room", title: "Crossing", participantNames: ["Rowan"], createdAt: stamp, stopped: false };
function authority(role: "owner" | "gm" | "player" | "observer" = "owner", configured = false, status: "draft" | "published" = "draft") {
  vi.mocked(api.getCampaignDetail).mockResolvedValue({ campaign: { id: props.campaignId, name: "Salt Road", actorRole: role, content: configured ? { status: "configured", rulesProfileId: "rules-one", contentPacks: [] } : { status: "unconfigured" }, createdAt: stamp, updatedAt: stamp } });
  const base = { id: props.campaignId, status, revision: 7, activeTimelineId: "timeline-one", updatedAt: stamp };
  const settings = { maxPlayers: 4, safetyMode: "strict" as const, allowPlayerDice: true, recapVisibility: "members" as const };
  vi.mocked(api.getCampaignAdministration).mockResolvedValue({ campaign: role === "owner" || role === "gm" ? { ...base, actorRole: role, settings: { ...settings, gmNotes: "" } } : { ...base, actorRole: role, settings } });
  // Only fields consumed by the component are mocked; transport schema tests own wire validation.
  vi.mocked(api.getCampaignAdministrationIntegrations).mockResolvedValue({ campaignId: props.campaignId, actorRole: role, revision: 7, safety: structuredClone(policy) } as Awaited<ReturnType<typeof api.getCampaignAdministrationIntegrations>>);
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); authority();
  vi.mocked(api.listCampaignRooms).mockResolvedValue({ attached: [], eligible: [room] });
  vi.mocked(api.listCampaignCharacters).mockResolvedValue({ characters: [{ id: "actor-one", characterId: "persona-one", name: "Rowan" }] });
});
afterEach(cleanup);
async function open(stage = 0) {
  const page = render(<CampaignPreparation {...props} initialStage={stage} />);
  await screen.findByText(/Current preparation read/);
  return page;
}
async function reconcile() {
  fireEvent.click(screen.getByRole("button", { name: "Read current preparation" }));
  await screen.findByText(/Current preparation read/);
}
describe("progressive campaign preparation", () => {
  it("installs only the explicitly chosen starter, never publishes the campaign", async () => {
    await open();
    expect(screen.queryByRole("textbox", { name: "Room title" })).toBeNull();
    const install = screen.getByRole("button", { name: "Install selected starter once" });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Rules package"), { target: { value: "srd" } });
    fireEvent.click(screen.getByLabelText(/I confirm this starter installation/));
    fireEvent.click(install);
    await screen.findByText(/Server response confirmed/);
    expect(api.setupSrd51Starter).toHaveBeenCalledExactlyOnceWith("campaign-one");
    expect(api.setupOriginalStarter).not.toHaveBeenCalled();
    expect(api.updateCampaignAdministration).not.toHaveBeenCalled();
  });
  it("requires read reconciliation for uncertain multi-transaction starter setup across remount", async () => {
    vi.mocked(api.setupSrd51Starter).mockRejectedValue(new TypeError("lost"));
    const page = await open();
    fireEvent.change(screen.getByLabelText("Rules package"), { target: { value: "srd" } });
    fireEvent.click(screen.getByLabelText(/I confirm this starter installation/));
    fireEvent.click(screen.getByRole("button", { name: "Install selected starter once" }));
    await screen.findByText(/Write outcome uncertain/);
    page.unmount(); await open();
    expect(screen.queryByRole("button", { name: /Retry exact/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Install selected starter once" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    expect(api.setupSrd51Starter).toHaveBeenCalledOnce();
  });
  it("does not replace an existing rules configuration", async () => {
    authority("owner", true); await open();
    expect(screen.queryByLabelText("Rules package")).toBeNull();
    expect(api.setupSrd51Starter).not.toHaveBeenCalled();
  });
  it.each(["gm", "player", "observer"] as const)("does not grant %s owner-only setup/publication", async role => {
    authority(role, true); await open(2);
    expect((screen.getByRole("button", { name: "Publish campaign" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    expect(api.updateCampaignAdministration).not.toHaveBeenCalled();
  });
  it.each(["gm", "player", "observer"] as const)("does not show %s the owner-only completion control", async role => {
    authority(role, true, "published"); await open(2);
    expect(screen.queryByRole("button", { name: "Mark campaign complete" })).toBeNull();
  });
  it("completes a published campaign with explicit confirmation, current revision, and receipt", async () => {
    authority("owner", true, "published");
    vi.mocked(api.updateCampaignAdministration).mockResolvedValue({ campaign: { id: props.campaignId, actorRole: "owner", status: "completed", revision: 8 }, receipt: { revisionAfter: 8 } } as Awaited<ReturnType<typeof api.updateCampaignAdministration>>);
    await open(2);
    fireEvent.click(screen.getByLabelText("I confirm that this published campaign is complete."));
    fireEvent.click(screen.getByRole("button", { name: "Mark campaign complete" }));
    await screen.findByText("Campaign marked completed. Receipt confirmed at revision 8.");
    expect(api.updateCampaignAdministration).toHaveBeenCalledExactlyOnceWith("campaign-one", { expectedRevision: 7, idempotencyKey: expect.any(String), status: "completed" });
  });
  it("persists an uncertain completion and only retries the exact command after a current-state read", async () => {
    authority("owner", true, "published");
    vi.mocked(api.updateCampaignAdministration).mockRejectedValueOnce(new TypeError("lost"));
    const page = await open(2);
    fireEvent.click(screen.getByLabelText("I confirm that this published campaign is complete."));
    fireEvent.click(screen.getByRole("button", { name: "Mark campaign complete" }));
    await screen.findByText(/Write outcome uncertain/);
    const command = vi.mocked(api.updateCampaignAdministration).mock.calls[0]![1];
    page.unmount(); await open(2);
    expect(api.updateCampaignAdministration).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact complete command" }));
    await waitFor(() => expect(vi.mocked(api.updateCampaignAdministration).mock.calls[1]![1]).toEqual(command));
  });
  it.each(["player", "observer"] as const)("does not grant %s safety or room writes", async role => {
    authority(role); await open(1);
    expect((screen.getByRole("button", { name: "Save reviewed safety agreement" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "4. Rooms" }));
    expect((screen.getByRole("button", { name: "Attach Crossing" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
  });
  it("preserves existing safety, uses the read revision, and retries the exact command after remount", async () => {
    authority("gm");
    vi.mocked(api.updateCampaignSessionZeroSafety).mockRejectedValueOnce(new TypeError("lost"));
    const page = await open(1);
    expect((screen.getByLabelText("Hard limits, one per line") as HTMLTextAreaElement).value).toBe("No torture");
    expect((screen.getByLabelText("Romance policy") as HTMLSelectElement).value).toBe("explicit-consent");
    expect(api.updateCampaignSessionZeroSafety).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I reviewed the complete agreement/));
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed safety agreement" }));
    await screen.findByText(/Write outcome uncertain/);
    const input = vi.mocked(api.updateCampaignSessionZeroSafety).mock.calls[0]![1];
    expect(input).toEqual({ expectedRevision: 7, idempotencyKey: expect.any(String), hardLimits: ["No torture"], veils: ["Injury"], pvpPolicy: "disallowed", romancePolicy: "explicit-consent", lethalityPolicy: "consent-required" });
    page.unmount(); await open(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact safety command" }));
    await screen.findByText(/Server response confirmed/);
    expect(vi.mocked(api.updateCampaignSessionZeroSafety).mock.calls[1]![1]).toEqual(input);
    expect(api.updateCampaignAdministration).not.toHaveBeenCalled();
  });
  it("keeps uncertain publication identity even if a later exact retry is rejected", async () => {
    authority("owner", true);
    vi.mocked(api.updateCampaignAdministration).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new api.ApiError(409, "conflict"));
    const page = await open(2);
    expect(api.updateCampaignAdministration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I reviewed the rules and safety/));
    fireEvent.click(screen.getByRole("button", { name: "Publish campaign" }));
    await screen.findByText(/Write outcome uncertain/);
    page.unmount(); await open(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact publish command" }));
    await screen.findByText(/Write outcome uncertain/);
    expect(vi.mocked(api.updateCampaignAdministration).mock.calls[1]![1]).toEqual(vi.mocked(api.updateCampaignAdministration).mock.calls[0]![1]);
    expect(localStorage.getItem("velvet.preparation.v1:campaign-one")).not.toBeNull();
  });
  it("requires fresh authority after a definitive first rejection", async () => {
    authority("owner", true);
    vi.mocked(api.updateCampaignAdministration).mockRejectedValue(new api.ApiError(403, "forbidden"));
    await open(2);
    fireEvent.click(screen.getByLabelText(/I reviewed the rules and safety/));
    fireEvent.click(screen.getByRole("button", { name: "Publish campaign" }));
    await screen.findByText(/Command rejected/);
    expect(screen.queryByRole("button", { name: "Publish campaign" })).toBeNull();
    expect(localStorage.getItem("velvet.preparation.v1:campaign-one")).toBeNull();
  });
  it("attaches an explicit opaque room without creating or activating one", async () => {
    await open(3);
    fireEvent.click(screen.getAllByLabelText("I confirm the selected room operation.")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Attach Crossing" }));
    await screen.findByText(/Server response confirmed/);
    expect(api.attachCampaignRoom).toHaveBeenCalledExactlyOnceWith("campaign-one", { sessionId: "opaque-room" });
    expect(api.startSession).not.toHaveBeenCalled();
  });
  it("never retries uncertain creation or auto-attaches a title match", async () => {
    vi.mocked(api.startSession).mockRejectedValue(new TypeError("lost"));
    const page = await open(3);
    fireEvent.click(screen.getByText("Create a new room"));
    fireEvent.change(screen.getByLabelText("Room title"), { target: { value: "Crossing" } });
    fireEvent.click(screen.getByLabelText("Rowan"));
    fireEvent.click(screen.getAllByLabelText("I confirm the selected room operation.")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Create room once" }));
    await screen.findByText(/Write outcome uncertain/);
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith({ characterIds: ["persona-one"], primaryCharacterId: "persona-one", title: "Crossing" });
    page.unmount(); await open(3); await reconcile();
    expect(api.startSession).toHaveBeenCalledOnce(); expect(api.attachCampaignRoom).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Retry exact/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "I reviewed current state; allow a new decision" }));
    expect(api.startSession).toHaveBeenCalledOnce();
  });
  it("fails closed on read errors and unavailable recovery storage", async () => {
    vi.mocked(api.getCampaignAdministrationIntegrations).mockRejectedValueOnce(new TypeError("unavailable"));
    render(<CampaignPreparation {...props} />);
    await screen.findByText(/Preparation could not be read/);
    expect(screen.queryByLabelText("Rules package")).toBeNull();
    await reconcile();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    fireEvent.change(screen.getByLabelText("Rules package"), { target: { value: "srd" } });
    fireEvent.click(screen.getByLabelText(/I confirm this starter installation/));
    fireEvent.click(screen.getByRole("button", { name: "Install selected starter once" }));
    await screen.findByText(/Safe recovery storage is unavailable/);
    expect(api.setupSrd51Starter).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it("does not duplicate a pending write when clicked twice", async () => {
    let finish!: () => void;
    vi.mocked(api.attachCampaignRoom).mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as Awaited<ReturnType<typeof api.attachCampaignRoom>>); }));
    await open(3);
    fireEvent.click(screen.getAllByLabelText("I confirm the selected room operation.")[0]!);
    const attach = screen.getByRole("button", { name: "Attach Crossing" });
    fireEvent.click(attach); fireEvent.click(attach);
    expect(api.attachCampaignRoom).toHaveBeenCalledOnce();
    finish(); await waitFor(() => expect(screen.getByText(/Server response confirmed/)).toBeTruthy());
  });
});
