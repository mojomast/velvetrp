import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCharacters } from "../../../api";
import { addCampaignRoomParticipant } from "../overview/activationApi";
import { CampaignCharacterCreator } from "./CampaignCharacterCreator";

type BuilderProps = { api: { finalize: (campaignId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<{ character: { id: string } }> } };
const builderProps = vi.hoisted(() => ({ current: null as BuilderProps | null }));
vi.mock("../character/CharacterBuilderPage", () => ({
  CharacterBuilderPage: (props: BuilderProps) => { builderProps.current = props; return <div data-testid="builder" />; },
}));
vi.mock("../../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api")>(),
  listCharacters: vi.fn(),
}));
vi.mock("../overview/activationApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("../overview/activationApi")>(),
  addCampaignRoomParticipant: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("CampaignCharacterCreator", () => {
  it("finalizes a character and then joins the current room once", async () => {
    vi.mocked(listCharacters).mockResolvedValue({ characters: [{ id: "persona", name: "Aria" }] } as never);
    vi.mocked(addCampaignRoomParticipant).mockResolvedValue({ campaignId: "campaign", sessionId: "session", campaignCharacterId: "cc", characterId: "persona",
      actorId: "actor", position: 2, revision: 7, receipt: { commandId: "cmd", idempotencyKey: "key", occurredAt: "2030-01-01T00:00:00.000Z" } });
    const finalize = vi.fn().mockResolvedValue({ character: { id: "cc" } });
    const builderApi = { create: vi.fn(), get: vi.fn(), update: vi.fn(), reroll: vi.fn(), finalize, getSheet: vi.fn() } as never;
    const joined = vi.fn();
    render(<CampaignCharacterCreator campaignId="campaign" sessionId="session" builderApi={builderApi} expectedRevision={async () => 7} onJoined={joined} onExit={vi.fn()} />);
    await screen.findByTestId("builder");
    const result = await builderProps.current!.api.finalize("campaign", "draft", { expectedRevision: 0, idempotencyKey: "finalize" });
    expect(result).toEqual({ character: { id: "cc" } });
    expect(addCampaignRoomParticipant).toHaveBeenCalledWith("campaign", "session", expect.objectContaining({ campaignCharacterId: "cc", expectedRevision: 7 }));
    expect(joined).toHaveBeenCalledWith("actor");
  });

  it("keeps the finalized sheet when the join is not confirmed", async () => {
    vi.mocked(listCharacters).mockResolvedValue({ characters: [{ id: "persona", name: "Aria" }] } as never);
    vi.mocked(addCampaignRoomParticipant).mockRejectedValue(new Error("conflict"));
    const finalize = vi.fn().mockResolvedValue({ character: { id: "cc" } });
    const builderApi = { create: vi.fn(), get: vi.fn(), update: vi.fn(), reroll: vi.fn(), finalize, getSheet: vi.fn() } as never;
    render(<CampaignCharacterCreator campaignId="campaign" sessionId="session" builderApi={builderApi} expectedRevision={async () => 7} onExit={vi.fn()} />);
    await screen.findByTestId("builder");
    await expect(builderProps.current!.api.finalize("campaign", "draft", { expectedRevision: 0, idempotencyKey: "finalize" })).resolves.toEqual({ character: { id: "cc" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
