import { describe, expect, it } from "vitest";
import { SystemOneShadowQueue } from "../src/agent/systemOneShadow.js";

describe("bounded advisory queue", () => {
  it("returns without waiting, caps concurrency and drops overflow", async () => {
    const queue = new SystemOneShadowQueue(1, 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    expect(queue.submit(async () => { seen.push("first"); await gate; })).toBe(true);
    expect(queue.submit(async () => { seen.push("second"); })).toBe(true);
    expect(queue.submit(async () => { seen.push("overflow"); })).toBe(false);
    await Promise.resolve();
    expect(seen).toEqual(["first"]);
    release();
    await queue.drain();
    expect(seen).toEqual(["first", "second"]);
    expect(queue.stats).toEqual({ running: 0, queued: 0, dropped: 1, failed: 0 });
  });

  it("isolates synchronous and asynchronous failure and reuses capacity", async () => {
    const queue = new SystemOneShadowQueue(1, 2);
    queue.submit(() => { throw new Error("sync"); });
    queue.submit(async () => { throw new Error("async"); });
    await queue.drain();
    let ran = false;
    expect(queue.submit(async () => { ran = true; })).toBe(true);
    await queue.drain();
    expect(ran).toBe(true);
    expect(queue.stats).toEqual({ running: 0, queued: 0, dropped: 0, failed: 2 });
  });
});
