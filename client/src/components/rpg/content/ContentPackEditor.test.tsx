import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentPackDraft } from "./ContentPackEditor";
import { ContentPackEditor } from "./ContentPackEditor";

const at = "2030-01-01T00:00:00.000Z";
const draft: ContentPackDraft = { manifest: {
  packId: "pack", packVersion: "1.0.0", name: "Pack", description: "Draft", tags: [], digest: "0".repeat(64),
  rulesProfile: { name: "Rules", description: "Rules", tags: [] },
  compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: "rules", catalogFormat: "validated-v1" },
  provenance: { authorship: "original", author: "Author", authoredAt: at, reviewedBy: "Reviewer", reviewedAt: at, declaration: "Original", thirdPartyData: false },
}, definitions: [{ reference: { packId: "pack", packVersion: "1.0.0", definitionId: "race", kind: "race" }, name: "Race", description: "Race", tags: [], mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] } }] };

describe("ContentPackEditor", () => {
  afterEach(cleanup);

  it("labels the browser-memory draft separately and emits metadata edits", () => {
    const onChange = vi.fn();
    render(<ContentPackEditor draft={draft} onChange={onChange} onValidate={vi.fn()} />);
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.queryByLabelText(/path/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Pack name"), { target: { value: "Next pack" } });
    expect(onChange.mock.calls[0]?.[0].manifest.name).toBe("Next pack");
  });

  it("groups definitions by kind and focuses the field represented by an issue path", () => {
    const { rerender } = render(<ContentPackEditor draft={draft} onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "race 1" })).toBeTruthy();
    rerender(<ContentPackEditor draft={draft} focusPath="definitions[0].mechanics.speed" onChange={vi.fn()} onValidate={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText(/Race · complete definition JSON/));
  });

  it("blocks validation while edited definition JSON is malformed", () => {
    render(<ContentPackEditor draft={draft} onChange={vi.fn()} onValidate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Race · complete definition JSON/), { target: { value: "{" } });
    expect(screen.getByRole("alert").textContent).toMatch(/must be valid/);
    expect((screen.getByRole("button", { name: "Validate current draft" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
