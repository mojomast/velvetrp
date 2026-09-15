import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AdventureTurnTranscriptEntry, CampaignDmHistory } from "@velvet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildReplayTimeline, CampaignReplay } from "./CampaignReplay";

const early = "2030-01-01T00:00:00.000Z";
const late = "2030-01-01T00:05:00.000Z";
const transcript: AdventureTurnTranscriptEntry[] = [
  { turnId: "turn", actorId: "actor", declaration: "I draw my blade.", narration: "The blade hums.", completedAt: early },
];
const dmHistory = { control: { campaignId: "campaign", mode: "ai", revision: 1 }, runs: [
  { runId: "run", campaignId: "campaign", sessionId: "session", intent: "open", mode: "ai", modeRevision: 1, revision: 2, state: "completed",
    narration: "The ember crown awakens.", receipts: [{ action: "reveal-node", summary: "A sealed scene is revealed." }], blockers: [], createdAt: late },
] } as CampaignDmHistory;

describe("CampaignReplay", () => {
  afterEach(cleanup);

  it("merges adventure turns and director runs into one chronological timeline", () => {
    const beats = buildReplayTimeline(dmHistory, transcript);
    expect(beats.map((beat) => beat.id)).toEqual(["turn:turn", "dm:run"]);
    expect(buildReplayTimeline(null, [])).toEqual([]);
  });

  it("maps the transcript's declaration plus director narration into the replay log", () => {
    render(<CampaignReplay dmHistory={dmHistory} transcript={transcript} actorNames={new Map([["actor", "Aria"]])} onExit={() => undefined} />);
    const log = screen.getByRole("log", { name: "Replayed session" });
    expect(log.textContent).toContain("I draw my blade.");
    expect(log.textContent).toContain("The blade hums.");
    expect(log.textContent).toContain("The ember crown awakens.");
    expect(log.textContent).toContain("A sealed scene is revealed.");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("skips backward and forward through the session with the transport controls", () => {
    render(<CampaignReplay dmHistory={dmHistory} transcript={transcript} actorNames={new Map([["actor", "Aria"]])} onExit={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous beat" }));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.queryByText("The ember crown awakens.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next beat" }));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByText("The ember crown awakens.")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), { target: { value: "0" } });
    expect(screen.getByText("0 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
    expect(screen.getByRole("button", { name: "Pause replay" })).toBeTruthy();
  });

  it("reports an empty replayable history without fabricating a scene", () => {
    render(<CampaignReplay dmHistory={null} transcript={[]} actorNames={new Map()} onExit={() => undefined} />);
    expect(screen.getByText(/No replayable history yet/)).toBeTruthy();
  });
});
