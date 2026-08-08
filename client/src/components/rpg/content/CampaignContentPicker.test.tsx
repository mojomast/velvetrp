import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentCatalogHttpCampaignContent, PublicationSummary } from "@velvet/contracts";
import { CampaignContentPicker } from "./CampaignContentPicker";

const digest = "a".repeat(64);
const current: ContentCatalogHttpCampaignContent = { compatible: true, rulesProfileId: "rules", contentPacks: [{ packId: "core", packVersion: "1.0.0", digest }], issues: [] };
const publication = (packVersion: string, rulesProfileId = "rules"): PublicationSummary => ({ packId: "core", packVersion, name: "Core", description: `Core ${packVersion}`, tags: [], compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId, catalogFormat: "validated-v1" }, digest, validationLevel: "validated-v1", publishedAt: "2030-01-01T00:00:00.000Z" });

describe("CampaignContentPicker", () => {
  afterEach(cleanup);

  it("structurally omits owner mutation controls for non-owners", () => {
    render(<CampaignContentPicker actorRole="gm" current={current} publications={[publication("1.0.0"), publication("2.0.0")]} expectedRevision={4} onInspect={vi.fn()} onApply={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText("Only campaign owners can change exact pins.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review all pin changes" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("compares only compatible versions and requires a complete explicit review", () => {
    const onApply = vi.fn();
    vi.stubGlobal("crypto", { randomUUID: () => "command" });
    render(<CampaignContentPicker actorRole="owner" current={current} publications={[publication("1.0.0"), publication("2.0.0"), publication("9.0.0", "other")]} expectedRevision={4} onInspect={vi.fn()} onApply={onApply} onRefresh={vi.fn()} />);
    expect(screen.queryByText("9.0.0")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /2.0.0/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review all pin changes" }));
    expect(screen.getByText("core @ 1.0.0")).toBeTruthy();
    expect(screen.getByText("core @ 2.0.0")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Apply exact pin set" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every exact old and new pin/i }));
    fireEvent.click(screen.getByRole("button", { name: "Apply exact pin set" }));
    expect(onApply).toHaveBeenCalledWith({ rulesProfileId: "rules", contentPacks: [{ packId: "core", packVersion: "2.0.0" }], expectedRevision: 4, idempotencyKey: "ui-content-command" });
  });

  it("locks duplicate submission behind authoritative refresh", () => {
    const onRefresh = vi.fn();
    render(<CampaignContentPicker actorRole="owner" current={current} publications={[publication("1.0.0")]} expectedRevision={4} mutationLocked onInspect={vi.fn()} onApply={vi.fn()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh authoritative content" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toMatch(/No write will be retried/);
  });

  it("keeps inspect as an associated sibling action outside the radio label", () => {
    const onInspect = vi.fn();
    render(<CampaignContentPicker actorRole="owner" current={current} publications={[publication("1.0.0"), publication("2.0.0")]} expectedRevision={4} onInspect={onInspect} onApply={vi.fn()} onRefresh={vi.fn()} />);
    const inspect = screen.getByRole("button", { name: "Inspect definitions for core @ 2.0.0" });
    expect(inspect.closest("label")).toBeNull();
    fireEvent.click(inspect);
    expect(onInspect).toHaveBeenCalledWith("core", "2.0.0");
    expect((screen.getByRole("radio", { name: /1.0.0/ }) as HTMLInputElement).checked).toBe(true);
  });
});
