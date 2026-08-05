import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  testMatch: "**/live.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  timeout: 120_000,
});
