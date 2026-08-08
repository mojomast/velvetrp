import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignHistoryApi } from "./CampaignEventLogPage";
import { CampaignEventLogPage } from "./CampaignEventLogPage";

const at = "2035-01-02T03:04:05.006Z";
const timeline = { id: "timeline-one", parentTimelineId: null, forkedFromRevision: null, revision: 3, createdAt: at, active: true };
function api(role: "owner" | "gm" | "player" | "observer" = "player"): CampaignHistoryApi {
  return {
    administration: vi.fn().mockResolvedValue({ campaign: { id: "campaign-one", actorRole: role, revision: 3 } }),
    timelines: vi.fn().mockResolvedValue({ activeTimelineId: timeline.id, timelines: [timeline] }), checkpoints: vi.fn().mockResolvedValue({ checkpoints: [{ id: "checkpoint", timelineId: timeline.id, timelineRevision: 2, label: "Before the gate", createdAt: at }] }), recaps: vi.fn().mockResolvedValue({ recaps: [{ id: "public-recap", timelineId: timeline.id, throughRevision: 2, selectedSessionIds: [], visibility: "members", text: "Public story", createdAt: at }, { id: "secret-recap", timelineId: timeline.id, throughRevision: 2, selectedSessionIds: [], visibility: "gm-only", text: "Secret story", createdAt: at }] }),
    events: vi.fn().mockResolvedValueOnce({ events: [{ eventId: "event-one", commandId: "command-one", timelineId: timeline.id, actorId: "actor-one", sourceTurnId: null, type: "actor_attribute_set", revision: 1, occurredAt: at, data: { attributeId: "strength", valueBefore: 1, valueAfter: 2 } }], nextAfterRevision: 1 }).mockResolvedValueOnce({ events: [{ eventId: "event-two", commandId: "command-two", timelineId: timeline.id, actorId: "actor-one", sourceTurnId: null, type: "actor_attribute_set", revision: 2, occurredAt: at, data: { attributeId: "strength", valueBefore: 2, valueAfter: 3 } }], nextAfterRevision: null }),
    receipt: vi.fn().mockRejectedValue(new Error("not public")), createRecap: vi.fn(),
  } as CampaignHistoryApi;
}

describe("campaign history experience", () => {
  afterEach(cleanup);
  it("uses bounded cursor pagination, role-safe recap absence, and explicit fork language", async () => {
    const client = api("player"); render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    await screen.findByText(/Changed strength from 1 to 2/); expect(screen.queryByText("Secret story")).toBeNull(); expect(screen.queryByRole("heading", { name: "Create a recap" })).toBeNull(); expect(screen.getByText(/never erases history/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load next events" })); await screen.findByText(/Changed strength from 2 to 3/);
    expect(client.events).toHaveBeenNthCalledWith(2, "campaign-one", { timelineId: "timeline-one", afterRevision: 1, limit: 25 });
  });

  it("focuses the meaningful retry after an initial failure", async () => {
    const client = api(); (client.administration as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    render(<CampaignEventLogPage campaignId="campaign-one" api={client} onBack={vi.fn()} onUnavailable={vi.fn()} />);
    const retry = await screen.findByRole("button", { name: "Retry history" }); await waitFor(() => expect(document.activeElement).toBe(retry));
  });
});
