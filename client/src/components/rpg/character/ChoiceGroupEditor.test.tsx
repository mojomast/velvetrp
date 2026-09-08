import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceGroupEditor } from "./ChoiceGroupEditor";

const bless = { kind: "spell" as const, packId: "srd-5.1", packVersion: "1.0.0", definitionId: "bless" };
const cureWounds = { kind: "spell" as const, packId: "srd-5.1", packVersion: "1.0.0", definitionId: "cure-wounds" };

describe("ChoiceGroupEditor prepared spells", () => {
  it("renders exact server options as a multi-select patch", () => {
    const onSelect = vi.fn();
    render(<ChoiceGroupEditor
      groups={[{ id: "prepared-spells", required: true, options: [
        { reference: bless, name: "Bless", description: "A blessing." },
        { reference: cureWounds, name: "Cure Wounds", description: "Healing." },
      ] }] as any}
      selections={{ preparedSpells: [bless] } as any}
      onSelect={onSelect}
    />);

    expect((screen.getByRole("checkbox", { name: /Bless/ }) as HTMLInputElement).checked).toBe(true);
    const cure = screen.getByRole("checkbox", { name: /Cure Wounds/ });
    fireEvent.click(cure);
    expect(onSelect).toHaveBeenCalledWith({ preparedSpells: [bless, cureWounds] });
  });
});
