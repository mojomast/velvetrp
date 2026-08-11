import { describe, expect, expectTypeOf, it } from "vitest";
import {
  gmHistoricalNpcHttpSchema,
  gmPresentNpcHttpSchema,
  gmRunningNpcCastHttpSchema,
  gmStoppedNpcCastHttpSchema,
  npcCastHttpSchema,
  npcPresenceMutationHttpRequestSchema,
  npcPresenceMutationHttpResponseSchema,
  npcPresenceMutationReceiptHttpSchema,
  playerHistoricalNpcHttpSchema,
  playerPresentNpcHttpSchema,
  playerRunningNpcCastHttpSchema,
  playerStoppedNpcCastHttpSchema,
  type NpcPresenceMutationHttpResponse,
} from "../src/npc-presence-http.js";

const presentAt = "2035-01-01T00:00:00.000Z";
const updatedAt = "2035-01-01T00:01:00.000Z";
const leftAt = "2035-01-01T00:02:00.000Z";
const publicState = { name: "Marrow" };
const privateState = { goals: "Trade", gmNotes: "Knows the passphrase", merchantState: null };
const playerNpc = {
  npcId: "npc", publicState, location: { label: "Great Hall" }, revision: 2, presentAt, updatedAt,
} as const;
const gmNpc = {
  ...playerNpc, location: { locationId: "hall", label: "Great Hall" }, personaId: "persona",
  principals: ["principal"], privateState,
} as const;
const playerHistoricalNpc = {
  npcId: "npc", publicState, lastLocation: { label: "Great Hall" }, revision: 3,
  presentAt, updatedAt, leftAt,
} as const;
const gmHistoricalNpc = {
  ...playerHistoricalNpc, lastLocation: { locationId: "hall", label: "Great Hall" }, personaId: "persona",
  principals: ["principal"], privateState,
} as const;

const playerRunning = {
  audience: "player", state: "running", sessionRevision: 6, presentCast: [playerNpc],
} as const;
const gmRunning = {
  audience: "gm", state: "running", sessionRevision: 6, presentCast: [gmNpc],
} as const;
const playerStopped = {
  audience: "player", state: "stopped", sessionRevision: 7, castHistory: [playerHistoricalNpc],
} as const;
const gmStopped = {
  audience: "gm", state: "stopped", sessionRevision: 7, castHistory: [gmHistoricalNpc],
} as const;

describe("M5.1 NPC presence HTTP contracts", () => {
  it("keeps route identities and caller authority out of strict mutation bodies", () => {
    const request = { expectedRevision: 5, idempotencyKey: "place", mutation: { kind: "place", locationId: null } } as const;
    expect(npcPresenceMutationHttpRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { campaignId: "campaign" }, { sessionId: "session" }, { npcId: "npc" },
      { principalId: "principal" }, { role: "gm" }, { authorized: true },
    ]) expect(npcPresenceMutationHttpRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(npcPresenceMutationHttpRequestSchema.safeParse({ ...request, expectedNpcRevision: 2 }).success).toBe(false);
  });

  it("publishes a safe receipt with exact keys and one session revision advance", () => {
    const receipt = { kind: "place", revisionBefore: 5, revisionAfter: 6, occurredAt: updatedAt } as const;
    expect(npcPresenceMutationReceiptHttpSchema.parse(receipt)).toEqual(receipt);
    expect(Object.keys(npcPresenceMutationReceiptHttpSchema.parse(receipt))).toEqual([
      "kind", "revisionBefore", "revisionAfter", "occurredAt",
    ]);
    for (const extra of [{ commandId: "command" }, { eventId: "event" }, { idempotencyKey: "place" },
      { internalId: "internal" }]) expect(npcPresenceMutationReceiptHttpSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
    expect(npcPresenceMutationReceiptHttpSchema.safeParse({ ...receipt, revisionAfter: 7 }).success).toBe(false);
  });

  it("uses structurally distinct running present-cast and at-stop history", () => {
    expect(gmRunningNpcCastHttpSchema.parse(gmRunning)).toEqual(gmRunning);
    expect(playerRunningNpcCastHttpSchema.parse(playerRunning)).toEqual(playerRunning);
    expect(gmStoppedNpcCastHttpSchema.parse(gmStopped)).toEqual(gmStopped);
    expect(playerStoppedNpcCastHttpSchema.parse(playerStopped)).toEqual(playerStopped);
    expect(playerRunningNpcCastHttpSchema.safeParse(gmRunning).success).toBe(false);
    expect(npcCastHttpSchema.safeParse({ ...playerStopped, presentCast: playerStopped.castHistory }).success).toBe(false);
    expect(npcCastHttpSchema.safeParse({ ...playerRunning, castHistory: [] }).success).toBe(false);
  });

  it("exposes player-safe labeled locations without a structural location ID", () => {
    expect(playerPresentNpcHttpSchema.safeParse({ ...playerNpc, location: { locationId: "hall", label: "Great Hall" } }).success).toBe(false);
    expect(playerHistoricalNpcHttpSchema.safeParse({
      ...playerHistoricalNpc, lastLocation: { locationId: "hall", label: "Great Hall" },
    }).success).toBe(false);
    expect(playerPresentNpcHttpSchema.safeParse({ ...playerNpc, locationId: "hall" }).success).toBe(false);
    expect(playerHistoricalNpcHttpSchema.safeParse({ ...playerHistoricalNpc, lastLocationId: "hall" }).success).toBe(false);
    expect(playerPresentNpcHttpSchema.safeParse({ ...playerNpc, location: null }).success).toBe(true);
    expect(playerHistoricalNpcHttpSchema.safeParse({ ...playerHistoricalNpc, lastLocation: null }).success).toBe(true);
    expect(gmPresentNpcHttpSchema.safeParse(gmNpc).success).toBe(true);
    expect(gmHistoricalNpcHttpSchema.safeParse(gmHistoricalNpc).success).toBe(true);
  });

  it("freezes exact player member, cast, and mutation response envelope keys", () => {
    const parsedPresent = playerPresentNpcHttpSchema.parse(playerNpc);
    const parsedHistory = playerHistoricalNpcHttpSchema.parse(playerHistoricalNpc);
    expect(Object.keys(parsedPresent)).toEqual([
      "npcId", "publicState", "revision", "presentAt", "updatedAt", "location",
    ]);
    expect(Object.keys(parsedPresent.location!)).toEqual(["label"]);
    expect(Object.keys(parsedHistory)).toEqual([
      "npcId", "publicState", "revision", "presentAt", "updatedAt", "leftAt", "lastLocation",
    ]);
    expect(Object.keys(parsedHistory.lastLocation!)).toEqual(["label"]);
    expect(Object.keys(playerRunningNpcCastHttpSchema.parse(playerRunning))).toEqual([
      "audience", "state", "sessionRevision", "presentCast",
    ]);
    expect(Object.keys(playerStoppedNpcCastHttpSchema.parse(playerStopped))).toEqual([
      "audience", "state", "sessionRevision", "castHistory",
    ]);

    const response = {
      receipt: { kind: "move", revisionBefore: 5, revisionAfter: 6, occurredAt: updatedAt },
    } as const;
    const parsedResponse = npcPresenceMutationHttpResponseSchema.parse(response);
    expect(Object.keys(parsedResponse)).toEqual(["receipt"]);
    expectTypeOf<NpcPresenceMutationHttpResponse>().toEqualTypeOf<{
      receipt: { kind: "place" | "move" | "remove"; revisionBefore: number; revisionAfter: number; occurredAt: string };
    }>();

    for (const forbidden of [
      { cast: playerRunning }, { cast: gmRunning }, { commandId: "command" }, { eventId: "event" },
      { idempotencyKey: "presence" }, { internalId: "internal" }, { privateState },
    ]) expect(npcPresenceMutationHttpResponseSchema.safeParse({ ...response, ...forbidden }).success).toBe(false);
  });

  it("rejects every private or internal field from running and historical player members", () => {
    const privateFields = [
      { personaId: "persona" }, { principals: ["principal"] }, { principalId: "principal" },
      { privateState }, { commandId: "command" }, { eventId: "event" },
      { idempotencyKey: "presence" }, { internalId: "internal" },
    ];
    for (const privateField of privateFields) {
      expect(playerPresentNpcHttpSchema.safeParse({ ...playerNpc, ...privateField }).success).toBe(false);
      expect(playerHistoricalNpcHttpSchema.safeParse({ ...playerHistoricalNpc, ...privateField }).success).toBe(false);
    }
  });

  it("requires positive per-NPC revisions and ordered timestamps in every member variant", () => {
    for (const [schema, member] of [
      [playerPresentNpcHttpSchema, playerNpc], [gmPresentNpcHttpSchema, gmNpc],
      [playerHistoricalNpcHttpSchema, playerHistoricalNpc], [gmHistoricalNpcHttpSchema, gmHistoricalNpc],
    ] as const) {
      expect(schema.safeParse({ ...member, revision: 0 }).success).toBe(false);
      expect(schema.safeParse({ ...member, updatedAt: "2034-12-31T23:59:00.000Z" }).success).toBe(false);
    }
    expect(playerHistoricalNpcHttpSchema.safeParse({ ...playerHistoricalNpc, leftAt: presentAt }).success).toBe(false);
    expect(gmHistoricalNpcHttpSchema.safeParse({ ...gmHistoricalNpc, leftAt: presentAt }).success).toBe(false);
  });

  it("rejects duplicate NPC casts and duplicate GM principals", () => {
    expect(playerRunningNpcCastHttpSchema.safeParse({ ...playerRunning, presentCast: [playerNpc, playerNpc] }).success).toBe(false);
    expect(gmRunningNpcCastHttpSchema.safeParse({ ...gmRunning, presentCast: [gmNpc, gmNpc] }).success).toBe(false);
    expect(playerStoppedNpcCastHttpSchema.safeParse({ ...playerStopped, castHistory: [playerHistoricalNpc, playerHistoricalNpc] }).success).toBe(false);
    expect(gmStoppedNpcCastHttpSchema.safeParse({ ...gmStopped, castHistory: [gmHistoricalNpc, gmHistoricalNpc] }).success).toBe(false);
    expect(gmPresentNpcHttpSchema.safeParse({ ...gmNpc, principals: ["principal", "principal"] }).success).toBe(false);
    expect(gmHistoricalNpcHttpSchema.safeParse({ ...gmHistoricalNpc, principals: ["principal", "principal"] }).success).toBe(false);
  });

  it("enforces cast, principal, and location-label caps", () => {
    const oversizedPlayerPresentCast = Array.from({ length: 1_001 }, (_, index) => ({ ...playerNpc, npcId: `npc-${index}` }));
    const oversizedGmPresentCast = Array.from({ length: 1_001 }, (_, index) => ({ ...gmNpc, npcId: `npc-${index}` }));
    const oversizedPlayerHistory = Array.from({ length: 1_001 }, (_, index) => ({ ...playerHistoricalNpc, npcId: `npc-${index}` }));
    const oversizedGmHistory = Array.from({ length: 1_001 }, (_, index) => ({ ...gmHistoricalNpc, npcId: `npc-${index}` }));
    const oversizedPrincipals = Array.from({ length: 1_001 }, (_, index) => `principal-${index}`);
    expect(playerRunningNpcCastHttpSchema.safeParse({ ...playerRunning, presentCast: oversizedPlayerPresentCast }).success).toBe(false);
    expect(gmRunningNpcCastHttpSchema.safeParse({ ...gmRunning, presentCast: oversizedGmPresentCast }).success).toBe(false);
    expect(playerStoppedNpcCastHttpSchema.safeParse({ ...playerStopped, castHistory: oversizedPlayerHistory }).success).toBe(false);
    expect(gmStoppedNpcCastHttpSchema.safeParse({ ...gmStopped, castHistory: oversizedGmHistory }).success).toBe(false);
    expect(gmPresentNpcHttpSchema.safeParse({ ...gmNpc, principals: oversizedPrincipals }).success).toBe(false);
    expect(gmHistoricalNpcHttpSchema.safeParse({ ...gmHistoricalNpc, principals: oversizedPrincipals }).success).toBe(false);
    expect(playerPresentNpcHttpSchema.safeParse({ ...playerNpc, location: { label: "x".repeat(201) } }).success).toBe(false);
    expect(playerHistoricalNpcHttpSchema.safeParse({ ...playerHistoricalNpc, lastLocation: { label: " " } }).success).toBe(false);
  });

  it("keeps exact retry responses immutable and independent of later GET projections", () => {
    const receipt = { kind: "remove", revisionBefore: 5, revisionAfter: 6, occurredAt: leftAt } as const;
    const original = npcPresenceMutationHttpResponseSchema.parse({ receipt });
    const exactRetry = npcPresenceMutationHttpResponseSchema.parse({ receipt: { ...receipt } });
    expect(exactRetry).toEqual(original);
    expect(Object.keys(exactRetry)).toEqual(["receipt"]);
    expect(npcPresenceMutationHttpResponseSchema.safeParse({ receipt, cast: playerRunning }).success).toBe(false);
    expect(npcPresenceMutationHttpResponseSchema.safeParse({ receipt, cast: gmRunning }).success).toBe(false);
  });

  it("fails closed for unknown projection kinds and fields", () => {
    expect(npcCastHttpSchema.safeParse({ ...playerRunning, audience: "observer" }).success).toBe(false);
    expect(npcCastHttpSchema.safeParse({ ...playerRunning, state: "paused" }).success).toBe(false);
    expect(npcCastHttpSchema.safeParse({ ...playerRunning, privateNpcState: privateState }).success).toBe(false);
  });
});
