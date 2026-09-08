import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActorGameplaySheetResponse } from "@velvet/contracts";
import { GameplaySheetDrawer } from "./GameplaySheetDrawer";

const at = "2030-01-01T00:00:00.000Z";
const ref = <K extends "race" | "background" | "class" | "item" | "ability" | "spell">(kind: K, definitionId: string) => ({ kind, packId: "starter", packVersion: "1.0.0", definitionId });
const statistics = ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"] as const;
const sheet: ActorGameplaySheetResponse = {
  identity: { actorId: "actor", name: "Arden Vale" },
  race: { reference: ref("race", "emberkin"), label: "Emberkin" },
  background: { reference: ref("background", "wayfinder"), label: "Wayfinder" },
  classes: [{ reference: ref("class", "warden"), label: "Warden", level: 3 }],
  attributes: [{ attributeId: "might", label: "Might", value: 16 }],
  proficiencies: [{ proficiencyId: "survival", label: "Survival", category: "skill" }, { proficiencyId: "resolve", label: "Resolve", category: "saving-throw" }],
  choices: [{ choiceId: "style", label: "Fighting style", selection: { reference: ref("ability", "sentinel"), label: "Sentinel" } }],
  derived: { maxHp: 24, defenses: { guard: 15, evasion: 13, will: 12 }, initiative: 3, speed: 30, carryingLimit: 100, spellAttack: 5, saveDc: 13,
    explanations: statistics.map((statistic) => ({ statistic, formula: "base plus training", inputs: {}, result: 1 })) },
  progression: { mode: "xp", level: 3, totalXp: 900, milestoneCount: 2, pendingChoiceCount: 1, updatedAt: at },
  resources: [{ resourceId: "focus", label: "Focus", current: 2, capacity: 3 }],
  inventory: { capacity: 10, items: [{ entryId: "rope", item: ref("item", "moonlit-rope"), label: "Moonlit rope", quantity: 1, equippedSlot: "accessory" }] },
  knownPowers: [
    { power: ref("spell", "guiding-spark"), label: "Guiding Spark", available: true, unavailableReasons: [] },
    { power: ref("ability", "guardian-rush"), label: "Guardian Rush", available: true, unavailableReasons: [] },
    { power: ref("spell", "spent-ward"), label: "Spent Ward", available: false, unavailableReasons: ["spell-slot-unavailable"] },
  ],
  activeEffects: [{ effectId: "blessed", source: { reference: ref("spell", "blessing"), label: "Blessed" }, modifiers: [{ kind: "flat", amount: 2, appliesToId: "guard" }], duration: { kind: "rounds", remaining: 2 }, recovery: "long_rest", stacking: "concentration", appliedAt: at }],
};

describe("GameplaySheetDrawer", () => {
  afterEach(cleanup);

  it("renders the strict contract's complete categories, item, spell, availability, and effect details", () => {
    render(<GameplaySheetDrawer sheet={sheet} canReference onClose={vi.fn()} onReference={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Arden Vale's character sheet" }).getAttribute("aria-modal")).toBe("false");
    for (const heading of ["Identity", "Classes", "Attributes", "Derived stats and progression", "Progression", "Proficiencies", "Choices", "Resources", "Inventory and equipment", "Known powers and spells", "Active effects"]) expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    for (const detail of ["Warden, level 3", "Might", "Maximum HP", "Survival", "Resolve", "Sentinel", "Focus", "Moonlit rope", "Guiding Spark", "Guardian Rush", "Spent Ward", "Blessed"]) expect(screen.getByText(detail)).toBeTruthy();
    expect(screen.getByText("Unavailable: spell slot unavailable")).toBeTruthy();
    expect(screen.getByText(/2 rounds remaining; concentration; recovers on long rest/)).toBeTruthy();
    expect(screen.getByText("+2 to guard")).toBeTruthy();
    expect(screen.getByText(/explicitly press Declare action/)).toBeTruthy();
  });

  it("emits natural-language fragments from every reference category without form submission", () => {
    const reference = vi.fn(); const submit = vi.fn();
    render(<form onSubmit={submit}><GameplaySheetDrawer sheet={sheet} canReference onClose={vi.fn()} onReference={reference} /></form>);
    const cases = [["Emberkin", "I draw on my Emberkin heritage to "], ["Wayfinder", "I draw on my Wayfinder background to "], ["Warden, level 3", "I use my Warden training to "], ["Might", "I rely on my Might to "], ["Guard", "I account for my Guard defense as I "], ["Survival", "I use my Survival proficiency to "], ["Sentinel", "I draw on my choice of Sentinel to "], ["Focus", "I draw on Focus to "], ["Moonlit rope", "I use Moonlit rope to "], ["Guiding Spark", "I cast Guiding Spark to "], ["Guardian Rush", "I use Guardian Rush to "], ["Blessed", "I account for Blessed as I "]] as const;
    for (const [name, fragment] of cases) { fireEvent.click(screen.getByRole("button", { name })); expect(reference).toHaveBeenLastCalledWith(fragment); }
    expect(reference).toHaveBeenCalledTimes(cases.length); expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed for unavailable powers and non-ready play", () => {
    const reference = vi.fn(); const { rerender } = render(<GameplaySheetDrawer sheet={sheet} canReference onClose={vi.fn()} onReference={reference} />);
    expect((screen.getByRole("button", { name: "Spent Ward" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<GameplaySheetDrawer sheet={sheet} canReference={false} onClose={vi.fn()} onReference={reference} />);
    expect((screen.getByRole("button", { name: "Guiding Spark" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Guiding Spark" })); expect(reference).not.toHaveBeenCalled();
    expect(screen.getByText(/disabled until play is ready and unambiguous/)).toBeTruthy();
  });
});
