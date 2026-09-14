import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file runs in its own forked process, so the process-wide
    // VELVET_DATA_DIR and the module-level repo singleton stay isolated across
    // files. Concurrency is therefore safe (validated: the full suite passes
    // in parallel) and roughly halves wall-clock time on a 4-core machine.
    // Do NOT switch to the "threads" pool: threads share process.env and would
    // reintroduce the cross-file SQLite collisions this comment used to guard.
    fileParallelism: true,
    pool: "forks",
    // Generous per-test budget: under 4-core parallel contention each test file
    // creates a full SQLite schema, and a tight 20s budget produced occasional
    // timeout flakes.
    testTimeout: 40000,
    hookTimeout: 40000,
  },
});
