import { describe, expect, expectTypeOf, it } from "vitest";
import {
  npcPresenceCommandSchema,
  npcPresenceMutationSchema,
  npcPresenceSchema,
  npcPresenceStatusSchema,
  type NpcPresenceStatus,
} from "../src/npc-presence.js";

const at = "2035-01-01T00:00:00.000Z";

describe("M5.1 NPC presence contracts", () => {
  it("freezes the internal lifecycle and per-NPC informational revision", () => {
    expect(npcPresenceStatusSchema.options).toEqual(["present", "left"]);
    expectTypeOf<NpcPresenceStatus>().toEqualTypeOf<"present" | "left">();
    const presence = { campaignId: "campaign", sessionId: "session", npcId: "npc", personaId: "persona",
      status: "present", locationId: null, principals: ["principal"], revision: 3,
      presentAt: at, updatedAt: at, leftAt: null } as const;
    expect(npcPresenceSchema.parse(presence)).toEqual(presence);
    expect(npcPresenceSchema.safeParse({ ...presence, revision: 0 }).success).toBe(false);
    expect(npcPresenceSchema.safeParse({ ...presence, status: "left" }).success).toBe(false);
    expect(npcPresenceSchema.safeParse({ ...presence, principals: ["principal", "principal"] }).success).toBe(false);
    expect(npcPresenceSchema.safeParse({ ...presence, expectedRevision: 3 }).success).toBe(false);

    const leftBeforeUpdate = npcPresenceSchema.safeParse({
      ...presence,
      status: "left",
      updatedAt: "2035-01-01T00:00:02.000Z",
      leftAt: "2035-01-01T00:00:01.000Z",
    });
    expect(leftBeforeUpdate.success).toBe(false);
    if (!leftBeforeUpdate.success) expect(leftBeforeUpdate.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ["leftAt"] }),
    ]));
  });

  it("closes place, move, and remove intents and permits nullable locations only where defined", () => {
    for (const mutation of [
      { kind: "place", locationId: null },
      { kind: "move", locationId: "hall" },
      { kind: "remove" },
    ]) expect(npcPresenceMutationSchema.parse(mutation)).toEqual(mutation);

    expect(npcPresenceMutationSchema.safeParse({ kind: "remove", locationId: null }).success).toBe(false);
    expect(npcPresenceMutationSchema.safeParse({ kind: "teleport", locationId: "hall" }).success).toBe(false);
    expect(npcPresenceMutationSchema.safeParse({ kind: "place", locationId: null, authority: "gm" }).success).toBe(false);
  });

  it("uses only the session root revision for internal commands", () => {
    const command = { campaignId: "campaign", sessionId: "session", npcId: "npc", expectedRevision: 4,
      idempotencyKey: "presence", mutation: { kind: "move", locationId: null } } as const;
    expect(npcPresenceCommandSchema.parse(command)).toEqual(command);
    expect(npcPresenceCommandSchema.safeParse({ ...command, expectedNpcRevision: 2 }).success).toBe(false);
    expect(npcPresenceCommandSchema.safeParse({ ...command, principalId: "caller" }).success).toBe(false);
  });
});
