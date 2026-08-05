import { describe, expect, it } from "vitest";
import { systemRuntime } from "../src/runtime.js";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../src/runtime.js";

describe("runtime dependencies", () => {
  it("supports deterministic clock, ID, and RNG implementations", () => {
    const clock: Clock = { now: () => new Date("2030-01-02T03:04:05.000Z") };
    const ids: IdGenerator = { nextId: () => "fixed-id" };
    const rng: RandomNumberGenerator = { integer: (minInclusive) => minInclusive };
    expect(clock.now().toISOString()).toBe("2030-01-02T03:04:05.000Z");
    expect(ids.nextId()).toBe("fixed-id");
    expect(rng.integer(3, 8)).toBe(3);
  });

  it("provides bounded production randomness", () => {
    for (let index = 0; index < 20; index += 1) {
      const value = systemRuntime.rng.integer(2, 5);
      expect(value).toBeGreaterThanOrEqual(2);
      expect(value).toBeLessThan(5);
    }
  });
});
