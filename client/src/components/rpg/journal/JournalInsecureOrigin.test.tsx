import { cleanup, render, screen } from "@testing-library/react";
import type { CampaignQuestsHttpResponse, CampaignStoryHttpResponse } from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sharedApi from "../../../api";
import type { StudioAuthorization } from "../StudioAuthorization";
import { QuestJournalPage, type QuestJournalApi } from "./QuestJournalPage";
import { StoryStudioPage, type StoryStudioApi } from "./StoryStudioPage";

const at = "2026-09-08T11:33:10.644Z";
const authorization: StudioAuthorization = {
  audience: "gm",
  role: "owner",
  generation: 1,
  reauthorize: vi.fn(),
};
const story: CampaignStoryHttpResponse = {
  storylines: [{ storylineId: "gen-arc", campaignId: "campaign", title: "Nine Minutes Missing", summary: null, status: "active", createdAt: at, updatedAt: at }],
  nodes: [{ nodeId: "gen-node", storylineId: "gen-arc", title: "The 02:17 Incident", description: "The synchronized loss.", gmNotes: null, status: "hidden", revealThreshold: 0, createdAt: at, updatedAt: at }],
  edges: [],
  plotPoints: [],
  clues: [],
};
const quests: CampaignQuestsHttpResponse = {
  quests: [{ questId: "gen-quest", campaignId: "campaign", storylineId: "gen-arc", title: "Nine Minutes Missing", description: "Compare the evidence.", status: "offered", rewards: [], createdAt: at, updatedAt: at }],
  objectives: [],
  journal: [{ entryId: "gen-journal", questId: "gen-quest", text: "Compare the stopped clock and port log.", occurredAt: at }],
};

describe("journal workspaces on insecure origins", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders persisted quest and story projections without crypto.randomUUID", async () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(sharedApi, "getCampaignStory").mockResolvedValue({ data: story, revision: 3 });
    const questApi = { list: vi.fn().mockResolvedValue({ data: quests, revision: 8 }), create: vi.fn(), command: vi.fn(), preview: vi.fn() } as unknown as QuestJournalApi;
    const questView = render(<QuestJournalPage campaignId="campaign" authorization={authorization} api={questApi} onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Nine Minutes Missing" })).toBeTruthy();
    expect(screen.getByText("Compare the stopped clock and port log.")).toBeTruthy();

    questView.unmount();
    const storyApi = { get: vi.fn().mockResolvedValue({ data: story, revision: 3 }), create: vi.fn(), command: vi.fn(), preview: vi.fn() } as unknown as StoryStudioApi;
    render(<StoryStudioPage campaignId="campaign" authorization={authorization} api={storyApi} onBack={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Nine Minutes Missing" })).toBeTruthy();
    expect(screen.getByText("The 02:17 Incident")).toBeTruthy();
  });
});
