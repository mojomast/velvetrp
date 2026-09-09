import { afterEach, describe, expect, it, vi } from "vitest";
import { activateRoom, getActivationReadiness } from "./activationApi";
const readiness = { campaignId: "campaign-one", sessionId: "session-one", expectedRevision: 2, active: true, ready: true, blockers: [], actorIds: [] };
afterEach(() => vi.unstubAllGlobals());
describe("strict activation transport", () => {
  it.each([{ ...readiness, secret: "unexpected" }, { ...readiness, sessionId: "other-room" }])("rejects malformed or misbound reads", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(getActivationReadiness("campaign-one", "session-one")).rejects.toThrow();
  });
  it("rejects a receipt bound to another command without silently retrying", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ readiness, receipt: { commandId: "command-one", idempotencyKey: "other-key", occurredAt: "2030-01-01T00:00:00.000Z", activated: true, placedActorIds: [], reconciledNpcCount: 0 } })));
    vi.stubGlobal("fetch", fetcher);
    await expect(activateRoom("campaign-one", "session-one", { expectedRevision: 2, idempotencyKey: "requested-key" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
