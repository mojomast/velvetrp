// Approved test (playtest kink #3b): a Quick adventure room starts with an authored opening (a system
// scene-setter plus a hero line). That is not "pre-campaign history", so the read-only legacy banner
// must not appear for an authored opening: legacy messages that start with a "system" message and
// contain no player ("user") message. Any other legacy room history keeps the banner.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../api";
import { CampaignConversation } from "./CampaignConversation";

const at = "2030-01-01T00:00:00.000Z";
const message = (
  id: string,
  role: ChatMessage["role"],
  content: string,
  speakerCharacterId: string | null = null,
): ChatMessage => ({
  id,
  sessionId: "session",
  role,
  speakerCharacterId,
  content,
  createdAt: at,
});

function renderWith(legacyMessages: ChatMessage[]) {
  render(
    <CampaignConversation
      transcript={[]}
      transcriptState="ready"
      legacyMessages={legacyMessages}
      legacyParticipants={[{ id: "hero", name: "Tessel Venn" }]}
      current={null}
      liveEvents={[]}
      actorNames={new Map()}
      onPrefillChoice={vi.fn()}
      canPrefill
      storyMode
    />,
  );
}

describe("CampaignConversation legacy heading", () => {
  afterEach(cleanup);

  it("shows an authored opening without the read-only pre-campaign banner", () => {
    renderWith([
      message(
        "m1",
        "system",
        "The campaign opens at Slake-Head in the Slake, on a morning when the street foundation has begun to shift.",
      ),
      message("m2", "character", "Those readings disagree. Orra, keep the street clear.", "hero"),
    ]);
    expect(screen.queryByText("Read-only pre-campaign history")).toBeNull();
    expect(screen.queryByText(/legacy room messages are historical context only/i)).toBeNull();
    // The opening itself still renders.
    expect(screen.getByText(/The campaign opens at Slake-Head/)).toBeTruthy();
    expect(screen.getByText(/Those readings disagree/)).toBeTruthy();
  });

  it("keeps the read-only banner for real pre-campaign chat", () => {
    renderWith([
      message("m1", "system", "A quiet tavern."),
      message("m2", "user", "I order a drink."),
      message("m3", "character", "The barkeep slides it over.", "hero"),
    ]);
    expect(screen.getByText("Read-only pre-campaign history")).toBeTruthy();
    expect(screen.getByText(/I order a drink/)).toBeTruthy();
  });

  it("keeps the read-only banner for legacy room history that is not an authored opening", () => {
    renderWith([message("m1", "character", "Campaign room history", "hero")]);
    expect(screen.getByText("Read-only pre-campaign history")).toBeTruthy();
  });
});
