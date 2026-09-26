import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../api";
import { ApiError } from "../../../api";
import { CampaignStartupAction } from "./CampaignStartupAction";

vi.mock("../../../api", async importOriginal => ({ ...await importOriginal<typeof api>(), campaignStartup: vi.fn() }));

const summary: Awaited<ReturnType<typeof api.campaignStartup>> = {
  campaignId: "campaign-one", sessionId: "room-one", dmMode: "ai", dmModeRevision: 1, published: [],
  beat: { runId: "run-one", state: "completed" }, imagesEnqueued: [], blockers: [],
};

function renderAction(role: "owner" | "gm" | "player" | "observer" = "owner", unstarted = true, canAct = true, loaded = true) {
  return render(<CampaignStartupAction campaignId="campaign-one" sessionId="room-one" role={role} canAct={canAct} unstarted={unstarted} loaded={loaded} />);
}

beforeEach(() => { vi.mocked(api.campaignStartup).mockResolvedValue(summary); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("CampaignStartupAction", () => {
  it.each(["player", "observer"] as const)("is hidden from %s principals", role => {
    renderAction(role);
    expect(screen.queryByRole("button", { name: "Start campaign" })).toBeNull();
    expect(api.campaignStartup).not.toHaveBeenCalled();
  });

  it.each(["owner", "gm"] as const)("shows %s an enabled control and never fires on mount", role => {
    renderAction(role);
    const button = screen.getByRole("button", { name: "Start campaign" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(api.campaignStartup).not.toHaveBeenCalled();
  });

  it("keeps the control visible but disabled once the campaign has started", () => {
    renderAction("owner", false);
    const button = screen.getByRole("button", { name: "Start campaign" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.campaignStartup).not.toHaveBeenCalled();
  });

  it("does not claim the campaign already started while director history is loading", () => {
    renderAction("owner", false, true, false);
    expect(screen.getByRole("button", { name: "Start campaign" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(/already has a completed opening scene/)).toBeNull();
    expect(screen.getByText(/Reading director history/)).toBeTruthy();
  });

  it("starts the campaign exactly once with both identifiers on an explicit click", async () => {
    renderAction("gm");
    const button = screen.getByRole("button", { name: "Start campaign" });
    expect(api.campaignStartup).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(api.campaignStartup).toHaveBeenCalledExactlyOnceWith("campaign-one", "room-one"));
    await screen.findByText(/Campaign startup confirmed/);
  });

  it("surfaces startup blockers through the status notice without breaking the view", async () => {
    vi.mocked(api.campaignStartup).mockResolvedValue({ ...summary, beat: { runId: null, state: "blocked" },
      blockers: ["story-public-rendering-required", "scene-resolution-requires-gm-binding-or-human-adjudication"] });
    renderAction("owner");
    fireEvent.click(screen.getByRole("button", { name: "Start campaign" }));
    await screen.findByText(/did not open the campaign/);
    const blockers = screen.getByRole("list", { name: "Campaign startup blockers" });
    expect(blockers.textContent).toContain("story-public-rendering-required");
    expect(blockers.textContent).toContain("scene-resolution-requires-gm-binding-or-human-adjudication");
    expect(screen.getByRole("button", { name: "Start campaign" })).toBeTruthy();
  });

  it("handles a rejected call without retrying or throwing into the render", async () => {
    vi.mocked(api.campaignStartup).mockRejectedValueOnce(new ApiError(409, "conflict"));
    renderAction("gm");
    fireEvent.click(screen.getByRole("button", { name: "Start campaign" }));
    await screen.findByText(/No retry was made/);
    expect(api.campaignStartup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start campaign" })).toBeTruthy();
  });
});
