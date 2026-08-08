import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogDefinitionSchema, contentCatalogHttpValidationRequestSchema } from "@velvet/contracts";
import { ContentPackEditor, CONTENT_DEFINITION_KINDS, createCompleteContentPackDraft } from "./ContentPackEditor";

const draft = createCompleteContentPackDraft();

describe("ContentPackEditor", () => {
  afterEach(cleanup);

  it("starts with strict definitions for every required server kind", () => {
    render(<ContentPackEditor draft={draft} onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(contentCatalogHttpValidationRequestSchema.safeParse(draft).success).toBe(true);
    expect(new Set(draft.definitions.map((definition) => definition.reference.kind))).toEqual(new Set(CONTENT_DEFINITION_KINDS));
    for (const kind of CONTENT_DEFINITION_KINDS) {
      expect(screen.getByRole("button", { name: `Add ${kind} definition` })).toBeTruthy();
    }
    expect(screen.queryByLabelText(/path/i)).toBeNull();
  });

  it("adds, duplicates, and removes through accessible strict-shape controls", () => {
    const onChange = vi.fn();
    const view = render(<ContentPackEditor draft={draft} onChange={onChange} onValidate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add spell definition" }));
    const added = onChange.mock.calls.at(-1)?.[0];
    expect(added.definitions).toHaveLength(draft.definitions.length + 1);
    expect(catalogDefinitionSchema.safeParse(added.definitions.at(-1)).success).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Duplicate Local race" }));
    const duplicated = onChange.mock.calls.at(-1)?.[0];
    expect(duplicated.definitions.at(-1).reference.definitionId).toMatch(/local-race-copy-1/);
    expect(catalogDefinitionSchema.safeParse(duplicated.definitions.at(-1)).success).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Remove Local race" }));
    const removed = onChange.mock.calls.at(-1)?.[0];
    expect(removed.definitions.some((definition: { reference: { kind: string } }) => definition.reference.kind === "race")).toBe(false);
    view.unmount();
  });

  it("maps real index, missing-kind, and kind:id issue paths to exact controls", () => {
    const view = render(<ContentPackEditor draft={draft} focusPath="definitions.0.reference" onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getAllByLabelText("Definition ID")[0]);

    view.rerender(<ContentPackEditor draft={draft} focusPath="definitions.spell" onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add spell definition" }));

    view.rerender(<ContentPackEditor draft={draft} focusPath="definitions.race:local-race.references.ability:local-ability" onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Mechanics JSON for Local race"));

    view.rerender(<ContentPackEditor draft={draft} focusPath="manifest.digest" onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Derived canonical digest"));
  });

  it("blocks validation when mechanics JSON is malformed", () => {
    render(<ContentPackEditor draft={draft} onChange={vi.fn()} onValidate={vi.fn()} />);
    const mechanics = screen.getByLabelText("Mechanics JSON for Local race");
    fireEvent.change(mechanics, { target: { value: "{" } });
    fireEvent.blur(mechanics);
    expect(screen.getByRole("alert").textContent).toMatch(/must be valid/);
    expect((screen.getByRole("button", { name: "Validate current draft" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
