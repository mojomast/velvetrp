import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CombatActionCommandResponse, CombatLegalAction, CombatReadResponse, CombatRewardGrantPublic } from "@velvet/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombatTrackerPage, type CombatTrackerApi } from "./CombatTrackerPage";
import { InitiativeRail } from "./InitiativeRail";
import { LegalActionTray } from "./LegalActionTray";
import { PowerLibraryPanel } from "./PowerLibraryPanel";
import {ApiError} from "../../../api";
import {CombatRewards} from "./CombatRewards";

const tacticalRender=vi.hoisted(()=>vi.fn());
vi.mock("../map/TacticalMapPanel",()=>({TacticalMapPanel:(props:Record<string,unknown>)=>{tacticalRender(props);return <section aria-label="Wired tactical map"/>;}}));

const at = "2030-01-01T00:00:00.000Z";
const combat: CombatReadResponse = {
  round: 2, currentCombatant: "combatant-one", revision: 4,
  combatants: [
    { combatantId: "combatant-one", kind: "actor", actorId: "actor-one", team: "allies", hitPoints: 8, maximumHitPoints: 10, temporaryHitPoints: 0, conditions: [], status: "active" },
    { combatantId: "combatant-two", kind: "enemy", template: null, team: "enemies", hitPoints: 3, maximumHitPoints: 5, temporaryHitPoints: 0, conditions: [], status: "active" },
  ],
  legalActions: [
    { legalActionId: "legal-attack", kind: "attack", targetIds: ["combatant-two"] },
    { legalActionId: "future-power", kind: "power", targetIds: ["combatant-two"] },
    { legalActionId: "legal-flee", kind: "flee", targetIds: [] },
    { legalActionId: "legal-end", kind: "end-turn", targetIds: [] },
  ],
};
const survivalActions: CombatLegalAction[] = [
  { legalActionId: "legal-save", kind: "death-save" as const, targetIds: [] },
  { legalActionId: "legal-stabilize", kind: "stabilize" as const, targetIds: ["combatant-one"], cost: "action" as const },
];
const response: CombatActionCommandResponse = {
  resolution: { actionId: "action-one", legalActionId: "legal-attack", kind: "attack", actingCombatantId: "combatant-one", targetIds: ["combatant-two"], outcomes: [{ kind: "damage", targetId: "combatant-two", damageType: "physical", requested: 1, applied: 1, hitPointsBefore: 3, hitPointsAfter: 2, statusBefore: "active", statusAfter: "active" }], roundBefore: 2, roundAfter: 2, currentCombatantBefore: "combatant-one", currentCombatantAfter: "combatant-two" },
  combat: { combatId: "combat-one", ...combat, currentCombatant: "combatant-two", revision: 5, combatants: [combat.combatants[0]!, { ...combat.combatants[1]!, hitPoints: 2 }], legalActions: [] },
  receipt: { idempotencyKey: "command-key", revisionBefore: 4, revisionAfter: 5, occurredAt: at },
};
const emptyPowers = { known: [], prepared: [], slots: [], uses: [], legalNow: [], legalCommands: [], revision: 0 } as const;
const emptyEffects = { effects: [], concentration: [], revision: 0 } as const;
const consumable={legalActionId:"consume:legal",kind:"use-consumable" as const,actingCombatantId:"combatant-one",inventoryEntryId:"entry",item:{kind:"item" as const,packId:"pack",packVersion:"1",definitionId:"tonic"},quantity:1 as const,actionCost:"action" as const,targetPolicy:"beneficial-only-self-or-ally" as const,target:{combatantId:"combatant-one",relation:"self" as const,actorBacked:true},effectPlan:{effectCount:1,effects:[{effectOrdinal:0,effect:{kind:"resource" as const,resource:"health" as const,amount:2}}]}};
const reward:CombatRewardGrantPublic={rewardBundleId:"bundle-one",recipientActorId:"actor-one",createdAt:at,rewards:[{kind:"currency",currency:{kind:"currency",packId:"pack",packVersion:"1",definitionId:"gold"},amount:25}],claim:{state:"unclaimed"}};
const claimedReward:CombatRewardGrantPublic={...reward,claim:{state:"claimed",rewardClaimId:"reward-claim",claimedAt:at}};
const combatPower={legalActionId:"power-legal",powerName:"Arc bolt",targetCombatantId:"combatant-two",target:"Enemy 2",powerRef:{kind:"ability" as const,packId:"pack",packVersion:"1",definitionId:"arc-bolt"},cost:null,revisions:{combat:4,sourceM15:1,sourceM16:2,targetM15:null,targetM16:null}};
const combatPowerResponse={request:{legalActionId:"power-legal",expectedCombatRevision:4,expectedSourceM15Revision:1,expectedSourceM16Revision:2,expectedTargetM15Revision:null,expectedTargetM16Revision:null,idempotencyKey:"power-key"},result:{commandId:"power-command",powerName:"Arc bolt",targetCombatantId:"combatant-two",cost:null,outcomes:[{kind:"damage" as const}],concentration:false,roundBefore:2,roundAfter:2,revisionBefore:4,revisionAfter:5,occurredAt:at}};

function api(overrides: Partial<CombatTrackerApi> = {}): CombatTrackerApi {
  return {
    listEncounters: vi.fn().mockResolvedValue({encounters:[{encounterId:"combat-one",sessionId:"session",name:"Ambush",status:"active",combatId:"combat-one",combatants:[],revision:4,createdAt:at,updatedAt:at}]}),
    getCombat: vi.fn().mockResolvedValue(combat),
    getCombatLog: vi.fn().mockResolvedValue({ entries: [], nextAfterSequence: null }),
    resolveAction: vi.fn().mockResolvedValue(response),
    resolveEnemyTurn:vi.fn().mockResolvedValue(response),
    getCommandResult:vi.fn().mockResolvedValue({operation:"action",result:response}),
    getPowers: vi.fn().mockResolvedValue(emptyPowers),
    getEffects: vi.fn().mockResolvedValue(emptyEffects),
    getResources:vi.fn().mockResolvedValue({resources:[],revision:0}),
    usePower:vi.fn(),
    getConsumableActions:vi.fn().mockResolvedValue([]),
    useConsumable:vi.fn(),
    getConsumableResult:vi.fn(),
    getCombatPowerActions:vi.fn().mockResolvedValue([]),
    useCombatPower:vi.fn(),
    getCombatPowerResult:vi.fn(),
    listRewards:vi.fn().mockResolvedValue([]),
    claimReward:vi.fn().mockImplementation((_combatId,_bundleId,_actorId,command)=>Promise.resolve({reward:{...claimedReward,claim:{state:"claimed",rewardClaimId:command.rewardClaimId,claimedAt:at}},receipt:{idempotencyKey:command.idempotencyKey,revisionBefore:command.expectedRevision,revisionAfter:command.expectedRevision+1,occurredAt:at}})),
    getRewardClaimResult:vi.fn().mockRejectedValue(new ApiError(404,"absent")),
    getWallet:vi.fn().mockResolvedValue({wallet:{balances:[]},revision:0}),
    startEncounter:vi.fn(),
    endCombat:vi.fn(),
    ...overrides,
  };
}
const combatReady = () => screen.findByRole("button", { name: /Inspect Ally 1/ });

describe("M3.5 server-authoritative combat controls", () => {
  beforeEach(() => { localStorage.clear(); tacticalRender.mockClear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("embeds room-bound legal actions without a second map or lifecycle controller", async () => {
    const client = api({ getTacticalMap: vi.fn(), generateTacticalMap: vi.fn(), previewTacticalMapMove: vi.fn(), moveTacticalMapToken: vi.fn() });
    const locked = vi.fn(); const changed = vi.fn();
    render(<CombatTrackerPage embedded campaignId="campaign" sessionId="session" api={client} actorRole="player" audience="player" controlledActorId="actor-one" onBack={vi.fn()} onLockChange={locked} onStateChange={changed} />);
    await combatReady();
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.getByRole("heading", { name: "Combat tracker", level: 2 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Encounter lifecycle" })).toBeNull();
    expect(tacticalRender).not.toHaveBeenCalled();
    expect(client.getCombat).toHaveBeenCalledWith("combat-one");
    expect(changed).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Review action" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    await waitFor(() => expect(client.resolveAction).toHaveBeenCalledOnce());
    expect(locked).toHaveBeenCalledWith(true);
  });

  it("locks embedded writes during a room operation and excludes other rooms", async () => {
    const client = api();
    vi.mocked(client.listEncounters).mockResolvedValue({ encounters: [
      { encounterId: "combat-one", sessionId: "session", name: "Ambush", status: "active", combatId: "combat-one", combatants: [], revision: 4, createdAt: at, updatedAt: at },
      { encounterId: "other", sessionId: "other-room", name: "Private battle", status: "active", combatId: "other", combatants: [], revision: 4, createdAt: at, updatedAt: at },
    ] });
    render(<CombatTrackerPage embedded blocked campaignId="campaign" sessionId="session" api={client} actorRole="player" audience="player" controlledActorId="actor-one" onBack={vi.fn()} />);
    await combatReady();
    expect(screen.queryByRole("option", { name: /Private battle/ })).toBeNull();
    const attack = screen.getByRole("button", { name: "Attack" });
    expect(attack.closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(attack);
    expect(client.resolveAction).not.toHaveBeenCalled();
    expect(client.getCombat).not.toHaveBeenCalledWith("other");
  });

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

  it("offers accessible server-authorized survival controls without client rolls or raw identifiers",()=>{
    const submit=vi.fn();render(<LegalActionTray legalActions={survivalActions} combatantLabels={new Map([["combatant-one","Ally 1"]])} onSubmit={submit}/>);
    const deathSave=screen.getByRole("button",{name:"Make death save"});deathSave.focus();expect(document.activeElement).toBe(deathSave);fireEvent.click(deathSave);
    expect(screen.getByText(/No roll is made in the client/)).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"Review action"}));fireEvent.click(screen.getByRole("button",{name:"Submit once"}));expect(submit).toHaveBeenCalledWith(survivalActions[0],[]);
    fireEvent.click(screen.getByRole("button",{name:"Stabilize"}));expect(screen.getByRole("radio",{name:"Ally 1"})).toBeTruthy();expect(screen.getByRole("button",{name:"Review action"}).hasAttribute("disabled")).toBe(true);
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

  it.each([1280,390])("renders explicit unclaimed and claimed reward state at %ipx",(width)=>{
    Object.defineProperty(window,"innerWidth",{configurable:true,value:width});
    render(<CombatRewards rewards={[reward,claimedReward]} claimableActorId="actor-one" onClaim={()=>undefined}/>);
    expect(screen.getByText("Unclaimed")).toBeTruthy();expect(screen.getByText("Claimed")).toBeTruthy();
    expect(screen.getByRole("button",{name:"Claim reward"})).toBeTruthy();expect(screen.getByText("Explicit settlement")).toBeTruthy();
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
    await combatReady();
    expect(service.getCombat).toHaveBeenCalledWith("combat-one");
    expect(service.getCombatLog).toHaveBeenCalledWith("combat-one", { afterSequence: 0, limit: 50 });
    expect(service.resolveAction).not.toHaveBeenCalled();
    unmount();
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await combatReady();
    expect(service.resolveAction).not.toHaveBeenCalled();
    expect(document.querySelector(".legal-action-tray")).toBeTruthy();
  });

  it("keeps an ambiguous stale action locked and never automatically replays it", async () => {
    const service = api({ resolveAction: vi.fn().mockRejectedValue(new Error("stale")) });
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={() => undefined} />);
    await combatReady();
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
    render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();
    fireEvent.click(screen.getByRole("button",{name:"Attack"}));fireEvent.click(screen.getByRole("radio"));fireEvent.click(screen.getByRole("button",{name:"Review action"}));fireEvent.click(screen.getByRole("button",{name:"Submit once"}));await screen.findByText(/outcome is uncertain or stale/i);
    fireEvent.click(screen.getByRole("button",{name:"Refresh authoritative state & log"}));await screen.findByText(/No exact authorized command result/i);
    expect(screen.getByText(/Action outcome unresolved/)).toBeTruthy();expect(service.resolveAction).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous death save locked and reconciles through the exact generic action result",async()=>{
    const unconscious:CombatReadResponse={...combat,combatants:[{combatantId:"combatant-one",kind:"actor",actorId:"actor-one",team:"allies",hitPoints:0,maximumHitPoints:10,temporaryHitPoints:0,conditions:[{condition:"unconscious",expiresAtRound:null}],status:"unconscious",deathSaves:{successes:1,failures:2}},combat.combatants[1]!],legalActions:[survivalActions[0]!]};
    const resolve=vi.fn().mockRejectedValue(new Error("offline"));const service=api({getCombat:vi.fn().mockResolvedValue(unconscious),resolveAction:resolve});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Make death save");fireEvent.click(screen.getByRole("button",{name:"Make death save"}));fireEvent.click(screen.getByRole("button",{name:"Review action"}));fireEvent.click(screen.getByRole("button",{name:"Submit once"}));await screen.findByText(/outcome is uncertain or stale/i);
    expect(resolve).toHaveBeenCalledTimes(1);expect(resolve.mock.calls[0]?.[1]).toEqual(expect.objectContaining({legalActionId:"legal-save",targetIds:[],choices:[]}));fireEvent.click(screen.getByRole("button",{name:"Refresh authoritative state & log"}));await waitFor(()=>expect(screen.queryByText(/Action outcome unresolved/)).toBeNull());expect(resolve).toHaveBeenCalledTimes(1);
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
    await combatReady();
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
    await combatReady();
    fireEvent.click(screen.getByRole("button", { name: "Attack" })); fireEvent.click(screen.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "Review action" })); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    unmount(); resolve(response); await pending; await Promise.resolve();
    expect(service.resolveAction).toHaveBeenCalledTimes(1);
  });

  it("resolves an enemy turn once with only expected revision and idempotency",async()=>{
    const enemyCombat={...combat,currentCombatant:"combatant-two",legalActions:[]};const enemyResponse={...response,resolution:{...response.resolution,actingCombatantId:"combatant-two",targetIds:["combatant-one"]},combat:{...response.combat,currentCombatant:"combatant-one",legalActions:[]}};
    const enemy=vi.fn().mockResolvedValue(enemyResponse);const service=api({getCombat:vi.fn().mockResolvedValue(enemyCombat),resolveEnemyTurn:enemy});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByRole("button",{name:"Resolve enemy turn"});fireEvent.click(screen.getByRole("button",{name:"Resolve enemy turn"}));await screen.findByText(/Enemy turn confirmed; authoritative combat state and log refreshed/i);
    expect(enemy).toHaveBeenCalledTimes(1);expect(enemy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({expectedRevision:4,idempotencyKey:expect.any(String)}));expect(Object.keys(enemy.mock.calls[0]?.[1]??[])).toEqual(["expectedRevision","idempotencyKey"]);
  });

  it("keeps an ambiguous enemy turn locked after refresh and never replays it",async()=>{
    const enemyCombat={...combat,currentCombatant:"combatant-two",legalActions:[]};const enemy=vi.fn().mockRejectedValue(new Error("offline"));const service=api({getCombat:vi.fn().mockResolvedValue(enemyCombat),resolveEnemyTurn:enemy});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByRole("button",{name:"Resolve enemy turn"});fireEvent.click(screen.getByRole("button",{name:"Resolve enemy turn"}));await screen.findByText(/delivery is ambiguous/i);fireEvent.click(screen.getByRole("button",{name:"Refresh authoritative combat state & log"}));await screen.findByText(/cannot be proven exact/i);
    expect(enemy).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-enemy-turn.v1:campaign:combat-one")).toContain('"phase":"ambiguous"');
  });

  it("does not show the enemy turn control during a player turn",async()=>{
    render(<CombatTrackerPage api={api()} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();expect(screen.queryByRole("button",{name:"Resolve enemy turn"})).toBeNull();
  });

  it("keeps survival controls disabled while the server owns an enemy turn",async()=>{
    const enemyCombat={...combat,currentCombatant:"combatant-two",legalActions:survivalActions};render(<CombatTrackerPage api={api({getCombat:vi.fn().mockResolvedValue(enemyCombat)})} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    expect(await screen.findByRole("button",{name:"Resolve enemy turn"})).toBeTruthy();expect(screen.getByRole("button",{name:"Make death save"}).hasAttribute("disabled")).toBe(true);expect(screen.getByRole("button",{name:"Stabilize"}).hasAttribute("disabled")).toBe(true);
  });

  it("locks an unknown consumable delivery, never replays POST, and reconciles only through exact result GET",async()=>{
    const commandResult={resolution:{actionId:"resolved",legalActionId:consumable.legalActionId,kind:"use-consumable" as const,actingCombatantId:"combatant-one",target:consumable.target,targetPolicy:consumable.targetPolicy,actionCost:"action" as const,consumed:{inventoryEntryId:"entry",item:consumable.item,quantity:1 as const},effectPlan:consumable.effectPlan,outcome:{targetCombatantId:"combatant-one",settlements:[{kind:"combat-hp-resource" as const,effectOrdinal:0,resource:"health" as const,requested:2,applied:2,before:8,after:10}]},combatRevisionBefore:4,combatRevisionAfter:5,actingM15Revision:{before:0,after:1},targetM15Revision:null},requestBinding:{requestEvidence:{} as any,canonicalRequestDigest:"a".repeat(64),idempotencyKey:"pending"},receipt:{idempotencyKey:"pending",revisionBefore:4,revisionAfter:5,occurredAt:at}};
    const use=vi.fn().mockRejectedValue(new Error("unknown")),read=vi.fn().mockImplementation((_combat,expected)=>Promise.resolve({...commandResult,requestBinding:{...commandResult.requestBinding,requestEvidence:expected,idempotencyKey:expected.idempotencyKey},receipt:{...commandResult.receipt,idempotencyKey:expected.idempotencyKey}}));
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:use,getConsumableResult:read});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();
    fireEvent.click(screen.getByRole("button",{name:/Use tonic on Ally 1/}));await screen.findByText(/outcome is ambiguous/i);expect(use).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toContain('"phase":"ambiguous"');
    fireEvent.click(screen.getByRole("button",{name:"Read exact result & refresh"}));await waitFor(()=>expect(screen.queryByText(/Consumable outcome unresolved/)).toBeNull());expect(read).toHaveBeenCalledTimes(1);expect(use).toHaveBeenCalledTimes(1);
  });

  it("preserves the consumable lock when exact result reconciliation is unavailable",async()=>{
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:vi.fn().mockRejectedValue(new Error("unknown")),getConsumableResult:vi.fn().mockRejectedValue(new Error("missing"))});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();fireEvent.click(screen.getByRole("button",{name:/Use tonic on Ally 1/}));await screen.findByText(/outcome is ambiguous/i);fireEvent.click(screen.getByRole("button",{name:"Read exact result & refresh"}));await screen.findByText(/persistent lock remains/i);expect(screen.getByText(/Consumable outcome unresolved/)).toBeTruthy();expect(service.useConsumable).toHaveBeenCalledTimes(1);
  });

  it("aborts before POST when the durable consumable marker cannot be written and read back",async()=>{
    const storage=vi.spyOn(Storage.prototype,"setItem").mockImplementation((key)=>{if(key.includes("combat-consumable"))throw new DOMException("quota");});
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable]),useConsumable:vi.fn()});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();fireEvent.click(screen.getByRole("button",{name:/Use tonic on Ally 1/}));await screen.findByText(/durable safety lock could not be stored/i);expect(service.useConsumable).not.toHaveBeenCalled();expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toBeNull();storage.mockRestore();
  });

  it("clears stale consumable actions when their authoritative refresh fails",async()=>{
    const actions=vi.fn().mockResolvedValueOnce([consumable]).mockRejectedValueOnce(new Error("offline"));const use=vi.fn().mockImplementation((_combat,command)=>Promise.resolve({resolution:{actionId:"resolved",legalActionId:consumable.legalActionId,kind:"use-consumable",actingCombatantId:"combatant-one",target:consumable.target,targetPolicy:consumable.targetPolicy,actionCost:"action",consumed:{inventoryEntryId:"entry",item:consumable.item,quantity:1},effectPlan:consumable.effectPlan,outcome:{targetCombatantId:"combatant-one",settlements:[{kind:"combat-hp-resource",effectOrdinal:0,resource:"health",requested:2,applied:2,before:8,after:10}]},combatRevisionBefore:4,combatRevisionAfter:5,actingM15Revision:{before:0,after:1},targetM15Revision:null},requestBinding:{requestEvidence:command,canonicalRequestDigest:"a".repeat(64),idempotencyKey:command.idempotencyKey},receipt:{idempotencyKey:command.idempotencyKey,revisionBefore:4,revisionAfter:5,occurredAt:at}}));
    const service=api({getConsumableActions:actions,useConsumable:use});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();fireEvent.click(screen.getByRole("button",{name:/Use tonic on Ally 1/}));await screen.findByText(/refresh is partial/i);expect(screen.queryByRole("button",{name:/Use tonic on Ally 1/})).toBeNull();
  });

  it("clears the marker and refreshes after a definitive 409 without retrying POST",async()=>{
    const actions=vi.fn().mockResolvedValue([consumable]),use=vi.fn().mockRejectedValue(new ApiError(409,"stale"));const service=api({getConsumableActions:actions,useConsumable:use});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();fireEvent.click(screen.getByRole("button",{name:/Use tonic on Ally 1/}));await screen.findByText(/rejected before commitment/i);await waitFor(()=>expect(actions.mock.calls.length).toBeGreaterThan(1));expect(localStorage.getItem("velvet.combat-consumable.v1:campaign:combat-one")).toBeNull();expect(screen.queryByText(/Consumable outcome unresolved/)).toBeNull();expect(use).toHaveBeenCalledTimes(1);
  });

  it("claims once, confirms settlement from reward reads, and refreshes the bound actor wallet",async()=>{
    localStorage.setItem("velvet.combat-actor-id.v2:campaign","actor-one");
    const claim=vi.fn().mockImplementation((_combatId,_bundleId,_actorId,command)=>Promise.resolve({reward:{...claimedReward,claim:{state:"claimed",rewardClaimId:command.rewardClaimId,claimedAt:at}},receipt:{idempotencyKey:command.idempotencyKey,revisionBefore:4,revisionAfter:5,occurredAt:at}}));
    const list=vi.fn().mockImplementation(()=>{const command=claim.mock.calls[0]?.[3];return Promise.resolve(command?[{...claimedReward,claim:{state:"claimed",rewardClaimId:command.rewardClaimId,claimedAt:at}}]:[reward]);});
    const wallet=vi.fn().mockResolvedValue({wallet:{balances:[]},revision:3});
    const service=api({listRewards:list,claimReward:claim,getWallet:wallet});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Unclaimed");fireEvent.click(screen.getByRole("button",{name:"Claim reward"}));
    await screen.findByText(/authoritative rewards and recipient wallet refreshed/i);expect(screen.getByText("Claimed")).toBeTruthy();
    expect(claim).toHaveBeenCalledTimes(1);expect(claim.mock.calls[0]?.slice(0,3)).toEqual(["combat-one","bundle-one","actor-one"]);expect(wallet.mock.calls.length).toBeGreaterThan(1);
    expect(localStorage.getItem("velvet.combat-reward-claim.v1:campaign:combat-one")).toBeNull();
  });

  it("keeps an ambiguous claim locked, never replays it, and reconciles the exact claim from reads",async()=>{
    localStorage.setItem("velvet.combat-actor-id.v2:campaign","actor-one");
    const claim=vi.fn().mockRejectedValue(new Error("connection lost"));
    const list=vi.fn().mockImplementation(()=>{const command=claim.mock.calls[0]?.[3];return Promise.resolve(command?[{...claimedReward,claim:{state:"claimed",rewardClaimId:command.rewardClaimId,claimedAt:at}}]:[reward]);});
    const service=api({listRewards:list,claimReward:claim});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Unclaimed");fireEvent.click(screen.getByRole("button",{name:"Claim reward"}));await screen.findByText(/delivery is ambiguous/i);
    expect(localStorage.getItem("velvet.combat-reward-claim.v1:campaign:combat-one")).toContain('"phase":"ambiguous"');fireEvent.click(screen.getByRole("button",{name:/Read exact claim result/}));
    await screen.findByText(/Claim settlement confirmed by authoritative reward state/i);expect(screen.getByText("Claimed")).toBeTruthy();expect(claim).toHaveBeenCalledTimes(1);
  });

  it("unlocks an ambiguous unclaimed projection when the exact committed claim exists, then refreshes without replay",async()=>{
    localStorage.setItem("velvet.combat-actor-id.v2:campaign","actor-one");
    const claim=vi.fn().mockRejectedValue(new ApiError(500,"ambiguous")),list=vi.fn().mockResolvedValue([reward]);
    const exact=vi.fn().mockImplementation((_campaignId,_combatId,_bundleId,_actorId,command)=>Promise.resolve({reward:{...claimedReward,
      claim:{state:"claimed",rewardClaimId:command.rewardClaimId,claimedAt:at}},requestBinding:{campaignId:"campaign",combatId:"combat-one",
        rewardBundleId:"bundle-one",recipientActorId:"actor-one",claimedAt:at,requestEvidence:command,canonicalRequestDigest:"a".repeat(64)},
      receipt:{idempotencyKey:command.idempotencyKey,revisionBefore:command.expectedRevision,revisionAfter:command.expectedRevision+1,occurredAt:at}}));
    const wallet=vi.fn().mockResolvedValue({wallet:{balances:[]},revision:1});
    render(<CombatTrackerPage api={api({listRewards:list,claimReward:claim,getRewardClaimResult:exact,getWallet:wallet})} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Unclaimed");fireEvent.click(screen.getByRole("button",{name:"Claim reward"}));await screen.findByText(/delivery is ambiguous/i);
    fireEvent.click(screen.getByRole("button",{name:/Read exact claim result/}));
    await screen.findByText(/Exact claim result confirmed; authoritative rewards and recipient wallet refreshed/i);
    expect(screen.getByText("Claimed")).toBeTruthy();expect(localStorage.getItem("velvet.combat-reward-claim.v1:campaign:combat-one")).toBeNull();
    expect(exact).toHaveBeenCalledTimes(1);expect(claim).toHaveBeenCalledTimes(1);expect(list.mock.calls.length).toBeGreaterThan(1);expect(wallet.mock.calls.length).toBeGreaterThan(1);
  });

  it("clears a definitively stale unclaimed intent after refresh without replaying it",async()=>{
    localStorage.setItem("velvet.combat-actor-id.v2:campaign","actor-one");const claim=vi.fn().mockRejectedValue(new ApiError(409,"stale"));
    const service=api({listRewards:vi.fn().mockResolvedValue([reward]),claimReward:claim});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Unclaimed");fireEvent.click(screen.getByRole("button",{name:"Claim reward"}));await screen.findByText(/rejected before settlement/i);
    expect(claim).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-reward-claim.v1:campaign:combat-one")).toBeNull();expect(screen.getByText("Unclaimed")).toBeTruthy();
  });

  it("shows a conflicting authoritative settlement and never retries the stale claim",async()=>{
    localStorage.setItem("velvet.combat-actor-id.v2:campaign","actor-one");const claim=vi.fn().mockRejectedValue(new ApiError(409,"conflict"));
    const list=vi.fn().mockImplementation(()=>Promise.resolve(claim.mock.calls.length?[{...claimedReward,claim:{state:"claimed",rewardClaimId:"other-claim",claimedAt:at}}]:[reward]));
    const service=api({listRewards:list,claimReward:claim});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Unclaimed");fireEvent.click(screen.getByRole("button",{name:"Claim reward"}));await screen.findByText(/Bundle settlement conflict confirmed/i);
    expect(screen.getByText("Claimed")).toBeTruthy();expect(claim).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-reward-claim.v1:campaign:combat-one")).toBeNull();
  });

  it("omits non-recipient rewards and never exposes a claim action",async()=>{
    const claim=vi.fn();const service=api({listRewards:vi.fn().mockResolvedValue([]),claimReward:claim});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText(/No reward bundles are visible to this recipient/i);expect(screen.queryByRole("button",{name:"Claim reward"})).toBeNull();expect(claim).not.toHaveBeenCalled();
  });

  it("preserves already claimed state when a later reward refresh fails",async()=>{
    const list=vi.fn().mockResolvedValueOnce([claimedReward]).mockRejectedValueOnce(new Error("offline"));
    const logs=vi.fn().mockRejectedValue(new Error("offline"));const service=api({listRewards:list,getCombatLog:logs});render(<CombatTrackerPage api={service} campaignId="campaign" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByText("Claimed");fireEvent.click(screen.getByRole("button",{name:"Retry log"}));await screen.findByText(/Existing claimed state is preserved/i);expect(screen.getByText("Claimed")).toBeTruthy();
  });

  it("gives a player only server legal actions for their own current combatant",async()=>{
    const service=api({getConsumableActions:vi.fn().mockResolvedValue([consumable])});
    render(<CombatTrackerPage api={service} campaignId="campaign" sessionId="session" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await combatReady();expect(screen.getByRole("button",{name:"Attack"})).toBeTruthy();expect(screen.getByRole("button",{name:/Use tonic on Ally 1/})).toBeTruthy();
    expect(screen.queryByRole("heading",{name:"Encounter control"})).toBeNull();expect(screen.queryByRole("heading",{name:"Enemy turn"})).toBeNull();expect(screen.queryByLabelText(/Actor ID for powers/)).toBeNull();
    cleanup();render(<CombatTrackerPage api={api({getCombat:vi.fn().mockResolvedValue({...combat,currentCombatant:"combatant-two"})})} campaignId="campaign" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await combatReady();expect(screen.queryByRole("button",{name:"Attack"})).toBeNull();
  });

  it.each(["owner","gm"] as const)("gives the %s role lifecycle and enemy-turn workspaces",async(actorRole)=>{
    render(<CombatTrackerPage api={api()} campaignId="campaign" actorRole={actorRole} audience="gm" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();
    expect(screen.getByRole("heading",{name:"Encounter lifecycle"})).toBeTruthy();expect(screen.getByRole("heading",{name:"Enemy turn"})).toBeTruthy();
  });

  it("keeps observers to read-only combat state, log, and rewards",async()=>{
    const service=api({listRewards:vi.fn().mockResolvedValue([reward])});
    render(<CombatTrackerPage api={service} campaignId="campaign" sessionId="session" actorRole="observer" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await combatReady();expect(screen.getByRole("heading",{name:"Combat rewards"})).toBeTruthy();expect(screen.getByRole("heading",{name:"Combat log"})).toBeTruthy();expect(document.querySelector(".legal-action-tray")).toBeNull();expect(screen.queryByRole("button",{name:"Claim reward"})).toBeNull();expect(screen.queryByLabelText("Wired tactical map")).toBeNull();
    expect(service.getConsumableActions).not.toHaveBeenCalled();expect(service.getCombatPowerActions).not.toHaveBeenCalled();expect(service.getPowers).not.toHaveBeenCalled();
  });

  it("wires the tactical map only from exact room, encounter, combat, actor, and combatant context",async()=>{
    const service=api({getTacticalMap:vi.fn(),generateTacticalMap:vi.fn(),previewTacticalMapMove:vi.fn(),moveTacticalMapToken:vi.fn()});
    render(<CombatTrackerPage api={service} campaignId="campaign" sessionId="session" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await screen.findByLabelText("Wired tactical map");expect(tacticalRender).toHaveBeenCalledWith(expect.objectContaining({campaignId:"campaign",sessionId:"session",actorId:"actor-one",audience:"player",mode:"combat",encounterId:"combat-one",combatantId:"combatant-one",readOnly:false,api:service}));
    cleanup();tacticalRender.mockClear();render(<CombatTrackerPage api={service} campaignId="campaign" sessionId="wrong-session" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await combatReady();expect(screen.queryByLabelText("Wired tactical map")).toBeNull();expect(tacticalRender).not.toHaveBeenCalled();
  });

  it("uses initial IDs, returns to the room, and clears private controls on authorization downgrade",async()=>{
    const room=vi.fn(),service=api();const view=render(<CombatTrackerPage api={service} campaignId="campaign" sessionId="session" actorRole="gm" audience="gm" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined} onReturnToRoom={room}/>);
    await combatReady();expect(screen.queryByRole("combobox",{name:"Campaign encounter"})).toBeNull();expect(screen.queryByLabelText(/Actor ID for powers/)).toBeNull();fireEvent.click(screen.getByRole("button",{name:/Return to room/}));expect(room).toHaveBeenCalledTimes(1);
    view.rerender(<CombatTrackerPage api={service} campaignId="campaign" sessionId="session" actorRole="observer" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);
    await waitFor(()=>expect(document.querySelector(".combat-actor-lanes")).toBeNull());expect(document.querySelector(".legal-action-tray")).toBeNull();
  });

  it("persists an uncertain combat-power request and recovers its exact result after remount without replay",async()=>{
    const use=vi.fn().mockRejectedValue(new Error("offline")),exact=vi.fn().mockImplementation((_combatId,command)=>Promise.resolve({...combatPowerResponse,request:command}));
    const service=api({getCombatPowerActions:vi.fn().mockResolvedValue([combatPower]),useCombatPower:use,getCombatPowerResult:exact});
    const first=render(<CombatTrackerPage api={service} campaignId="campaign" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);await combatReady();fireEvent.click(screen.getByRole("button",{name:"Use Arc bolt"}));await screen.findByText(/Combat power outcome is uncertain/i);
    expect(use).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-power.v1:campaign:combat-one")).toContain('"phase":"ambiguous"');first.unmount();
    render(<CombatTrackerPage api={service} campaignId="campaign" actorRole="player" audience="player" controlledActorId="actor-one" initialCombatId="combat-one" onBack={()=>undefined}/>);await screen.findByText(/Combat power outcome unresolved/i);expect(use).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button",{name:/Read exact combat-power result/}));await screen.findByText(/Exact combat-power result confirmed/i);expect(exact).toHaveBeenCalledTimes(1);expect(use).toHaveBeenCalledTimes(1);expect(localStorage.getItem("velvet.combat-power.v1:campaign:combat-one")).toBeNull();
  });
});
