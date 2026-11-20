// Approved test (playtest kink #6, follow-up): the Quick adventure build runs in a worker thread with
// its own database connection, so the main event loop stays responsive even during the one-time
// starter catalog install (a single ~1s synchronous database call that cannot yield). A build error
// raised inside the worker must still surface as the documented problem response.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const URL = "/api/rpg/v1/quick-adventures";
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
const FAIL_STEP_ENV = "VELVET_QUICK_ADVENTURE_FAIL_AT_STEP";
/**
 * Off-main-thread bound. With the build on the main thread the first build stalls the loop for
 * ~1.0-1.5s locally (starter catalog install); with the build in a worker only spawn and message
 * handling run here, which stay far below this bound even on a loaded CI runner.
 */
const OFF_THREAD_MAX_STALL_MS = 600;

beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
  delete process.env[FAIL_STEP_ENV];
});

describe("Quick adventure build runs off the main thread", () => {
  it("keeps the main event loop nearly stall-free during a first build and the result is readable here", async () => {
    const app = buildApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
      // Warm the campaign repository outside the measured window: the first RPG request opens and
      // schema-validates it on the main thread (~250-450ms locally), which is not build work.
      expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" })).statusCode).toBe(200);

      let maxStall = 0;
      let last = performance.now();
      const ticker = setInterval(() => {
        const now = performance.now();
        maxStall = Math.max(maxStall, now - last);
        last = now;
      }, 5);
      const created = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "worker-1" } });
      clearInterval(ticker);

      expect(created.statusCode).toBe(201);
      const body = created.json();
      expect(body).toMatchObject({ replayed: false });
      expect(maxStall).toBeLessThan(OFF_THREAD_MAX_STALL_MS);

      // The worker wrote through its own connection; the main-thread repository must see the result.
      const bootstrap = await app.inject({
        method: "GET",
        url: `/api/rpg/v1/campaigns/${body.campaignId}/rooms/${body.sessionId}/play-bootstrap`,
      });
      expect(bootstrap.statusCode).toBe(200);

      const replay = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "worker-1" } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ campaignId: body.campaignId, replayed: true });
    } finally {
      await app.close();
      closeRepo();
    }
  }, 120_000);

  it("surfaces a build error raised inside the worker as a step-named problem and recovers", async () => {
    const app = buildApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

      // Test-only fault injection (honoured only when NODE_ENV=test): fail inside the party step.
      process.env[FAIL_STEP_ENV] = "party";
      const failed = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "worker-fail" } });
      expect(failed.statusCode).toBe(500);
      expect(failed.headers["content-type"]).toMatch(/application\/problem\+json/);
      const problem = failed.json();
      expect(problem.code).toBe("RPG_QUICK_ADVENTURE_FAILED");
      expect(problem.detail).toMatch(/^Quick adventure failed at step party: /);
      expect(problem.detail).toContain("injected failure");

      // The failure is not cached and does not leave a build marked in progress.
      delete process.env[FAIL_STEP_ENV];
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      const retried = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "worker-fail" } });
      expect(retried.statusCode).toBe(201);
      expect(retried.json()).toMatchObject({ replayed: false });
    } finally {
      await app.close();
      closeRepo();
    }
  }, 120_000);
});
