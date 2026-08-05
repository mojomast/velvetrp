import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  testIgnore: "**/live.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:18789",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/support/fake-provider.mjs",
      url: "http://127.0.0.1:18788/health",
      reuseExistingServer: false,
    },
    {
      command: "node e2e/support/start-deterministic-server.mjs",
      url: "http://127.0.0.1:18787/api/health",
      reuseExistingServer: false,
    },
    {
      command: "VELVET_API_URL=http://127.0.0.1:18787 npm --prefix client run dev -- --host 127.0.0.1 --port 18789",
      url: "http://127.0.0.1:18789",
      reuseExistingServer: false,
    },
  ],
});
