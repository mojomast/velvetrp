import { configDefaults, defineConfig } from "vitest/config";

/**
 * Fast iteration lane. Runs the same suite as `vitest run` minus the heaviest
 * end-to-end acceptance files, which are still covered by `npm test` and CI.
 * Use this while iterating; run the full suite at wave boundaries / pre-merge.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    fileParallelism: true,
    pool: "forks",
    testTimeout: 90000,
    hookTimeout: 90000,
    exclude: [
      ...configDefaults.exclude,
      "**/reviewed-adventure-*.test.ts",
      "**/api-stream.test.ts",
      "**/rpg-*-route.test.ts",
      "**/campaign-room-activation.test.ts",
      "**/roll-actor-dice-command.test.ts",
    ],
  },
});
