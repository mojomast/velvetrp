// Approved test (Hermes/Nous quick adventure): the quick-adventure request can name which bundled world to
// build. Omitting the id keeps today's behaviour (Sintermark); unknown ids are rejected.
import { describe, expect, it } from "vitest";
import { QUICK_ADVENTURE_IDS, QUICK_ADVENTURE_OPTIONS, quickAdventureCreateRequestSchema } from "../src/index.js";

describe("quick adventure request", () => {
  it("offers exactly the bundled adventures, Sintermark first", () => {
    expect([...QUICK_ADVENTURE_IDS]).toEqual(["sintermark", "hermes-nous"]);
    expect(QUICK_ADVENTURE_OPTIONS.map((option) => option.id)).toEqual(["sintermark", "hermes-nous"]);
    expect(QUICK_ADVENTURE_OPTIONS[0]!.name).toMatch(/Sintermark/);
    expect(QUICK_ADVENTURE_OPTIONS[1]!.name).toBe("Hermes Agent Squad: We Never Surrender");
  });

  it("keeps the id optional and accepts each bundled id", () => {
    expect(quickAdventureCreateRequestSchema.parse({ idempotencyKey: "quick-1" })).toEqual({
      idempotencyKey: "quick-1",
    });
    for (const adventureId of QUICK_ADVENTURE_IDS) {
      expect(quickAdventureCreateRequestSchema.parse({ idempotencyKey: "quick-1", adventureId })).toEqual({
        idempotencyKey: "quick-1",
        adventureId,
      });
    }
  });

  it("rejects unknown ids and still rejects extra keys", () => {
    for (const payload of [
      { idempotencyKey: "quick-1", adventureId: "nope" },
      { idempotencyKey: "quick-1", adventureId: "" },
      { idempotencyKey: "quick-1", adventureId: null },
      { idempotencyKey: "quick-1", adventureId: "hermes-nous", extra: true },
    ]) {
      expect(quickAdventureCreateRequestSchema.safeParse(payload).success).toBe(false);
    }
  });
});
