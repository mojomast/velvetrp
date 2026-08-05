import { describe, expect, it } from "vitest";
import {
  campaignAdministrationPatchSchema,
  campaignAdministrationSchema,
  campaignTransferEventSchema,
  campaignTransferPackageSchema,
} from "../src/index.js";

const at = "2035-01-02T03:04:05.006Z";

describe("campaign administration contracts", () => {
  it("structurally excludes privileged settings from player projections", () => {
    const parsed = campaignAdministrationSchema.parse({ id: "campaign", status: "draft",
      activeTimelineId: "timeline", revision: 0, updatedAt: at, actorRole: "player",
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "strict", recapVisibility: "members" } });
    expect(parsed.settings).not.toHaveProperty("gmNotes");
    expect(() => campaignAdministrationSchema.parse({ ...parsed,
      settings: { ...parsed.settings, gmNotes: "secret" } })).toThrow();
  });

  it("rejects empty, unbounded, and unknown administration mutations", () => {
    expect(() => campaignAdministrationPatchSchema.parse({ expectedRevision: 0, idempotencyKey: "key" })).toThrow();
    expect(() => campaignAdministrationPatchSchema.parse({ expectedRevision: 0, idempotencyKey: "key", settings: {} })).toThrow();
    expect(() => campaignAdministrationPatchSchema.parse({ expectedRevision: 0, idempotencyKey: "key",
      settings: { maxPlayers: 21 } })).toThrow();
    expect(() => campaignAdministrationPatchSchema.parse({ expectedRevision: 0, idempotencyKey: "key",
      status: "published", actorId: "caller" })).toThrow();
  });

  it("keeps transfer packages strict and secret-domain free", () => {
    const base = { formatVersion: 1, exportedAt: at,
      campaign: { name: "Campaign", status: "draft", settings: { maxPlayers: 6,
        allowPlayerDice: true, safetyMode: "standard", recapVisibility: "members", gmNotes: "" }, administrationRevision: 0 },
      timelines: [{ sourceId: "timeline", parentSourceId: null, forkedFromRevision: null, revision: 0, createdAt: at, events: [] }],
      activeTimelineSourceId: "timeline", content: { status: "unconfigured" },
      records: { actors: [], checkpoints: [], recaps: [], memberships: [], roomAttachments: [],
        administration: { events: [], receipts: [] } },
      excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] } as const;
    expect(campaignTransferPackageSchema.parse(base)).toEqual(base);
    expect(() => campaignTransferPackageSchema.parse({ ...base, apiKey: "secret" })).toThrow();
    const event = { eventId: "event", commandId: "command", type: "campaign_renamed" as const,
      revision: 1, occurredAt: at, data: { name: "Renamed" } };
    const mismatchedReceiptTime = { ...base, campaign: { ...base.campaign, administrationRevision: 1 },
      records: { ...base.records, administration: { events: [event], receipts: [{ commandId: "command",
        type: "campaign_renamed" as const, revisionBefore: 0, revisionAfter: 1,
        occurredAt: "2035-01-02T03:04:05.007Z" }] } } };
    expect(() => campaignTransferPackageSchema.parse(mismatchedReceiptTime)).toThrow(/receipt time must match/);
  });

  it("accepts only exact portable public RPG event variants", () => {
    const common = { sourceEventId: "event", sourceCommandId: "command", actorId: "actor",
      sourceTurnId: null, revision: 1, occurredAt: at };
    expect(campaignTransferEventSchema.parse({ ...common, type: "actor_attribute_set",
      data: { attributeId: "strength", valueBefore: 9, valueAfter: 10 } }).type).toBe("actor_attribute_set");
    expect(() => campaignTransferEventSchema.parse({ ...common, type: "unknown", data: {} })).toThrow();
    expect(() => campaignTransferEventSchema.parse({ ...common, type: "actor_attribute_set",
      data: { attributeId: "strength", valueBefore: 9, valueAfter: 10, total: 99 } })).toThrow();
  });
});
