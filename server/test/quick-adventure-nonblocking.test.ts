// Approved test (playtest kink #6): building a Quick adventure must not freeze the server. Seen live:
// /api/health took ~6.7s while a ~6.9s build ran, and the documented 409 for a second key during a
// build never fired because the second request could not even be read until the first finished.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const URL = "/api/rpg/v1/quick-adventures";
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
/**
 * Longest acceptable event-loop stall while a build runs. Measured on main: the build is one ~5s
 * synchronous run; its slowest single steps (starter catalog install, party creation) take ~1.6s
 * each, so yielding between build steps brings the worst stall under this bound.
 */
const MAX_STALL_MS = 2500;

beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe("Quick adventure build does not block the server", () => {
  it("keeps the event loop responsive and answers health while a build is running", async () => {
    const app = buildApp();
    try {
      // Warm the app (routes, first database open) outside the measured window.
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

      let buildDone = false;
      let maxStall = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxStall = Math.max(maxStall, now - last);
        last = now;
      }, 5);
      const build = app
        .inject({ method: "POST", url: URL, payload: { idempotencyKey: "nonblocking-1" } })
        .finally(() => {
          buildDone = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const health = await app.inject({ method: "GET", url: "/api/health" });
      const healthAnsweredDuringBuild = !buildDone;
      const created = await build;
      clearInterval(ticker);

      expect(health.statusCode).toBe(200);
      expect(created.statusCode).toBe(201);
      expect(healthAnsweredDuringBuild).toBe(true);
      expect(maxStall).toBeLessThan(MAX_STALL_MS);
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("rejects a different key with 409 while a build is in progress, then builds it afterwards", async () => {
    const app = buildApp();
    try {
      const first = app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "inflight-a" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "inflight-b" } });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ code: "RPG_QUICK_ADVENTURE_IN_PROGRESS" });

      // The same key while in flight awaits the running build and replays it.
      const sameKey = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "inflight-a" } });
      const created = await first;
      expect(created.statusCode).toBe(201);
      expect(sameKey.statusCode).toBe(200);
      expect(sameKey.json()).toMatchObject({ campaignId: created.json().campaignId, replayed: true });

      const after = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "inflight-b" } });
      expect(after.statusCode).toBe(201);
      expect(after.json().campaignId).not.toBe(created.json().campaignId);
    } finally {
      await app.close();
      closeRepo();
    }
  });
});
