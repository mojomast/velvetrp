import { defineConfig } from "@playwright/test";
// Isolated UI + tests that start their own ephemeral HTTP application servers.
export default defineConfig({
  testDir: "./e2e/tests", testMatch: "reviewed-adventure.spec.ts", workers: 1, reporter: "line",
  use: { baseURL: "http://127.0.0.1:19789", trace: "retain-on-failure" },
  webServer: { command: "npm --prefix client run dev -- --host 127.0.0.1 --port 19789", url: "http://127.0.0.1:19789", reuseExistingServer: false },
});
