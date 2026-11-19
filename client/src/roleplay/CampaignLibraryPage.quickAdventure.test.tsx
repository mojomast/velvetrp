// Approved test for plan 1.6: the campaign library offers a one-click Quick adventure that
// builds the bundled starter world through the API and opens it straight into play.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuickAdventure, getCampaignAdministration, listCampaigns } from "../api";
import { CampaignLibraryPage } from "./CampaignLibraryPage";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  listCampaigns: vi.fn(),
  createCampaign: vi.fn(),
  getCampaignAdministration: vi.fn(),
  createQuickAdventure: vi.fn(),
}));

const built = { campaignId: "quick-campaign", campaignName: "The Sintermark", sessionId: "quick-room", actorId: "quick-actor", replayed: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function setup() {
  vi.mocked(listCampaigns).mockResolvedValue({ campaigns: [] });
  vi.mocked(getCampaignAdministration).mockRejectedValue(new Error("unused"));
  const onOpen = vi.fn();
  render(<CampaignLibraryPage onBack={vi.fn()} onOpen={onOpen} />);
  return { onOpen, button: () => screen.getByRole("button", { name: /quick adventure/i }) };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("CampaignLibraryPage quick adventure", () => {
  it("builds once per click, shows progress, and opens the new campaign in play", async () => {
    const pending = deferred<typeof built>();
    vi.mocked(createQuickAdventure).mockReturnValue(pending.promise);
    const { onOpen, button } = setup();
    expect(button().textContent).toMatch(/quick adventure/i);

    fireEvent.click(button());
    fireEvent.click(button());
    expect(createQuickAdventure).toHaveBeenCalledTimes(1);
    const [request] = vi.mocked(createQuickAdventure).mock.calls[0]!;
    expect(request.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("status").some((element) => /building/i.test(element.textContent ?? ""))).toBe(true);

    pending.resolve(built);
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("quick-campaign", "play"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("explains a failure, keeps the same key for a retry, and uses a fresh key after success", async () => {
    vi.mocked(createQuickAdventure)
      .mockRejectedValueOnce(new Error("Quick adventure failed at step tactical-map: disk full"))
      .mockResolvedValueOnce(built)
      .mockResolvedValueOnce({ ...built, campaignId: "quick-campaign-2" });
    const { onOpen, button } = setup();

    fireEvent.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/quick adventure could not be started/i);
    expect(alert.textContent).toContain("disk full");
    expect((button() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("quick-campaign", "play"));
    const keys = vi.mocked(createQuickAdventure).mock.calls.map(([request]) => request.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(screen.queryByRole("alert")).toBeNull();

    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("quick-campaign-2", "play"));
    const third = vi.mocked(createQuickAdventure).mock.calls[2]![0].idempotencyKey;
    expect(third).not.toBe(keys[0]);
  });
});
