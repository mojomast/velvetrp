import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CombatActionCommandResponse, CombatReadResponse } from "@velvet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombatTrackerPage, type CombatTrackerApi } from "./CombatTrackerPage";
import { InitiativeRail } from "./InitiativeRail";
import { LegalActionTray } from "./LegalActionTray";
import { PowerLibraryPanel } from "./PowerLibraryPanel";
import {ApiError} from "../../../api";

const at = "2030-01-01T00:00:00.000Z";
const combat: CombatReadResponse = {
  round: 2, currentCombatant: "combatant-one", revision: 4,
  combatants: [
    { combatantId: "combatant-one", kind: "actor", actorId: "actor-one", team: "allies", hitPoints: 8, maximumHitPoints: 10, status: "active" },
    { combatantId: "combatant-two", kind: "enemy", template: null, team: "enemies", hitPoints: 3, maximumHitPoints: 5, status: "active" },
  ],
  legalActions: [
    { legalActionId: "legal-attack", kind: "attack", targetIds: ["combatant-two"] },
    { legalActionId: "future-power", kind: "power", targetIds: ["combatant-two"] },
    { legalActionId: "legal-flee", kind: "flee", targetIds: [] },
    { legalActionId: "legal-end", kind: "end-turn", targetIds: [] },
  ],
};
const response: CombatActionCommandResponse = {
  resolution: { actionId: "action-one", legalActionId: "legal-attack", kind: "attack", actingCombatantId: "combatant-one", targetIds: ["combatant-two"], outcomes: [{ kind: "damage", targetId: "combatant-two", damageType: "physical", requested: 1, applied: 1, hitPointsBefore: 3, hitPointsAfter: 2, statusBefore: "active", statusAfter: "active" }], roundBefore: 2, roundAfter: 2, currentCombatantBefore: "combatant-one", currentCombatantAfter: "combatant-two" },
  combat: { combatId: "combat-one", ...combat, currentCombatant: "combatant-two", revision: 5, combatants: [combat.combatants[0]!, { ...combat.combatants[1]!, hitPoints: 2 }], legalActions: [] },
  receipt: { idempotencyKey: "command-key", revisionBefore: 4, revisionAfter: 5, occurredAt: at },
};
const emptyPowers = { known: [], prepared: [], slots: [], uses: [], legalNow: [], legalCommands: [], revision: 0 } as const;
const emptyEffects = { effects: [], concentration: [], revision: 0 } as const;
const consumable={legalActionId:"consume:legal",kind:"use-consumable" as const,actingCombatantId:"combatant-one",inventoryEntryId:"entry",item:{kind:"item" as const,packId:"pack",packVersion:"1",definitionId:"tonic"},quantity:1 as const,actionCost:"action" as const,targetPolicy:"beneficial-only-self-or-ally" as const,target:{combatantId:"combatant-one",relation:"self" as const,actorBacked:true},effectPlan:{effectCount:1,effects:[{effectOrdinal:0,effect:{kind:"resource" as const,resource:"health" as const,amount:2}}]}};

function api(overrides: Partial<CombatTrackerApi> = {}): CombatTrackerApi {
  return {
    listEncounters: vi.fn().mockResolvedValue({encounters:[{encounterId:"combat-one",sessionId:"session",name:"Ambush",status:"active",combatId:"combat-one",combatants:[],revision:4,createdAt:at,updatedAt:at}]}),
    getCombat: vi.fn().mockResolvedValue(combat),
    getCombatLog: vi.fn().mockResolvedValue({ entries: [], nextAfterSequence: null }),
    resolveAction: vi.fn().mockResolvedValue(response),
    getCommandResult:vi.fn().mockResolvedValue({operation:"action",result:response}),
    getPowers: vi.fn().mockResolvedValue(emptyPowers),
    getEffects: vi.fn().mockResolvedValue(emptyEffects),
    getResources:vi.fn().mockResolvedValue({resources:[],revision:0}),
    usePower:vi.fn(),
    getConsumableActions:vi.fn().mockResolvedValue([]),
    useConsumable:vi.fn(),
    getConsumableResult:vi.fn(),
    ...overrides,
  };
}

describe("M3.5 server-authoritative combat controls", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders only resolution-supported legal actions and exact server targets", () => {
    const submit = vi.fn();
    render(<LegalActionTray legalActions={combat.legalActions} combatantLabels={new Map([["combatant-two", "Enemy beta"]])} onSubmit={submit} />);
    expect(screen.getByRole("button", { name: "Attack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "End turn" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /power/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "Enemy beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    expect(screen.getByText("Not supplied by this legal-action response")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(submit).toHaveBeenCalledWith(combat.legalActions[0], ["combatant-two"]);
  });

  it("renders each supported consumable as one exact server-targeted quantity-one action",()=>{
    const use=vi.fn();render(<LegalActionTray legalActions={[]} consumableActions={[consumable]} combatantLabels={new Map([["combatant-one","actor-one"]])} onSubmit={()=>undefined} onUseConsumable={use}/>);
    const button=screen.getByRole("button",{name:/Use tonic on actor-one/});expect(screen.getByText(/Quantity 1 · Cost: action/)).toBeTruthy();fireEvent.click(button);expect(use).toHaveBeenCalledWith(consumable);
  });

  it("uses a native ordered list and keyboard-focusable buttons for the visual rail", () => {
    render(<InitiativeRail combatants={combat.combatants} currentCombatant="combatant-one" onInspect={() => undefined} />);
    const list = screen.getByRole("list", { name: "Combat turn order" });
    expect(list.tagName).toBe("OL");
    const buttons = screen.getAllByRole("button", { name: /Inspect/ });
    expect(buttons).toHaveLength(2);
    buttons[0]!.focus();
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0]!.getAttribute("aria-current")).toBe("step");
  });

  it("submits only a server-planned self power with the contract's empty target request",()=>{
    const power={kind:"ability" as const,packId:"pack",packVersion:"1",definitionId:"ward"};const use=vi.fn();
    render(<PowerLibraryPanel powers={{known:[power],prepared:[power],slots:[],uses:[],legalNow:[{powerRef:power,legal:true,reasons:[]}],legalCommands:[{powerRef:power,targeting:"self",validTargets:[{actorId:"actor-one",label:"Aster"}],maxTargets:0,costs:[],concentration:false,effectKinds:["modifier"]}],revision:2}} onUse={use}/>);
    fireEvent.click(screen.getByRole("button",{name:"Choose server-planned power"}));
    expect(screen.queryByRole("radio")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"Review power command"}));
    expect(screen.getByText("None (server resolves self)")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Execute once"}));
    expect(use).toHaveBeenCalledWith(expect.objectContaining({targeting:"self"}),[]);
  });

  it("caps area selection at 32 and renders structured outcomes, deltas, receipt, and actor states",()=>{
    const power={kind:"ability" as const,packId:"pack",packVersion:"1",definitionId:"wave"},targets=Array.from({length:33},(_,index)=>({actorId:`target-${index}`,label:`Target ${index}`})),use=vi.fn();
    const powers={known:[power],prepared:[power],slots:[],uses:[],legalNow:[{powerRef:power,legal:true,reasons:[]}],legalCommands:[{powerRef:power,targeting:"area" as const,validTargets:targets,maxTargets:32,costs:[],concentration:false,effectKinds:["damage" as const]}],revision:2};
    const result={resolution:{powerUseId:"use",powerRef:power,targetIds:["target-0"],costs:[],outcomes:[{kind:"damage" as const,targetId:"target-0",damageType:"physical" as const,roll:{expression:"1d4",normalized:{count:1,sides:4,selection:{type:"all" as const},modifier:0},terms:[{value:3,kept:true}],modifier:0,total:3},adjustment:"none" as const,applied:3}],stateDeltas:[{kind:"resource" as const,actorId:"target-0",resourceId:"health",before:10,after:7}]},actorStates:[{actorId:"source",resources:[],activeEffects:[],revision:3},{actorId:"target-0",resources:[{resourceId:"health",current:7,capacity:10}],activeEffects:[],revision:1}],receipt:{idempotencyKey:"power-key",revisionBefore:2,revisionAfter:3,occurredAt:at}};
    render(<PowerLibraryPanel powers={powers} onUse={use} result={result}/>);const choose=screen.getByRole("button",{name:"Choose server-planned power"});choose.focus();expect(document.activeElement).toBe(choose);fireEvent.click(choose);
    const checks=screen.getAllByRole("checkbox");checks.slice(0,32).forEach((check)=>fireEvent.click(check));expect((checks[32] as HTMLInputElement).disabled).toBe(true);fireEvent.click(screen.getByRole("button",{name:"Review power command"}));fireEvent.click(screen.getByRole("button",{name:"Execute once"}));expect(use.mock.calls[0]?.[1]).toHaveLength(32);
    expect(screen.getByText("power-key")).toBeTruthy();expect(screen.getByText(/roll 1d4 = 3/)).toBeTruthy();expect(screen.getByText(/health 10 → 7/)).toBeTruthy();expect(screen.getByRole("list",{name:"Returned actor states"}).textContent).toContain("health 7/10");
  });

  it("loads state and paginated log on reconnect without posting an action", async () => {
    const service = api();
    const { unmount } = render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await screen.findAllByText("actor-one");
    expect(service.getCombat).toHaveBeenCalledWith("combat-one");
    expect(service.getCombatLog).toHaveBeenCalledWith("combat-one", { afterSequence: 0, limit: 50 });
    expect(service.resolveAction).not.toHaveBeenCalled();
    unmount();
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await screen.findAllByText("actor-one");
    expect(service.resolveAction).not.toHaveBeenCalled();
    expect(document.querySelector(".legal-action-tray")).toBeTruthy();
  });

  it("keeps an ambiguous stale action locked and never automatically replays it", async () => {
    const service = api({ resolveAction: vi.fn().mockRejectedValue(new Error("stale")) });
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await screen.findAllByText("actor-one");
    fireEvent.click(screen.getByRole("button", { name: "Attack" }));
    fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    await screen.findByText(/outcome is uncertain or stale/i);
    expect(service.resolveAction).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("velvet.combat-action.v2:campaign:combat-one")).toContain('"phase":"ambiguous"');
    fireEvent.click(screen.getByRole("button", { name: "Refresh authoritative state & log" }));
    await waitFor(() => expect(screen.queryByText(/Action outcome unresolved/)).toBeNull());
    expect(service.resolveAction).toHaveBeenCalledTimes(1);
  });

  it("does not clear ambiguity when the exact immutable command result is unavailable",async()=>{
    const service=api({resolveAction:vi.fn().mockRejectedValue(new Error("offline")),getCommandResult:vi.fn().mockRejectedValue(new Error("missing"))});
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");
    fireEvent.click(screen.getByRole("button",{name:"Attack"}));fireEvent.click(screen.getByRole("radio"));fireEvent.click(screen.getByRole("button",{name:"Review action"}));fireEvent.click(screen.getByRole("button",{name:"Submit once"}));await screen.findByText(/outcome is uncertain or stale/i);
    fireEvent.click(screen.getByRole("button",{name:"Refresh authoritative state & log"}));await screen.findByText(/No exact authorized command result/i);
    expect(screen.getByText(/Action outcome unresolved/)).toBeTruthy();expect(service.resolveAction).toHaveBeenCalledTimes(1);
  });

  it("never hydrates a combat ID absent from the campaign encounter list",async()=>{
    const service=api();render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="other-campaign-combat" onBack={()=>undefined}/>);
    await screen.findByRole("heading",{name:"Connect a combat"});expect(service.getCombat).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox",{name:"Campaign encounter"})).toBeTruthy();
  });

  it("preserves a confirmed response and lock when post-submit refresh is partial", async () => {
    const getLog = vi.fn().mockResolvedValueOnce({ entries: [], nextAfterSequence: null }).mockRejectedValueOnce(new Error("offline"));
    const service = api({ getCombatLog: getLog });
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await screen.findAllByText("actor-one");
    fireEvent.click(screen.getByRole("button", { name: "Attack" })); fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Review action" })); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(await screen.findByRole("heading", { name: "Confirmed action receipt" })).toBeTruthy();
    await screen.findByText(/refresh was partial/i);
    expect(screen.getByText(/Confirmed action awaiting complete refresh/)).toBeTruthy();
    expect(localStorage.getItem("velvet.combat-action.v2:campaign:combat-one")).toContain('"phase":"confirmed"');
  });

  it("does not publish state after an unmounted pending action", async () => {
    let resolve!: (value: CombatActionCommandResponse) => void;
    const pending = new Promise<CombatActionCommandResponse>((done) => { resolve = done; });
    const service = api({ resolveAction: vi.fn(() => pending) });
    const { unmount } = render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await screen.findAllByText("actor-one");
    fireEvent.click(screen.getByRole("button", { name: "Attack" })); fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Review action" })); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    unmount(); resolve(response); await pending; await Promise.resolve();
    expect(service.resolveAction).toHaveBeenCalledTimes(1);
  });

  it("locks an unknown consumable delivery, never replays POST, and reconciles only through exact result GET",async()=>{
    const commandResult={resolution:{actionId:"resolved",legalActionId:consumable.legalActionId,kind:"use-consumable" as const,actingCombatantId:"combatant-one",target:consumable.target,targetPolicy:consumable.targetPolicy,actionCost:"action" as const,consumed:{inventoryEntryId:"entry",item:consumable.item,quantity:1 as const},effectPlan:consumable.effectPlan,outcome:{targetCombatantId:"combatant-one",settlements:[{kind:"combat-hp-resource" as const,effectOrdinal:0,resource:"health" as const,requested:2,applied:2,before:8,after:10}]},combatRevisionBefore:4,combatRevisionAfter:5,actingM15Revision:{before:0,after:1},targetM15Revision:null},requestBinding:{requestEvidence:{} as any,canonicalRequestDigest:"a".repeat(64),idempotencyKey:"pending"},receipt:{idempotencyKey:"pending",revisionBefore:4,revisionAfter:5,occurredAt:at}};
    const use=vi.fn().mockRejectedValue(new Error("unknown")),read=vi.fn().mockImplementation((_combat,expected)=>Promise.resolve({...commandResult,requestBinding:{...commandResult.requestBinding,requestEvidence:expected,idempotencyKey:expected.idempotencyKey},receipt:{...commandResult.receipt,idempotencyKey:expected.idempotencyKey}}));
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:use,getConsumableResult:read});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");
    fireEvent.click(screen.getByRole("button",{name:/Use tonic on actor-one/}));await screen.findByText(/outcome is ambiguous/i);expect(use).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toContain('"phase":"ambiguous"');
    fireEvent.click(screen.getByRole("button",{name:"Read exact result & refresh"}));await waitFor(()=>expect(screen.queryByText(/Consumable outcome unresolved/)).toBeNull());expect(read).toHaveBeenCalledTimes(1);expect(use).toHaveBeenCalledTimes(1);
  });

  it("preserves the consumable lock when exact result reconciliation is unavailable",async()=>{
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:vi.fn().mockRejectedValue(new Error("unknown")),getConsumableResult:vi.fn().mockRejectedValue(new Error("missing"))});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");fireEvent.click(screen.getByRole("button",{name:/Use tonic on actor-one/}));await screen.findByText(/outcome is ambiguous/i);fireEvent.click(screen.getByRole("button",{name:"Read exact result & refresh"}));await screen.findByText(/persistent lock remains/i);expect(screen.getByText(/Consumable outcome unresolved/)).toBeTruthy();expect(service.useConsumable).toHaveBeenCalledTimes(1);
  });

  it("aborts before POST when the durable consumable marker cannot be written and read back",async()=>{
    const storage=vi.spyOn(Storage.prototype,"setItem").mockImplementation((key)=>{if(key.includes("combat-consumable"))throw new DOMException("quota");});
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:vi.fn()});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");fireEvent.click(screen.getByRole("button",{name:/Use tonic on actor-one/}));await screen.findByText(/durable safety lock could not be stored/i);expect(service.useConsumable).not.toHaveBeenCalled();expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toBeNull();storage.mockRestore();
  });

  it("clears stale consumable actions when their authoritative refresh fails",async()=>{
    const actions=vi.fn().mockResolvedValueOnce([consumable]).mockRejectedValueOnce(new Error("offline"));const use=vi.fn().mockImplementation((_combat,command)=>Promise.resolve({resolution:{actionId:"resolved",legalActionId:consumable.legalActionId,kind:"use-consumable",actingCombatantId:"combatant-one",target:consumable.target,targetPolicy:consumable.targetPolicy,actionCost:"action",consumed:{inventoryEntryId:"entry",item:consumable.item,quantity:1},effectPlan:consumable.effectPlan,outcome:{targetCombatantId:"combatant-one",settlements:[{kind:"combat-hp-resource",effectOrdinal:0,resource:"health",requested:2,applied:2,before:8,after:10}]},combatRevisionBefore:4,combatRevisionAfter:5,actingM15Revision:{before:0,after:1},targetM15Revision:null},requestBinding:{requestEvidence:command,canonicalRequestDigest:"a".repeat(64),idempotencyKey:command.idempotencyKey},receipt:{idempotencyKey:command.idempotencyKey,revisionBefore:4,revisionAfter:5,occurredAt:at}}));
    const service=api({getConsumableActions:actions,useConsumable:use});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");fireEvent.click(screen.getByRole("button",{name:/Use tonic on actor-one/}));await screen.findByText(/refresh is partial/i);expect(screen.queryByRole("button",{name:/Use tonic on actor-one/})).toBeNull();
  });

  it("clears the marker and refreshes after a definitive 409 without retrying POST",async()=>{
    const actions=vi.fn().mockResolvedValue([consumable]),use=vi.fn().mockRejectedValue(new ApiError(409,"stale"));const service=api({getConsumableActions:actions,useConsumable:use});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findAllByText("actor-one");fireEvent.click(screen.getByRole("button",{name:/Use tonic on actor-one/}));await screen.findByText(/rejected before commitment/i);await waitFor(()=>expect(actions.mock.calls.length).toBeGreaterThan(1));expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toBeNull();expect(screen.queryByText(/Consumable outcome unresolved/)).toBeNull();expect(use).toHaveBeenCalledTimes(1);
  });
});
