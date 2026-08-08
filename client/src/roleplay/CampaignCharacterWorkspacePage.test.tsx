import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCampaignCharacterWorkspace } from "../api";
import { CampaignCharacterWorkspacePage, resetCampaignCharacterWorkspacePageModuleStateForTests } from "./CampaignCharacterWorkspacePage";
import { RpgCharacterSheetPage, type RpgCharacterSheetApi } from "../components/rpg/actor/RpgCharacterSheetPage";
import { formatMinorUnits } from "../components/rpg/actor/ShopBrowser";

vi.mock("../api", async (importOriginal) => ({ ...await importOriginal<typeof import("../api")>(), getCampaignCharacterWorkspace: vi.fn() }));

const response = { character: {
  name: "ليلى 🐉", race: { name: "Avelune", description: "Moonlit people." }, background: { name: "Rainledger", description: "Records journeys." },
  classes: [{ name: "Pathmender", description: "Restores meeting places.", level: 1 }],
  attributes: [{ label: "Attribute 1", value: 12 }],
  proficiencies: [{ category: "skill" as const, label: "Skill proficiency 1" }],
  choices: [{ label: "Choice 1", selection: { kind: "race" as const, name: "Bright path", description: "A careful route." } }],
  resources: [{ label: "Resource 1", current: 2, max: 3 }],
} };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => { cleanup(); localStorage.clear(); resetCampaignCharacterWorkspacePageModuleStateForTests(); vi.resetAllMocks(); });

describe("CampaignCharacterWorkspacePage", () => {
  it("renders all display-only metadata and mandatory sections without technical identities or controls", async () => {
    vi.mocked(getCampaignCharacterWorkspace).mockResolvedValue(response);
    render(<CampaignCharacterWorkspacePage campaignId="campaign-secret" campaignCharacterId="entry-secret" onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Loading character…");
    const name = await screen.findByRole("heading", { name: response.character.name });
    expect(name.querySelector("bdi")?.getAttribute("dir")).toBe("auto");
    for (const heading of ["Attributes", "Proficiencies", "Choices", "Resources"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    for (const text of ["Avelune", "Rainledger", "Pathmender", "12", "Skill proficiency 1", "Bright path", "2 / 3"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["← Back to campaign"]);
    expect(document.body.outerHTML).not.toMatch(/campaign-secret|entry-secret/);
  });

  it("focuses the ready heading only for an exact open-transition request", async () => {
    vi.mocked(getCampaignCharacterWorkspace).mockResolvedValue(response);
    render(<CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="entry" focusHeadingRequest={7} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: response.character.name });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("renders the exact empty collection messages", async () => {
    vi.mocked(getCampaignCharacterWorkspace).mockResolvedValue({ character: { ...response.character, classes: [], attributes: [], proficiencies: [], choices: [], resources: [] } });
    render(<CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="entry" onBack={vi.fn()} onUnavailable={vi.fn()} />);
    for (const text of ["No classes.", "No attributes.", "No proficiencies.", "No choices.", "No resources."]) expect(await screen.findByText(text)).toBeTruthy();
  });

  it("keeps failures local, restores Retry focus, and focuses content after retry success", async () => {
    vi.mocked(getCampaignCharacterWorkspace).mockRejectedValueOnce(new Error("private detail")).mockRejectedValueOnce(new Error("private retry")).mockResolvedValueOnce(response);
    render(<CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="entry" onBack={vi.fn()} onUnavailable={vi.fn()} />);
    let retry = await screen.findByRole("button", { name: "Retry" });
    expect(document.body.textContent).not.toContain("private detail");
    fireEvent.click(retry);
    retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.click(retry);
    const heading = await screen.findByRole("heading", { name: response.character.name });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("returns to detail on 404 and reuses one StrictMode in-flight read", async () => {
    const unavailable = vi.fn();
    vi.mocked(getCampaignCharacterWorkspace).mockRejectedValueOnce(new ApiError(404, "private missing"));
    const first = render(<CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="missing" onBack={vi.fn()} onUnavailable={unavailable} />);
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    first.unmount();

    const pending = deferred<typeof response>();
    vi.mocked(getCampaignCharacterWorkspace).mockReturnValue(pending.promise);
    render(<StrictMode><CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="entry" onBack={vi.fn()} onUnavailable={vi.fn()} /></StrictMode>);
    expect(getCampaignCharacterWorkspace).toHaveBeenCalledTimes(2);
    pending.resolve(response);
    await screen.findByRole("heading", { name: response.character.name });
    expect(getCampaignCharacterWorkspace).toHaveBeenCalledTimes(2);
  });

  it("ignores stale rapid-switch and unmounted completions", async () => {
    const oldRead = deferred<typeof response>();
    const newRead = deferred<typeof response>();
    vi.mocked(getCampaignCharacterWorkspace).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const props = { campaignId: "campaign", onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignCharacterWorkspacePage {...props} campaignCharacterId="old" />);
    view.rerender(<CampaignCharacterWorkspacePage {...props} campaignCharacterId="new" />);
    newRead.resolve({ character: { ...response.character, name: "Current" } });
    await screen.findByRole("heading", { name: "Current" });
    oldRead.resolve({ character: { ...response.character, name: "Stale" } });
    await oldRead.promise;
    expect(screen.queryByText("Stale")).toBeNull();
    view.unmount();
  });

  it.each([
    ["success", (read: ReturnType<typeof deferred<typeof response>>) => read.resolve(response)],
    ["rejection", (read: ReturnType<typeof deferred<typeof response>>) => read.reject(new Error("late private failure"))],
    ["404", (read: ReturnType<typeof deferred<typeof response>>) => read.reject(new ApiError(404, "late private absence"))],
  ])("ignores pending %s after unmount without state, focus, or navigation updates", async (_outcome, settle) => {
    const read = deferred<typeof response>();
    vi.mocked(getCampaignCharacterWorkspace).mockReturnValue(read.promise);
    const back = vi.fn();
    const unavailable = vi.fn();
    const anchor = document.createElement("button");
    anchor.textContent = "Outside focus anchor";
    document.body.append(anchor);
    const view = render(<CampaignCharacterWorkspacePage campaignId="campaign" campaignCharacterId="entry" focusHeadingRequest={11} onBack={back} onUnavailable={unavailable} />);
    view.unmount();
    anchor.focus();

    settle(read);
    await read.promise.catch(() => undefined);
    await Promise.resolve();
    expect(document.activeElement).toBe(anchor);
    expect(back).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    expect(document.querySelector(".workspace-page")).toBeNull();
    anchor.remove();
  });
});

describe("RpgCharacterSheetPage", () => {
  const at = "2030-01-01T00:00:00.000Z";
  const item = { kind: "item" as const, packId: "pack", packVersion: "1", definitionId: "potion" };
  const currency = { kind: "currency" as const, packId: "pack", packVersion: "1", definitionId: "coin" };
  const derived = { maxHp: 10, defenses: { guard: 11, evasion: 12, will: 13 }, initiative: 2, speed: 30, carryingLimit: 100, spellAttack: 3, saveDc: 11,
    explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"].map((statistic) => ({ statistic, formula: "server", inputs: {}, result: 1 })) };
  const sheet = { sheet: response.character, derived, progression: { mode: "xp" as const, level: 1, totalXp: 0, milestoneCount: 0, updatedAt: at } };
  const resources = { resources: [{ name: "hp", current: 2, max: 10 }], revision: 4 };
  const inventory = { entries: [{ kind: "stackable" as const, entryId: "entry", item, quantity: 2 }], equipment: [], capacity: 10, revision: 4 };
  const wallet = { wallet: { balances: [{ currency, minorUnits: 105 }] }, revision: 4 };
  const effects = { effects: [], concentration: [], revision: 4 };
  const actorStorage = "velvet.actor-id.v1:8:campaigncharacter";

  function actorApi(overrides: Partial<RpgCharacterSheetApi> = {}): RpgCharacterSheetApi {
    return {
      getSheet: vi.fn(async () => sheet as any),
      getResources: vi.fn(async () => resources), getInventory: vi.fn(async () => inventory), getWallet: vi.fn(async () => wallet), getEffects: vi.fn(async () => effects),
      getShop: vi.fn(async () => ({ shop: { name: "Known" }, stock: [], currencies: [] })),
      inventoryCommand: vi.fn(async (_campaign, _actor, command) => ({ inventory: { ...inventory, revision: 5 }, receipt: { ...command, revisionBefore: 4, revisionAfter: 5, occurredAt: at } } as any)),
      economyCommand: vi.fn(async () => { throw new Error("unused"); }), rest: vi.fn(async () => { throw new Error("unused"); }),
      getCampaignContent: vi.fn(async () => { throw new Error("catalog unavailable"); }), getCampaignPack: vi.fn(async () => { throw new Error("unused"); }),
      ...overrides,
    };
  }

  it("focuses the heading, composes server values, and structurally omits unavailable actor lanes", async () => {
    const api = actorApi({ getResources: vi.fn(async () => { throw new ApiError(404, "hidden"); }), getInventory: vi.fn(async () => { throw new ApiError(404, "hidden"); }), getWallet: vi.fn(async () => { throw new ApiError(404, "hidden"); }), getEffects: vi.fn(async () => { throw new ApiError(404, "hidden"); }) });
    localStorage.setItem(actorStorage, "actor");
    render(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="character" api={api} focusHeadingRequest={9} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: response.character.name });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText("Maximum HP").nextElementSibling?.textContent).toBe("10");
    expect(screen.queryByRole("heading", { name: "Inventory" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Wallet & shop" })).toBeNull();
    expect(document.body.textContent).not.toContain("hidden");
  });

  it("ignores stale and unmounted sheet completions", async () => {
    const old = deferred<typeof sheet>(); const fresh = deferred<typeof sheet>();
    const api = actorApi({ getSheet: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise) });
    const unavailable = vi.fn();
    const view = render(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="old" api={api} onBack={vi.fn()} onUnavailable={unavailable} />);
    view.rerender(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="new" api={api} onBack={vi.fn()} onUnavailable={unavailable} />);
    fresh.resolve({ ...sheet, sheet: { ...sheet.sheet, name: "Fresh" } } as any);
    await screen.findByRole("heading", { name: "Fresh" });
    old.resolve({ ...sheet, sheet: { ...sheet.sheet, name: "Stale" } } as any);
    await old.promise; expect(screen.queryByText("Stale")).toBeNull();
    view.unmount(); expect(unavailable).not.toHaveBeenCalled();
  });

  it("persists an ambiguous write across unmount and blocks duplicate replay", async () => {
    localStorage.setItem(actorStorage, "actor");
    const never = new Promise<never>(() => undefined);
    const command = vi.fn(() => never);
    const api = actorApi({ inventoryCommand: command });
    const view = render(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="character" api={api} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Inventory" });
    fireEvent.click(screen.getByRole("button", { name: "Review equip" }));
    fireEvent.click(screen.getByLabelText("Confirm this exact command"));
    fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(command).toHaveBeenCalledOnce();
    view.unmount();
    render(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="character" api={api} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(await screen.findByText(/Write outcome uncertain/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review equip" }) as HTMLButtonElement).disabled).toBe(true);
    expect(command).toHaveBeenCalledOnce();
  });

  it("preserves a confirmed receipt when its authoritative refresh fails", async () => {
    localStorage.setItem(actorStorage, "actor");
    const getInventory = vi.fn().mockResolvedValueOnce(inventory).mockRejectedValueOnce(new Error("refresh failed"));
    const api = actorApi({ getInventory });
    render(<RpgCharacterSheetPage campaignId="campaign" campaignCharacterId="character" api={api} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Inventory" });
    fireEvent.click(screen.getByRole("button", { name: "Review equip" })); fireEvent.click(screen.getByLabelText("Confirm this exact command")); fireEvent.click(screen.getByRole("button", { name: "Submit once" }));
    expect(await screen.findByText(/Command was confirmed, but authoritative refresh failed/)).toBeTruthy();
    expect(screen.getByText(/Receipt .* revision 4 → 5/)).toBeTruthy();
    expect(screen.getByText(/Confirmed write awaiting refresh/)).toBeTruthy();
  });

  it("formats decimal and non-decimal currency scales without float math", () => {
    expect(formatMinorUnits(105, currency, { name: "Crowns", symbol: "¤", minorPerMajor: 100 })).toBe("¤1.05 Crowns");
    expect(formatMinorUnits(25, currency, { name: "Marks", symbol: "M", minorPerMajor: 20 })).toBe("M1 + 5/20 Marks (exact)");
    expect(formatMinorUnits(Number.MAX_SAFE_INTEGER, currency)).toContain("minor units (coin)");
  });
});
