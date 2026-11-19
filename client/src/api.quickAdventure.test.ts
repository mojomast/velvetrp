// Approved test for plan 1.6: the client binding for POST /api/rpg/v1/quick-adventures.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createQuickAdventure } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const body = {
  campaignId: "quick-campaign",
  campaignName: "The Sintermark",
  sessionId: "quick-room",
  actorId: "quick-actor",
  replayed: false,
};

describe("createQuickAdventure", () => {
  it("posts only the idempotency key and accepts a new build (201) or a replay (200)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 201, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...body, replayed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createQuickAdventure({ idempotencyKey: "quick-1" })).resolves.toEqual(body);
    await expect(createQuickAdventure({ idempotencyKey: "quick-1" })).resolves.toEqual({ ...body, replayed: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/quick-adventures", expect.objectContaining({ method: "POST" }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ idempotencyKey: "quick-1" });
  });

  it("rejects an invalid key before any request and a malformed success body after one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...body, secret: "x" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createQuickAdventure({ idempotencyKey: "has spaces" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(createQuickAdventure({ idempotencyKey: "quick-2" })).rejects.toThrow();
  });

  it("surfaces the server's problem detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "https://velvet.invalid/problems/rpg-quick-adventure-failed",
            title: "Quick adventure failed",
            status: 500,
            code: "RPG_QUICK_ADVENTURE_FAILED",
            error: "Internal Server Error",
            detail: "Quick adventure failed at step tactical-map: disk full",
            requestId: "req-1",
          }),
          { status: 500, headers: { "Content-Type": "application/problem+json" } },
        ),
      ),
    );
    const failure = await createQuickAdventure({ idempotencyKey: "quick-3" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).message).toContain("disk full");
    expect((failure as ApiError).code).toBe("RPG_QUICK_ADVENTURE_FAILED");
  });
});
