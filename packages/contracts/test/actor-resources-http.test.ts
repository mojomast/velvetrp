import { describe, expect, it } from "vitest";
import {
  actorResourcesHttpChangeCommandRequestSchema,
  actorResourcesHttpChangeCommandResponseSchema,
  actorResourcesHttpGetResponseSchema,
} from "../src/actor-resources-http.js";

const resources = [
  { name: "health", current: 8, max: 10 },
  { name: "focus", current: 3, max: 5 },
];

describe("actor resources HTTP contracts", () => {
  it("returns a strict route-owned resource projection with its revision", () => {
    const response = { resources, revision: 4 };
    expect(actorResourcesHttpGetResponseSchema.parse(response)).toEqual(response);
    expect(actorResourcesHttpGetResponseSchema.safeParse({ ...response, actorId: "private" }).success).toBe(false);
    expect(actorResourcesHttpGetResponseSchema.safeParse({
      ...response,
      resources: [...resources, { name: "health", current: 1, max: 1 }],
    }).success).toBe(false);
  });

  it("accepts only a strict non-zero change command", () => {
    const request = {
      kind: "change" as const, resourceName: "health", amount: -2, expectedRevision: 4, idempotencyKey: "resource-change-1",
    };
    expect(actorResourcesHttpChangeCommandRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { ...request, kind: "set" },
      { ...request, amount: 0 },
      { ...request, amount: 1.5 },
      { ...request, current: 6 },
      { ...request, actorId: "private" },
    ]) {
      expect(actorResourcesHttpChangeCommandRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("returns updated resources with a strict public receipt", () => {
    const response = {
      resources: [{ name: "health", current: 6, max: 10 }, resources[1]],
      receipt: {
        kind: "change" as const, resourceName: "health", amount: -2, idempotencyKey: "resource-change-1",
        revisionBefore: 4, revisionAfter: 5, occurredAt: "2030-01-01T00:00:00.000Z",
      },
    };
    expect(actorResourcesHttpChangeCommandResponseSchema.parse(response)).toEqual(response);
    expect(actorResourcesHttpChangeCommandResponseSchema.safeParse({
      ...response,
      receipt: { ...response.receipt, revisionAfter: 6 },
    }).success).toBe(false);
    expect(actorResourcesHttpChangeCommandResponseSchema.safeParse({
      ...response,
      receipt: { ...response.receipt, commandId: "private" },
    }).success).toBe(false);
  });
});
