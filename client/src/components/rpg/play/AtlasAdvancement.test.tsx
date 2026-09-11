import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasAdvancement, type AtlasAdvancementApi } from "./AtlasAdvancement";

const wizard = vi.hoisted(() => vi.fn());
vi.mock("../character/LevelUpWizard", () => ({ LevelUpWizard: (props: Record<string, unknown>) => { wizard(props); return <section aria-label="Existing progression controller" />; } }));
afterEach(() => { cleanup(); wizard.mockClear(); });
describe("AtlasAdvancement", () => {
  it("requires an explicit roster identity instead of inferring a play actor from a name", async () => {
    const api: AtlasAdvancementApi = { listCharacters: vi.fn().mockResolvedValue({ characters: [{ id: "roster-1", characterId: "persona-1", name: "Aria" }, { id: "roster-2", characterId: "persona-2", name: "Aria" }] }), getProgression: vi.fn().mockRejectedValue(new Error("none")), getSheet: vi.fn(), preview: vi.fn(), apply: vi.fn(), grantXp: vi.fn() };
    const reauthorize = vi.fn(), onLockChange = vi.fn();
    render(<AtlasAdvancement campaignId="campaign" api={api} blocked={false} reauthorize={reauthorize} onLockChange={onLockChange} onStateChange={vi.fn()} />);
    await screen.findByRole("option", { name: "Aria (roster-2)" });
    expect(wizard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Advancement character"), { target: { value: "roster-2" } });
    expect(wizard).toHaveBeenLastCalledWith(expect.objectContaining({ campaignId: "campaign", campaignCharacterId: "roster-2", api, reauthorize, blocked: false }));
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("grants XP with the loaded revision and reports the exact receipt", async () => {
    const progression = { campaignId: "campaign", campaignCharacterId: "roster-2", profile: { profileId: "p", rulesProfileId: "r", mode: "xp", maxLevel: 20, thresholds: [] },
      classRef: { kind: "class", packId: "pack", packVersion: "1", definitionId: "fighter" }, level: 1, totalXp: 0, milestoneCount: 0, revision: 9,
      pendingChoices: [], knownAbilities: [], knownSpells: [], derived: {}, updatedAt: "2030-01-01T00:00:00.000Z" } as never;
    const api: AtlasAdvancementApi = {
      listCharacters: vi.fn().mockResolvedValue({ characters: [{ id: "roster-2", characterId: "persona-2", name: "Aria" }] }),
      getProgression: vi.fn().mockResolvedValue(progression), getSheet: vi.fn(), preview: vi.fn(), apply: vi.fn(),
      grantXp: vi.fn().mockResolvedValue({ progression: { ...(progression as object), totalXp: 100, revision: 10 },
        receipt: { campaignCharacterId: "roster-2", idempotencyKey: "k", type: "grant-xp", revisionBefore: 9, revisionAfter: 10, occurredAt: "2030-01-01T00:00:00.000Z", appliedLevels: [] } }),
    };
    render(<AtlasAdvancement campaignId="campaign" api={api} blocked={false} reauthorize={vi.fn().mockResolvedValue(true)} onLockChange={vi.fn()} onStateChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Advancement character"), { target: { value: "roster-2" } });
    fireEvent.change(await screen.findByLabelText("Amount"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Grant XP" }));
    await screen.findByText(/progression revision 9 → 10/);
    expect(api.grantXp).toHaveBeenCalledWith("campaign", "roster-2", expect.objectContaining({ amount: 100, expectedRevision: 9 }));
  });
});
