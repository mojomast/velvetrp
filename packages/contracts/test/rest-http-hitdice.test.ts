// Approved test (round-2 playtest kink 2): the server requires hitDiceToSpend for an SRD short rest,
// but the strict HTTP request schema rejected the field, so a short rest could never succeed over HTTP.
import { describe, expect, it } from "vitest";
import { restHttpRequestSchema } from "../src/rest-http.js";

describe("rest HTTP request hit dice", () => {
  it("accepts hitDiceToSpend on a short rest", () => {
    const parsed = restHttpRequestSchema.safeParse({
      type: "take_short_rest",
      hitDiceToSpend: 2,
      expectedRevision: 3,
      idempotencyKey: "short-rest-dice",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ hitDiceToSpend: 2 });
  });
  it("still accepts a short rest without hit dice", () => {
    expect(
      restHttpRequestSchema.safeParse({
        type: "take_short_rest",
        expectedRevision: 3,
        idempotencyKey: "short-rest-plain",
      }).success,
    ).toBe(true);
  });
  it("rejects invalid hit dice and hit dice on a long rest", () => {
    for (const hitDiceToSpend of [0, -1, 1.5, 129, "2"])
      expect(
        restHttpRequestSchema.safeParse({
          type: "take_short_rest",
          hitDiceToSpend,
          expectedRevision: 3,
          idempotencyKey: "short-rest-bad",
        }).success,
      ).toBe(false);
    expect(
      restHttpRequestSchema.safeParse({
        type: "take_long_rest",
        hitDiceToSpend: 1,
        expectedRevision: 3,
        idempotencyKey: "long-rest-dice",
      }).success,
    ).toBe(false);
  });
});
