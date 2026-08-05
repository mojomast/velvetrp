import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@velvet/contracts";
import {
  CampaignDiceUnavailableError,
  CampaignDiceVisibleBindingConflictError,
  createCampaignDiceService,
  type CampaignDiceRepository,
} from "../src/campaignDice.js";

const AT = "2030-01-02T03:04:05.006Z";
const result = {
  expression: "1d20", normalized: { count: 1, sides: 20, selection: { type: "all" as const }, modifier: 0 },
  terms: [{ value: 14, kept: true }], modifier: 0, total: 14,
};

function setup(role = "owner") {
  const unit = {
    getCampaign: vi.fn(() => ({
      id: "campaign", name: "Campaign", activeTimelineId: "timeline", ownerPrincipalId: "local-owner",
      createdAt: AT, updatedAt: AT, actorRole: role,
    })),
    getCampaignTimeline: vi.fn(() => ({ id: "timeline", campaignId: "campaign", revision: 7, createdAt: AT })),
    getCampaignCharacterRoster: vi.fn(() => ({ campaignId: "campaign", characters: [
      { id: "cc-a", characterId: "persona-a", name: "Same" },
      { id: "cc-b", characterId: "persona-b", name: "Same" },
    ] })),
    listCampaignCharacters: vi.fn(() => [
      { projection: { campaignCharacter: { id: "cc-a" }, actor: { id: "actor-a" } } },
      { projection: { campaignCharacter: { id: "cc-b" }, actor: { id: "actor-b" } } },
    ]),
    listRecentCampaignDiceEvents: vi.fn(() => [{
      eventId: "event-old", commandId: "command-old", campaignId: "campaign", timelineId: "timeline",
      actorId: "actor-b", sourceTurnId: null, type: "actor_dice_rolled" as const,
      revision: 7, occurredAt: AT, data: result,
    }]),
  };
  const execute = vi.fn((_: string, envelope: CommandEnvelope, _binding?: unknown) => ({
    commandId: envelope.commandId, campaignId: envelope.campaignId,
    revisionBefore: envelope.expectedRevision, revisionAfter: envelope.expectedRevision + 1,
    events: [{
      eventId: "new-event", commandId: envelope.commandId, campaignId: envelope.campaignId,
      timelineId: envelope.timelineId, actorId: envelope.actorId, sourceTurnId: null,
      type: "actor_dice_rolled" as const, revision: envelope.expectedRevision + 1,
      occurredAt: AT, data: result,
    }],
  }));
  const repository = {
    transaction: vi.fn((callback: (input: typeof unit) => unknown) => callback(unit)),
    executeRollActorDiceForVisibleCharacter: execute,
  } as unknown as CampaignDiceRepository;
  const nextId = vi.fn(() => "dice-command");
  return { unit, execute, repository, nextId };
}

describe("trusted-local campaign dice service", () => {
  it("reads one snapshot and binds duplicate names by contiguous position", () => {
    const fixture = setup();
    const response = createCampaignDiceService(fixture.repository, { nextId: fixture.nextId })
      .read("local-owner", "campaign");
    expect(response).toEqual({
      characters: [{ position: 1, name: "Same" }, { position: 2, name: "Same" }],
      rolls: [{ character: { position: 2, name: "Same" }, occurredAt: AT, result }],
    });
    expect(fixture.repository.transaction).toHaveBeenCalledOnce();
    expect(fixture.nextId).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("keeps repository revision order when informational timestamps run backward or tie", () => {
    const fixture = setup();
    const laterTimestamp = "2030-01-02T03:04:06.000Z";
    const event = fixture.unit.listRecentCampaignDiceEvents.mock.results.length === 0
      ? {
          eventId: "event", commandId: "command", campaignId: "campaign", timelineId: "timeline",
          actorId: "actor-b", sourceTurnId: null, type: "actor_dice_rolled" as const,
          revision: 7, occurredAt: AT, data: result,
        }
      : fixture.unit.listRecentCampaignDiceEvents.mock.results[0]!.value[0];
    fixture.unit.listRecentCampaignDiceEvents.mockReturnValueOnce([
      { ...event, eventId: "event-7", revision: 7, occurredAt: AT },
      { ...event, eventId: "event-6", revision: 6, occurredAt: laterTimestamp },
      { ...event, eventId: "event-5", revision: 5, occurredAt: laterTimestamp },
    ]);
    expect(createCampaignDiceService(fixture.repository, { nextId: fixture.nextId })
      .read("local-owner", "campaign").rolls.map((roll) => roll.occurredAt))
      .toEqual([AT, laterTimestamp, laterTimestamp]);
  });

  it.each(["player", "observer"])('masks role "%s" before roster, history, IDs, or execution', (role) => {
    const fixture = setup(role);
    expect(() => createCampaignDiceService(fixture.repository, { nextId: fixture.nextId })
      .read("local-owner", "campaign")).toThrow(CampaignDiceUnavailableError);
    expect(fixture.unit.getCampaignCharacterRoster).not.toHaveBeenCalled();
    expect(fixture.unit.listRecentCampaignDiceEvents).not.toHaveBeenCalled();
    expect(fixture.nextId).not.toHaveBeenCalled();
  });

  it("preflights exact visible binding, then generates one internal identity and executes once", () => {
    const fixture = setup();
    const response = createCampaignDiceService(fixture.repository, { nextId: fixture.nextId }).roll(
      "local-owner", "campaign", { character: { position: 2, name: "Same" }, expression: "1d20" },
    );
    expect(response.roll.character).toEqual({ position: 2, name: "Same" });
    expect(fixture.nextId).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.execute.mock.calls[0]![1]).toEqual({
      commandId: "dice-command", idempotencyKey: "dice-command", campaignId: "campaign",
      timelineId: "timeline", actorId: "actor-b", expectedRevision: 7, sourceTurnId: null,
      command: { type: "roll_actor_dice", payload: { expression: "1d20" } },
    });
    expect(fixture.execute.mock.calls[0]![2]).toEqual({
      position: 2, name: "Same", campaignCharacterId: "cc-b",
    });
  });

  it("classifies only stale visible bindings and does no ID generation or execution", () => {
    const fixture = setup();
    expect(() => createCampaignDiceService(fixture.repository, { nextId: fixture.nextId }).roll(
      "local-owner", "campaign", { character: { position: 1, name: "Changed" }, expression: "1d20" },
    )).toThrow(CampaignDiceVisibleBindingConflictError);
    expect(fixture.nextId).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not retry ambiguous executor or committed malformed-output failures", () => {
    for (const malformed of [false, true]) {
      const fixture = setup();
      fixture.execute.mockImplementationOnce(() => {
        if (!malformed) throw new Error("revision raced after preflight");
        return { committed: true } as never;
      });
      expect(() => createCampaignDiceService(fixture.repository, { nextId: fixture.nextId }).roll(
        "local-owner", "campaign", { character: { position: 1, name: "Same" }, expression: "1d20" },
      )).toThrow();
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fixture.nextId).toHaveBeenCalledOnce();
    }
  });
});
