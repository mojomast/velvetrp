import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { registerClientApp } from "../src/static.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function clientDist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "velvet-client-dist-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>velvet-test-index</body></html>");
  writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log('velvet-test-asset');");
  return dir;
}

describe("serving the built client", () => {
  it("serves index.html, hashed assets and SPA routes while the API keeps working", async () => {
    const app = buildApp();
    try {
      expect(await registerClientApp(app, { clientDist: clientDist() })).toBe(true);
      const root = await app.inject({ method: "GET", url: "/" });
      expect(root.statusCode).toBe(200);
      expect(root.headers["content-type"]).toMatch(/text\/html/);
      expect(root.body).toContain("velvet-test-index");

      const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toMatch(/javascript/);
      expect(asset.body).toContain("velvet-test-asset");

      const deepLink = await app.inject({ method: "GET", url: "/campaigns/some-campaign/play" });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.headers["content-type"]).toMatch(/text\/html/);
      expect(deepLink.body).toContain("velvet-test-index");
      expect(deepLink.headers["cache-control"]).toMatch(/no-cache|no-store/);

      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ ok: true });

      const missingApi = await app.inject({ method: "GET", url: "/api/definitely-not-a-route" });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.body).not.toContain("velvet-test-index");

      const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.body).not.toContain("velvet-test-index");

      const post = await app.inject({ method: "POST", url: "/campaigns/x", headers: { "content-type": "application/json" }, payload: "{}" });
      expect(post.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("stays API-only when there is no built client", async () => {
    const app = buildApp();
    try {
      const empty = mkdtempSync(path.join(tmpdir(), "velvet-client-none-"));
      dirs.push(empty);
      expect(await registerClientApp(app, { clientDist: empty })).toBe(false);
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
