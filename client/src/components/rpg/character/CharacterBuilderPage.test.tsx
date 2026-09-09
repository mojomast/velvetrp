import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CharacterDraftHttpView, CharacterDraftHttpFinalizationResult } from "@velvet/contracts";
import { ApiError, createCharacter, listCharacters, type Character } from "../../../api";
import { CharacterBuilderPage, resetCharacterBuilderPageModuleStateForTests, type CharacterBuilderApi, type CharacterBuilderPageProps } from "./CharacterBuilderPage";

afterEach(cleanup);
vi.mock("../../../api", async (importOriginal) => ({ ...await importOriginal<typeof import("../../../api")>(), createCharacter: vi.fn(), listCharacters: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); resetCharacterBuilderPageModuleStateForTests(); });

function draft(complete = false): CharacterDraftHttpView {
  return {
    id: "draft", campaignId: "campaign", personaId: "persona", status: "active", durability: "durable",
    expiresAt: null, effectivelyExpired: false, revision: 2, rulesProfileId: "velvet", rulesetId: "velvet", rulesetVersion: "1.0.0",
    pins: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    allocation: { method: "standard-array", scores: { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 } },
    selections: { race: null, background: null, class: null, starterGrant: complete ? "kit" : null, preparedSpells: [] },
    choiceGroups: [{ id: "starter-grant", required: true, options: ["kit", "currency"] }],
    completion: { complete, issues: complete ? [] : [{ code: "missing-starter-grant", path: "selections.starterGrant", message: "Choose a starting grant." }] },
    derivedPreview: complete ? { maxHp: 12, defenses: { guard: 10, evasion: 11, will: 12 }, initiative: 2, speed: 30, carryingLimit: 100, spellAttack: 2, saveDc: 10, explanations: [] } : null,
    startingGrants: [],
  };
}

function setup(overrides: Partial<CharacterBuilderPageProps> = {}) {
  const api = { create: vi.fn(), get: vi.fn().mockResolvedValue(draft()), update: vi.fn(), reroll: vi.fn(), finalize: vi.fn(), getSheet: vi.fn() };
  const props = { campaignId: "campaign", personas: [{ id: "persona", name: "Rowan" }, { id: "other", name: "Ash" }], api, onBack: vi.fn(), onUnavailable: vi.fn(), onEditPersona: vi.fn(), onOpenCharacter: vi.fn(), onDraftIdentity: vi.fn(), ...overrides };
  return { ...render(<CharacterBuilderPage {...props} />), api, props };
}
function click(name: string | RegExp) { fireEvent.click(screen.getByRole("button", { name })); }
function expectStage(name: string) { expect(screen.getByText(name, { selector: "li" }).getAttribute("aria-current")).toBe("step"); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

it("offers inline RPG concept creation without sending until explicitly submitted", () => {
  const create = vi.fn();
  render(<CharacterBuilderPage campaignId="campaign" personas={[]} api={{ create } as unknown as CharacterBuilderApi} onBack={vi.fn()} onUnavailable={vi.fn()} onEditPersona={vi.fn()} onOpenCharacter={vi.fn()} />);
  expect(screen.getByRole("region", { name: "Character building stages" })).toBeTruthy();
  expect(screen.getByText(/New drafts belong to the local campaign owner/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Adventurer concept" })).toBeTruthy();
  expectStage("Concept / persona");
  expect((screen.getByRole("button", { name: "Next: Rules choices" }) as HTMLButtonElement).disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
  expect(createCharacter).not.toHaveBeenCalled();
});

function fillPersona() {
  for (const [name, value] of [["Persona name", "Rowan"], ["Adventurer concept", "Exiled scout"], ["Adventuring goal", "Find the lost expedition"], ["Boundaries and hard limits", "No torture"]]) {
    fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
  }
  fireEvent.change(screen.getByRole("spinbutton", { name: "Age (18+)" }), { target: { value: "28" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /This character is fictional/ }));
}
const createdPersona: Character = { id: "new-persona", name: "Rowan", age: 28, archetype: "Exiled scout", boundaries: "No torture", fictionalConfirmed: true, isRealPerson: false, createdAt: "2026-09-08T00:00:00Z" };

it("creates a persona inline and uses its returned ID with stale parent props", async () => {
  const { api, props, rerender } = setup({ personas: [] });
  vi.mocked(createCharacter).mockResolvedValue(createdPersona);
  fillPersona(); click("Create persona once");
  await screen.findByRole("combobox", { name: "Persona" });
  expect(vi.mocked(createCharacter)).toHaveBeenCalledWith(expect.objectContaining({ name: "Rowan", age: 28, archetype: "Exiled scout", profile: expect.objectContaining({ goal: "Find the lost expedition" }) }));
  rerender(<CharacterBuilderPage {...props} personas={[{ id: "later", name: "Later arrival" }]} />);
  expect((screen.getByRole("combobox", { name: "Persona" }) as HTMLSelectElement).value).toBe("new-persona");
  api.create.mockResolvedValue({ draft: { ...draft(), personaId: "new-persona" }, receipt: {} });
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  expect(api.create).toHaveBeenCalledWith("campaign", expect.objectContaining({ personaId: "new-persona" }));
  expect(createCharacter).toHaveBeenCalledTimes(1);
});

it("retains the RPG form through definite rejection and create/select switching", async () => {
  setup(); click("Create new persona"); fillPersona();
  vi.mocked(createCharacter).mockRejectedValue(new ApiError(422, "Policy rejected"));
  click("Create persona once"); await screen.findByText(/Policy rejected/);
  expect((screen.getByRole("button", { name: "Create persona once" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(false);
  click("Select existing persona"); click("Next: Rules choices"); click("Back: Concept / persona"); click("Create new persona");
  expect((screen.getByRole("textbox", { name: "Adventuring goal" }) as HTMLTextAreaElement).value).toBe("Find the lost expedition");
  expect(createCharacter).toHaveBeenCalledTimes(1);
});

it("blocks double submission and navigation while persona creation is pending", async () => {
  setup({ personas: [] }); fillPersona();
  const pending = deferred<Character>(); vi.mocked(createCharacter).mockReturnValue(pending.promise);
  click("Create persona once"); click("Create persona once");
  expect(createCharacter).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Select existing persona" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Next: Rules choices" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => pending.resolve(createdPersona));
  expect((screen.getByRole("button", { name: "Next: Rules choices" }) as HTMLButtonElement).disabled).toBe(false);
});

it("treats a success body without an identity as uncertain rather than matching by name", async () => {
  setup(); click("Create new persona"); fillPersona();
  vi.mocked(createCharacter).mockResolvedValue({ ...createdPersona, id: "" });
  click("Create persona once");
  await screen.findByRole("region", { name: "Unresolved persona creation" });
  expect((screen.getByRole("button", { name: "Next: Rules choices" }) as HTMLButtonElement).disabled).toBe(true);
  expect(listCharacters).not.toHaveBeenCalled();
  expect(createCharacter).toHaveBeenCalledTimes(1);
});

it("locks an uncertain persona POST across remount and requires explicit authoritative ID selection", async () => {
  const first = setup({ personas: [] }); fillPersona();
  vi.mocked(createCharacter).mockRejectedValue(new Error("lost response"));
  click("Create persona once"); await screen.findByRole("region", { name: "Unresolved persona creation" });
  first.unmount(); setup({ personas: [] });
  expect((screen.getByRole("textbox", { name: "Persona name" }) as HTMLInputElement).value).toBe("Rowan");
  click("Create persona once"); expect(createCharacter).toHaveBeenCalledTimes(1);
  vi.mocked(listCharacters).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ characters: [] }).mockResolvedValue({ characters: [createdPersona, { ...createdPersona, id: "collision" }] });
  click("Refresh authoritative persona list"); await screen.findByText(/list could not be loaded/);
  click("Refresh authoritative persona list"); await screen.findByText(/No personas are currently listed/);
  click("Refresh authoritative persona list"); await screen.findByRole("option", { name: "Rowan - collision" });
  expect((screen.getByRole("combobox", { name: "Authoritative persona" }) as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("button", { name: "Next: Rules choices" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Authoritative persona" }), { target: { value: "collision" } });
  click("Use explicitly selected persona");
  expect((screen.getByRole("combobox", { name: "Persona" }) as HTMLSelectElement).value).toBe("collision");
  click("Next: Rules choices"); expectStage("Rules choices");
  click("Back: Concept / persona"); click("Create new persona");
  expect(screen.getByRole("region", { name: "Unresolved persona creation" })).toBeTruthy();
  expect(createCharacter).toHaveBeenCalledTimes(1);
});

it("stages concept and allocation, retaining persona, mode and unsaved scores across Back", () => {
  const { api } = setup();
  expect(screen.queryByRole("heading", { name: "Allocate attributes" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Persona" }), { target: { value: "other" } });
  click("Next: Rules choices");
  expectStage("Rules choices");
  fireEvent.click(screen.getByRole("radio", { name: "Manual" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Might score" }), { target: { value: "19" } });
  click("Back: Concept / persona");
  expect((screen.getByRole("combobox", { name: "Persona" }) as HTMLSelectElement).value).toBe("other");
  click("Next: Rules choices");
  expect((screen.getByRole("radio", { name: "Manual" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("spinbutton", { name: "Might score" }) as HTMLInputElement).value).toBe("19");
  expect(api.create).not.toHaveBeenCalled();
});

it("explains invalid allocation and saves only the supported server-roll request", async () => {
  const { api } = setup();
  api.create.mockResolvedValue({ draft: draft(), receipt: {} });
  click("Next: Rules choices");
  fireEvent.change(screen.getByRole("combobox", { name: "Might score" }), { target: { value: "14" } });
  expect(screen.getByRole("alert").textContent).toContain("Assign each standard-array value exactly once");
  expect((screen.getByRole("button", { name: "Create draft with this allocation" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Server roll" }));
  click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  expect(api.create).toHaveBeenCalledWith("campaign", { personaId: "persona", durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: expect.any(String) });
  expectStage("Rules choices");
  expect(screen.queryByRole("heading", { name: "Derived statistics and starter grants" })).toBeNull();
});

it("waits for saved choices before Review and preserves revision through backward navigation", async () => {
  const { api } = setup({ initialDraftId: "draft" });
  await screen.findByRole("heading", { name: "Required choices" });
  expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(true);
  click("Choose a starting grant.");
  expect(document.activeElement?.id).toBe("builder-choice-starter-grant");
  const saving = deferred<unknown>(); api.update.mockReturnValue(saving.promise);
  fireEvent.click(screen.getByRole("radio", { name: /Background kit/ }));
  expect((screen.getByRole("button", { name: "Back: Concept / persona" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(true);
  const saved = { ...draft(true), revision: 3 };
  await act(async () => saving.resolve({ draft: saved, receipt: {} }));
  expect(api.update).toHaveBeenCalledWith("campaign", "draft", { expectedRevision: 2, selections: { starterGrant: "kit" }, idempotencyKey: expect.any(String) });
  expectStage("Rules choices");
  click("Next: Review");
  expectStage("Review");
  expect(screen.queryByRole("heading", { name: "Required choices" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Derived statistics and starter grants" })).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the server preview/ }));
  click("Back: Rules choices");
  click("Back: Concept / persona");
  expect(screen.getByText(/This saved draft is bound/)).toBeTruthy();
  click("Next: Rules choices");
  expect((screen.getByRole("radio", { name: /Background kit/ }) as HTMLInputElement).checked).toBe(true);
  click("Next: Review");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(api.update).toHaveBeenCalledTimes(1);
});

it.each([409, 422, 500])("reconciles a %s save error without replaying a write, even without an initial draft prop", async (status) => {
  const { api } = setup();
  api.create.mockResolvedValue({ draft: draft(), receipt: {} });
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  api.update.mockRejectedValue(new ApiError(status, "Save rejected"));
  fireEvent.click(screen.getByRole("radio", { name: /Background kit/ }));
  await screen.findByRole("button", { name: "Refresh authoritative draft" });
  expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(true);
  api.get.mockResolvedValue({ ...draft(true), revision: 7 });
  click("Refresh authoritative draft");
  await screen.findByText(/Authoritative draft revision refreshed/);
  click("Next: Review");
  expect(screen.getByText(/Saved revision 7/)).toBeTruthy();
  expect(api.update).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith("campaign", "draft");
});

it("retains a finalization receipt on sheet failure and retries only GET in Ready", async () => {
  const { api, props } = setup({ initialDraftId: "draft" });
  api.get.mockResolvedValue(draft(true));
  // The initial read was already issued; explicitly return the complete draft on refresh.
  await screen.findByRole("heading", { name: "Required choices" });
  api.update.mockResolvedValue({ draft: draft(true), receipt: {} });
  fireEvent.click(screen.getByRole("radio", { name: /Background kit/ }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(false));
  click("Next: Review");
  expect((screen.getByRole("button", { name: "Finalize playable character once" }) as HTMLButtonElement).disabled).toBe(true);
  const receipt = { character: { id: "created" }, receipt: { revisionBefore: 2, revisionAfter: 3, occurredAt: "2026-09-08T00:00:00.000Z" } } as CharacterDraftHttpFinalizationResult;
  api.finalize.mockResolvedValue(receipt); api.getSheet.mockRejectedValue(new Error("offline"));
  fireEvent.click(screen.getByRole("checkbox")); click("Finalize playable character once");
  await screen.findByText(/sheet refresh failed/);
  expectStage("Ready");
  expect(screen.getByText(/Receipt revision 2/)).toBeTruthy();
  expect(api.finalize).toHaveBeenCalledWith("campaign", "draft", { expectedRevision: 2, idempotencyKey: expect.any(String) });
  api.getSheet.mockResolvedValue({ progression: { level: 1 }, derived: { maxHp: 12 } });
  click("Retry authoritative sheet GET");
  await screen.findByText(/Authoritative sheet: level 1/);
  expect(api.finalize).toHaveBeenCalledTimes(1);
  click("Open created character"); expect(props.onOpenCharacter).toHaveBeenCalledWith("created");
  click("Build another character"); expectStage("Concept / persona");
});

it("locks ambiguous creation across remount without duplicating POST", async () => {
  const first = setup(); first.api.create.mockRejectedValue(new Error("offline"));
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Review unresolved draft creation" });
  first.unmount();
  const second = setup(); click("Next: Rules choices");
  expect((screen.getByRole("button", { name: "Create draft with this allocation" }) as HTMLButtonElement).disabled).toBe(true);
  expect(second.api.create).not.toHaveBeenCalled();
});

it("ignores a late save response after switching drafts", async () => {
  const { api, props, rerender } = setup({ initialDraftId: "draft" });
  await screen.findByRole("heading", { name: "Required choices" });
  const saving = deferred<unknown>(); api.update.mockReturnValue(saving.promise);
  fireEvent.click(screen.getByRole("radio", { name: /Background kit/ }));
  api.get.mockResolvedValue({ ...draft(), id: "next-draft", revision: 8 });
  rerender(<CharacterBuilderPage {...props} initialDraftId="next-draft" />);
  await screen.findByText("Revision 8");
  await act(async () => saving.resolve({ draft: { ...draft(true), revision: 3 }, receipt: {} }));
  expect(screen.getByText("Revision 8")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(true);
});

it("resumes a different persona without duplicate reads and retains stage when App records draft identity", async () => {
  const { api, props, rerender } = setup();
  const saved = { ...draft(true), personaId: "other", revision: 4 };
  api.create.mockResolvedValue({ draft: saved, receipt: {} }); api.get.mockResolvedValue(saved);
  fireEvent.change(screen.getByRole("combobox", { name: "Persona" }), { target: { value: "other" } });
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  rerender(<CharacterBuilderPage {...props} initialDraftId="draft" />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Next: Review" }) as HTMLButtonElement).disabled).toBe(false));
  click("Next: Review");
  expect(screen.getByText(/Persona: Ash. Saved revision 4/)).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1);
});

it("reconciles uncertain finalization to Ready without replaying finalization", async () => {
  const { api } = setup();
  api.create.mockResolvedValue({ draft: draft(true), receipt: {} });
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  click("Next: Review");
  api.finalize.mockRejectedValue(new Error("lost receipt"));
  fireEvent.click(screen.getByRole("checkbox")); click("Finalize playable character once");
  await screen.findByRole("button", { name: "Refresh authoritative draft" });
  expect((screen.getByRole("button", { name: "Finalize playable character once" }) as HTMLButtonElement).disabled).toBe(true);
  api.get.mockResolvedValue({ ...draft(true), status: "finalized", revision: 3 });
  click("Refresh authoritative draft");
  await screen.findByRole("heading", { name: "Draft already finalized" });
  expectStage("Ready");
  expect(screen.queryByRole("button", { name: "Finalize playable character once" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review authoritative campaign roster" })).toBeTruthy();
  expect(api.finalize).toHaveBeenCalledTimes(1);
});

it("ignores a finalization receipt delivered after switching campaigns", async () => {
  const { api, props, rerender } = setup();
  api.create.mockResolvedValue({ draft: draft(true), receipt: {} });
  click("Next: Rules choices"); click("Create draft with this allocation");
  await screen.findByRole("heading", { name: "Required choices" });
  click("Next: Review");
  const finalizing = deferred<unknown>(); api.finalize.mockReturnValue(finalizing.promise);
  fireEvent.click(screen.getByRole("checkbox")); click("Finalize playable character once");
  rerender(<CharacterBuilderPage {...props} campaignId="another-campaign" />);
  await act(async () => finalizing.resolve({ character: { id: "old-character" }, receipt: { revisionAfter: 3 } }));
  expectStage("Concept / persona");
  expect(screen.queryByRole("heading", { name: "Playable character finalized" })).toBeNull();
  expect(api.getSheet).not.toHaveBeenCalled();
});

it("keeps a rejected allocation editable without an uncertain-write lock", async () => {
  const { api } = setup();
  api.create.mockRejectedValue(new ApiError(422, "Allocation is not allowed by campaign rules"));
  click("Next: Rules choices");
  fireEvent.click(screen.getByRole("radio", { name: "Point Buy" }));
  click("Create draft with this allocation");
  await screen.findByText("Allocation is not allowed by campaign rules");
  expectStage("Rules choices");
  expect((screen.getByRole("radio", { name: "Point Buy" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("spinbutton", { name: "Might score" }) as HTMLInputElement).value).toBe("15");
  expect((screen.getByRole("button", { name: "Create draft with this allocation" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("heading", { name: "Review unresolved draft creation" })).toBeNull();
});

it("offers GET retry after a load error without creating or finalizing a draft", async () => {
  const api = { create: vi.fn(), get: vi.fn().mockRejectedValue(new Error("offline")), update: vi.fn(), reroll: vi.fn(), finalize: vi.fn(), getSheet: vi.fn() };
  setup({ initialDraftId: "draft", api });
  await screen.findByRole("button", { name: "Retry draft" });
  api.get.mockResolvedValue(draft(true));
  click("Retry draft");
  await screen.findByRole("heading", { name: "Required choices" });
  expectStage("Rules choices");
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.create).not.toHaveBeenCalled(); expect(api.finalize).not.toHaveBeenCalled();
});
