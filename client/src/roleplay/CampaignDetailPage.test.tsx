import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { CampaignAdministrationReceipt } from "@velvet/contracts";
import { ApiError, ApiInputError, attachCampaignRoom, createOriginalStarterCampaignCharacter, getCampaignAdministration, getCampaignCharacterCreationOptions, getCampaignDetail, getCampaignPlayBootstrap, listCampaignCharacters, listCampaignCheckpoints, listCampaignMemberships, listCampaignRooms, listCampaignTimelines, renameCampaign, setupMechanicsStarter, setupOriginalStarter, updateCampaignAdministration } from "../api";
import { CampaignDetailPage, resetCampaignDetailPageModuleStateForTests } from "./CampaignDetailPage";
import { CampaignAdministrationPage, resetCampaignAdministrationPageModuleStateForTests } from "../components/rpg/campaign/CampaignAdministrationPage";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
  getCampaignDetail: vi.fn(),
  getCampaignCharacterCreationOptions: vi.fn(),
  listCampaignCharacters: vi.fn(),
  listCampaignRooms: vi.fn(),
  attachCampaignRoom: vi.fn(),
  createOriginalStarterCampaignCharacter: vi.fn(),
  renameCampaign: vi.fn(),
  setupOriginalStarter: vi.fn(),
  setupMechanicsStarter: vi.fn(),
  getCampaignAdministration: vi.fn(),
  getCampaignPlayBootstrap: vi.fn(),
  listCampaignMemberships: vi.fn(),
  listCampaignTimelines: vi.fn(),
  listCampaignCheckpoints: vi.fn(),
  updateCampaignAdministration: vi.fn(),
}));

const unconfigured = { id: "campaign-one", name: "The Long Road", actorRole: "gm" as const, createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-04-05T00:00:00.000Z", content: { status: "unconfigured" as const } };
const configured = { ...unconfigured, id: "campaign-two", name: "Second Road", actorRole: "owner" as const, content: { status: "configured" as const, rulesProfileId: "rules.core", contentPacks: [{ packId: "pack.core", packVersion: "1.0" }] } };
const ownerUnconfigured = { ...unconfigured, actorRole: "owner" as const };
const starterConfigured = { ...ownerUnconfigured, updatedAt: "2030-04-06T00:00:00.000Z", content: { status: "configured" as const, rulesProfileId: "velvet:rules:original-narrative", contentPacks: [{ packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818" }] } };
const mechanicsConfigured = { ...ownerUnconfigured, updatedAt: "2030-04-06T00:00:00.000Z", content: { status: "configured" as const, rulesProfileId: "velvet:rules:starter-v1", contentPacks: [{ packId: "velvet:mechanics-starter", packVersion: "1.1.0+2f9199b5696d" }] } };
const starter = {
  rulesProfile: { rulesProfileId: "velvet:rules:original-narrative" as const, name: "Velvet Original Narrative" as const, description: "Metadata identity for Velvet's original narrative starter concepts." as const },
  pack: { packId: "velvet:original-starter" as const, packVersion: "1.0.0+d15042935818" as const, rulesProfileId: "velvet:rules:original-narrative" as const, name: "Velvet Original Starter" as const, description: "A small original fantasy collection for future campaign setup." as const },
  race: { reference: { packId: "velvet:original-starter" as const, packVersion: "1.0.0+d15042935818" as const, definitionId: "velvet:original-starter:race:avelune" as const, kind: "race" as const }, name: "Avelune" as const, description: "Avelune communities gather around drifting lights and preserve family stories in woven night banners." as const },
  background: { reference: { packId: "velvet:original-starter" as const, packVersion: "1.0.0+d15042935818" as const, definitionId: "velvet:original-starter:background:rainledger" as const, kind: "background" as const }, name: "Rainledger" as const, description: "Rainledgers once recorded seasonal journeys, local customs, and promises exchanged between distant settlements." as const },
  class: { reference: { packId: "velvet:original-starter" as const, packVersion: "1.0.0+d15042935818" as const, definitionId: "velvet:original-starter:class:pathmender" as const, kind: "class" as const }, name: "Pathmender" as const, description: "Pathmenders travel between isolated communities, carrying news and helping neighbors restore neglected meeting places." as const, level: 1 as const },
};
const creationOptions = { campaignId: starterConfigured.id, personas: [
  { characterId: "persona-unused-secret", name: "Shared Persona", alreadyUsed: false },
  { characterId: "persona-used-secret", name: "Shared Persona", alreadyUsed: true },
], starter };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

afterEach(() => { cleanup(); resetCampaignDetailPageModuleStateForTests(); resetCampaignAdministrationPageModuleStateForTests(); vi.resetAllMocks(); });

describe("CampaignDetailPage", () => {
  // Most legacy detail tests exercise servers from before the optional roster
  // read. A 404 must preserve that compatibility without changing their UI.
  beforeEach(() => {
    vi.mocked(listCampaignRooms).mockResolvedValue({ attached: [], eligible: [] });
    vi.mocked(listCampaignCharacters).mockRejectedValue(new ApiError(404, "unsupported"));
    vi.mocked(getCampaignCharacterCreationOptions).mockRejectedValue(new ApiError(404, "unsupported"));
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: { id: unconfigured.id, actorRole: "gm", status: "draft", activeTimelineId: "timeline", revision: 0, updatedAt: unconfigured.updatedAt, settings: { maxPlayers: 6, allowPlayerDice: false, safetyMode: "standard", recapVisibility: "members", gmNotes: "" } } });
    vi.mocked(getCampaignPlayBootstrap).mockResolvedValue({ campaignId: mechanicsConfigured.id, sessionId: "room", expectedRevision: 4, session: { attached: true, attachedAt: unconfigured.updatedAt, active: true, adventureEligible: true }, principal: { role: "owner", control: "all" }, playableActors: [{ actorId: "actor", name: "Aria" }] });
  });

  it("leads with explicit campaign readiness and opens the first ready room", async () => {
    const open = vi.fn();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: mechanicsConfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValue({ characters: [{ id: "campaign-character", characterId: "persona", name: "Aria" }] });
    vi.mocked(listCampaignRooms).mockResolvedValue({ attached: [{ sessionId: "room", title: "Raincross", participantNames: ["Aria"], createdAt: unconfigured.createdAt, attachedAt: unconfigured.updatedAt, stopped: false }], eligible: [] });
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: { id: mechanicsConfigured.id, actorRole: "owner", status: "published", activeTimelineId: "timeline", revision: 4, updatedAt: mechanicsConfigured.updatedAt, settings: { maxPlayers: 6, allowPlayerDice: false, safetyMode: "standard", recapVisibility: "members", gmNotes: "" } } });
    render(<CampaignDetailPage campaignId={mechanicsConfigured.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} onOpenRoom={open} />);
    await screen.findByRole("heading", { name: "Campaign ready" });
    expect(screen.getByText("Ready to play")).toBeTruthy();
    expect(screen.getByText("1 authorized actor is available in an attached room.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enter command center" }));
    expect(open).toHaveBeenCalledWith("room");
  });

  it("renders isolated auto-direction roster names in server order, including valid RTL, astral, duplicate, and maximum names", async () => {
    const maximumName = "界".repeat(200);
    const characters = [
      { id: "campaign-character-secret-one", characterId: "persona-secret-one", name: "Shared Name" },
      { id: "campaign-character-secret-two", characterId: "persona-secret-two", name: "Shared Name" },
      { id: "campaign-character-secret-three", characterId: "persona-secret-three", name: "ليلى 🐉" },
      { id: "campaign-character-secret-four", characterId: "persona-secret-four", name: maximumName },
    ];
    const openCharacter = vi.fn();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: unconfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValue({ characters });
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} onOpenCharacter={openCharacter} />);

    const list = await screen.findByRole("list", { name: "Campaign characters" });
    expect(screen.getAllByText("Shared Name")).toHaveLength(2);
    expect(maximumName.length).toBe(200);
    expect(screen.getByText(maximumName)).toBeTruthy();
    expect(Array.from(list.children).map((item) => item.textContent)).toEqual(characters.map(({ name }) => `${name}Open character`));
    const rendered = document.body.outerHTML;
    for (const character of characters) {
      expect(rendered).not.toContain(character.id);
      expect(rendered).not.toContain(character.characterId);
    }
    expect(list.querySelectorAll("button")).toHaveLength(characters.length);
    expect(screen.getByRole("button", { name: "Open character Shared Name, character 1 of 4" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open character Shared Name, character 2 of 4" }));
    expect(openCharacter).toHaveBeenCalledWith(characters[1]!.id);
    for (const item of Array.from(list.children)) {
      const isolatedName = item.querySelector("bdi");
      expect(isolatedName?.getAttribute("dir")).toBe("auto");
      expect(item.textContent).toBe(`${isolatedName?.textContent}Open character`);
    }
    expect(rendered).not.toMatch(/controller|persona-secret|campaign-character-secret|private/i);
  });

  it("renders duplicate safe rooms without opaque IDs and attaches once followed by exactly one fresh GET", async () => {
    const eligible = { sessionId: "room-secret-eligible", title: "Shared room", participantNames: ["ليلى", "Aria"], createdAt: "2030-01-03T00:00:00.000Z" };
    const attached = { ...eligible, sessionId: "room-secret-stopped", attachedAt: "2030-01-04T00:00:00.000Z", stopped: true };
    const refreshed = { attached: [attached, { ...eligible, attachedAt: "2030-01-05T00:00:00.000Z", stopped: false }], eligible: [] };
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
    vi.mocked(listCampaignRooms).mockResolvedValueOnce({ attached: [attached], eligible: [eligible] }).mockResolvedValueOnce(refreshed);
    vi.mocked(attachCampaignRoom).mockResolvedValue({ attachment: { sessionId: eligible.sessionId, attachedAt: "2030-01-05T00:00:00.000Z" } });
    const open = vi.fn();
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} onOpenRoom={open} />);
    await screen.findByRole("list", { name: "Eligible campaign rooms" });
    expect(screen.getAllByText("Shared room")).toHaveLength(2);
    expect(document.querySelectorAll(".campaign-room-list bdi").length).toBeGreaterThan(2);
    fireEvent.click(screen.getByRole("button", { name: "Open attached room 1 of 1" }));
    expect(open).toHaveBeenCalledWith(attached.sessionId);
    const attach = screen.getByRole("button", { name: "Attach eligible room 1 of 1" });
    fireEvent.click(attach); fireEvent.click(attach);
    expect(attachCampaignRoom).toHaveBeenCalledOnce();
    await screen.findByText("Room attached. Latest campaign rooms were refreshed.");
    expect(listCampaignRooms).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Open attached room 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open attached room 2 of 2" })).toBeTruthy();
    for (const action of screen.getAllByRole("button", { name: /^(?:Open attached|Attach eligible) room/ })) {
      expect(action.getAttribute("aria-label")).not.toMatch(/Shared room|ليلى/);
    }
    const html = document.body.outerHTML;
    expect(html).not.toContain(eligible.sessionId);
    expect(html).not.toContain(attached.sessionId);
  });

  it("disables attach acquisition while a manual rooms refresh is pending", async () => {
    const eligible = { sessionId: "manual-refresh-room", title: "Refresh race", participantNames: ["Aria"], createdAt: "2030-01-03T00:00:00.000Z" };
    const refresh = deferred<{ attached: []; eligible: [typeof eligible] }>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
    vi.mocked(listCampaignRooms)
      .mockResolvedValueOnce({ attached: [], eligible: [eligible] })
      .mockReturnValueOnce(refresh.promise);
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const attach = await screen.findByRole("button", { name: "Attach eligible room 1 of 1" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: "Refresh rooms" }));
    expect(attach.disabled).toBe(true);
    fireEvent.click(attach);
    expect(attachCampaignRoom).not.toHaveBeenCalled();
    refresh.resolve({ attached: [], eligible: [eligible] });
    await refresh.promise;
    await waitFor(() => expect(attach.disabled).toBe(false));
  });

  it("reopens during attach without starting a pre-reconciliation room GET", async () => {
    const eligible = { sessionId: "reopen-room", title: "Reopen race", participantNames: ["Aria"], createdAt: "2030-01-03T00:00:00.000Z" };
    const put = deferred<{ attachment: { sessionId: string; attachedAt: string } }>();
    const reconciled = { attached: [{ ...eligible, attachedAt: "2030-01-04T00:00:00.000Z", stopped: false }], eligible: [] };
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
    vi.mocked(listCampaignRooms).mockResolvedValueOnce({ attached: [], eligible: [eligible] }).mockResolvedValueOnce(reconciled);
    vi.mocked(attachCampaignRoom).mockReturnValue(put.promise);
    const props = { campaignId: ownerUnconfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Attach eligible room 1 of 1" }));
    first.unmount();
    render(<CampaignDetailPage {...props} />);
    await screen.findByRole("heading", { name: ownerUnconfigured.name });
    expect(listCampaignRooms).toHaveBeenCalledTimes(1);
    put.resolve({ attachment: { sessionId: eligible.sessionId, attachedAt: "2030-01-04T00:00:00.000Z" } });
    await screen.findByText("Room attached. Latest campaign rooms were refreshed.");
    expect(listCampaignRooms).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Open attached room 1 of 1" })).toBeTruthy();
  });

  it("broadcasts an attach reconciliation to every mounted same-campaign peer before cleanup", async () => {
    const eligible = { sessionId: "peer-room", title: "Peer room", participantNames: ["Aria"], createdAt: "2030-01-03T00:00:00.000Z" };
    const initial = deferred<{ attached: []; eligible: [typeof eligible] }>();
    const put = deferred<{ attachment: { sessionId: string; attachedAt: string } }>();
    const reconciled = { attached: [{ ...eligible, attachedAt: "2030-01-04T00:00:00.000Z", stopped: false }], eligible: [] };
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
    vi.mocked(listCampaignRooms).mockReturnValueOnce(initial.promise).mockResolvedValueOnce(reconciled);
    vi.mocked(attachCampaignRoom).mockReturnValue(put.promise);
    const props = { campaignId: ownerUnconfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    const second = render(<CampaignDetailPage {...props} />);
    initial.resolve({ attached: [], eligible: [eligible] });
    const attach = await within(first.container).findByRole("button", { name: "Attach eligible room 1 of 1" });
    await within(second.container).findByRole("button", { name: "Attach eligible room 1 of 1" });
    fireEvent.click(attach);
    put.resolve({ attachment: { sessionId: eligible.sessionId, attachedAt: "2030-01-04T00:00:00.000Z" } });
    await within(first.container).findByText("Room attached. Latest campaign rooms were refreshed.");
    await within(second.container).findByText("Room attached. Latest campaign rooms were refreshed.");
    expect(within(first.container).getByRole("button", { name: "Open attached room 1 of 1" })).toBeTruthy();
    expect(within(second.container).getByRole("button", { name: "Open attached room 1 of 1" })).toBeTruthy();
    expect(attachCampaignRoom).toHaveBeenCalledOnce();
    expect(listCampaignRooms).toHaveBeenCalledTimes(2);
  });

  it.each(["gm", "player", "observer"] as const)("shows attached rooms but no attach controls to %s", async (actorRole) => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: { ...unconfigured, actorRole } });
    vi.mocked(listCampaignRooms).mockResolvedValue({ attached: [{ sessionId: `private-${actorRole}`, title: null, participantNames: ["Visible participant"], createdAt: "2030-01-01T00:00:00.000Z", attachedAt: "2030-01-02T00:00:00.000Z", stopped: false }], eligible: [] });
    const view = render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("button", { name: "Open attached room 1 of 1" });
    expect(screen.queryByRole("heading", { name: "Attach a room" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Attach room/ })).toBeNull();
    expect(document.body.outerHTML).not.toContain(`private-${actorRole}`);
    view.unmount();
  });

  it("shows an accessible authorized empty roster for every role and configuration state", async () => {
    for (const [index, actorRole] of (["owner", "gm", "player", "observer"] as const).entries()) {
      const detail = index % 2 === 0 ? { ...configured, actorRole } : { ...unconfigured, actorRole };
      vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: detail });
      vi.mocked(listCampaignCharacters).mockResolvedValueOnce({ characters: [] });
      const view = render(<CampaignDetailPage campaignId={detail.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
      await screen.findByRole("heading", { name: "Characters" });
      expect(document.querySelector(".roster-status")?.textContent).toBe("No characters yet.");
      expect(screen.getByRole("region", { name: "Characters" }).querySelector('[role="status"]')?.textContent)
        .toBe("Character roster is empty.");
      view.unmount();
    }
  });

  it("silently compatibility-falls back on roster 404 without making detail unavailable", async () => {
    const unavailable = vi.fn();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: unconfigured });
    vi.mocked(listCampaignCharacters).mockRejectedValue(new ApiError(404, "private roster absence"));
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    await screen.findByRole("heading", { name: unconfigured.name });
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledOnce());
    expect(screen.queryByRole("heading", { name: "Characters" })).toBeNull();
    expect(document.body.textContent).not.toContain("private roster absence");
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("keeps non-404 roster failures local and focuses the heading after same-campaign retry success", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: configured });
    vi.mocked(listCampaignCharacters)
      .mockRejectedValueOnce(new Error("private database detail"))
      .mockResolvedValueOnce({ characters: [{ id: "entry-secret", characterId: "persona-secret", name: "Recovered" }] });
    const unavailable = vi.fn();
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={unavailable} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Characters could not be loaded.");
    expect(document.body.textContent).not.toContain("private database detail");
    const back = screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    const retry = screen.getByRole("button", { name: "Retry characters" });
    fireEvent.click(retry);
    await screen.findByText("Recovered");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Characters" })));
    expect(screen.getByRole("region", { name: "Characters" }).querySelector('[role="status"]')?.textContent)
      .toBe("1 character loaded.");
    expect(listCampaignCharacters).toHaveBeenCalledTimes(2);
    expect(renameCampaign).not.toHaveBeenCalled();
    expect(setupOriginalStarter).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    expect(document.body.outerHTML).not.toMatch(/entry-secret|persona-secret/);
  });

  it("restores roster retry focus after same-campaign retry failure", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: configured });
    vi.mocked(listCampaignCharacters).mockRejectedValue(new Error("private failure"));
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry characters" });
    fireEvent.click(retry);
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry characters" })));
  });

  it("does not let a pending campaign A retry steal focus after campaign B succeeds", async () => {
    const campaignA = { ...unconfigured, id: "roster-focus-pending-a", name: "Roster Pending A" };
    const campaignB = { ...configured, id: "roster-focus-pending-b", name: "Roster Pending B" };
    const retryA = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(listCampaignCharacters)
      .mockRejectedValueOnce(new Error("A initial failure"))
      .mockReturnValueOnce(retryA.promise)
      .mockResolvedValueOnce({ characters: [{ id: "b-entry", characterId: "b-persona", name: "Campaign B character" }] });
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry characters" }));
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByText("Campaign B character");
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Characters" }));

    retryA.resolve({ characters: [{ id: "a-entry", characterId: "a-persona", name: "Late campaign A character" }] });
    await retryA.promise;
    await Promise.resolve();
    expect(screen.queryByText("Late campaign A character")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Characters" }));
  });

  it("clears campaign A retry focus intent on compatibility 404 before switching to B", async () => {
    const campaignA = { ...unconfigured, id: "roster-focus-404-a", name: "Roster 404 A" };
    const campaignB = { ...configured, id: "roster-focus-404-b", name: "Roster 404 B" };
    const retryA = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(listCampaignCharacters)
      .mockRejectedValueOnce(new Error("A initial failure"))
      .mockReturnValueOnce(retryA.promise)
      .mockResolvedValueOnce({ characters: [{ id: "b-404-entry", characterId: "b-404-persona", name: "Campaign B after 404" }] });
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry characters" }));
    retryA.reject(new ApiError(404, "unsupported"));
    await retryA.promise.catch(() => undefined);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Characters" })).toBeNull());
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByText("Campaign B after 404");
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Characters" }));
  });

  it("rechecks campaign and generation before a queued retry focus callback runs", async () => {
    const campaignA = { ...unconfigured, id: "roster-focus-queued-a", name: "Roster Queued A" };
    const campaignB = { ...configured, id: "roster-focus-queued-b", name: "Roster Queued B" };
    const retryA = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    const queuedCallbacks: VoidFunction[] = [];
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queuedCallbacks.push(callback);
    });
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(listCampaignCharacters)
      .mockRejectedValueOnce(new Error("A initial failure"))
      .mockReturnValueOnce(retryA.promise)
      .mockResolvedValueOnce({ characters: [{ id: "b-queued-entry", characterId: "b-queued-persona", name: "Campaign B after queue" }] });
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry characters" }));
    retryA.resolve({ characters: [{ id: "a-queued-entry", characterId: "a-queued-persona", name: "Campaign A completed" }] });
    await screen.findByText("Campaign A completed");
    await waitFor(() => expect(queuedCallbacks).toHaveLength(1));
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    queuedCallbacks[0]?.();
    await screen.findByText("Campaign B after queue");
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Characters" }));
    queueMicrotaskSpy.mockRestore();
  });

  it("reuses StrictMode replay reads once per campaign and lets the replay generation render", async () => {
    const detailRead = deferred<{ campaign: typeof unconfigured }>();
    const rosterRead = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    vi.mocked(getCampaignDetail).mockReturnValue(detailRead.promise);
    vi.mocked(listCampaignCharacters).mockReturnValue(rosterRead.promise);
    render(<StrictMode><CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} /></StrictMode>);

    expect(getCampaignDetail).toHaveBeenCalledOnce();
    expect(listCampaignCharacters).toHaveBeenCalledOnce();
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledOnce();
    detailRead.resolve({ campaign: unconfigured });
    rosterRead.resolve({ characters: [{ id: "strict-entry", characterId: "strict-persona", name: "Strict survivor" }] });
    await screen.findByRole("heading", { name: unconfigured.name });
    await screen.findByText("Strict survivor");
    expect(getCampaignDetail).toHaveBeenCalledOnce();
    expect(listCampaignCharacters).toHaveBeenCalledOnce();
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledOnce();
  });

  it("ignores stale roster switch and unmount completions using its own generation", async () => {
    const firstRoster = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    const secondRoster = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: unconfigured }).mockResolvedValueOnce({ campaign: configured });
    vi.mocked(listCampaignCharacters).mockReturnValueOnce(firstRoster.promise).mockReturnValueOnce(secondRoster.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={unconfigured.id} {...props} />);
    view.rerender(<CampaignDetailPage campaignId={configured.id} {...props} />);
    secondRoster.resolve({ characters: [{ id: "new-entry", characterId: "new-persona", name: "Current roster" }] });
    await screen.findByText("Current roster");
    firstRoster.resolve({ characters: [{ id: "old-entry", characterId: "old-persona", name: "Stale roster" }] });
    await firstRoster.promise;
    await waitFor(() => expect(screen.queryByText("Stale roster")).toBeNull());
    view.unmount();

    const unmountedRoster = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: unconfigured });
    vi.mocked(listCampaignCharacters).mockReturnValueOnce(unmountedRoster.promise);
    const unavailable = vi.fn();
    const late = render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    late.unmount();
    unmountedRoster.reject(new ApiError(500, "late private"));
    await unmountedRoster.promise.catch(() => undefined);
    await Promise.resolve();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("keeps roster generations independent while a rename mutation coexists", async () => {
    const rosterRead = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    const renameWrite = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    const renamed = { ...configured, name: "Renamed", updatedAt: "2030-04-07T00:00:00.000Z" };
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: renamed });
    vi.mocked(listCampaignCharacters).mockReturnValue(rosterRead.promise);
    vi.mocked(renameCampaign).mockReturnValue(renameWrite.promise);
    const openCharacter = vi.fn();
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} onOpenCharacter={openCharacter} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamed.name } });
    fireEvent.submit(input.closest("form")!);
    const back = screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Renaming…" })).toBeTruthy();

    rosterRead.resolve({ characters: [{ id: "coexist-entry", characterId: "coexist-persona", name: "Visible during write" }] });
    await screen.findByText("Visible during write");
    const open = screen.getByRole("button", { name: "Open character Visible during write, character 1 of 1" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.getAttribute("disabled")).not.toBeNull();
    fireEvent.click(open);
    expect(openCharacter).not.toHaveBeenCalled();
    expect(back.disabled).toBe(true);
    expect(screen.getByRole("region", { name: "Characters" }).getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector(".campaign-detail-panel")?.getAttribute("aria-busy")).toBe("false");
    expect(renameCampaign).toHaveBeenCalledOnce();
    renameWrite.resolve({ campaign: { id: renamed.id, name: renamed.name, updatedAt: renamed.updatedAt } });
    await screen.findByRole("heading", { name: renamed.name });
    await waitFor(() => expect(back.disabled).toBe(false));
    expect(open.disabled).toBe(false);
    expect(listCampaignCharacters).toHaveBeenCalledOnce();
    expect(document.body.outerHTML).not.toMatch(/coexist-entry|coexist-persona/);
  });

  it("keeps overlapping A-to-B mutation guards and phases independently owned", async () => {
    const campaignA = { ...configured, id: "campaign-a", name: "Campaign A" };
    const campaignB = { ...configured, id: "campaign-b", name: "Campaign B" };
    const renamedA = { ...campaignA, name: "Renamed A", updatedAt: "2030-05-01T00:00:00.000Z" };
    const renamedB = { ...campaignB, name: "Renamed B", updatedAt: "2030-05-02T00:00:00.000Z" };
    const writeA = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    const writeB = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : renamedB }));
    vi.mocked(renameCampaign).mockImplementation((id) => id === campaignA.id ? writeA.promise : writeB.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    let input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamedA.name } });
    fireEvent.submit(input.closest("form")!);
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamedB.name } });
    fireEvent.submit(input.closest("form")!);
    expect(renameCampaign).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Renaming…" })).toBeTruthy();

    writeA.resolve({ campaign: { id: renamedA.id, name: renamedA.name, updatedAt: renamedA.updatedAt } });
    await writeA.promise;
    await Promise.resolve();
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Renaming…" })).toBeTruthy();
    writeB.resolve({ campaign: { id: renamedB.id, name: renamedB.name, updatedAt: renamedB.updatedAt } });
    await screen.findByRole("heading", { name: renamedB.name });
    await waitFor(() => expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(false));
    expect(renameCampaign).toHaveBeenCalledTimes(2);
  });

  it("keeps document unload protection for pending A while B stays usable and after detail unmount", async () => {
    const campaignA = { ...configured, id: "warning-a", name: "Warning A" };
    const campaignB = { ...configured, id: "warning-b", name: "Warning B" };
    const renamedA = { ...campaignA, name: "Warning A renamed", updatedAt: "2030-05-03T00:00:00.000Z" };
    const writeA = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(renameCampaign).mockReturnValue(writeA.promise);
    const unloadIsBlocked = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    const inputA = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(inputA, { target: { value: renamedA.name } });
    fireEvent.submit(inputA.closest("form")!);
    expect(unloadIsBlocked()).toBe(true);

    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    const inputB = await screen.findByRole("textbox", { name: "Campaign name" }) as HTMLInputElement;
    expect(inputB.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Rename campaign" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(false);
    expect(unloadIsBlocked()).toBe(true);

    view.unmount();
    expect(unloadIsBlocked()).toBe(true);
    writeA.resolve({ campaign: { id: renamedA.id, name: renamedA.name, updatedAt: renamedA.updatedAt } });
    await writeA.promise;
    await waitFor(() => expect(unloadIsBlocked()).toBe(false));
  });

  it("reconciles and focuses A after A-to-B-to-A while B remains independently guarded", async () => {
    const campaignA = { ...configured, id: "campaign-return-a", name: "Return A" };
    const campaignB = { ...configured, id: "campaign-return-b", name: "Return B" };
    const renamedA = { ...campaignA, name: "Returned A latest", updatedAt: "2030-06-01T00:00:00.000Z" };
    const renamedB = { ...campaignB, name: "Returned B latest", updatedAt: "2030-06-02T00:00:00.000Z" };
    const writeA = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    const writeB = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    let aCompleted = false;
    let bCompleted = false;
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id
      ? (aCompleted ? renamedA : campaignA)
      : (bCompleted ? renamedB : campaignB) }));
    vi.mocked(renameCampaign).mockImplementation((id) => id === campaignA.id ? writeA.promise : writeB.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    let input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamedA.name } });
    fireEvent.submit(input.closest("form")!);
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamedB.name } });
    fireEvent.submit(input.closest("form")!);
    view.rerender(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    await screen.findByRole("heading", { name: campaignA.name });
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(true);

    aCompleted = true;
    writeA.resolve({ campaign: { id: renamedA.id, name: renamedA.name, updatedAt: renamedA.updatedAt } });
    await screen.findByRole("heading", { name: renamedA.name });
    const returnedInput = screen.getByRole("textbox", { name: "Campaign name" });
    await waitFor(() => expect(document.activeElement).toBe(returnedInput));
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(false);
    expect(vi.mocked(getCampaignDetail).mock.calls.filter(([id]) => id === campaignA.id)).toHaveLength(3);

    bCompleted = true;
    writeB.resolve({ campaign: { id: renamedB.id, name: renamedB.name, updatedAt: renamedB.updatedAt } });
    await writeB.promise;
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByRole("heading", { name: renamedB.name });
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Rename campaign" })).toBeTruthy();
  });
  it("shows loading then only approved unconfigured metadata", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: unconfigured });
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading campaign");
    await screen.findByRole("heading", { name: unconfigured.name });
    expect(screen.getByText("Gm")).toBeTruthy();
    expect(screen.getByText("Unconfigured")).toBeTruthy();
    expect(document.querySelector(`time[datetime="${unconfigured.createdAt}"]`)).toBeTruthy();
    expect(document.querySelector(`time[datetime="${unconfigured.updatedAt}"]`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(unconfigured.id);
    for (const privateText of ["Owner principal", "Active timeline", "Rename", "Delete", "Characters", "Setup"]) expect(screen.queryByText(privateText)).toBeNull();
  });

  it("shows configured identifiers and no private campaign identities", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: configured });
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText("rules.core");
    expect(screen.getByText("pack.core")).toBeTruthy();
    expect(screen.getByText("1.0")).toBeTruthy();
    expect(document.body.textContent).not.toContain(configured.id);
    expect(screen.getByRole("textbox", { name: "Campaign name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename campaign" })).toBeTruthy();
  });

  it("never renders rename controls for a non-owner", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: unconfigured });
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: unconfigured.name });
    expect(screen.queryByRole("textbox", { name: "Campaign name" })).toBeNull();
    expect(screen.queryByRole("button", { name: /rename campaign/i })).toBeNull();
  });

  it("shows the shared metadata-only preview only to an unconfigured owner", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Set up campaign metadata" });
    for (const text of ["Velvet Original Narrative", "Velvet Original Starter", "Avelune", "Rainledger", "Pathmender"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText(/metadata scaffolding only/i)).toBeTruthy();
    expect(screen.getByText(/adds no playable mechanics, gameplay, or character creation/i)).toBeTruthy();
    expect(screen.getByText(/two-transaction setup/i)).toBeTruthy();
    expect(screen.getAllByText(/pack may remain installed/i).length).toBeGreaterThan(0);
    expect(document.body.textContent?.toLowerCase()).not.toContain("ready to play");
  });

  it("shows only the exact fixed finalized form, preserves duplicate order, and keeps opaque persona IDs out of the DOM", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValue({ characters: [] });
    vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValue(creationOptions);
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);

    await screen.findByRole("heading", { name: "Finalize a character record" });
    for (const text of ["Velvet Original Narrative", "Velvet Original Starter", "Avelune", "Rainledger", "Pathmender, level 1"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios[0]?.disabled).toBe(false);
    expect(radios[1]?.disabled).toBe(true);
    expect(screen.getByRole("radio", { name: "Shared Persona Persona 1 of 2" })).toBe(radios[0]);
    expect(screen.getByRole("radio", { name: "Shared Persona Persona 2 of 2 Already used — not selectable" })).toBe(radios[1]);
    expect(radios.every((radio) => !radio.hasAttribute("value") && !radio.hasAttribute("aria-label") && !radio.hasAttribute("id"))).toBe(true);
    expect(screen.getAllByText("Shared Persona")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Finalize character record" }) as HTMLButtonElement).disabled).toBe(true);
    const html = document.body.outerHTML;
    expect(html).not.toMatch(/persona-(?:unused|used)-secret/);
    expect(html).not.toMatch(/controller|private/i);
    expect(screen.getByRole("checkbox", { name: "I confirm this record is finalized and currently has NO derived stats, rules validation, editing, deletion, rebuilding or reset, gameplay or mechanics, inventory, equipment, spells, powers, progression, or AI workflow." })).toBeTruthy();
  });

  it("announces an options retry and focuses the creation heading only after guarded success", async () => {
    const retry = deferred<typeof creationOptions>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockRejectedValueOnce(new Error("private initial options failure"))
      .mockReturnValueOnce(retry.promise);
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry character options" }));
    expect(screen.getByText("Loading character creation options…")).toBeTruthy();
    retry.resolve(creationOptions);
    expect(await screen.findByText("Character creation options loaded.")).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "Finalize a character record" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("restores options Retry after failure and prevents a stale campaign retry from stealing focus", async () => {
    const campaignA = { ...starterConfigured, id: "options-retry-a", name: "Options A" };
    const campaignB = { ...starterConfigured, id: "options-retry-b", name: "Options B" };
    const retryA = deferred<typeof creationOptions>();
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockRejectedValueOnce(new Error("A initial"))
      .mockRejectedValueOnce(new Error("A retry failure"))
      .mockReturnValueOnce(retryA.promise)
      .mockResolvedValue({ ...creationOptions, campaignId: campaignB.id });
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry character options" }));
    const failedRetry = await screen.findByRole("button", { name: "Retry character options" });
    await waitFor(() => expect(document.activeElement).toBe(failedRetry));
    fireEvent.click(failedRetry);
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByRole("heading", { name: "Options B" });
    const bHeading = await screen.findByRole("heading", { name: "Finalize a character record" });
    bHeading.focus();
    retryA.resolve({ ...creationOptions, campaignId: campaignA.id });
    await retryA.promise;
    await Promise.resolve();
    expect(document.activeElement).toBe(bHeading);
  });

  it("rechecks campaign and options generation before queued Retry focus", async () => {
    const campaignA = { ...starterConfigured, id: "options-focus-queued-a", name: "Options queued A" };
    const campaignB = { ...starterConfigured, id: "options-focus-queued-b", name: "Options queued B" };
    const queuedCallbacks: VoidFunction[] = [];
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queuedCallbacks.push(callback);
    });
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockRejectedValueOnce(new Error("A initial options failure"))
      .mockResolvedValueOnce({ ...creationOptions, campaignId: campaignA.id })
      .mockResolvedValueOnce({ ...creationOptions, campaignId: campaignB.id });
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry character options" }));
    await screen.findByRole("heading", { name: "Finalize a character record" });
    await waitFor(() => expect(queuedCallbacks).toHaveLength(1));
    const staleFocus = queuedCallbacks[0]!;
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    const bHeading = await screen.findByRole("heading", { name: "Finalize a character record" });
    bHeading.focus();
    staleFocus();
    expect(document.activeElement).toBe(bHeading);
    queueMicrotaskSpy.mockRestore();
  });

  it("requires unused selection and single-use confirmation, POSTs once, then performs exactly one concurrent authoritative pair", async () => {
    const freshOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const created = { id: "created-entry-secret", characterId: creationOptions.personas[0]!.characterId, name: creationOptions.personas[0]!.name };
    const rosterRefresh = deferred<{ characters: Array<typeof created> }>();
    const optionsRefresh = deferred<typeof freshOptions>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValueOnce({ characters: [] }).mockReturnValueOnce(rosterRefresh.promise);
    vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValueOnce(creationOptions).mockReturnValueOnce(optionsRefresh.promise);
    vi.mocked(createOriginalStarterCampaignCharacter).mockResolvedValue({ character: created });
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const radios = await screen.findAllByRole("radio");
    fireEvent.click(radios[0]!);
    const submit = screen.getByRole("button", { name: "Finalize character record" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const confirmation = screen.getByRole("checkbox", { name: /currently has NO derived stats/i });
    fireEvent.click(confirmation);
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledWith(starterConfigured.id, { characterId: creationOptions.personas[0]!.characterId });
    await waitFor(() => {
      expect(listCampaignCharacters).toHaveBeenCalledTimes(2);
      expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(2);
    });
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(true);
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    rosterRefresh.resolve({ characters: [created] });
    optionsRefresh.resolve(freshOptions);
    await screen.findByText(/created and confirmed by the latest character status/i);
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "← Campaigns" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Refresh character status" })).toBeTruthy();
    expect(document.body.outerHTML).not.toMatch(/created-entry-secret|persona-unused-secret/);
  });

  it("broadcasts one create reconciliation to all mounted same-campaign peers", async () => {
    const created = { id: "peer-created-entry", characterId: creationOptions.personas[0]!.characterId, name: creationOptions.personas[0]!.name };
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const initialRoster = deferred<{ characters: [] }>();
    const initialOptions = deferred<typeof creationOptions>();
    const post = deferred<{ character: typeof created }>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters).mockReturnValueOnce(initialRoster.promise).mockResolvedValueOnce({ characters: [created] });
    vi.mocked(getCampaignCharacterCreationOptions).mockReturnValueOnce(initialOptions.promise).mockResolvedValueOnce(usedOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    const second = render(<CampaignDetailPage {...props} />);
    initialRoster.resolve({ characters: [] });
    initialOptions.resolve(creationOptions);
    const firstUi = within(first.container);
    fireEvent.click((await firstUi.findAllByRole("radio"))[0]!);
    fireEvent.click(firstUi.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(firstUi.getByRole("button", { name: "Finalize character record" }));
    post.resolve({ character: created });
    await within(first.container).findByText(/created and confirmed by the latest character status/i);
    await within(second.container).findByText(/created and confirmed by the latest character status/i);
    expect(within(first.container).queryByRole("radio", { name: /Persona 1 of 2$/ })).toBeNull();
    expect(within(second.container).queryByRole("radio", { name: /Persona 1 of 2$/ })).toBeNull();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(listCampaignCharacters).toHaveBeenCalledTimes(2);
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(2);
  });

  it("retains peer create completion until delayed same-campaign detail and rejects stale peer reads", async () => {
    const peerDetail = deferred<{ campaign: typeof starterConfigured }>();
    const stalePeerRoster = deferred<{ characters: [] }>();
    const stalePeerOptions = deferred<typeof creationOptions>();
    const created = { id: "delayed-peer-created", characterId: creationOptions.personas[0]!.characterId, name: creationOptions.personas[0]!.name };
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign: starterConfigured })
      .mockReturnValueOnce(peerDetail.promise);
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockReturnValueOnce(stalePeerRoster.promise)
      .mockResolvedValueOnce({ characters: [created] });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockReturnValueOnce(stalePeerOptions.promise)
      .mockResolvedValueOnce(usedOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockResolvedValue({ character: created });
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const owner = render(<CampaignDetailPage {...props} />);
    const ownerUi = within(owner.container);
    fireEvent.click((await ownerUi.findAllByRole("radio"))[0]!);
    const peer = render(<CampaignDetailPage {...props} />);
    fireEvent.click(ownerUi.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(ownerUi.getByRole("button", { name: "Finalize character record" }));
    await ownerUi.findByText(/created and confirmed by the latest character status/i);

    // These requests began before completion and must not restore the unused
    // option while the peer still waits for its own campaign detail.
    stalePeerRoster.resolve({ characters: [] });
    stalePeerOptions.resolve(creationOptions);
    peerDetail.resolve({ campaign: starterConfigured });
    const peerUi = within(peer.container);
    await peerUi.findByText(/created and confirmed by the latest character status/i);
    expect(peerUi.queryByRole("radio", { name: /Persona 1 of 2$/ })).toBeNull();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(listCampaignCharacters).toHaveBeenCalledTimes(3);
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["malformed success currently present", new Error("private malformed body"), "present", /currently present, but it cannot be attributed/i],
    ["typed conflict", new ApiError(409, "private conflict"), "unused", /conflicts with current state/i],
    ["typed unavailable", new ApiError(404, "private unavailable"), "unused", /unavailable for this campaign or persona/i],
    ["network failure with partial reads", new Error("private network"), "partial", /only partial reconciliation/i],
  ])("conservatively classifies %s after exactly one GET pair and no POST retry", async (_label, postError, readState, expected) => {
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const present = { id: "classification-entry-secret", characterId: creationOptions.personas[0]!.characterId, name: creationOptions.personas[0]!.name };
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValueOnce({ characters: [] });
    vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValueOnce(creationOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockRejectedValueOnce(postError);
    if (readState === "present") {
      vi.mocked(listCampaignCharacters).mockResolvedValueOnce({ characters: [present] });
      vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValueOnce(usedOptions);
    } else if (readState === "unused") {
      vi.mocked(listCampaignCharacters).mockResolvedValueOnce({ characters: [] });
      vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValueOnce(creationOptions);
    } else {
      vi.mocked(listCampaignCharacters).mockRejectedValueOnce(new Error("private roster read"));
      vi.mocked(getCampaignCharacterCreationOptions).mockResolvedValueOnce(creationOptions);
    }
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    const confirmation = screen.getByRole("checkbox", { name: /currently has NO derived stats/i });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));

    expect(await screen.findByText(expected)).toBeTruthy();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(listCampaignCharacters).toHaveBeenCalledTimes(2);
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(2);
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(document.body.textContent).not.toMatch(/private (?:malformed|conflict|unavailable|network|roster)/);
  });

  it("keeps a conservative create outcome and paired GET-only refresh outside a failed options form", async () => {
    const created = { id: "persistent-entry-secret", characterId: creationOptions.personas[0]!.characterId, name: "Shared Persona" };
    const refreshRoster = deferred<{ characters: Array<typeof created> }>();
    const refreshOptions = deferred<typeof creationOptions>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockResolvedValueOnce({ characters: [created] })
      .mockReturnValueOnce(refreshRoster.promise);
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockRejectedValueOnce(new ApiError(404, "private reconciliation absence"))
      .mockReturnValueOnce(refreshOptions.promise);
    vi.mocked(createOriginalStarterCampaignCharacter).mockResolvedValue({ character: created });
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);

    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));

    const outcome = await screen.findByText(/only partial reconciliation or unavailable reads/i);
    expect(screen.queryByRole("heading", { name: "Finalize a character record" })).toBeNull();
    expect(screen.getByText("Character creation options could not be loaded.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry character options" })).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh character status" });
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    fireEvent.click(refresh);
    expect(outcome.isConnected).toBe(true);
    expect(screen.getByRole("region", { name: "Character creation" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Refreshing character creation options…")).toBeTruthy();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();

    refreshRoster.reject(new Error("private refresh roster"));
    refreshOptions.reject(new Error("private refresh options"));
    const refreshedOutcome = await screen.findByText(/status refresh was partial or unavailable/i);
    await waitFor(() => expect(document.activeElement).toBe(refreshedOutcome));
    expect(screen.getByRole("button", { name: "Refresh character status" })).toBeTruthy();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/private (?:reconciliation|refresh)/);
  });

  it("keeps pending A reconciliation independent from B, then restores A's module result and status focus", async () => {
    const campaignA = { ...starterConfigured, id: "create-switch-a", name: "Create A" };
    const campaignB = { ...starterConfigured, id: "create-switch-b", name: "Create B" };
    const optionsA = { ...creationOptions, campaignId: campaignA.id };
    const optionsB = { ...creationOptions, campaignId: campaignB.id };
    const usedA = { ...optionsA, personas: optionsA.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const createdA = { id: "switch-a-entry-secret", characterId: optionsA.personas[0]!.characterId, name: "A reconciled character" };
    const postA = deferred<{ character: typeof createdA }>();
    let aRosterReads = 0;
    let aOptionsReads = 0;
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(listCampaignCharacters).mockImplementation(async (id) => {
      if (id === campaignA.id) return ++aRosterReads === 1 ? { characters: [] } : { characters: [createdA] };
      return { characters: [{ id: "b-entry-secret", characterId: "b-persona-secret", name: "B remains current" }] };
    });
    vi.mocked(getCampaignCharacterCreationOptions).mockImplementation(async (id) => {
      if (id === campaignA.id) return ++aOptionsReads === 1 ? optionsA : usedA;
      return optionsB;
    });
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(postA.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));

    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByText("B remains current");
    expect(screen.getByRole("region", { name: "Character creation" }).getAttribute("aria-busy")).toBe("false");
    postA.resolve({ character: createdA });
    await postA.promise;
    await waitFor(() => expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce());
    expect(screen.getByText("B remains current")).toBeTruthy();
    expect(screen.queryByText(/created and confirmed/i)).toBeNull();
    expect(vi.mocked(getCampaignDetail).mock.calls.filter(([id]) => id === campaignB.id)).toHaveLength(1);

    view.rerender(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    const restored = await screen.findByText(/created and confirmed by the latest character status/i);
    await waitFor(() => expect(document.activeElement).toBe(restored));
    expect(screen.getByText("A reconciled character")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /metadata-only setup is final/i })).toBeNull();
    expect(aRosterReads).toBe(3); // initial, operation reconciliation, reopened initial (superseded)
    expect(aOptionsReads).toBe(3);
  });

  it("hands a completed create snapshot to one reopen without overriding its fresh authoritative reads", async () => {
    const created = { id: "handoff-old-entry", characterId: creationOptions.personas[0]!.characterId, name: "Completed snapshot character" };
    const externallyNewer = { id: "handoff-new-entry", characterId: "newer-persona", name: "Externally newer character" };
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const newerOptions = { ...creationOptions, personas: [{ characterId: "newer-unused", name: "New authoritative option", alreadyUsed: false }] };
    const post = deferred<{ character: typeof created }>();
    const freshRoster = deferred<{ characters: Array<typeof externallyNewer> }>();
    const freshOptions = deferred<typeof newerOptions>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockResolvedValueOnce({ characters: [created] })
      .mockReturnValueOnce(freshRoster.promise)
      .mockResolvedValueOnce({ characters: [externallyNewer] });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValueOnce(usedOptions)
      .mockReturnValueOnce(freshOptions.promise)
      .mockResolvedValueOnce(newerOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    first.unmount();
    post.resolve({ character: created });
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));

    const reopened = render(<CampaignDetailPage {...props} />);
    await screen.findByText(/created and confirmed by the latest character status/i);
    expect(listCampaignCharacters).toHaveBeenCalledTimes(3);
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(3);
    freshRoster.resolve({ characters: [externallyNewer] });
    freshOptions.resolve(newerOptions);
    await screen.findByText("Externally newer character");
    await screen.findByText("New authoritative option");
    const outcome = await screen.findByText(/selected persona is currently unused/i);
    await waitFor(() => expect(document.activeElement).toBe(outcome));
    expect(screen.queryByText(/created and confirmed by the latest character status/i)).toBeNull();
    expect(screen.queryByText("Completed snapshot character")).toBeNull();
    reopened.unmount();

    render(<CampaignDetailPage {...props} />);
    await screen.findByText("Externally newer character");
    await screen.findByText("New authoritative option");
    expect(screen.queryByText(/created and confirmed by the latest character status/i)).toBeNull();
    expect(screen.queryByText("Completed snapshot character")).toBeNull();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
  });

  it("rechecks the exact detail generation before queued reopen-handoff focus", async () => {
    const created = { id: "generation-handoff-entry", characterId: creationOptions.personas[0]!.characterId, name: "Generation handoff character" };
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const post = deferred<{ character: typeof created }>();
    const pendingRename = deferred<never>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockResolvedValue({ characters: [created] });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValue(usedOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    vi.mocked(renameCampaign).mockReturnValue(pendingRename.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    first.unmount();
    post.resolve({ character: created });
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));

    const queuedCallbacks: VoidFunction[] = [];
    const queueMicrotaskSpy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      queuedCallbacks.push(callback);
    });
    render(<CampaignDetailPage {...props} />);
    await screen.findByText(/created and confirmed by the latest character status/i);
    await waitFor(() => expect(queuedCallbacks).toHaveLength(1));
    const handoffFocus = queuedCallbacks[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));
    const rosterHeading = screen.getByRole("heading", { name: "Characters" });
    rosterHeading.focus();
    handoffFocus();
    expect(document.activeElement).toBe(rosterHeading);
    queueMicrotaskSpy.mockRestore();
  });

  it("keeps a consumed handoff's conservative outcome when reopen reads fail", async () => {
    const created = { id: "failed-reopen-entry", characterId: creationOptions.personas[0]!.characterId, name: "Partial snapshot" };
    const post = deferred<{ character: typeof created }>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockRejectedValueOnce(new Error("operation roster unavailable"))
      .mockRejectedValueOnce(new Error("fresh roster unavailable"));
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockRejectedValueOnce(new Error("fresh options unavailable"));
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    first.unmount();
    post.resolve({ character: created });
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));

    render(<CampaignDetailPage {...props} />);
    const conservative = await screen.findByText(/only partial reconciliation or unavailable reads/i);
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(3));
    expect(conservative.isConnected).toBe(true);
    expect(screen.getByText("Character creation options could not be loaded.")).toBeTruthy();
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
  });

  it("replaces a handed-off success with a conservative message when the fresh reopen pair fails", async () => {
    const created = { id: "fresh-failure-entry", characterId: creationOptions.personas[0]!.characterId, name: "Previously confirmed" };
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    const post = deferred<{ character: typeof created }>();
    const freshRoster = deferred<{ characters: Array<typeof created> }>();
    const freshOptions = deferred<typeof creationOptions>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockResolvedValueOnce({ characters: [] })
      .mockResolvedValueOnce({ characters: [created] })
      .mockReturnValueOnce(freshRoster.promise);
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValueOnce(usedOptions)
      .mockReturnValueOnce(freshOptions.promise);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    first.unmount();
    post.resolve({ character: created });
    await waitFor(() => expect(listCampaignCharacters).toHaveBeenCalledTimes(2));

    render(<CampaignDetailPage {...props} />);
    await screen.findByText(/created and confirmed by the latest character status/i);
    freshRoster.reject(new Error("private fresh roster failure"));
    freshOptions.reject(new Error("private fresh options failure"));
    await screen.findByText(/only partial reconciliation or unavailable reads/i);
    expect(screen.queryByText(/created and confirmed by the latest character status/i)).toBeNull();
    expect(listCampaignCharacters).toHaveBeenCalledTimes(3);
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toMatch(/private fresh/);
  });

  it("does not disturb B's fresh state when pending A settles", async () => {
    const campaignA = { ...starterConfigured, id: "create-refresh-a", name: "Refresh A" };
    const campaignB = { ...starterConfigured, id: "create-refresh-b", name: "Refresh B" };
    const optionsA = { ...creationOptions, campaignId: campaignA.id };
    const optionsB = { ...creationOptions, campaignId: campaignB.id };
    const used = (value: typeof creationOptions) => ({ ...value, personas: value.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) });
    const createdA = { id: "refresh-a-entry", characterId: optionsA.personas[0]!.characterId, name: "A character" };
    const createdB = { id: "refresh-b-entry", characterId: optionsB.personas[0]!.characterId, name: "B character" };
    const postA = deferred<{ character: typeof createdA }>();
    let aRosterReads = 0;
    let aOptionsReads = 0;
    let bRosterReads = 0;
    let bOptionsReads = 0;
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({ campaign: id === campaignA.id ? campaignA : campaignB }));
    vi.mocked(listCampaignCharacters).mockImplementation((id) => {
      if (id === campaignA.id) return Promise.resolve(++aRosterReads === 1 ? { characters: [] } : { characters: [createdA] });
      bRosterReads += 1;
      if (bRosterReads === 1) return Promise.resolve({ characters: [] });
      return Promise.resolve({ characters: [createdB] });
    });
    vi.mocked(getCampaignCharacterCreationOptions).mockImplementation((id) => {
      if (id === campaignA.id) return Promise.resolve(++aOptionsReads === 1 ? optionsA : used(optionsA));
      bOptionsReads += 1;
      if (bOptionsReads === 1) return Promise.resolve(optionsB);
      return Promise.resolve(used(optionsB));
    });
    vi.mocked(createOriginalStarterCampaignCharacter).mockImplementation((id) => id === campaignA.id
      ? postA.promise
      : Promise.resolve({ character: createdB }));
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    await screen.findByText(/created and confirmed by the latest character status/i);

    view.rerender(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByText("B character");

    postA.resolve({ character: createdA });
    await postA.promise;
    await waitFor(() => expect(aRosterReads).toBe(2));
    expect(screen.getByText("B character")).toBeTruthy();
    expect(screen.queryByText("A character")).toBeNull();
    expect(screen.getByRole("region", { name: "Character creation" }).getAttribute("aria-busy")).toBe("false");
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledTimes(2);
  });

  it("invalidates a pending pre-create roster across unmount/reopen so reconciliation wins", async () => {
    const preCreateRoster = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    const reopenedRoster = deferred<{ characters: Array<{ id: string; characterId: string; name: string }> }>();
    const created = { id: "reopen-entry-secret", characterId: creationOptions.personas[0]!.characterId, name: "Fresh reconciliation winner" };
    const post = deferred<{ character: typeof created }>();
    const usedOptions = { ...creationOptions, personas: creationOptions.personas.map((persona, index) => index === 0 ? { ...persona, alreadyUsed: true } : persona) };
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters)
      .mockReturnValueOnce(preCreateRoster.promise)
      .mockReturnValueOnce(reopenedRoster.promise)
      .mockResolvedValueOnce({ characters: [created] });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValueOnce(creationOptions)
      .mockResolvedValueOnce(usedOptions);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    const props = { campaignId: starterConfigured.id, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    fireEvent.click((await screen.findAllByRole("radio"))[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    first.unmount();

    render(<CampaignDetailPage {...props} />);
    await screen.findByRole("heading", { name: starterConfigured.name });
    post.resolve({ character: created });
    const outcome = await screen.findByText(/created and confirmed by the latest character status/i);
    reopenedRoster.resolve({ characters: [] });
    preCreateRoster.resolve({ characters: [] });
    await Promise.all([reopenedRoster.promise, preCreateRoster.promise]);
    await waitFor(() => expect(screen.getByText("Fresh reconciliation winner")).toBeTruthy());
    expect(outcome.isConnected).toBe(true);
    expect(listCampaignCharacters).toHaveBeenCalledTimes(3);
    expect(createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
  });

  it("announces independent initial options and create-form busy states", async () => {
    const initialOptions = deferred<typeof creationOptions>();
    const post = deferred<{ character: { id: string; characterId: string; name: string } }>();
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(listCampaignCharacters).mockResolvedValue({ characters: [] });
    vi.mocked(getCampaignCharacterCreationOptions).mockReturnValueOnce(initialOptions.promise);
    vi.mocked(createOriginalStarterCampaignCharacter).mockReturnValue(post.promise);
    render(<CampaignDetailPage campaignId={starterConfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Character creation" });
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading character creation options…")).toBeTruthy();
    initialOptions.resolve(creationOptions);
    const form = (await screen.findByRole("heading", { name: "Finalize a character record" })).closest("form")!;
    expect(region.getAttribute("aria-busy")).toBe("false");
    expect(form.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finalize character record" }));
    await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("true"));
    expect(region.getAttribute("aria-busy")).toBe("false");
    post.resolve({ character: { id: "busy-entry", characterId: creationOptions.personas[0]!.characterId, name: "Shared Persona" } });
    await screen.findByText(/only partial reconciliation or unavailable reads/i);
  });

  it("requires explicit confirmation, locks duplicate PUTs, reconciles success, and removes all setup mutation", async () => {
    const write = deferred<{ campaign: typeof starterConfigured }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: starterConfigured });
    vi.mocked(setupOriginalStarter).mockReturnValue(write.promise);
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const confirmation = await screen.findByRole("checkbox", { name: /I understand this metadata-only setup is final/i });
    const setup = screen.getByRole("button", { name: "Set up original starter" });
    expect((setup as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmation);
    fireEvent.click(setup);
    fireEvent.click(setup);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    expect(setupOriginalStarter).toHaveBeenCalledWith(ownerUnconfigured.id);
    expect((confirmation as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Campaign name" }) as HTMLInputElement).disabled).toBe(true);
    write.resolve({ campaign: starterConfigured });
    await screen.findByText(/Original starter setup is complete/i);
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByText("velvet:rules:original-narrative")).toBeTruthy();
    expect(screen.getByText("velvet:original-starter")).toBeTruthy();
    expect(screen.getByText(/Content configuration is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set up original starter/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /metadata-only setup is final/i })).toBeNull();
    expect(document.activeElement).toBe(screen.getByText(/Content configuration is read-only/i).closest(".configured-readonly"));
  });

  it("offers mutually exclusive fixed starters and reconciles one mechanics PUT with one detail GET", async () => {
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign: ownerUnconfigured })
      .mockResolvedValueOnce({ campaign: mechanicsConfigured });
    vi.mocked(setupMechanicsStarter).mockResolvedValueOnce({ campaign: mechanicsConfigured });
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} mechanicsEnabled onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const original = await screen.findByRole("radio", { name: /Original metadata starter/i });
    const mechanics = screen.getByRole("radio", { name: /Mechanics starter/i });
    expect((original as HTMLInputElement).checked).toBe(true);
    expect((mechanics as HTMLInputElement).checked).toBe(false);
    fireEvent.click(mechanics);
    expect((original as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/future builder and progression UI/i)).toBeTruthy();
    expect(screen.getByText(/cannot replace any configured content/i)).toBeTruthy();
    const confirmation = screen.getByRole("checkbox", { name: /explicitly confirm mechanics starter activation/i });
    fireEvent.click(confirmation);
    const activate = screen.getByRole("button", { name: "Activate mechanics starter" });
    fireEvent.click(activate);
    fireEvent.click(activate);

    await screen.findByText(/Mechanics starter setup is complete/i);
    expect(setupMechanicsStarter).toHaveBeenCalledOnce();
    expect(setupMechanicsStarter).toHaveBeenCalledWith(ownerUnconfigured.id);
    expect(setupOriginalStarter).not.toHaveBeenCalled();
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Content configuration is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /starter/i })).toBeNull();
  });

  it("prevents a late pre-activation detail read from overwriting mechanics reconciliation after reopen", async () => {
    const write = deferred<{ campaign: typeof mechanicsConfigured }>();
    const stalePreActivation = deferred<{ campaign: typeof ownerUnconfigured }>();
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign: ownerUnconfigured })
      .mockReturnValueOnce(stalePreActivation.promise)
      .mockResolvedValueOnce({ campaign: mechanicsConfigured });
    vi.mocked(setupMechanicsStarter).mockReturnValueOnce(write.promise);
    const props = { campaignId: ownerUnconfigured.id, mechanicsEnabled: true, onBack: vi.fn(), onUnavailable: vi.fn() };
    const first = render(<CampaignDetailPage {...props} />);
    await screen.findByRole("radio", { name: /Mechanics starter/i });
    fireEvent.click(screen.getByRole("radio", { name: /Mechanics starter/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /explicitly confirm mechanics starter activation/i }));
    fireEvent.click(screen.getByRole("button", { name: "Activate mechanics starter" }));
    expect(setupMechanicsStarter).toHaveBeenCalledOnce();
    first.unmount();

    render(<CampaignDetailPage {...props} />);
    await waitFor(() => expect(getCampaignDetail).toHaveBeenCalledTimes(2));
    write.resolve({ campaign: mechanicsConfigured });
    await screen.findByText(/Mechanics starter setup is complete/i);
    expect(getCampaignDetail).toHaveBeenCalledTimes(3);
    stalePreActivation.resolve({ campaign: ownerUnconfigured });
    await stalePreActivation.promise;
    await Promise.resolve();

    expect(screen.getByText("velvet:rules:starter-v1")).toBeTruthy();
    expect(screen.getByText(/Content configuration is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate mechanics starter" })).toBeNull();
    expect(screen.queryByRole("radio", { name: /Mechanics starter/i })).toBeNull();
    expect(setupMechanicsStarter).toHaveBeenCalledOnce();
  });

  it("keeps setup serialized across unmount and reopen without a duplicate PUT", async () => {
    const write = deferred<{ campaign: typeof starterConfigured }>();
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign: ownerUnconfigured })
      .mockResolvedValueOnce({ campaign: ownerUnconfigured })
      .mockResolvedValue({ campaign: starterConfigured });
    vi.mocked(getCampaignCharacterCreationOptions)
      .mockRejectedValueOnce(new ApiError(404, "pre-commit unavailable"))
      .mockRejectedValueOnce(new ApiError(404, "reopen pre-commit unavailable"))
      .mockResolvedValueOnce(creationOptions);
    vi.mocked(setupOriginalStarter).mockReturnValue(write.promise);
    const first = render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    first.unmount();

    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const reopened = await screen.findByRole("button", { name: "Set up original starter" });
    expect((reopened as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reopened);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    write.resolve({ campaign: starterConfigured });
    await screen.findByText(/Content configuration is read-only/i);
    await screen.findByRole("heading", { name: "Finalize a character record" });
    expect(getCampaignCharacterCreationOptions).toHaveBeenCalledTimes(3);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
  });

  it("forces post-commit options after an A-B-A setup completion without stale form theft", async () => {
    const campaignA = { ...ownerUnconfigured, id: "setup-options-a", name: "Setup A" };
    const configuredA = { ...starterConfigured, id: campaignA.id, name: campaignA.name };
    const campaignB = { ...configured, id: "setup-options-b", name: "Setup B" };
    const optionsA = { ...creationOptions, campaignId: campaignA.id };
    const optionsB = { ...creationOptions, campaignId: campaignB.id };
    const write = deferred<{ campaign: typeof configuredA }>();
    let aDetailReads = 0;
    vi.mocked(getCampaignDetail).mockImplementation(async (id) => ({
      campaign: id === campaignB.id ? campaignB : (++aDetailReads < 3 ? campaignA : configuredA),
    }));
    vi.mocked(getCampaignCharacterCreationOptions).mockImplementation(async (id) => id === campaignB.id ? optionsB : optionsA);
    vi.mocked(setupOriginalStarter).mockReturnValue(write.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    view.rerender(<CampaignDetailPage campaignId={campaignB.id} {...props} />);
    await screen.findByRole("heading", { name: campaignB.name });
    view.rerender(<CampaignDetailPage campaignId={campaignA.id} {...props} />);
    await screen.findByRole("heading", { name: campaignA.name });

    const beforeCommitOptions = vi.mocked(getCampaignCharacterCreationOptions).mock.calls
      .filter(([id]) => id === campaignA.id).length;
    write.resolve({ campaign: configuredA });
    await screen.findByRole("heading", { name: "Finalize a character record" });
    expect(vi.mocked(getCampaignCharacterCreationOptions).mock.calls.filter(([id]) => id === campaignA.id).length)
      .toBe(beforeCommitOptions + 1);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
  });

  it("keeps rename serialized across unmount and reopen without a duplicate PATCH", async () => {
    const renamed = { ...configured, name: "After reopen", updatedAt: "2030-04-07T00:00:00.000Z" };
    const write = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(getCampaignDetail)
      .mockResolvedValueOnce({ campaign: configured })
      .mockResolvedValueOnce({ campaign: configured })
      .mockResolvedValue({ campaign: renamed });
    vi.mocked(renameCampaign).mockReturnValue(write.promise);
    const first = render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: renamed.name } });
    fireEvent.submit(input.closest("form")!);
    expect(renameCampaign).toHaveBeenCalledOnce();
    first.unmount();

    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const reopened = await screen.findByRole("button", { name: "Rename campaign" });
    expect((reopened as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reopened);
    expect(renameCampaign).toHaveBeenCalledOnce();
    write.resolve({ campaign: { id: renamed.id, name: renamed.name, updatedAt: renamed.updatedAt } });
    await screen.findByRole("heading", { name: renamed.name });
    expect(renameCampaign).toHaveBeenCalledOnce();
  });

  it("treats a malformed successful PUT response as ambiguous and reconciles exact success", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: starterConfigured });
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new Error("Campaign starter setup response did not match the request"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    await screen.findByText(/write response was not authoritative.*reconciled/i);
    expect(screen.getByText(/Content configuration is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set up original starter/i })).toBeNull();
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByText(/Content configuration is read-only/i).closest(".configured-readonly")));
  });

  it("reconciles an ambiguous PUT failure to exact starter success without retrying", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: starterConfigured });
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new Error("response lost"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    await screen.findByText(/write response was not authoritative.*reconciled/i);
    expect(screen.getByText("velvet:rules:original-narrative")).toBeTruthy();
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByText(/Content configuration is read-only/i).closest(".configured-readonly")));
  });

  it("keeps a 409 reconciliation unconfigured with a stable message and confirmation focus", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: ownerUnconfigured });
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new ApiError(409, "private conflict"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const confirmation = await screen.findByRole("checkbox", { name: /metadata-only setup is final/i });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("campaign remains unconfigured");
    expect(alert.textContent).toContain("setup was not repeated");
    expect(document.body.textContent).not.toContain("private conflict");
    expect(screen.getByText("Unconfigured")).toBeTruthy();
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
  });

  it("does not trust the PUT body as current detail when post-setup detail refresh fails", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockRejectedValueOnce(new Error("private refresh"));
    vi.mocked(setupOriginalStarter).mockResolvedValueOnce({ campaign: starterConfigured });
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    await screen.findByText(/setup completed, but the latest details could not be refreshed/i);
    expect(screen.getByText("Unconfigured")).toBeTruthy();
    expect(screen.queryByText(/Content configuration is read-only/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Finalize a character record" })).toBeNull();
    expect(document.body.textContent).not.toContain("private refresh");
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.activeElement)
      .toBe(screen.getByRole("checkbox", { name: /metadata-only setup is final/i })));
  });

  it("keeps generic failed reconciliation stable and never retries the PUT", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockRejectedValueOnce(new Error("private refresh"));
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new Error("private write"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const confirmation = await screen.findByRole("checkbox", { name: /metadata-only setup is final/i });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Setup outcome is uncertain");
    expect(alert.textContent).toContain("PUT was not repeated");
    expect(document.body.textContent).not.toMatch(/private (?:write|refresh)/);
    expect(screen.getByText("Unconfigured")).toBeTruthy();
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
  });

  it("keeps failed 409 reconciliation stable and never retries the PUT", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockRejectedValueOnce(new Error("private refresh"));
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new ApiError(409, "private conflict"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const confirmation = await screen.findByRole("checkbox", { name: /metadata-only setup is final/i });
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("conflicts with current state");
    expect(alert.textContent).toContain("PUT was not repeated");
    expect(document.body.textContent).not.toMatch(/private (?:conflict|refresh)/);
    expect(screen.getByText("Unconfigured")).toBeTruthy();
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
  });

  it("reconciles ambiguous two-transaction failure without repeating PUT", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: ownerUnconfigured });
    vi.mocked(setupOriginalStarter).mockRejectedValue(new Error("private response loss"));
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("two transactions");
    expect(alert.textContent).toContain("pack may remain installed");
    expect(alert.textContent).toContain("PUT was not repeated");
    expect(alert.textContent).not.toContain("private response loss");
    expect(setupOriginalStarter).toHaveBeenCalledOnce();
    expect(getCampaignDetail).toHaveBeenCalledTimes(2);
  });

  it("handles setup conflict through authoritative different configuration and authority 404 without leaks", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: configured });
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new ApiError(409, "private namespace collision"));
    const first = render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    expect((await screen.findByRole("alert")).textContent).toContain("different content configuration");
    expect(document.body.textContent).not.toContain("private namespace collision");
    expect(screen.queryByRole("button", { name: /Set up original starter/i })).toBeNull();
    first.unmount();

    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured });
    vi.mocked(setupOriginalStarter).mockRejectedValueOnce(new ApiError(404, "private authority"));
    const unavailable = vi.fn();
    render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toContain("private authority");
  });

  it("ignores stale and unmounted starter setup completions", async () => {
    const staleWrite = deferred<{ campaign: typeof starterConfigured }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured }).mockResolvedValueOnce({ campaign: configured });
    vi.mocked(setupOriginalStarter).mockReturnValueOnce(staleWrite.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const view = render(<CampaignDetailPage campaignId={ownerUnconfigured.id} {...props} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    view.rerender(<CampaignDetailPage campaignId={configured.id} {...props} />);
    await screen.findByRole("heading", { name: configured.name });
    staleWrite.resolve({ campaign: starterConfigured });
    await staleWrite.promise;
    await waitFor(() => expect(screen.getByRole("heading", { name: configured.name })).toBeTruthy());
    // The stale operation still owns its mandatory reconciliation GET even
    // though campaign B is now displayed.
    expect(getCampaignDetail).toHaveBeenCalledTimes(3);
    view.unmount();

    const unmountedWrite = deferred<{ campaign: typeof starterConfigured }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured });
    vi.mocked(setupOriginalStarter).mockReturnValueOnce(unmountedWrite.promise);
    const unavailable = vi.fn();
    const late = render(<CampaignDetailPage campaignId={ownerUnconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(screen.getByRole("button", { name: "Set up original starter" }));
    late.unmount();
    unmountedWrite.resolve({ campaign: starterConfigured });
    await unmountedWrite.promise;
    await Promise.resolve();
    expect(unavailable).not.toHaveBeenCalled();
    expect(getCampaignDetail).toHaveBeenCalledTimes(5);
  });

  it("normalizes, saves same or changed names once, reconciles, announces, and focuses", async () => {
    const renamed = { ...configured, name: "New Road", updatedAt: "2030-04-06T00:00:00.000Z" };
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: renamed });
    const write = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(renameCampaign).mockReturnValue(write.promise);
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    expect((input as HTMLInputElement).value).toBe(configured.name);
    fireEvent.change(input, { target: { value: "  New Road  " } });
    const submit = screen.getByRole("button", { name: "Rename campaign" });
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    expect(renameCampaign).toHaveBeenCalledOnce();
    expect(renameCampaign).toHaveBeenCalledWith(configured.id, { name: "New Road", expectedUpdatedAt: configured.updatedAt });
    expect((input as HTMLInputElement).disabled).toBe(true);
    write.resolve({ campaign: { id: renamed.id, name: renamed.name, updatedAt: renamed.updatedAt } });
    await screen.findByRole("heading", { name: renamed.name });
    await screen.findByText(`Campaign renamed to “${renamed.name}”.`);
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
    expect(document.activeElement).toBe(input);

    // Equality with the current name remains a permitted timestamp-changing write.
    vi.mocked(renameCampaign).mockResolvedValueOnce({ campaign: { id: renamed.id, name: renamed.name, updatedAt: "2030-04-07T00:00:00.000Z" } });
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: { ...renamed, updatedAt: "2030-04-07T00:00:00.000Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));
    await waitFor(() => expect(renameCampaign).toHaveBeenCalledTimes(2));
  });

  it("validates synchronously without a PATCH and preserves the invalid draft", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: configured });
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("between 1 and 200");
    expect(renameCampaign).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("   ");
    expect(document.activeElement).toBe(input);
  });

  it("retains the draft and authoritatively refreshes after a two-tab stale conflict", async () => {
    const elsewhere = { ...configured, name: "Changed Elsewhere", updatedAt: "2030-04-08T00:00:00.000Z" };
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: elsewhere });
    vi.mocked(renameCampaign).mockRejectedValue(new ApiError(409, "private stale"));
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: "My Draft" } });
    fireEvent.submit(input.closest("form")!);
    await screen.findByRole("heading", { name: elsewhere.name });
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    expect((input as HTMLInputElement).value).toBe("My Draft");
    expect(renameCampaign).toHaveBeenCalledOnce();
  });

  it("reconciles ambiguous failures but never attributes matching names or timestamps to the PATCH", async () => {
    const committed = { ...configured, name: "Recovered Name", updatedAt: "2030-04-09T00:00:00.000Z" };
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: committed });
    vi.mocked(renameCampaign).mockRejectedValueOnce(new Error("response lost"));
    const { unmount } = render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: committed.name } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("rename write could not be confirmed");
    expect(screen.queryByText(/is saved/i)).toBeNull();
    expect(renameCampaign).toHaveBeenCalledOnce();
    unmount();

    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: { ...configured, updatedAt: "2030-04-10T00:00:00.000Z" } });
    vi.mocked(renameCampaign).mockRejectedValueOnce(new ApiError(500, "private internal"));
    render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const secondInput = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(secondInput, { target: { value: "Not Saved" } });
    fireEvent.submit(secondInput.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("rename write could not be confirmed");
    expect((await screen.findByRole("alert")).textContent).toContain(`current name is “${configured.name}”`);
    expect((secondInput as HTMLInputElement).value).toBe("Not Saved");
    expect(renameCampaign).toHaveBeenCalledTimes(2);
  });

  it("keeps transient failures on-page, redacts details, and retries", async () => {
    vi.mocked(getCampaignDetail).mockRejectedValueOnce(new Error("private failure")).mockResolvedValueOnce({ campaign: unconfigured });
    const unavailable = vi.fn();
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    await screen.findByText("Campaign could not be loaded.");
    expect(screen.queryByText("private failure")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: unconfigured.name });
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("reconciles 404 and unavailable detail to campaigns", async () => {
    vi.mocked(getCampaignDetail).mockRejectedValue(new ApiError(404, "private not found"));
    const unavailable = vi.fn();
    render(<CampaignDetailPage campaignId="missing" onBack={vi.fn()} onUnavailable={unavailable} />);
    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(screen.queryByText("private not found")).toBeNull();
  });

  it("applies only the newest rapid campaign switch", async () => {
    const first = deferred<{ campaign: typeof unconfigured }>();
    const second = deferred<{ campaign: typeof configured }>();
    vi.mocked(getCampaignDetail).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const { rerender } = render(<CampaignDetailPage campaignId={unconfigured.id} {...props} />);
    rerender(<CampaignDetailPage campaignId={configured.id} {...props} />);
    second.resolve({ campaign: configured });
    await screen.findByRole("heading", { name: configured.name });
    first.resolve({ campaign: unconfigured });
    await waitFor(() => expect(screen.getByRole("heading", { name: configured.name })).toBeTruthy());
    expect(screen.queryByText(unconfigured.name)).toBeNull();
  });

  it("ignores success and failure completions after unmount", async () => {
    for (const outcome of ["success", "failure"] as const) {
      const pending = deferred<{ campaign: typeof unconfigured }>();
      vi.mocked(getCampaignDetail).mockReturnValueOnce(pending.promise);
      const unavailable = vi.fn();
      const { unmount } = render(<CampaignDetailPage campaignId={unconfigured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
      unmount();
      if (outcome === "success") pending.resolve({ campaign: unconfigured }); else pending.reject(new Error("late"));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
      expect(unavailable).not.toHaveBeenCalled();
    }
  });

  it("ignores a rename completion after unmount and a stale rename after rapid selection", async () => {
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured });
    const pendingWrite = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(renameCampaign).mockReturnValueOnce(pendingWrite.promise);
    const unavailable = vi.fn();
    const first = render(<CampaignDetailPage campaignId={configured.id} onBack={vi.fn()} onUnavailable={unavailable} />);
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: "Late Name" } });
    fireEvent.submit(input.closest("form")!);
    first.unmount();
    pendingWrite.resolve({ campaign: { id: configured.id, name: "Late Name", updatedAt: "2030-04-11T00:00:00.000Z" } });
    await pendingWrite.promise;
    await Promise.resolve();
    expect(unavailable).not.toHaveBeenCalled();
    expect(getCampaignDetail).toHaveBeenCalledTimes(1);

    const rapidWrite = deferred<{ campaign: { id: string; name: string; updatedAt: string } }>();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: configured }).mockResolvedValueOnce({ campaign: unconfigured });
    vi.mocked(renameCampaign).mockReturnValueOnce(rapidWrite.promise);
    const props = { onBack: vi.fn(), onUnavailable: vi.fn() };
    const rapid = render(<CampaignDetailPage campaignId={configured.id} {...props} />);
    const rapidInput = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(rapidInput, { target: { value: "Stale Selection Name" } });
    fireEvent.submit(rapidInput.closest("form")!);
    rapid.rerender(<CampaignDetailPage campaignId={unconfigured.id} {...props} />);
    await screen.findByRole("heading", { name: unconfigured.name });
    rapidWrite.resolve({ campaign: { id: configured.id, name: "Stale Selection Name", updatedAt: "2030-04-12T00:00:00.000Z" } });
    await rapidWrite.promise;
    await waitFor(() => expect(screen.getByRole("heading", { name: unconfigured.name })).toBeTruthy());
    expect(screen.queryByText("Stale Selection Name")).toBeNull();
  });

  it("returns to campaigns through its back action", () => {
    vi.mocked(getCampaignDetail).mockReturnValue(new Promise(() => undefined));
    const onBack = vi.fn();
    render(<CampaignDetailPage campaignId={unconfigured.id} onBack={onBack} onUnavailable={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("CampaignAdministrationPage role projections", () => {
  const timestamp = "2030-04-05T00:00:00.000Z";
  const timeline = { id: "timeline-main", parentTimelineId: null, forkedFromRevision: null, revision: 7, createdAt: timestamp, active: true };
  const receipt: CampaignAdministrationReceipt = { commandId: "command-one", campaignId: "campaign-one", type: "administration_updated",
    revisionBefore: 4, revisionAfter: 5, occurredAt: timestamp, events: [{ eventId: "event-one", commandId: "command-one",
      campaignId: "campaign-one", type: "administration_updated", revision: 5, occurredAt: timestamp, data: { settings: {} } }] };

  beforeEach(() => {
    vi.mocked(listCampaignTimelines).mockResolvedValue({ activeTimelineId: timeline.id, timelines: [timeline] });
    vi.mocked(listCampaignCheckpoints).mockResolvedValue({ checkpoints: [] });
    vi.mocked(getCampaignDetail).mockResolvedValue({ campaign: ownerUnconfigured });
  });

  it("structurally omits owner and privileged controls from a player projection", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "player", status: "published", activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "standard", recapVisibility: "members" },
    } });
    render(<CampaignAdministrationPage campaignId="campaign-one" campaignName="The Long Road" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Campaign settings" })).toBeTruthy();
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Timeline checkpoints" })).toBeTruthy();
    expect(screen.queryByText("GM notes")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Memberships" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create checkpoint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import / export" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Inspect an import report" })).toBeNull();
    expect(listCampaignMemberships).not.toHaveBeenCalled();
  });

  it("shows GM notes but structurally omits every owner mutation from a GM projection", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "gm", status: "paused", activeTimelineId: timeline.id, revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: false, safetyMode: "strict", recapVisibility: "gm-only", gmNotes: "GM-only canon" },
    } });
    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    expect(await screen.findByText("GM-only canon")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume campaign" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Memberships" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create checkpoint" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Inspect an import report" })).toBeNull();
  });

  it("omits privileged notes and every mutation from an observer projection", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "observer", status: "published", activeTimelineId: timeline.id, revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: false, safetyMode: "standard", recapVisibility: "members" },
    } });
    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Campaign settings" })).toBeTruthy();
    expect(screen.queryByText("GM notes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create checkpoint" })).toBeNull();
    expect(listCampaignMemberships).not.toHaveBeenCalled();
  });

  it("renders owner-only lifecycle, membership, checkpoint, archive, and transfer navigation", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "owner", status: "published", activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict", recapVisibility: "gm-only", gmNotes: "Private canon" },
    } });
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [
      { principalId: "local-owner", role: "owner", createdAt: timestamp },
      { principalId: "local-player", role: "player", createdAt: timestamp },
    ] });
    render(<CampaignAdministrationPage campaignId="campaign-one" campaignName="The Long Road" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const saveSettings = await screen.findByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(saveSettings.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I reviewed these policy and visibility settings and confirm this change."));
    expect(saveSettings.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Pause campaign" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Archive campaign" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "Memberships" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create checkpoint" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Import / export" })).toBeTruthy();
    expect(screen.getByDisplayValue("Private canon")).toBeTruthy();
  });

  it("locks an uncertain write against duplicates until an authoritative refresh", async () => {
    const administration = { campaign: {
      id: "campaign-one", actorRole: "owner" as const, status: "published" as const, activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict" as const, recapVisibility: "gm-only" as const, gmNotes: "Private canon" },
    } };
    vi.mocked(getCampaignAdministration).mockResolvedValue(administration);
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [{ principalId: "local-owner", role: "owner", createdAt: timestamp }] });
    vi.mocked(updateCampaignAdministration).mockRejectedValueOnce(new Error("connection lost"));
    render(<CampaignAdministrationPage campaignId="campaign-one" campaignName="The Long Road" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const save = await screen.findByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    fireEvent.click(screen.getByLabelText("I reviewed these policy and visibility settings and confirm this change."));
    fireEvent.click(save);
    const refresh = await screen.findByRole("button", { name: "Refresh authoritative state" });
    const lockedSave = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect((lockedSave.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(lockedSave);
    expect(updateCampaignAdministration).toHaveBeenCalledTimes(1);

    fireEvent.click(refresh);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save settings" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
    expect(updateCampaignAdministration).toHaveBeenCalledTimes(1);
  });

  it("keeps restored archive unavailable until an explicit campaign-name retry succeeds", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "owner", status: "published", activeTimelineId: timeline.id, revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict", recapVisibility: "gm-only", gmNotes: "" },
    } });
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [{ principalId: "local-owner", role: "owner", createdAt: timestamp }] });
    vi.mocked(getCampaignDetail).mockRejectedValueOnce(new Error("detail unavailable"));
    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const retry = await screen.findByRole("button", { name: "Retry campaign name" });
    expect(screen.queryByRole("button", { name: "Archive campaign" })).toBeNull();
    vi.mocked(getCampaignDetail).mockResolvedValueOnce({ campaign: ownerUnconfigured });
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "Archive campaign" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Archive campaign" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires settings review and treats local invalid input as a certain non-commit", async () => {
    vi.mocked(getCampaignAdministration).mockResolvedValue({ campaign: {
      id: "campaign-one", actorRole: "owner", status: "published", activeTimelineId: timeline.id, revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict", recapVisibility: "gm-only", gmNotes: "" },
    } });
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [{ principalId: "local-owner", role: "owner", createdAt: timestamp }] });
    vi.mocked(updateCampaignAdministration).mockRejectedValueOnce(new ApiInputError());
    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const save = await screen.findByRole("button", { name: "Save settings" });
    fireEvent.click(save);
    expect(updateCampaignAdministration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("I reviewed these policy and visibility settings and confirm this change."));
    fireEvent.click(save);
    await screen.findByText("The change was rejected. Refresh before editing stale state.");
    expect(screen.queryByRole("button", { name: "Refresh authoritative state" })).toBeNull();
    expect((save.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
  });

  it("retains a settled write across unmount and blocks reopening until authoritative refresh", async () => {
    const administration = { campaign: {
      id: "campaign-one", actorRole: "owner" as const, status: "published" as const, activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict" as const, recapVisibility: "gm-only" as const, gmNotes: "" },
    } };
    const write = deferred<Awaited<ReturnType<typeof updateCampaignAdministration>>>();
    vi.mocked(getCampaignAdministration).mockResolvedValue(administration);
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [{ principalId: "local-owner", role: "owner", createdAt: timestamp }] });
    vi.mocked(updateCampaignAdministration).mockReturnValue(write.promise);
    const first = render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "Save settings" });
    fireEvent.click(screen.getByLabelText("I reviewed these policy and visibility settings and confirm this change."));
    fireEvent.click(save);
    first.unmount();

    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByRole("heading", { name: "Campaign settings" });
    expect(screen.queryByRole("button", { name: "Refresh authoritative state" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save settings" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    await act(async () => { write.resolve({ campaign: { ...administration.campaign, revision: 5 }, receipt }); await write.promise; });
    const refresh = await screen.findByRole("button", { name: "Refresh authoritative state" });
    expect(updateCampaignAdministration).toHaveBeenCalledTimes(1);
    fireEvent.click(refresh);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save settings" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
    expect(updateCampaignAdministration).toHaveBeenCalledTimes(1);
  });

  it("unlocks only after a receipt-backed write receives successful authoritative reconciliation", async () => {
    const before = { campaign: {
      id: "campaign-one", actorRole: "owner" as const, status: "published" as const, activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict" as const, recapVisibility: "gm-only" as const, gmNotes: "" },
    } };
    const after = { campaign: { ...before.campaign, revision: 5, updatedAt: "2030-04-05T00:00:01.000Z" } };
    vi.mocked(getCampaignAdministration).mockResolvedValueOnce(before).mockResolvedValue(after);
    vi.mocked(listCampaignMemberships).mockResolvedValue({ memberships: [{ principalId: "local-owner", role: "owner", createdAt: timestamp }] });
    vi.mocked(updateCampaignAdministration).mockResolvedValue({ campaign: after.campaign, receipt });
    render(<CampaignAdministrationPage campaignId="campaign-one" onBack={vi.fn()} onUnavailable={vi.fn()} />);

    const save = await screen.findByRole("button", { name: "Save settings" });
    fireEvent.click(screen.getByLabelText("I reviewed these policy and visibility settings and confirm this change."));
    fireEvent.click(save);
    await screen.findByText(/Confirmed by receipt at revision 5/);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save settings" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
    expect(getCampaignAdministration).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Refresh authoritative state" })).toBeNull();
  });

  it("does not let stale cross-campaign loads publish or claim queued heading focus", async () => {
    const campaignA = deferred<Awaited<ReturnType<typeof getCampaignAdministration>>>();
    const observer = (id: string) => ({ campaign: {
      id, actorRole: "observer" as const, status: "published" as const, activeTimelineId: timeline.id,
      revision: 4, updatedAt: timestamp,
      settings: { maxPlayers: 6, allowPlayerDice: false, safetyMode: "standard" as const, recapVisibility: "members" as const },
    } });
    vi.mocked(getCampaignAdministration).mockImplementation((id) => id === "campaign-a" ? campaignA.promise : Promise.resolve(observer(id)));
    vi.mocked(getCampaignDetail).mockImplementation((id) => Promise.resolve({ campaign: { ...unconfigured, id, name: id === "campaign-a" ? "First" : "Second" } }));
    const focused = vi.fn();
    const view = render(<CampaignAdministrationPage campaignId="campaign-a" focusHeadingRequest={1} onHeadingFocused={focused} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    view.rerender(<CampaignAdministrationPage campaignId="campaign-b" focusHeadingRequest={2} onHeadingFocused={focused} onBack={vi.fn()} onUnavailable={vi.fn()} />);

    expect(await screen.findByText("Second")).toBeTruthy();
    await waitFor(() => expect(focused).toHaveBeenCalledWith(2));
    await act(async () => { campaignA.resolve(observer("campaign-a")); await campaignA.promise; });
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.queryByText("First")).toBeNull();
    expect(focused).not.toHaveBeenCalledWith(1);
  });
});
