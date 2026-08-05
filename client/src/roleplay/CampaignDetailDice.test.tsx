import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCampaignCharacterCreationOptions, getCampaignDetail, getCampaignDiceHistory, listCampaignCharacters, listCampaignRooms, rollCampaignDice } from "../api";
import { CampaignDetailPage, resetCampaignDetailPageModuleStateForTests } from "./CampaignDetailPage";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  getCampaignDetail: vi.fn(),
  getCampaignDiceHistory: vi.fn(),
  rollCampaignDice: vi.fn(),
  listCampaignCharacters: vi.fn(),
  getCampaignCharacterCreationOptions: vi.fn(),
  listCampaignRooms: vi.fn(),
}));

const campaign = {
  id: "campaign-private-id", name: "Visible campaign", actorRole: "owner" as const,
  createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z",
  content: { status: "unconfigured" as const },
};
const characters = [{ position: 1, name: "Shared name" }, { position: 2, name: "Shared name" }];
const roll = {
  character: characters[1]!, occurredAt: "2030-01-03T04:05:06.000Z",
  result: {
    expression: "4d6kh3+2", normalized: { count: 4, sides: 6, selection: { type: "keep_highest" as const, count: 3 }, modifier: 2 },
    terms: [{ value: 6, kept: true }, { value: 4, kept: true }, { value: 3, kept: true }, { value: 1, kept: false }],
    modifier: 2, total: 15,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function typedApiError(status: number, code: string): ApiError {
  const error = new ApiError(status, "private server detail");
  error.code = code;
  return error;
}

async function issueRoll(waitForEmptyHistory = true) {
  if (waitForEmptyHistory) await screen.findByText("No rolls yet.");
  else await screen.findByText("15");
  fireEvent.change(screen.getByLabelText("Character"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Expression"), { target: { value: roll.result.expression } });
  fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
}

beforeEach(() => {
  vi.mocked(getCampaignDetail).mockResolvedValue({ campaign });
  vi.mocked(listCampaignCharacters).mockRejectedValue(new ApiError(404, "unsupported"));
  vi.mocked(getCampaignCharacterCreationOptions).mockRejectedValue(new ApiError(404, "unsupported"));
  vi.mocked(getCampaignDiceHistory).mockResolvedValue({ characters, rolls: [] });
  vi.mocked(listCampaignRooms).mockResolvedValue({ attached: [], eligible: [] });
});

afterEach(() => {
  cleanup();
  resetCampaignDetailPageModuleStateForTests();
  vi.resetAllMocks();
});

describe("campaign detail dice", () => {
  it("is feature-and-role gated while its independent StrictMode history read is reused", async () => {
    const hidden = render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled={false} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: campaign.name });
    expect(screen.queryByRole("heading", { name: "Dice" })).toBeNull();
    expect(getCampaignDiceHistory).not.toHaveBeenCalled();
    hidden.unmount();

    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: { ...campaign, actorRole: "player" } });
    const player = render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: campaign.name });
    expect(screen.queryByRole("heading", { name: "Dice" })).toBeNull();
    expect(getCampaignDiceHistory).not.toHaveBeenCalled();
    player.unmount();

    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: { ...campaign, actorRole: "gm" } });
    render(<StrictMode><CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Dice" })).toBeTruthy();
    await screen.findByText("No rolls yet.");
    expect(getCampaignDiceHistory).toHaveBeenCalledOnce();
  });

  it("renders duplicate names positionally and physical kept/discarded terms without private identities", async () => {
    vi.mocked(getCampaignDiceHistory).mockResolvedValue({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Dice" });
    const options = (await screen.findByLabelText("Character")).querySelectorAll("option");
    expect(Array.from(options).map((option) => [option.value, option.textContent])).toEqual([
      ["1", "Character 1 of 2 — Shared name"], ["2", "Character 2 of 2 — Shared name"],
    ]);
    expect(screen.getByText("6 (kept)")).toBeTruthy();
    expect(screen.getByText("1 (discarded)")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    const html = document.body.outerHTML;
    expect(html).not.toContain(campaign.id);
    expect(html).not.toMatch(/campaign-character|actor-|timeline-|revision|command-|event-|receipt-|idempotency/i);
  });

  it("serializes one POST, blocks navigation, then confirms with exactly one fresh history GET", async () => {
    const pending = deferred<{ roll: typeof roll }>();
    vi.mocked(rollCampaignDice).mockReturnValue(pending.promise);
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    const back = vi.fn();
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={back} onUnavailable={vi.fn()} />);
    await screen.findByText("No rolls yet.");
    fireEvent.change(screen.getByLabelText("Character"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Expression"), { target: { value: roll.result.expression } });
    const form = screen.getByRole("button", { name: "Roll dice" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    const backButton = screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement;
    expect(backButton.disabled).toBe(true);
    fireEvent.click(backButton);
    expect(back).not.toHaveBeenCalled();

    pending.resolve({ roll });
    await screen.findByText("The server confirmed the roll was committed. Latest roll history was refreshed.");
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByText("15")).toBeTruthy();
    expect(backButton.disabled).toBe(false);
    expect(document.activeElement).toBe(screen.getByText("The server confirmed the roll was committed. Latest roll history was refreshed."));
  });

  it("never attributes an identity-free matching roll to an ambiguous network attempt", async () => {
    vi.mocked(rollCampaignDice).mockRejectedValue(new TypeError("private network detail"));
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll();
    await screen.findByText(/remains unknown and cannot be attributed/i);
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Expression") as HTMLInputElement).value).toBe(roll.result.expression);
    expect(screen.getByRole("button", { name: "Refresh rolls" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roll dice" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private network detail");
  });

  it("uses the 201 alone as attribution when identical history projections cannot identify the roll", async () => {
    vi.mocked(rollCampaignDice).mockResolvedValue({ roll });
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [roll] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll(false);
    expect(await screen.findByText("The server confirmed the roll was committed. Latest roll history was refreshed.")).toBeTruthy();
    expect(screen.queryByText(/confirmed in|present in|not present in/i)).toBeNull();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    expect(rollCampaignDice).toHaveBeenCalledOnce();
  });

  it.each([
    ["network", new TypeError("network private")],
    ["500", new ApiError(500, "server private")],
    ["malformed success", new Error("success response did not match contract")],
  ])("keeps %s outcomes ambiguous without attributing an identical preexisting roll", async (_label, failure) => {
    vi.mocked(rollCampaignDice).mockRejectedValue(failure);
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [roll] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll(false);
    expect(await screen.findByText(/attempt remains unknown and cannot be attributed/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain(failure.message);
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
  });

  it.each([
    [409, "RPG_CAMPAIGN_DICE_BINDING_CONFLICT", /not committed because the character selection changed/i],
    [404, "RPG_CAMPAIGN_NOT_FOUND", /not committed because campaign dice became unavailable/i],
  ])("shows typed %i as a known non-commit while still reconciling history", async (status, code, message) => {
    vi.mocked(rollCampaignDice).mockRejectedValue(typedApiError(status, code));
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByText(/unknown|try again|retry/i)).toBeNull();
    expect(screen.getByText("15")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Roll dice" })).toBeTruthy();
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps an ambiguous failed-history warning visible and recomputes it after GET-only refresh", async () => {
    vi.mocked(rollCampaignDice).mockRejectedValue(new TypeError("network private"));
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockRejectedValueOnce(new Error("history private"))
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll();
    const failed = await screen.findByText(/attempt remains unknown, and the latest roll history could not be loaded/i);
    await waitFor(() => expect(document.activeElement).toBe(failed));
    expect(screen.getByRole("button", { name: "Refresh rolls" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry roll history" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh rolls" }));
    const refreshed = await screen.findByText(/history was refreshed, but the earlier roll attempt remains unknown/i);
    await waitFor(() => expect(document.activeElement).toBe(refreshed));
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.getByText("15")).toBeTruthy();
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(3);
  });

  it("survives unmount and reopen without a second POST and keeps the document warning through reconciliation", async () => {
    const pending = deferred<{ roll: typeof roll }>();
    vi.mocked(rollCampaignDice).mockReturnValue(pending.promise);
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    const props = { campaignId: campaign.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    await screen.findByText("No rolls yet.");
    fireEvent.change(screen.getByLabelText("Character"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Expression"), { target: { value: roll.result.expression } });
    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    first.unmount();

    render(<CampaignDetailPage {...props} />);
    await screen.findByRole("heading", { name: campaign.name });
    expect(screen.getByRole("button", { name: "← Campaigns" }).hasAttribute("disabled")).toBe(true);
    pending.resolve({ roll });
    await screen.findByText("The server confirmed the roll was committed. Latest roll history was refreshed.");
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
  });

  it("retains a completed unmounted handoff through StrictMode replay without an extra history GET", async () => {
    const pending = deferred<{ roll: typeof roll }>();
    vi.mocked(rollCampaignDice).mockReturnValue(pending.promise);
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    const props = { campaignId: campaign.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    await issueRoll();
    first.unmount();
    pending.resolve({ roll });
    await pending.promise;
    await waitFor(() => expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2));

    render(<StrictMode><CampaignDetailPage {...props} /></StrictMode>);
    const outcome = await screen.findByText("The server confirmed the roll was committed. Latest roll history was refreshed.");
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(screen.getByText("15")).toBeTruthy();
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
  });

  it("broadcasts one exact dice reconciliation to every mounted same-campaign peer", async () => {
    const initial = deferred<{ characters: typeof characters; rolls: [] }>();
    const write = deferred<{ roll: typeof roll }>();
    vi.mocked(getCampaignDiceHistory)
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    vi.mocked(rollCampaignDice).mockReturnValue(write.promise);
    const props = { campaignId: campaign.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    const second = render(<CampaignDetailPage {...props} />);
    initial.resolve({ characters, rolls: [] });
    await within(first.container).findByText("No rolls yet.");
    await within(second.container).findByText("No rolls yet.");
    const firstUi = within(first.container);
    fireEvent.change(firstUi.getByLabelText("Character"), { target: { value: "2" } });
    fireEvent.change(firstUi.getByLabelText("Expression"), { target: { value: roll.result.expression } });
    fireEvent.click(firstUi.getByRole("button", { name: "Roll dice" }));
    write.resolve({ roll });
    await within(first.container).findByText(/server confirmed the roll was committed/i);
    await within(second.container).findByText(/server confirmed the roll was committed/i);
    expect(within(first.container).getByText("15")).toBeTruthy();
    expect(within(second.container).getByText("15")).toBeTruthy();
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps peer dice completion authoritative when peer detail settles later without an extra GET", async () => {
    const peerDetail = deferred<{ campaign: typeof campaign }>();
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign })
      .mockReturnValueOnce(peerDetail.promise);
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] })
      .mockRejectedValueOnce(new Error("would-be delayed detail history failure"));
    vi.mocked(rollCampaignDice).mockResolvedValue({ roll });
    const props = { campaignId: campaign.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const owner = render(<CampaignDetailPage {...props} />);
    await within(owner.container).findByText("No rolls yet.");
    const peer = render(<CampaignDetailPage {...props} />);
    const ownerUi = within(owner.container);
    fireEvent.change(ownerUi.getByLabelText("Character"), { target: { value: "2" } });
    fireEvent.change(ownerUi.getByLabelText("Expression"), { target: { value: roll.result.expression } });
    fireEvent.click(ownerUi.getByRole("button", { name: "Roll dice" }));
    await ownerUi.findByText(/server confirmed the roll was committed/i);

    peerDetail.resolve({ campaign });
    const peerUi = within(peer.container);
    await peerUi.findByText(/server confirmed the roll was committed/i);
    expect(peerUi.getByText("15")).toBeTruthy();
    await Promise.resolve();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("would-be delayed detail history failure");
  });

  it("retains a peer completion when pending detail unmounts, then consumes it on StrictMode reopen", async () => {
    const peerDetail = deferred<{ campaign: typeof campaign }>();
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign })
      .mockReturnValueOnce(peerDetail.promise)
      .mockResolvedValue({ campaign });
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] });
    vi.mocked(rollCampaignDice).mockResolvedValue({ roll });
    const props = { campaignId: campaign.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const owner = render(<CampaignDetailPage {...props} />);
    await within(owner.container).findByText("No rolls yet.");
    const peer = render(<CampaignDetailPage {...props} />);

    const ownerUi = within(owner.container);
    fireEvent.change(ownerUi.getByLabelText("Character"), { target: { value: "2" } });
    fireEvent.change(ownerUi.getByLabelText("Expression"), { target: { value: roll.result.expression } });
    fireEvent.click(ownerUi.getByRole("button", { name: "Roll dice" }));
    await ownerUi.findByText(/server confirmed the roll was committed/i);
    peer.unmount();
    peerDetail.resolve({ campaign });
    owner.unmount();

    render(<StrictMode><CampaignDetailPage {...props} /></StrictMode>);
    expect(await screen.findByText(/server confirmed the roll was committed/i)).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
    expect(rollCampaignDice).toHaveBeenCalledOnce();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
  });

  it("validates canonical grammar before network and supports history error retry focus", async () => {
    vi.mocked(getCampaignDiceHistory)
      .mockRejectedValueOnce(new Error("private read"))
      .mockResolvedValueOnce({ characters, rolls: [] });
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry roll history" });
    expect(document.body.textContent).not.toContain("private read");
    fireEvent.click(retry);
    await screen.findByText("No rolls yet.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Dice" })));
    fireEvent.change(screen.getByLabelText("Expression"), { target: { value: "d20" } });
    fireEvent.click(screen.getByRole("button", { name: "Roll dice" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/canonical dice notation/i);
    expect(rollCampaignDice).not.toHaveBeenCalled();
  });

  it("synchronously locks rapid pointer and keyboard activation of history Retry", async () => {
    const pending = deferred<{ characters: typeof characters; rolls: typeof roll[] }>();
    vi.mocked(getCampaignDiceHistory)
      .mockRejectedValueOnce(new Error("initial private read"))
      .mockReturnValueOnce(pending.promise);
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry roll history" });

    fireEvent.click(retry);
    fireEvent.keyDown(retry, { key: "Enter" });
    retry.click();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);

    pending.resolve({ characters, rolls: [] });
    await screen.findByText("No rolls yet.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Dice" })));
  });

  it("synchronously locks rapid pointer and keyboard activation of Refresh without affecting reconciliation GET", async () => {
    const refreshPending = deferred<{ characters: typeof characters; rolls: typeof roll[] }>();
    vi.mocked(rollCampaignDice).mockRejectedValue(new TypeError("network private"));
    vi.mocked(getCampaignDiceHistory)
      .mockResolvedValueOnce({ characters, rolls: [] })
      .mockResolvedValueOnce({ characters, rolls: [roll] })
      .mockReturnValueOnce(refreshPending.promise);
    render(<CampaignDetailPage campaignId={campaign.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await issueRoll();
    await screen.findByText(/attempt remains unknown and cannot be attributed/i);
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(2);
    const refresh = screen.getByRole("button", { name: "Refresh rolls" });

    fireEvent.click(refresh);
    fireEvent.keyDown(refresh, { key: " " });
    refresh.click();
    expect(getCampaignDiceHistory).toHaveBeenCalledTimes(3);

    refreshPending.resolve({ characters, rolls: [roll] });
    const status = await screen.findByText(/history was refreshed, but the earlier roll attempt remains unknown/i);
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(rollCampaignDice).toHaveBeenCalledOnce();
  });
});
