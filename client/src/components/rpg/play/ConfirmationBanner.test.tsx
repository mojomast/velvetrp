import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationBanner } from "./ConfirmationBanner";

const at = "2030-01-01T00:00:00.000Z";
const proposal = { proposalId: "proposal", position: 0, toolName: "roll", proposedAt: at, confirmation: { state: "pending" as const, expiresAt: "2099-01-01T00:00:00.000Z" } };
const turn = { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", declaration: "Listen", state: "confirmed" as const, revision: 3, createdAt: at, updatedAt: at };

describe("ConfirmationBanner", () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  it("labels AI content and submits one exact selected batch", async () => {
    const confirmAdventureTurn = vi.fn().mockResolvedValue({ turn, resumeToken: "v1.dHVybg.ZGVjaXNpb24" });
    const getAdventureTurn = vi.fn().mockResolvedValue({ turn, proposals: [proposal], confirmation: { state: "decided", decisions: [{ proposalId: "proposal", decision: "approved", decidedAt: at }] }, receipts: [], narrationStatus: { status: "none", text: null } });
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    expect(screen.getByText("AI suggestion", { selector: "strong" })).toBeTruthy(); expect(screen.getByText("Confirmation required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve selected batch" }));
    await waitFor(() => expect(confirmAdventureTurn).toHaveBeenCalledTimes(1));
    expect(confirmAdventureTurn.mock.calls[0]?.[1]).toMatchObject({ proposalIds: ["proposal"], decision: "approve", expectedRevision: 2 });
  });

  it("reconciles an ambiguous mutation by GET and never retries confirmation", async () => {
    const confirmAdventureTurn = vi.fn().mockRejectedValue(new Error("network"));
    const getAdventureTurn = vi.fn().mockResolvedValue({ turn, proposals: [proposal], confirmation: { state: "pending", proposalIds: ["proposal"], expiresAt: proposal.confirmation.expiresAt }, receipts: [], narrationStatus: { status: "none", text: null } });
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject selected batch" }));
    await screen.findByRole("alert");
    expect(confirmAdventureTurn).toHaveBeenCalledTimes(1); expect(getAdventureTurn).toHaveBeenCalledTimes(1);
  });
});
