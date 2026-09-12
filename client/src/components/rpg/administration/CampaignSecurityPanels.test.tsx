import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignAdministrationIntegrations } from "@velvet/contracts";
import { getCampaignAdministrationIntegrations, updateCampaignSessionZeroSafety } from "../../../api";
import { CampaignSecurityPanels } from "./CampaignSecurityPanels";

vi.mock("../../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api")>(),
  getCampaignAdministrationIntegrations: vi.fn(),
  selectCampaignRuleset: vi.fn(),
  updateCampaignSessionZeroSafety: vi.fn(),
  requestCampaignSafetyAction: vi.fn(),
}));

const integrations = {
  campaignId: "campaign", actorRole: "owner", revision: 7,
  rulesets: { current: { rulesetId: "starter", name: "Starter Rules", version: "1.0.0", digest: "digest-one", migration: "none", capabilities: [{ capabilityId: "combat", label: "Combat", supported: true }] }, available: [], mechanicallyEmpty: true, selectionWarning: null },
  safety: { revision: 6, hardLimits: ["Harm to children"], veils: ["Body horror"], pvpPolicy: "explicit-consent", romancePolicy: "fade-to-black", lethalityPolicy: "consent-required", paused: false },
} as unknown as CampaignAdministrationIntegrations;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("CampaignSecurityPanels", () => {
  it("renders the authoritative rules identity and editable safety agreement", async () => {
    vi.mocked(getCampaignAdministrationIntegrations).mockResolvedValue(integrations);
    render(<CampaignSecurityPanels campaignId="campaign" />);
    expect(await screen.findByText(/starter @ 1.0.0/)).toBeTruthy();
    expect(screen.getByLabelText(/Hard limits/).matches(":disabled")).toBe(false);
  });

  it("re-reads authoritative settings and notifies after a confirmed safety write", async () => {
    vi.mocked(getCampaignAdministrationIntegrations).mockResolvedValue(integrations);
    vi.mocked(updateCampaignSessionZeroSafety).mockResolvedValue(undefined as never);
    const mutated = vi.fn();
    render(<CampaignSecurityPanels campaignId="campaign" onMutated={mutated} />);
    await screen.findByText(/starter @ 1.0.0/);
    fireEvent.change(screen.getByLabelText(/Hard limits/), { target: { value: "Harm to children\nSpiders" } });
    fireEvent.click(screen.getByRole("button", { name: "Review safety agreement" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Confirm this complete revision-bound/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save safety agreement once" }));
    await waitFor(() => expect(updateCampaignSessionZeroSafety).toHaveBeenCalledOnce());
    await waitFor(() => expect(mutated).toHaveBeenCalledOnce());
    expect(vi.mocked(getCampaignAdministrationIntegrations).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
