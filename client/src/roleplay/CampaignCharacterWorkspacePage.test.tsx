import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCampaignCharacterWorkspace } from "../api";
import { CampaignCharacterWorkspacePage, resetCampaignCharacterWorkspacePageModuleStateForTests } from "./CampaignCharacterWorkspacePage";

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

afterEach(() => { cleanup(); resetCampaignCharacterWorkspacePageModuleStateForTests(); vi.resetAllMocks(); });

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
