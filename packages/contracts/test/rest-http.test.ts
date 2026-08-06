import { describe, expect, expectTypeOf, it } from "vitest";
import type { RestHttpResponse } from "../src/rest-http.js";
import {
  restHttpActorStateSchema,
  restHttpReceiptSchema,
  restHttpRequestSchema,
  restHttpResponseSchema,
} from "../src/rest-http.js";

describe("rest HTTP contracts", () => {
  it("accepts only strict route-safe short and long rest requests", () => {
    const short = { type: "take_short_rest" as const, expectedRevision: 4, idempotencyKey: "short-rest-1" };
    const long = { type: "take_long_rest" as const, expectedRevision: 5, idempotencyKey: "long-rest-1" };

    expect(restHttpRequestSchema.parse(short)).toEqual(short);
    expect(restHttpRequestSchema.parse(long)).toEqual(long);
    expect(restHttpRequestSchema.safeParse({ ...short, campaignId: "private" }).success).toBe(false);
    expect(restHttpRequestSchema.safeParse({ ...long, actorId: "private" }).success).toBe(false);
    expect(restHttpRequestSchema.safeParse({ ...short, type: "short" }).success).toBe(false);
  });

  it("returns a resource state and a redacted, revision-advancing receipt", () => {
    const actorState = {
      resources: [{ resourceId: "health", current: 10, capacity: 10 }],
      revision: 5,
    };
    const receipt = {
      kind: "short" as const,
      recoveredAt: "2030-01-01T00:00:00.000Z",
      recovery: { resources: [{ resourceId: "health", before: 4, after: 10 }] },
      revisionBefore: 4,
      revisionAfter: 5,
      idempotencyKey: "short-rest-1",
    };

    expect(restHttpActorStateSchema.parse(actorState)).toEqual(actorState);
    expect(restHttpReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(restHttpResponseSchema.parse({ actorState, receipt })).toEqual({ actorState, receipt });
    for (const privateField of ["restId", "campaignId", "actorId"] as const) {
      expect(restHttpReceiptSchema.safeParse({ ...receipt, [privateField]: "private" }).success).toBe(false);
    }
    expect(restHttpReceiptSchema.safeParse({ ...receipt, revisionAfter: 6 }).success).toBe(false);
    expect(restHttpActorStateSchema.safeParse({ ...actorState, actorId: "private" }).success).toBe(false);
  });

  it("infers only the public actor state and receipt fields", () => {
    expectTypeOf<RestHttpResponse>().toEqualTypeOf<{
      actorState: { resources: Array<{ resourceId: string; current: number; capacity: number }>; revision: number };
      receipt: {
        kind: "short" | "long";
        recoveredAt: string;
        recovery: { resources: Array<{ resourceId: string; before: number; after: number }> };
        revisionBefore: number;
        revisionAfter: number;
        idempotencyKey: string;
      };
    }>();
  });
});
