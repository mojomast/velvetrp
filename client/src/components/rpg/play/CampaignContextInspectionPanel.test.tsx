import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignDmRun } from "@velvet/contracts";
import { CampaignContextInspectionPanel, type CampaignContextInspectionApi } from "./CampaignContextInspectionPanel";

const run: CampaignDmRun = { runId: "run", campaignId: "campaign", sessionId: "room", intent: "continue", mode: "ai", modeRevision: 0, revision: 1, state: "completed", narration: null, receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" };
const references = { version: "1.0" as const, identity: { campaignId: "campaign", sessionId: "room", source: { kind: "adventure-turn" as const, sourceId: "turn" } }, references: [{ lane: "adventure-planning" as const, dispatchId: "dispatch" }] };
const available = { version: "1.0" as const, identity: { campaignId: "campaign", sessionId: "room", lane: "adventure-planning" as const, dispatchId: "dispatch" }, availability: "available" as const,
  dispatch: { recordedPhase: "planned" as const, certainty: "provider-receipt-confirmed" as const, settlement: "settled" as const },
  sections: [{ status: "included" as const, kind: "safety" as const, label: "Safety boundary", authority: "system-safety" as const, text: "Keep the scene safe.", displayedUtf8Bytes: 20 }, { status: "withheld" as const, kind: "recall" as const, reason: "private-source" as const }],
  recallHits: [], usage: { storedRecallPacketUtf8Bytes: null, storedMessageContentUtf8Bytes: null, serializedStoredRequestUtf8Bytes: null, displayedSafeResponseUtf8Bytes: 20, reportedPromptTokens: null, reportedCompletionTokens: null, reservedPromptTokens: null, reservedCompletionTokens: null } };
function api(): CampaignContextInspectionApi {
  return { getCampaignContextInspectionReferences: vi.fn().mockResolvedValue(references), getCampaignContextInspection: vi.fn().mockResolvedValue(available) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("CampaignContextInspectionPanel", () => {
  it("only reads after explicit source and dispatch actions and renders safe semantics", async () => {
    const client = api(); const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<CampaignContextInspectionPanel campaignId="campaign" sessionId="room" role="owner" runs={[run]} currentTurnId="turn" api={client} />);
    expect(client.getCampaignContextInspectionReferences).not.toHaveBeenCalled(); expect(client.getCampaignContextInspection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "adventure-turn:turn" } });
    expect(client.getCampaignContextInspectionReferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load dispatch references" }));
    await screen.findByRole("option", { name: "Adventure planning (dispatch)" });
    expect(client.getCampaignContextInspectionReferences).toHaveBeenCalledWith("campaign", "room", { kind: "adventure-turn", sourceId: "turn" });
    expect(client.getCampaignContextInspection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Recorded dispatch"), { target: { value: "adventure-planning:dispatch" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect selected dispatch" }));
    expect(await screen.findByText("Keep the scene safe.")).toBeTruthy();
    expect(screen.getByText(/source is private/)).toBeTruthy();
    expect(screen.getAllByText("Withheld or not reported").length).toBeGreaterThan(0);
    expect(client.getCampaignContextInspection).toHaveBeenCalledWith("campaign", "room", "adventure-planning", "dispatch");
    expect(storage).not.toHaveBeenCalled();
  });

  it("clears immediately on source change and discards a late reference response", async () => {
    let resolve!: (value: typeof references) => void;
    const client = api(); vi.mocked(client.getCampaignContextInspectionReferences).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<CampaignContextInspectionPanel campaignId="campaign" sessionId="room" role="gm" runs={[run]} currentTurnId="turn" api={client} />);
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "adventure-turn:turn" } }); fireEvent.click(screen.getByRole("button", { name: "Load dispatch references" }));
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "director-run:run" } });
    await act(async () => resolve(references));
    expect(screen.queryByLabelText("Recorded dispatch")).toBeNull();
    expect(screen.queryByText("Loading dispatch references...")).toBeNull();
  });

  it("discards a late inspection response after the exact source changes", async () => {
    let resolve!: (value: typeof available) => void;
    const client = api(); vi.mocked(client.getCampaignContextInspection).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<CampaignContextInspectionPanel campaignId="campaign" sessionId="room" role="gm" runs={[run]} currentTurnId="turn" api={client} />);
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "adventure-turn:turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Load dispatch references" }));
    await screen.findByLabelText("Recorded dispatch");
    fireEvent.change(screen.getByLabelText("Recorded dispatch"), { target: { value: "adventure-planning:dispatch" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect selected dispatch" }));
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "director-run:run" } });
    await act(async () => resolve(available));
    expect(screen.queryByText("Keep the scene safe.")).toBeNull();
    expect(screen.queryByText("Loading safe context inspection...")).toBeNull();
  });

  it("clears inspected data on campaign changes and renders unavailable without unsafe detail", async () => {
    const client = api(); vi.mocked(client.getCampaignContextInspection).mockResolvedValue({ version: "1.0", identity: { campaignId: "campaign", sessionId: "room", lane: "adventure-planning", dispatchId: "dispatch" }, availability: "unavailable", reason: "provenance-corrupt" });
    const view = render(<CampaignContextInspectionPanel campaignId="campaign" sessionId="room" role="owner" runs={[run]} currentTurnId="turn" api={client} />);
    fireEvent.change(screen.getByLabelText("Turn or director run"), { target: { value: "adventure-turn:turn" } }); fireEvent.click(screen.getByRole("button", { name: "Load dispatch references" }));
    await screen.findByLabelText("Recorded dispatch"); fireEvent.change(screen.getByLabelText("Recorded dispatch"), { target: { value: "adventure-planning:dispatch" } }); fireEvent.click(screen.getByRole("button", { name: "Inspect selected dispatch" }));
    expect(await screen.findByText("The recorded provenance could not be safely read.")).toBeTruthy();
    view.rerender(<CampaignContextInspectionPanel campaignId="other" sessionId="room" role="owner" runs={[]} api={client} />);
    await waitFor(() => expect(screen.queryByText("The recorded provenance could not be safely read.")).toBeNull());
    expect((screen.getByLabelText("Turn or director run") as HTMLSelectElement).value).toBe("");
  });
});
