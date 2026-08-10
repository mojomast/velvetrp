import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import { ConfirmationBanner } from "./ConfirmationBanner";

const at = "2030-01-01T00:00:00.000Z";
const proposal = { proposalId: "proposal", position: 0, toolName: "roll", proposedAt: at,
  policy:{version:"v1" as const,category:"ambiguous-consequential-change" as const,requiresConfirmation:true,requiredAuthorizer:"controller" as const,
    review:{summary:"Apply a consequential change.",consequences:[{kind:"campaign-change" as const,text:"Campaign state may change"}]}},
  confirmation: { state: "pending" as const, expiresAt: "2099-01-01T00:00:00.000Z" } };
const turn = { turnId: "turn", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original" as const, priorTurnId: null, declaration: "Listen", state: "confirmed" as const, revision: 3, createdAt: at, updatedAt: at };
const binding = { campaignId: "campaign", sessionId: "session", actorId: "actor", turnId: "turn" };

describe("ConfirmationBanner", () => {
  afterEach(() => { cleanup(); localStorage.clear(); });
  it("labels AI content and submits one exact selected batch", async () => {
    const confirmAdventureTurn = vi.fn().mockResolvedValue({ turn, resumeToken: "v1.dHVybg.ZGVjaXNpb24" });
    const getAdventureTurn = vi.fn().mockResolvedValue({ turn, proposals: [proposal], confirmation: { state: "decided", decisions: [{ proposalId: "proposal", decision: "approved", decidedAt: at }] }, receipts: [], narrationStatus: { status: "none", text: null } });
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    expect(screen.getByText("AI suggestion", { selector: "strong" })).toBeTruthy(); expect(screen.getByText("Confirmation required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve selected batch" }));
    await waitFor(() => expect(confirmAdventureTurn).toHaveBeenCalledTimes(1));
    expect(confirmAdventureTurn.mock.calls[0]?.[1]).toMatchObject({ proposalIds: ["proposal"], decision: "approve", expectedRevision: 2 });
    expect(confirmAdventureTurn.mock.calls[0]?.[2]).toEqual(binding);
  });

  it("reconciles an ambiguous mutation by GET and never retries confirmation", async () => {
    const confirmAdventureTurn = vi.fn().mockRejectedValue(new Error("network"));
    const getAdventureTurn = vi.fn().mockResolvedValue({ turn, proposals: [proposal], confirmation: { state: "pending", proposalIds: ["proposal"], expiresAt: proposal.confirmation.expiresAt }, receipts: [], narrationStatus: { status: "none", text: null } });
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject selected batch" }));
    await screen.findByRole("alert");
    expect(confirmAdventureTurn).toHaveBeenCalledTimes(1); expect(getAdventureTurn).toHaveBeenCalledTimes(1);
  });

  it("unlocks after a deterministic confirmation rejection without reconciling", async () => {
    const confirmAdventureTurn = vi.fn().mockRejectedValue(new ApiError(409, "stale"));
    const getAdventureTurn = vi.fn();
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve selected batch" }));
    await screen.findByRole("alert");
    expect(getAdventureTurn).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Approve selected batch" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("resets a sending banner when the pending revision changes", async () => {
    let resolveConfirmation!: (value: { turn: typeof turn }) => void;
    const confirmAdventureTurn = vi.fn().mockReturnValue(new Promise<{ turn: typeof turn }>((resolve) => { resolveConfirmation = resolve; }));
    const getAdventureTurn = vi.fn();
    const { rerender } = render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve selected batch" }));
    expect((screen.getByRole("button", { name: "Approve selected batch" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ConfirmationBanner turnId="turn" revision={3} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={vi.fn()} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve selected batch" }) as HTMLButtonElement).disabled).toBe(false));
    resolveConfirmation({ turn });
    await waitFor(() => expect((screen.getByRole("button", { name: "Approve selected batch" }) as HTMLButtonElement).disabled).toBe(false));
    expect(getAdventureTurn).not.toHaveBeenCalled();
  });

  it.each(["approved", "rejected"] as const)("recovers a lost %s response token by GET without replaying confirm", async (decision) => {
    const confirmAdventureTurn = vi.fn().mockRejectedValue(new Error("lost response"));
    const recovered = { turn: { ...turn, state: decision === "approved" ? "confirmed" as const : "cancelled" as const }, proposals: [proposal],
      confirmation: { state: "decided" as const, decisions: [{ proposalId: "proposal", decision, decidedAt: at }] }, receipts: [],
      narrationStatus: { status: "none" as const, text: null }, resumeToken: "v1.dHVybg.ZGlnZXN0" };
    const getAdventureTurn = vi.fn().mockResolvedValue(recovered); const onReconciled = vi.fn();
    render(<ConfirmationBanner turnId="turn" revision={2} proposals={[proposal]} proposalIds={["proposal"]} expiresAt={proposal.confirmation.expiresAt}
      binding={binding} api={{ confirmAdventureTurn, getAdventureTurn }} onReconciled={onReconciled} />);
    fireEvent.click(screen.getByRole("button", { name: decision === "approved" ? "Approve selected batch" : "Reject selected batch" }));
    await waitFor(() => expect(onReconciled).toHaveBeenCalledWith(recovered, recovered.resumeToken));
    expect(confirmAdventureTurn).toHaveBeenCalledTimes(1); expect(getAdventureTurn).toHaveBeenCalledWith("turn", binding);
  });
});
