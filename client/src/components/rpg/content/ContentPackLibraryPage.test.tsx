import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentCatalogHttpOwnerDetailResponse, ContentCatalogHttpPublicationRequest, PublicationSummary } from "@velvet/contracts";
import { validateContentCatalog } from "../../../../../server/src/repo/contentCatalog/catalogValidation";
import { ContentPackLibraryPage, resetContentPackLibraryPageModuleStateForTests, type ContentPackLibraryApi } from "./ContentPackLibraryPage";

const at = "2030-01-01T00:00:00.000Z";
const summary: PublicationSummary = { packId: "sealed", packVersion: "1.0.0", name: "Sealed pack", description: "Sealed", tags: [], compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: "rules", catalogFormat: "validated-v1" }, digest: "a".repeat(64), validationLevel: "validated-v1", publishedAt: at };
const definition = { reference: { packId: "sealed", packVersion: "1.0.0", definitionId: "race", kind: "race" as const }, name: "Sealed race", description: "Read only", tags: [], mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] } };
const detail: ContentCatalogHttpOwnerDetailResponse = { catalog: { publication: summary, provenance: { authorship: "original", author: "A", authoredAt: at, reviewedBy: "R", reviewedAt: at, declaration: "Original", thirdPartyData: false }, definitions: [definition] } };

function ownerDetail(input: ContentCatalogHttpPublicationRequest): ContentCatalogHttpOwnerDetailResponse {
  return { catalog: { publication: { packId: input.manifest.packId, packVersion: input.manifest.packVersion, name: input.manifest.name, description: input.manifest.description, tags: input.manifest.tags, compatibility: input.manifest.compatibility, digest: input.manifest.digest, validationLevel: "validated-v1", publishedAt: at }, provenance: input.manifest.provenance, definitions: input.definitions } };
}

function api(overrides: Partial<ContentPackLibraryApi> = {}): ContentPackLibraryApi {
  return {
    list: vi.fn().mockResolvedValue({ publications: [summary], nextCursor: null }),
    detail: vi.fn().mockResolvedValue(detail),
    validate: vi.fn(async (draft) => ({ report: validateContentCatalog({ ...draft, idempotencyKey: "client-validation-test" }) })),
    publish: vi.fn(async (input) => ownerDetail(input)),
    ...overrides,
  };
}

async function validateTwice(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
  await screen.findByRole("heading", { name: "Draft needs attention" });
  fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
  await screen.findByRole("heading", { name: "Draft is valid" });
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ContentPackLibraryPage", () => {
  afterEach(() => { cleanup(); resetContentPackLibraryPageModuleStateForTests(); vi.unstubAllGlobals(); });

  it("uses a genuinely server-valid complete local draft before immutable publication", async () => {
    const adapter = api();
    vi.stubGlobal("crypto", { randomUUID: () => "publish-command" });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /^Add .* definition$/ })).toHaveLength(10);
    await validateTwice();
    const exactDraft = vi.mocked(adapter.validate).mock.calls.at(-1)?.[0];
    expect(validateContentCatalog({ ...exactDraft, idempotencyKey: "proof" }).valid).toBe(true);
    expect(exactDraft?.manifest.packVersion).toBe(`0.1.0+${exactDraft?.manifest.digest.slice(0, 12)}`);
    fireEvent.click(screen.getByRole("button", { name: "Review immutable publication" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /understand publication is immutable/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish this exact version once" }));
    await screen.findByText(/This exact version is now sealed and immutable/);
    expect(adapter.publish).toHaveBeenCalledOnce();
  });

  it("keeps the editable local draft distinct from grouped immutable definitions", async () => {
    const adapter = api();
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect sealed definitions" }));
    expect(await screen.findByRole("heading", { name: "race 1" })).toBeTruthy();
    expect(screen.getByText("Immutable")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local draft" })).toBeTruthy();
    expect(screen.queryByLabelText(/filesystem|file path/i)).toBeNull();
  });

  it("focuses real server issue path forms on their represented controls", async () => {
    const reports = [
      { valid: false as const, issues: [{ code: "identity-mismatch" as const, path: "definitions.0.reference", message: "Reference is invalid" }], normalizedSummary: { totalDefinitions: 10, counts: validateContentCatalog({}).normalizedSummary.counts, digest: null } },
      { valid: false as const, issues: [{ code: "incomplete-starter" as const, path: "definitions.spell", message: "Spell is missing" }], normalizedSummary: { totalDefinitions: 9, counts: validateContentCatalog({}).normalizedSummary.counts, digest: null } },
    ];
    const adapter = api({ validate: vi.fn().mockResolvedValueOnce({ report: reports[0] }).mockResolvedValueOnce({ report: reports[1] }) });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Reference is invalid/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByLabelText("Definition ID")[0]));
    fireEvent.click(screen.getByRole("button", { name: "Validate current draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Spell is missing/ }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add spell definition" })));
  });

  it("broadcasts writing and uncertain locks across remount and keeps absent exact versions blocked", async () => {
    const pending = deferred<ContentCatalogHttpOwnerDetailResponse>();
    const adapter = api({ publish: vi.fn(() => pending.promise) });
    const first = render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    await validateTwice();
    fireEvent.click(screen.getByRole("button", { name: "Review immutable publication" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /understand publication is immutable/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish this exact version once" }));
    expect(await screen.findByText(/Publication is in progress/)).toBeTruthy();
    first.unmount();

    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    expect(await screen.findByText(/Publication is in progress/)).toBeTruthy();
    pending.reject(new Error("network"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Refresh authoritative publications/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh authoritative publications" }));
    expect(await screen.findByText(/complete authoritative publication list does not contain this exact version/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(adapter.publish).toHaveBeenCalledOnce();
  });

  it("clears ambiguity only after complete-list discovery and exact detail reconciliation", async () => {
    let calls = 0;
    const adapter = api({ publish: vi.fn().mockRejectedValue(new Error("network")) });
    adapter.list = vi.fn(async () => {
      const exactDraft = vi.mocked(adapter.validate).mock.calls.at(-1)?.[0];
      return { publications: calls++ === 0 || !exactDraft ? [summary] : [summary, ownerDetail({ ...exactDraft, idempotencyKey: "reconcile" }).catalog.publication], nextCursor: null };
    });
    adapter.detail = vi.fn(async (packId, packVersion) => {
      const exactDraft = vi.mocked(adapter.validate).mock.calls.at(-1)![0];
      const exact = ownerDetail({ ...exactDraft, idempotencyKey: "reconcile" });
      if (exact.catalog.publication.packId !== packId || exact.catalog.publication.packVersion !== packVersion) throw new Error("wrong exact version");
      return exact;
    });
    render(<ContentPackLibraryPage api={adapter} onBack={vi.fn()} />);
    await validateTwice();
    fireEvent.click(screen.getByRole("button", { name: "Review immutable publication" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /understand publication is immutable/i }));
    fireEvent.click(screen.getByRole("button", { name: "Publish this exact version once" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Refresh authoritative publications" }));
    expect(await screen.findByText(/exact publication was found and reconciled across the complete catalog/)).toBeTruthy();
    expect(adapter.detail).toHaveBeenCalledOnce();
    expect(adapter.publish).toHaveBeenCalledOnce();
  });
});
