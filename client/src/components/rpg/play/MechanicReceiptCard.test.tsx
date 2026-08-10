import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MechanicReceiptCard } from "./MechanicReceiptCard";

describe("MechanicReceiptCard", () => {
  it("deduplicates links and renders exact physical dice terms without inferred fields", async () => {
    const getCampaignCommandReceipt = vi.fn().mockResolvedValue({ receipt: { kind: "mechanic", revisionBefore: 2, revisionAfter: 3,
      occurredAt: "2030-01-01T00:00:00.000Z", event: { type: "actor_dice_rolled", data: { expression: "2d20adv+2",
        normalized: { count: 2, sides: 20, selection: { type: "advantage" }, modifier: 2 }, terms: [{ value: 7, kept: false }, { value: 18, kept: true }], modifier: 2, total: 20 } } } });
    const link = { commandId: "command", proposalId: "proposal", linkedAt: "2030-01-01T00:00:00.000Z" };
    render(<MechanicReceiptCard campaignId="campaign" links={[link, link]} api={{ getCampaignCommandReceipt }} />);
    await screen.findByText("2d20adv+2");
    expect(getCampaignCommandReceipt).toHaveBeenCalledTimes(1);
    expect(screen.getByText("7 — discarded")).toBeTruthy(); expect(screen.getByText("18 — kept")).toBeTruthy();
    expect(screen.getAllByText("Not recorded for this mechanic")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Committed mechanics" })).toBeTruthy();
  });
  it("resolves and renders an authoritative generalized combat receipt",async()=>{
    const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"combat",revisionBefore:4,revisionAfter:5,occurredAt:"2030-01-01T00:00:00.000Z",
      roundBefore:1,roundAfter:2}});
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"combat-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Combat update");expect(screen.getByText("Action resolved")).toBeTruthy();expect(screen.getByText("1 → 2")).toBeTruthy();expect(getCampaignCommandReceipt).toHaveBeenCalledWith("campaign","combat-command");
  });
});
