import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AdventureTurnStreamEvent } from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignConversation } from "./CampaignConversation";

const at = "2030-01-01T00:00:00.000Z";
const turn = { turnId: "current", campaignId: "campaign", sessionId: "session", actorId: "actor", mode: "original" as const, priorTurnId: null, declaration: "Open the gate", state: "completed" as const, revision: 3, createdAt: at, updatedAt: at };

describe("CampaignConversation", () => {
  afterEach(cleanup);

  it("renders legacy history, durable turns oldest first, and every live event in one log", () => {
    const prefill = vi.fn();
    const events = [
      { type: "turn_started", sequence: 0, timestamp: at, payload: { turn } },
      { type: "agent_status", sequence: 1, timestamp: at, payload: { status: "planning" } },
      { type: "tool_proposed", sequence: 2, timestamp: at, payload: { proposal: { proposalId: "proposal", position: 0, toolName: "actor-check", proposedAt: at, policy: { version: "v1", category: "deterministic-roll", requiresConfirmation: false, requiredAuthorizer: "controller", review: { summary: "Resolve the check", consequences: [{ kind: "roll-recorded", text: "A roll is recorded" }] } }, confirmation: { state: "not-required" } } } },
      { type: "mechanics_committed", sequence: 3, timestamp: at, payload: { receipts: [{ commandId: "command", proposalId: "proposal", linkedAt: at }] } },
      { type: "narration_delta", sequence: 4, timestamp: at, payload: { text: "The gate opens." } },
      { type: "choice", sequence: 5, timestamp: at, payload: { choices: [
        { family: "travel", label: "Travel: Lantern Quay → Keeper House", target: "Keeper House", candidateId: "candidate-1" },
        { family: "commerce", label: "buy: Lantern oil at the quay stall → Keeper Maren", target: "Keeper Maren", candidateId: null },
      ] } },
      { type: "confirmation_required", sequence: 6, timestamp: at, payload: { proposalIds: ["proposal"], expiresAt: at } },
      { type: "terminal", sequence: 7, timestamp: at, payload: { outcome: "done", turn, narrationStatus: { status: "completed", text: "The gate opens.", source: "provider-assisted" }, receipts: [{ commandId: "command", proposalId: "proposal", linkedAt: at }] } },
    ] as AdventureTurnStreamEvent[];
    render(<CampaignConversation transcript={[{ turnId: "older", actorId: "actor", declaration: "First action", narration: "First answer", completedAt: at }, { turnId: "newer", actorId: "actor", declaration: "Second action", narration: "Second answer", completedAt: at }]}
      transcriptState="ready" legacyMessages={[{ id: "legacy", sessionId: "session", role: "user", speakerCharacterId: null, content: "Legacy hello", createdAt: at }]}
      legacyParticipants={[]} current={null} liveEvents={events} actorNames={new Map([["actor", "Aria"]])} onPrefillChoice={prefill} canPrefill />);
    const log = screen.getByRole("log"); expect(screen.getAllByRole("log")).toHaveLength(1); expect(log.textContent).toContain("Read-only pre-campaign history");
    expect(log.textContent!.indexOf("First action")).toBeLessThan(log.textContent!.indexOf("Second action"));
    expect(log.textContent).toMatch(/planning|Proposed mechanic|Waiting for confirmation|receipt committed|The gate opens|Turn done/);
    // Advertised affordances render as explicit controls but never fire on their own.
    expect(prefill).not.toHaveBeenCalled();
    const travel = screen.getByRole("button", { name: "Suggested action: Travel: Lantern Quay → Keeper House" });
    expect(screen.getByRole("button", { name: "Suggested action: buy: Lantern oil at the quay stall → Keeper Maren" })).toBeTruthy();
    fireEvent.click(travel); expect(prefill).toHaveBeenCalledTimes(1); expect(prefill).toHaveBeenCalledWith("Travel: Lantern Quay → Keeper House");
  });
});
