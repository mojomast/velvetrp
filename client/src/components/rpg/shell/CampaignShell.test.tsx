import { useEffect, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignShell, campaignDestinations, useCampaignShell } from "./CampaignShell";
import type { CampaignDetail } from "../../../api";

const campaign = { id: "campaign-one", name: "The Salt Road", actorRole: "owner" as CampaignDetail["actorRole"] };
function Page({ role = campaign.actorRole, blocked = false }: { role?: CampaignDetail["actorRole"]; blocked?: boolean }) {
  const { report, blockNavigation } = useCampaignShell();
  useEffect(() => { report({ ...campaign, actorRole: role }); }, [report, role]);
  useEffect(() => { blockNavigation(blocked); }, [blockNavigation, blocked]);
  return <main><h1>Campaign overview</h1><h2 id="campaign-roster-heading">Party roster</h2></main>;
}
function CrashablePage({ onMount }: { onMount: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { onMount(); }, [onMount]);
  if (failed) throw new Error("workspace render exploded");
  return <main><h1>Healthy workspace</h1><button onClick={() => setFailed(true)}>Break workspace</button></main>;
}

function ThrowingPage(): ReactNode {
  throw new Error("workspace render exploded");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("campaign control plane", () => {
  it.each(["owner", "gm", "player", "observer"] as const)("uses the actual %s role without a role switch", async (role) => {
    render(<CampaignShell campaignId={campaign.id} view="campaign-detail" selection={null} studio combat onNavigate={vi.fn()} onCampaigns={vi.fn()}><Page role={role} /></CampaignShell>);
    const nav = screen.getByRole("navigation", { name: "Campaign destinations" });
    expect(within(nav).getByRole("button", { name: "Overview workspace" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).queryByRole("button", { name: "Create workspace" }) !== null).toBe(role === "owner" || role === "gm");
    expect(within(nav).queryByRole("button", { name: "Manage workspace" }) !== null).toBe(role === "owner" || role === "gm");
    expect(screen.queryByRole("combobox")).toBeNull();
    if (role === "observer") expect(screen.getByText("Spectator / Read-only")).toBeTruthy();
  });

  it("keeps maps and gameplay destinations discoverable and honors feature availability", () => {
    const navigate = vi.fn();
    render(<CampaignShell campaignId={campaign.id} view="campaign-detail" selection={null} studio combat onNavigate={navigate} onCampaigns={vi.fn()}><Page /></CampaignShell>);
    fireEvent.click(screen.getByRole("button", { name: "Combat tracker" }));
    fireEvent.click(screen.getByRole("button", { name: "World & routes" }));
    fireEvent.click(screen.getByRole("button", { name: "Play workspace" }));
    expect(navigate.mock.calls).toEqual([["combat"], ["world"], ["play"]]);
    expect(campaignDestinations("owner", false, false).find((item) => item.id === "create")?.enabled).toBe(false);
    expect(campaignDestinations(null, true, true).some((item) => item.id === "manage")).toBe(false);
  });

  it("defers campaign navigation to the in-room command center while the table is open", () => {
    render(<CampaignShell campaignId={campaign.id} view="campaign-play" selection={null} studio combat onNavigate={vi.fn()} onCampaigns={vi.fn()}><main><h1>Adventure room</h1></main></CampaignShell>);
    expect(screen.queryByRole("navigation", { name: "Table tools" })).toBeNull();
    expect(screen.getByText("Play / Table tools")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Campaign destinations" })).toBeTruthy();
  });

  it("removes privileged destinations when authoritative role changes", () => {
    const props = { campaignId: campaign.id, view: "campaign-detail" as const, selection: null, studio: true, combat: true, onNavigate: vi.fn(), onCampaigns: vi.fn() };
    const result = render(<CampaignShell {...props}><Page role="gm" /></CampaignShell>);
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeTruthy();
    result.rerender(<CampaignShell {...props}><Page role="observer" /></CampaignShell>);
    expect(screen.queryByRole("button", { name: "Create workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage workspace" })).toBeNull();
  });

  it("focuses the roster destination and preserves page mutation navigation locks", async () => {
    const navigate = vi.fn();
    render(<CampaignShell campaignId={campaign.id} view="campaign-detail" selection={{ destination: "characters", view: "campaign-detail", request: 1 }} studio combat onNavigate={navigate} onCampaigns={vi.fn()}><Page blocked /></CampaignShell>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Party roster" })));
    const button = screen.getByRole("button", { name: "Play workspace" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the shell visible when a child throws and retries with a fresh child", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mounted = vi.fn();
    render(<CampaignShell campaignId={campaign.id} view="campaign-detail" selection={null} studio combat onNavigate={vi.fn()} onCampaigns={vi.fn()}><CrashablePage onMount={mounted} /></CampaignShell>);

    expect(screen.getByRole("heading", { name: "Healthy workspace" })).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Break workspace" }));

    const failure = screen.getByRole("alert");
    expect(within(failure).getByRole("heading", { name: "Campaign workspace failed" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Campaign destinations" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(failure));
    expect(reported).toHaveBeenCalledWith("Campaign workspace render failed", expect.any(Error), expect.any(String));

    fireEvent.click(screen.getByRole("button", { name: "Retry workspace" }));
    expect(screen.getByRole("heading", { name: "Healthy workspace" })).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  it("returns from a failed workspace to the campaign overview", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const navigate = vi.fn();
    render(<CampaignShell campaignId={campaign.id} view="campaign-detail" selection={null} studio combat onNavigate={navigate} onCampaigns={vi.fn()}><ThrowingPage /></CampaignShell>);

    fireEvent.click(screen.getByRole("button", { name: "Return to campaign overview" }));
    expect(navigate).toHaveBeenCalledWith("overview");
  });

  it.each([
    ["campaign", { campaignId: "campaign-two", view: "campaign-detail" as const }],
    ["view", { campaignId: campaign.id, view: "campaign-world" as const }],
  ])("clears a workspace error when the %s changes", (_reset, next) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const props = { campaignId: campaign.id, view: "campaign-detail" as const, selection: null, studio: true, combat: true, onNavigate: vi.fn(), onCampaigns: vi.fn() };
    const result = render(<CampaignShell {...props}><ThrowingPage /></CampaignShell>);
    expect(screen.getByRole("alert")).toBeTruthy();

    result.rerender(<CampaignShell {...props} {...next}><main><h1>Recovered workspace</h1></main></CampaignShell>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "Recovered workspace" })).toBeTruthy();
  });
});
