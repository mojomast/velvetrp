import { describe, expect, expectTypeOf, it } from "vitest";
import {
  factionMembershipSchema, factionRelationSchema, gmWorldProjectionSchema, locationConnectionSchema, locationSchema,
  playerWorldProjectionSchema, reputationLedgerEntrySchema, travelCommandSchema, type WorldProjection,
} from "../src/world.js";

const time = "2026-08-05T12:00:00.000Z";
const location = { campaignId: "campaign", locationId: "town", parentLocationId: null, name: "Town", description: "A town.", visibility: "visible", createdAt: time, updatedAt: time } as const;
const discovery = { locationDiscoveryId: "discovery", campaignId: "campaign", principalId: "player", locationId: "town", discoveredAt: time } as const;

describe("M1.8 world contracts", () => {
  it("uses strict, bounded authoritative locations and directed connections", () => {
    expect(locationSchema.parse(location)).toEqual(location);
    const connection = { campaignId: "campaign", locationConnectionId: "road", fromLocationId: "town", toLocationId: "forest", visibility: "hidden", createdAt: time } as const;
    expect(locationConnectionSchema.parse(connection)).toEqual(connection);
    for (const invalid of [{ ...location, parentLocationId: "town" }, { ...location, gmNotes: "no" }, { ...connection, toLocationId: "town" }, { ...connection, travelCost: 1 }]) {
      expect(("locationId" in invalid ? locationSchema : locationConnectionSchema).safeParse(invalid).success).toBe(false);
    }
  });

  it("makes travel a closed, deterministic intent with a unique bounded selected party", () => {
    const command = { type: "travel", campaignId: "campaign", travelId: "travel", locationConnectionId: "road", selectedPartyActorIds: ["a", "b"], expectedRevision: 0, idempotencyKey: "travel-1" } as const;
    expect(travelCommandSchema.parse(command)).toEqual(command);
    for (const invalid of [{ ...command, selectedPartyActorIds: [] }, { ...command, selectedPartyActorIds: ["a", "a"] }, { ...command, outcome: "arrived" }, { ...command, speech: "I go" }, { ...command, expectedRevision: -1 }, { ...command, type: "teleport" }]) {
      expect(travelCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("keeps player projections structurally unable to carry secrets or undiscovered routes", () => {
    const player = { audience: "player", campaignId: "campaign", revision: 0, discoveries: [discovery], locations: [{ locationId: "town", parentLocationId: null, name: "Town", description: "A town." }], connections: [], npcs: [{ npcId: "mayor", name: "Mayor" }], actorLocations: [], factions: [], relationships: [] } as const;
    expect(playerWorldProjectionSchema.parse(player)).toEqual(player);
    expect(playerWorldProjectionSchema.safeParse({ ...player, locations: [{ ...player.locations[0], visibility: "hidden" }] }).success).toBe(false);
    expect(playerWorldProjectionSchema.safeParse({ ...player, privateNpcStates: [] }).success).toBe(false);
    expect(playerWorldProjectionSchema.safeParse({ ...player, connections: [{ locationConnectionId: "secret-road", fromLocationId: "town", toLocationId: "secret", travelCost: 1 }] }).success).toBe(false);
  });

  it("admits GM-only NPC state and validates factions, relations, and ledger bounds", () => {
    const gm = { audience: "gm", campaignId: "campaign", revision: 0, locations: [location], connections: [], discoveries: [discovery], actorLocations: [], npcPersonaLinks: [{ npcPersonaLinkId: "link", campaignId: "campaign", npcId: "mayor", actorId: "mayor-actor", linkedAt: time }], privateNpcStates: [{ campaignId: "campaign", npcId: "mayor", gmNotes: "Secret", secrets: ["Secret"], motivations: ["Power"], updatedAt: time }], factions: [], memberships: [], factionRelations: [], relationships: [], reputationLedger: [] } as const;
    expect(gmWorldProjectionSchema.parse(gm)).toEqual(gm);
    expect(factionMembershipSchema.safeParse({ factionMembershipId: "m", campaignId: "campaign", factionId: "guild", member: { kind: "faction", factionId: "guild" }, role: "member", joinedAt: time }).success).toBe(false);
    expect(factionRelationSchema.safeParse({ factionRelationId: "r", campaignId: "campaign", fromFactionId: "guild", toFactionId: "guild", disposition: "neutral", score: 0, updatedAt: time }).success).toBe(false);
    expect(reputationLedgerEntrySchema.safeParse({ reputationLedgerEntryId: "l", campaignId: "campaign", factionId: "guild", subject: { kind: "actor", actorId: "a" }, delta: 0, reason: "help", recordedAt: time }).success).toBe(false);
  });

  it("publishes a closed audience union", () => {
    expectTypeOf<WorldProjection["audience"]>().toEqualTypeOf<"player" | "gm">();
  });
});
