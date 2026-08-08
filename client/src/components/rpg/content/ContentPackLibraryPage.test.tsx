import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogValidationReport, ContentCatalogHttpOwnerDetailResponse } from "@velvet/contracts";
import { ContentPackLibraryPage, resetContentPackLibraryPageModuleStateForTests, type ContentPackLibraryApi } from "./ContentPackLibraryPage";

const counts = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"].map((kind) => ({ kind, count: kind === "race" ? 1 : 0 })) as CatalogValidationReport["normalizedSummary"]["counts"];
const summary = { packId: "sealed", packVersion: "1.0.0", name: "Sealed pack", description: "Sealed", tags: [], compatibility: { rulesEngine: "velvet-starter-v1" as const, rulesProfileId: "rules", catalogFormat: "validated-v1" as const }, digest: "a".repeat(64), validationLevel: "validated-v1" as const, publishedAt: "2030-01-01T00:00:00.000Z" };
const definition = { reference: { packId: "sealed", packVersion: "1.0.0", definitionId: "race", kind: "race" as const }, name: "Sealed race", description: "Read only", tags: [], mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] } };
const detail: ContentCatalogHttpOwnerDetailResponse = { catalog: { publication: summary, provenance: { authorship: "original", author: "A", authoredAt: summary.publishedAt, reviewedBy: "R", reviewedAt: summary.publishedAt, declaration: "Original", thirdPartyData: false }, definitions: [definition] } };

function api(overrides: Partial<ContentPackLibraryApi> = {}): ContentPackLibraryApi {
  return { list: vi.fn().mockResolvedValue({ publications: [summary], nextCursor: null }), detail: vi.fn().mockResolvedValue(detail), validate: vi.fn().mockResolvedValue({ report: { valid: true, issues: [], normalizedSummary: { totalDefinitions: 1, counts, digest: "b".repeat(64) } } }), publish: vi.fn().mockResolvedValue(detail), ...overrides };
}

describe("ContentPackLibraryPage", () => {
  afterEach(() => { cleanup(); resetContentPackLibraryPageModuleStateForTests(); vi.unstubAllGlobals(); });

  it("keeps the editable local draft distinct from grouped immutable definitions", async () => {
    const adapter = api();
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect sealed definitions" }));
    expect(await screen.findByRole("heading", { name: "race 1" })).toBeTruthy();
    expect(screen.getByText("Immutable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local draft" })).toBeTruthy();
    expect(screen.queryByLabelText(/filesystem|file path/i)).toBeNull();
  });

  it("requires fresh valid in-memory validation and explicit immutable review before one POST", async () => {
    const adapter = api();
    vi.stubGlobal("crypto", { randomUUID: () => "publish-command" });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Publish this exact version once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
    await screen.findByRole("heading", { name: "Draft is valid" });
    fireEvent.click(screen.getByRole("button", { name: "Review immutable publication" }));
    const publish = screen.getByRole("button", { name: "Publish this exact version once" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /understand publication is immutable/i }));
    fireEvent.click(publish);
    await screen.findByText(/This exact version is now sealed and immutable/);
    expect(adapter.publish).toHaveBeenCalledOnce();
  });

  it("focuses the represented field from a validation issue", async () => {
    const adapter = api({ validate: vi.fn().mockResolvedValue({ report: { valid: false, issues: [{ code: "invalid-input", path: "manifest.name", message: "Name is invalid" }], normalizedSummary: { totalDefinitions: 1, counts, digest: null } } }) });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Name is invalid/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Pack name")));
  });

  it("locks ambiguous duplicate publication until authoritative refresh without retry", async () => {
    const adapter = api({ publish: vi.fn().mockRejectedValue(new Error("network")) });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
    await screen.findByRole("heading", { name: "Draft is valid" });
    fireEvent.click(screen.getByRole("button", { name: "Review immutable publication" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /understand publication is immutable/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish this exact version once" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no POST will be retried automatically/i);
    expect((screen.getByRole("button", { name: "Publish this exact version once" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh authoritative publications" }));
    await screen.findByText(/No publication was retried/);
    expect(adapter.publish).toHaveBeenCalledOnce();
    expect(adapter.list).toHaveBeenCalledTimes(2);
  });
});
