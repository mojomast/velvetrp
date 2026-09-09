import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtlasAdvancement, type AtlasAdvancementApi } from "./AtlasAdvancement";

const wizard = vi.hoisted(() => vi.fn());
vi.mock("../character/LevelUpWizard", () => ({ LevelUpWizard: (props: Record<string, unknown>) => { wizard(props); return <section aria-label="Existing progression controller" />; } }));
afterEach(() => { cleanup(); wizard.mockClear(); });
describe("AtlasAdvancement", () => {
  it("requires an explicit roster identity instead of inferring a play actor from a name", async () => {
    const api: AtlasAdvancementApi = { listCharacters: vi.fn().mockResolvedValue({ characters: [{ id: "roster-1", characterId: "persona-1", name: "Aria" }, { id: "roster-2", characterId: "persona-2", name: "Aria" }] }), getProgression: vi.fn(), getSheet: vi.fn(), preview: vi.fn(), apply: vi.fn() };
    const reauthorize = vi.fn(), onLockChange = vi.fn();
    render(<AtlasAdvancement campaignId="campaign" api={api} blocked={false} reauthorize={reauthorize} onLockChange={onLockChange} onStateChange={vi.fn()} />);
    await screen.findByRole("option", { name: "Aria (roster-2)" });
    expect(wizard).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Advancement character"), { target: { value: "roster-2" } });
    expect(wizard).toHaveBeenLastCalledWith(expect.objectContaining({ campaignId: "campaign", campaignCharacterId: "roster-2", api, reauthorize, blocked: false }));
    expect(api.apply).not.toHaveBeenCalled();
  });
});
