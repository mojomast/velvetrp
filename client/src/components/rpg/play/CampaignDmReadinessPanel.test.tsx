import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignDmReadinessResponse } from "@velvet/contracts";
import { CampaignDmReadinessPanel } from "./CampaignDmReadinessPanel";

const families = ["locations", "connections", "actors", "quests", "encounters", "story", "clues", "artifacts", "bindings", "evidence"] as const;
const report: CampaignDmReadinessResponse = {
  version: "1.0", identity: { campaignId: "campaign", sessionId: "room", timelineId: "timeline", campaignRevision: 1, timelineRevision: 2 }, mode: "human",
  activationReadiness: { campaignId: "campaign", sessionId: "room", expectedRevision: 1, active: true, ready: true, blockers: [], actorIds: ["actor"] },
  issues: [{ code: "awaiting-play-evidence", severity: "review", scope: "awaiting-play-evidence", reference: { kind: "evidence", id: "evidence" }, label: "Awaiting play evidence", explanation: "The prepared binding is waiting for qualifying committed play evidence.", remediation: "play" }],
  coverage: { state: "partial", families: families.map(family => ({ family, state: family === "story" ? "partial" : "complete", inspected: [], omitted: family === "story" ? [{ kind: "story-node", id: "omitted" }] : [] })) },
  manualReviewLimitations: ["Clue alternatives and fail-forward routes require human review.", "Required paths and endings are not inferred from titles or prose."],
};

afterEach(cleanup);
describe("CampaignDmReadinessPanel", () => {
  it("fetches only after Inspect preparation and keeps activation separate from bounded diagnostics", async () => {
    const getCampaignDmPreparationReadiness = vi.fn().mockResolvedValue(report);
    render(<CampaignDmReadinessPanel campaignId="campaign" sessionId="room" role="owner" api={{ getCampaignDmPreparationReadiness }} />);
    expect(getCampaignDmPreparationReadiness).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Inspect preparation" }));
    await screen.findByText("Awaiting play evidence");
    expect(getCampaignDmPreparationReadiness).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Activation readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Inspection coverage: partial" })).toBeTruthy();
    expect(screen.getByText(/does not declare the campaign solvable/)).toBeTruthy();
    expect(screen.getByText(/continue supported play/)).toBeTruthy();
  });

  it("discards a late inspection when the room changes", async () => {
    let resolve: (value: CampaignDmReadinessResponse) => void = () => undefined;
    const getCampaignDmPreparationReadiness = vi.fn().mockReturnValue(new Promise<CampaignDmReadinessResponse>(r => { resolve = r; }));
    const view = render(<CampaignDmReadinessPanel campaignId="campaign" sessionId="room" role="owner" api={{ getCampaignDmPreparationReadiness }} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect preparation" }));
    view.rerender(<CampaignDmReadinessPanel campaignId="campaign" sessionId="other-room" role="owner" api={{ getCampaignDmPreparationReadiness }} />);
    resolve(report);
    await waitFor(() => expect(screen.queryByText("Awaiting play evidence")).toBeNull());
    expect(screen.getByRole("button", { name: "Inspect preparation" })).toBeTruthy();
  });

  it("clears a private report when GM role changes", async () => {
    const getCampaignDmPreparationReadiness = vi.fn().mockResolvedValue(report);
    const view = render(<CampaignDmReadinessPanel campaignId="campaign" sessionId="room" role="owner" api={{ getCampaignDmPreparationReadiness }} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect preparation" }));
    await screen.findByText("Awaiting play evidence");
    view.rerender(<CampaignDmReadinessPanel campaignId="campaign" sessionId="room" role="gm" api={{ getCampaignDmPreparationReadiness }} />);
    expect(screen.queryByText("Awaiting play evidence")).toBeNull();
    expect(getCampaignDmPreparationReadiness).toHaveBeenCalledOnce();
  });
});
