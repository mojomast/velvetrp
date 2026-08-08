import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignHistoryApi } from "./CampaignEventLogPage";
import { CampaignEventLogPage } from "./CampaignEventLogPage";

const at = "2035-01-02T03:04:05.006Z";
const timeline = { id: "timeline-one", parentTimelineId: null, forkedFromRevision: null, revision: 3, createdAt: at, active: true };
const fork = { id: "timeline-two", parentTimelineId: timeline.id, forkedFromRevision: 2, revision: 2, createdAt: "2036-02-03T03:04:05.006Z", active: false };
function api(role: "owner" | "gm" | "player" | "observer" = "player"): CampaignHistoryApi {
  return {
    administration: vi.fn().mockResolvedValue({ campaign: { id: "campaign-one", actorRole: role, revision: 3 } }),
    timelines: vi.fn().mockResolvedValue({ activeTimelineId: timeline.id, timelines: [timeline, fork] }), checkpoints: vi.fn().mockResolvedValue({ checkpoints: [{ id: "checkpoint", timelineId: timeline.id, timelineRevision: 2, label: "Before the gate", createdAt: at }] }), recaps: vi.fn().mockResolvedValue({ recaps: [{ id: "public-recap", timelineId: timeline.id, throughRevision: 2, selectedSessionIds: [], visibility: "members", text: "Public story", createdAt: at }, { id: "secret-recap", timelineId: timeline.id, throughRevision: 2, selectedSessionIds: [], visibility: "gm-only", text: "Secret story", createdAt: at }] }),
    events: vi.fn().mockResolvedValueOnce({ events: [{ eventId: "event-one", commandId: "command-one", timelineId: timeline.id, actorId: "actor-one", sourceTurnId: null, type: "actor_attribute_set", revision: 1, occurredAt: at, data: { attributeId: "strength", valueBefore: 1, valueAfter: 2 } }], nextAfterRevision: 1 }).mockResolvedValueOnce({ events: [{ eventId: "event-two", commandId: "command-two", timelineId: timeline.id, actorId: "actor-one", sourceTurnId: null, type: "actor_attribute_set", revision: 2, occurredAt: at, data: { attributeId: "strength", valueBefore: 2, valueAfter: 3 } }], nextAfterRevision: null }),
    receipt: vi.fn().mockResolvedValue({ receipt: { kind: "mechanic", revisionBefore: 0, revisionAfter: 1, occurredAt: at,
      event: { type: "actor_attribute_set", data: { attributeId: "strength", valueBefore: 1, valueAfter: 2 } } } }), createRecap: vi.fn(),
  } as CampaignHistoryApi;
}

describe("campaign history experience", () => {
  afterEach(cleanup);
  it("uses bounded cursor pagination, role-safe recap absence, and explicit fork language", async () => {
    const client = api("player"); render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/Strength changed from 1 to 2/); expect(screen.getByText("Technical identifier:").parentElement?.textContent).toContain("strength"); expect(screen.queryByText("Secret story")).toBeNull(); expect(screen.queryByRole("heading", { name: "Create a recap" })).toBeNull(); expect(screen.getByText(/never erases history/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open public receipt" })); expect(await screen.findByText("Strength: 1 → 2.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load next events" })); await screen.findByText(/Strength changed from 2 to 3/);
    expect(client.events).toHaveBeenNthCalledWith(2, "campaign-one", { timelineId: "timeline-one", afterRevision: 1, limit: 25 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Event log" })));
  });

  it("clears the old timeline synchronously and does not infer empty after replacement failure", async () => {
    let rejectFork!: (reason: unknown) => void; const pending = new Promise<never>((_resolve, reject) => { rejectFork = reject; });
    const client = api(); (client.events as ReturnType<typeof vi.fn>).mockReset()
      .mockResolvedValueOnce({ events: [{ eventId: "event-old", commandId: "command-old", timelineId: timeline.id, actorId: "actor", sourceTurnId: null, type: "actor_attribute_set", revision: 1, occurredAt: at, data: { attributeId: "strength", valueBefore: 1, valueAfter: 2 } }], nextAfterRevision: null })
      .mockReturnValueOnce(pending);
    render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />); await screen.findByText(/Strength changed/);
    fireEvent.change(screen.getByLabelText("Timeline"), { target: { value: fork.id } });
    expect(screen.queryByText(/Strength changed/)).toBeNull(); expect(screen.getByText(/Loading events for the selected/)).toBeTruthy();
    rejectFork(new Error("offline")); await screen.findByText(/Events for this timeline are unavailable/);
    expect(screen.queryByText("No public events on this timeline.")).toBeNull();
  });

  it("distinguishes failed lanes from authoritative empty results", async () => {
    const client = api(); (client.events as ReturnType<typeof vi.fn>).mockReset().mockRejectedValue(new Error("events"));
    (client.recaps as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("recaps")); (client.checkpoints as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("checkpoints"));
    render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/Some history is temporarily unavailable/);
    expect(screen.getByText(/Events for this timeline are unavailable/)).toBeTruthy(); expect(screen.getByText(/Recaps are unavailable/)).toBeTruthy(); expect(screen.getByText(/Checkpoints are unavailable/)).toBeTruthy();
    expect(screen.queryByText("No public events on this timeline.")).toBeNull(); expect(screen.queryByText("No recaps are available for your role.")).toBeNull(); expect(screen.queryByText(/No checkpoints yet/)).toBeNull();
  });

  it("humanizes unknown identifiers while keeping the exact ID secondary", async () => {
    const client = api(); (client.events as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue({ events: [{ eventId: "event", commandId: "command", timelineId: timeline.id, actorId: "actor", sourceTurnId: null, type: "actor_resource_initialized", revision: 1, occurredAt: at, data: { name: "arcane_charge", current: 2, max: 4 } }], nextAfterRevision: null });
    render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    expect(await screen.findByText("Arcane Charge initialized at 2 of 4.")).toBeTruthy(); expect(screen.getByText("arcane_charge", { selector: "code" })).toBeTruthy();
  });

  it("focuses the meaningful retry after an initial failure", async () => {
    const client = api(); (client.administration as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry history" }); await waitFor(() => expect(document.activeElement).toBe(retry));
  });
});
