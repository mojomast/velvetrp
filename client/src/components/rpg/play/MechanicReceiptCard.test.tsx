import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import type { CampaignHistoryHttpPublicReceiptResponse } from "@velvet/contracts";
import { describe, expect, it, vi } from "vitest";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";

describe("MechanicReceiptCard", () => {
  it("renders exact combat consumable rolls, targets, costs, and outcomes",async()=>{const response={receipt:{kind:"combat-consumable",itemName:"Fire Tonic",target:"Gloam Mite",quantity:1,actionCost:"action",outcomes:[{kind:"damage",damageType:"fire",roll:{expression:"1d4",normalized:{count:1,sides:4,modifier:0,selection:{type:"all"}},terms:[{value:3,kept:true}],modifier:0,total:3},requested:3,adjustment:"resistance",applied:1,before:8,after:7}],roundBefore:1,roundAfter:1,revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}}satisfies CampaignHistoryHttpPublicReceiptResponse,getCampaignCommandReceipt=vi.fn().mockResolvedValue(response),view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",proposalId:"private-proposal",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);await screen.findByText("1 Fire Tonic");expect(screen.getByText("Gloam Mite")).toBeTruthy();expect(screen.getByText("One action")).toBeTruthy();expect(screen.getByText("3 rolled, 1 fire damage (resistance)")).toBeTruthy();expect(screen.getByText("2 → 3")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-|candidateId|combatantId|entryId|definitionId/);view.unmount();});
  it("renders a redacted authoritative combat power receipt",async()=>{const response={receipt:{kind:"combat-power",powerName:"Ember Orb (single-target development spell)",target:"Gloam Mite",actionCost:"action",costs:[{label:"Level 1 spell slot",before:1,after:0}],outcomes:[{kind:"damage",damageType:"fire",roll:{expression:"2d6",normalized:{count:2,sides:6,modifier:0,selection:{type:"all"}},terms:[{value:2,kept:true},{value:2,kept:true}],modifier:0,total:4},requested:4,adjustment:"resistance",applied:2,before:8,after:6}],concentration:false,roundBefore:1,roundAfter:1,revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}}satisfies CampaignHistoryHttpPublicReceiptResponse,getCampaignCommandReceipt=vi.fn().mockResolvedValue(response),view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",proposalId:"private-proposal",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);await screen.findByText("Ember Orb (single-target development spell)");expect(screen.getByText("Gloam Mite")).toBeTruthy();expect(screen.getByText("4 rolled, 2 fire damage (resistance)")).toBeTruthy();expect(screen.getByText("1 → 0")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-|candidateId|combatantId|actorId|definitionId|digest/);view.unmount();});
  it("renders vendor commerce labels, price, and safe wallet delta",async()=>{const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"commerce",action:"sell",vendorLabel:"Mara",shopLabel:"Mara's Goods",itemLabel:"Waylamp",quantity:1,currencyLabel:"Glimmer",priceMinorUnits:4,debitMinorUnits:0,creditMinorUnits:4,balanceBefore:30,balanceAfter:34,revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}}),view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",proposalId:"private-proposal",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);await screen.findByText("Mara at Mara's Goods");expect(screen.getByText("4 Glimmer")).toBeTruthy();expect(screen.getByText("30 → 34")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-|shopId|npcId/);view.unmount();});
  it("renders redacted power costs, targets, effects, and concentration",async()=>{const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"power",powerName:"Sheltering Glow",targets:["Briar"],costs:[{label:"Level 1 spell slot",before:1,after:0}],stateDeltas:[{actor:"Briar",change:"Effect applied",before:null,after:null}],concentration:true,revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}}),view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",proposalId:"private-proposal",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);await screen.findByText("Sheltering Glow");expect(screen.getAllByText("Briar")).toHaveLength(2);expect(screen.getByText("1 → 0")).toBeTruthy();expect(screen.getByText("Effect applied")).toBeTruthy();expect(screen.getByText("Active")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-|actorId|effectId|slotId/);view.unmount();});
  it("renders exact short-rest recovery",async()=>{const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"rest",restKind:"short",restName:"Short rest",recovery:[{label:"Focus",before:0,after:2}],revisionBefore:0,revisionAfter:1,occurredAt:"2030-01-01T00:00:00.000Z"}}),view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"rest-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);await screen.findByText("Short rest");expect(screen.getByText("Focus")).toBeTruthy();expect(screen.getByText("0 → 2")).toBeTruthy();view.unmount();});
  it("renders an exact public inventory receipt",async()=>{const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"inventory",itemLabel:"Waylamp",action:"gift",quantity:1,slot:null,recipient:"Briar",revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}});
    const view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",proposalId:"private-proposal",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Inventory action");expect(screen.getByText("gift")).toBeTruthy();expect(screen.getByText("1 Waylamp")).toBeTruthy();expect(screen.getByText("Briar")).toBeTruthy();expect(screen.getByText("2 → 3")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-/);view.unmount();});
  it("renders an understandable redacted SRD check receipt",async()=>{
    const receipt={kind:"check",checkKind:"skill",ability:"Wisdom",skill:"Perception",mode:"advantage",difficulty:"Hard",
      rolls:[{value:7,kept:false},{value:18,kept:true}],abilityModifier:2,proficiencyBonus:3,modifier:5,total:23,dc:20,
      outcome:"success",revisionBefore:0,revisionAfter:1,occurredAt:"2030-01-01T00:00:00.000Z"} as const;
    const read=vi.fn().mockResolvedValue({receipt});const view=render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"private-command",
      proposalId:null,linkedAt:receipt.occurredAt}]} api={{getCampaignCommandReceipt:read}}/>);
    await screen.findByText("Perception (Wisdom)");expect(screen.getByText("7 — discarded")).toBeTruthy();expect(screen.getByText("18 — kept")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();expect(screen.getByText("+3")).toBeTruthy();expect(screen.getByText("Hard (DC 20)")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private-command|candidate|actor|principal|provider|revision/i);view.unmount();
  });
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
  it("resolves and renders an authoritative generalized combat receipt without private IDs",async()=>{
    const response = { receipt: { kind: "combat", revisionBefore: 4, revisionAfter: 5, occurredAt: "2030-01-01T00:00:00.000Z",
      action: "attack", outcome: { kind: "damage", damageType: "physical", requested: 1, applied: 1,
        hitPointsBefore: 8, hitPointsAfter: 7, statusAfter: "active" }, roundBefore: 1, roundAfter: 2 } } satisfies CampaignHistoryHttpPublicReceiptResponse;
    const getCampaignCommandReceipt=vi.fn().mockResolvedValue(response);
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"combat-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Combat update");expect(screen.getByText("Attack")).toBeTruthy();expect(screen.getByText("1 physical damage")).toBeTruthy();
    expect(screen.getByText("7 HP, active")).toBeTruthy();expect(screen.getByText("1 → 2")).toBeTruthy();expect(getCampaignCommandReceipt).toHaveBeenCalledWith("campaign","combat-command");
    expect(document.body.textContent).not.toMatch(/combat-command|actionId|legalActionId|combatant/i);
  });
  it("renders a generalized combat action with no target outcome",async()=>{
    const response = { receipt: { kind: "combat", revisionBefore: 4, revisionAfter: 5, occurredAt: "2030-01-01T00:00:00.000Z",
      action: "end-turn", outcome: { kind: "none" }, roundBefore: 1, roundAfter: 2 } } satisfies CampaignHistoryHttpPublicReceiptResponse;
    const getCampaignCommandReceipt=vi.fn().mockResolvedValue(response);
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"combat-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Combat update");expect(screen.getByText("End turn")).toBeTruthy();expect(screen.getByText("No direct target outcome")).toBeTruthy();
  });
  it("renders the public travel destination and durable receipt metadata",async()=>{
    const getCampaignCommandReceipt=vi.fn().mockResolvedValue({receipt:{kind:"travel",destination:"Glass Harbor",
      revisionBefore:7,revisionAfter:8,occurredAt:"2030-01-01T00:00:00.000Z"}});
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"travel-command",proposalId:null,linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Travel completed");expect(screen.getByText("Glass Harbor")).toBeTruthy();expect(screen.getByText("World travel revision")).toBeTruthy();expect(screen.getByText("7 → 8")).toBeTruthy();
    expect(getCampaignCommandReceipt).toHaveBeenCalledTimes(1);
  });
  it("renders public quest progress and completion without private IDs", async () => {
    const response = { receipt: { kind: "quest", title: "The Sealed Gate", objectiveDescription: "Break the final seal",
      progressBefore: 2, progressAfter: 3, target: 3, objectiveCompleted: true, questCompleted: true,
      revisionBefore: 8, revisionAfter: 9, occurredAt: "2030-01-01T00:00:00.000Z" } } satisfies CampaignHistoryHttpPublicReceiptResponse;
    const getCampaignCommandReceipt = vi.fn().mockResolvedValue(response);
    render(<MechanicReceiptCard campaignId="campaign" links={[{ commandId: "quest-command", proposalId: null,
      linkedAt: "2030-01-01T00:00:00.000Z" }]} api={{ getCampaignCommandReceipt }} />);
    await screen.findByText("Quest progress");
    expect(screen.getByText("The Sealed Gate")).toBeTruthy();
    expect(screen.getByText("Break the final seal")).toBeTruthy();
    expect(screen.getByText("2 → 3 / 3")).toBeTruthy();
    expect(screen.getAllByText("Completed")).toHaveLength(2);
    expect(screen.getByText("8 → 9")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/quest-command|questId|objectiveId|candidateId|providerCallId|digest/);
  });
  it("renders safe quest lifecycle and progression summaries",async()=>{
    const getCampaignCommandReceipt=vi.fn().mockResolvedValueOnce({receipt:{kind:"quest-lifecycle",action:"claim-reward",questTitle:"The Sealed Gate",statusBefore:"completed",statusAfter:"completed",reward:{label:"Gate bounty",kind:"Currency",amount:12,recipient:"Aster"},revisionBefore:4,revisionAfter:5,occurredAt:"2030-01-01T00:00:00.000Z"}}).mockResolvedValueOnce({receipt:{kind:"progression",className:"Lantern Warden",levelBefore:1,levelAfter:2,features:["Mending Light"],resources:[{label:"Focus",before:0,after:1}],revisionBefore:2,revisionAfter:3,occurredAt:"2030-01-01T00:00:00.000Z"}});
    render(<MechanicReceiptCard campaignId="campaign" links={[{commandId:"quest-private",proposalId:"proposal-private",linkedAt:"2030-01-01T00:00:00.000Z"},{commandId:"progression-private",proposalId:"proposal-private-2",linkedAt:"2030-01-01T00:00:00.000Z"}]} api={{getCampaignCommandReceipt}}/>);
    await screen.findByText("Quest action");await screen.findByText("Character progression");expect(screen.getByText(/12 Currency.*Gate bounty/)).toBeTruthy();expect(screen.getAllByText("1 → 2").length).toBeGreaterThan(0);expect(screen.getByText("Mending Light")).toBeTruthy();expect(document.body.textContent).not.toMatch(/private|candidateId|digest|actorId|rewardId|previewToken/);
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
