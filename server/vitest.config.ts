import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests set process-wide VELVET_DATA_DIR; concurrent files would overwrite
    // one another's SQLite directory and make historical migrations flaky.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
