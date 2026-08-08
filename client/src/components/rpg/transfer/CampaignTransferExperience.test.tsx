import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campaignTransferHttpExportDocumentSchema, type CampaignTransferHttpApplyResponse, type CampaignTransferHttpExportDocument } from "@velvet/contracts";
import { CampaignImportWizard, type CampaignImportApi } from "./CampaignImportWizard";
import { CampaignExportDialog } from "./CampaignExportDialog";

const at = "2035-01-02T03:04:05.006Z";
const packageValue = { formatVersion: 1 as const, exportedAt: at, campaign: { name: "Campaign", status: "draft" as const, settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "" }, administrationRevision: 0 }, timelines: [{ sourceId: "timeline", parentSourceId: null, forkedFromRevision: null, revision: 0, createdAt: at, events: [] }], activeTimelineSourceId: "timeline", content: { status: "unconfigured" as const }, records: { actors: [], checkpoints: [], recaps: [], memberships: [], roomAttachments: [], administration: { events: [], receipts: [] } }, excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] as const };
const documentValue: CampaignTransferHttpExportDocument = campaignTransferHttpExportDocumentSchema.parse({ package: packageValue, messages: { included: false } });
const report = { importId: "import-one", report: { valid: true, conflicts: [], missingReferences: [], warnings: ["Review memberships"], counts: { timelines: 1, events: 0, actors: 0, checkpoints: 0, recaps: 0, memberships: 0, roomAttachments: 0 } } };
const applied = { campaign: { id: "fresh-campaign", actorRole: "owner" }, receipt: { revisionAfter: 1 } } as CampaignTransferHttpApplyResponse;

async function selectDocument() {
  const file = new File([JSON.stringify(documentValue)], "campaign.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(JSON.stringify(documentValue)) });
  fireEvent.change(screen.getByLabelText("Local Velvet export JSON"), { target: { files: [file] } });
  await screen.findByText(/Local file validated/);
}

describe("campaign import and export experience", () => {
  beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; }); HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; }); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it("requires a successful fresh dry run before one exact apply", async () => {
    const api: CampaignImportApi = { dryRun: vi.fn().mockResolvedValue(report), apply: vi.fn().mockResolvedValue(applied) };
    render(<CampaignImportWizard api={api} />);
    expect(screen.queryByRole("button", { name: /Apply as fresh/ })).toBeNull();
    await selectDocument(); expect(api.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Create fresh dry-run/ }));
    await screen.findByText("Dry-run report ready");
    expect(screen.getByText("Review memberships")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply as fresh campaign" }));
    await screen.findByText(/confirmed by receipt at revision 1/);
    expect(api.dryRun).toHaveBeenCalledOnce(); expect(api.apply).toHaveBeenCalledOnce();
  });

  it("blocks an expired report and demands a new dry run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api: CampaignImportApi = { dryRun: vi.fn().mockResolvedValue(report), apply: vi.fn() };
    render(<CampaignImportWizard api={api} />); await selectDocument(); fireEvent.click(screen.getByRole("button", { name: /Create fresh dry-run/ }));
    await screen.findByText("Dry-run report ready"); vi.advanceTimersByTime(5 * 60_000 + 15_000);
    await screen.findByText("Dry-run report expired"); expect((screen.getByRole("button", { name: "Apply as fresh campaign" }) as HTMLButtonElement).disabled).toBe(true); expect(api.apply).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("persists an ambiguous apply lock across unmount and never replays", async () => {
    const api: CampaignImportApi = { dryRun: vi.fn().mockResolvedValue(report), apply: vi.fn().mockRejectedValue(new TypeError("network")) };
    const first = render(<CampaignImportWizard api={api} />); await selectDocument(); fireEvent.click(screen.getByRole("button", { name: /Create fresh dry-run/ })); await screen.findByText("Dry-run report ready"); fireEvent.click(screen.getByRole("button", { name: "Apply as fresh campaign" })); await screen.findByText(/outcome is unknown/); first.unmount();
    render(<CampaignImportWizard api={api} />); expect(screen.getByText(/earlier Apply outcome is unknown/)).toBeTruthy(); expect(api.apply).toHaveBeenCalledOnce();
  });

  it("shows the complete export review before fetching", async () => {
    const exportApi = { export: vi.fn().mockResolvedValue(documentValue) };
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:export"), revokeObjectURL: vi.fn() }); vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<CampaignExportDialog campaignId="campaign-one" campaignName="My Campaign" open api={exportApi} onClose={vi.fn()} />);
    expect(screen.getByText("Credentials")).toBeTruthy(); expect(screen.getByText("Local paths")).toBeTruthy(); expect(exportApi.export).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Exclude all message content")); fireEvent.click(screen.getByLabelText(/reviewed all included/)); fireEvent.click(screen.getByRole("button", { name: /Fetch and download/ }));
    await waitFor(() => expect(exportApi.export).toHaveBeenCalledWith("campaign-one", false));
  });
});
