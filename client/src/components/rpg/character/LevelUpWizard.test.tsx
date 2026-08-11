import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api";
import { LevelUpWizard, resetLevelUpWizardModuleStateForTests, type LevelUpWizardApi } from "./LevelUpWizard";

function missingProgression(): ApiError {
  const error = new ApiError(404, "private absence");
  error.code = "RPG_CHARACTER_PROGRESSION_NOT_FOUND";
  return error;
}

const state = { level: 1, totalXp: 0, milestoneCount: 0, pendingChoices: [] } as any;
const sheet = { sheet: { name: "Authoritative" } } as any;
const preview = { eligibleLevel: 1, pendingChoices: [], levels: [], previewRevision: 1, previewToken: "token" } as any;

function wizardApi(overrides: Partial<LevelUpWizardApi> = {}): LevelUpWizardApi {
  return {
    getProgression: vi.fn().mockResolvedValue(state),
    getSheet: vi.fn().mockResolvedValue(sheet),
    preview: vi.fn().mockResolvedValue(preview),
    apply: vi.fn(),
    ...overrides,
  };
}

afterEach(() => { cleanup(); resetLevelUpWizardModuleStateForTests(); vi.restoreAllMocks(); });

describe("LevelUpWizard optional workspace progression", () => {
  it("omits only the exact missing-progression response before reading the sheet", async () => {
    const api = wizardApi({ getProgression: vi.fn().mockRejectedValue(missingProgression()) });
    const unavailable = vi.fn();
    const { container } = render(<LevelUpWizard campaignId="campaign" campaignCharacterId="character" api={api} mode="workspace" onUnavailable={unavailable} />);

    await waitFor(() => expect(container.querySelector(".level-up-wizard")).toBeNull());
    expect(api.getSheet).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("keeps standalone missing progression unavailable behavior unchanged", async () => {
    const api = wizardApi({ getProgression: vi.fn().mockRejectedValue(missingProgression()) });
    const unavailable = vi.fn();
    render(<LevelUpWizard campaignId="campaign" campaignCharacterId="character" api={api} onUnavailable={unavailable} />);

    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toContain("private absence");
  });

  it.each([
    ["another progression 404", "progression", new ApiError(404, "route missing")],
    ["a sheet 404", "sheet", missingProgression()],
    ["a preview 404", "preview", missingProgression()],
  ] as const)("does not omit %s", async (_label, source, error) => {
    const api = wizardApi({
      ...(source === "progression" ? { getProgression: vi.fn().mockRejectedValue(error) } : {}),
      ...(source === "sheet" ? { getSheet: vi.fn().mockRejectedValue(error) } : {}),
      ...(source === "preview" ? { preview: vi.fn().mockRejectedValue(error) } : {}),
    });
    const unavailable = vi.fn();
    render(<LevelUpWizard campaignId="campaign" campaignCharacterId="character" api={api} mode="workspace" onUnavailable={unavailable} />);

    await waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Advancement unavailable" })).toBeTruthy();
  });

  it("waits for progression before requesting the authoritative sheet", async () => {
    let resolveProgression!: (value: typeof state) => void;
    const progression = new Promise<typeof state>((resolve) => { resolveProgression = resolve; });
    const api = wizardApi({ getProgression: vi.fn().mockReturnValue(progression) });
    render(<LevelUpWizard campaignId="campaign" campaignCharacterId="character" api={api} mode="workspace" />);

    expect(api.getSheet).not.toHaveBeenCalled();
    resolveProgression(state);
    await screen.findByRole("heading", { name: "Level up wizard" });
    expect(api.getSheet).toHaveBeenCalledOnce();
    expect(api.preview).toHaveBeenCalledOnce();
  });

  it("publishes an authoritative sheet without hiding a later preview failure", async () => {
    const api = wizardApi({ preview: vi.fn().mockRejectedValue(new Error("preview failed")) });
    const onSheetRefreshed = vi.fn();
    render(<LevelUpWizard campaignId="campaign" campaignCharacterId="character" api={api} mode="workspace" onSheetRefreshed={onSheetRefreshed} />);

    expect(await screen.findByRole("heading", { name: "Advancement unavailable" })).toBeTruthy();
    expect(onSheetRefreshed).toHaveBeenCalledWith(sheet);
    expect(document.body.textContent).not.toContain("preview failed");
  });
});
