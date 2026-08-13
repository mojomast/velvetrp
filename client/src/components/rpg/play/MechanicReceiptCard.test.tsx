import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";

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
  it("renders the public travel destination and durable receipt metadata",async()=>{
    const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"travel",destination:"Glass Harbor",
      revisionBefore:7,revisionAfter:8,occurredAt:"2030-01-01T00:00:00.000Z"}});
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"travel-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Travel completed");expect(screen.getByText("Glass Harbor")).toBeTruthy();expect(screen.getByText("World travel revision")).toBeTruthy();expect(screen.getByText("7 → 8")).toBeTruthy();
    expect(getCampaignCommandReceipt).toHaveBeenCalledTimes(1);
  });
  it("scopes requests by campaign and API reader identity",async()=>{
    const link={commandId:"same-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"};
    const first=vi.fn().mockResolvedValue({receipt:{kind:"travel",destination:"First Harbor",revisionBefore:0,revisionAfter:1,occurredAt:"2030-01-01T00:00:00.000Z"}});
    const second=vi.fn().mockResolvedValue({receipt:{kind:"travel",destination:"Second Harbor",revisionBefore:1,revisionAfter:2,occurredAt:"2030-01-01T00:00:00.000Z"}});
    const firstApi={getCampaignCommandReceipt:first},secondApi={getCampaignCommandReceipt:second};
    const view=render(<MechanicReceiptCard campaignId="campaign-a" links={[link]} api={firstApi}/>);await screen.findByText("First Harbor");
    view.rerender(<MechanicReceiptCard campaignId="campaign-b" links={[link]} api={firstApi}/>);expect(screen.queryByText("First Harbor")).toBeNull();expect(screen.getByText("Loading committed mechanic…")).toBeTruthy();
    await screen.findByText("First Harbor");expect(first).toHaveBeenCalledWith("campaign-b","same-command");
    view.rerender(<MechanicReceiptCard campaignId="campaign-b" links={[link]} api={secondApi}/>);expect(screen.queryByText("First Harbor")).toBeNull();expect(screen.getByText("Loading committed mechanic…")).toBeTruthy();
    await screen.findByText("Second Harbor");expect(second).toHaveBeenCalledTimes(1);
  });
  it("evicts rejected requests so a remount can recover",async()=>{
    const read=vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({receipt:{kind:"travel",destination:"Recovered Harbor",revisionBefore:0,revisionAfter:1,occurredAt:"2030-01-01T00:00:00.000Z"}});
    const props={campaignId:"campaign",links:[{commandId:"retry-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}],api:{getCampaignCommandReceipt:read}};
    const view=render(<MechanicReceiptCard {...props}/>);await screen.findByRole("alert");view.unmount();render(<MechanicReceiptCard {...props}/>);await screen.findByText("Recovered Harbor");expect(read).toHaveBeenCalledTimes(2);
  });
  it("deduplicates the StrictMode effect replay while one request is in flight",async()=>{
    let resolve!:(value:Awaited<ReturnType<MechanicReceiptApi["getCampaignCommandReceipt"]>>)=>void;
    const read:MechanicReceiptApi["getCampaignCommandReceipt"]=vi.fn(()=>new Promise<Awaited<ReturnType<MechanicReceiptApi["getCampaignCommandReceipt"]>>>((done)=>{resolve=done;}));
    render(<StrictMode><MechanicReceiptCard campaignId="campaign" links={[{commandId:"strict-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt:read}}/></StrictMode>);
    expect(read).toHaveBeenCalledTimes(1);resolve({receipt:{kind:"travel",destination:"Strict Harbor",revisionBefore:0,revisionAfter:1,occurredAt:"2030-01-01T00:00:00.000Z"}});await screen.findByText("Strict Harbor");expect(read).toHaveBeenCalledTimes(1);
  });
});
