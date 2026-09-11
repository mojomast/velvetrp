import assert from "node:assert/strict";
import test from "node:test";
import { runLiveDirectorPlaytest } from "../live-director-playtest.js";

// Opt-in: this test spends real provider calls and is skipped by default so CI stays provider-free.
const live = process.env.LIVE_DIRECTOR_PLAYTEST === "1";

test("live director playtest completes every beat without objective failures", {
  skip: live ? false : "set LIVE_DIRECTOR_PLAYTEST=1 to run against the live provider",
  timeout: 1_800_000,
}, async () => {
  const beats = Number(process.env.LIVE_DIRECTOR_BEATS ?? 8);
  const mode = process.env.LIVE_DIRECTOR_MODE === "human" ? "human" as const : "ai" as const;
  const { artifact } = await runLiveDirectorPlaytest({ seed: Number(process.env.LIVE_DIRECTOR_SEED ?? 9001), beats, mode,
    maxCalls: 60, maxTokens: 300_000, maxUsd: 1 });
  assert.equal(artifact.capHit, null, `provider cap hit: ${artifact.capHit}`);
  assert.equal(artifact.failures.length, 0, artifact.failures.join(", "));
  assert.equal(artifact.beats.length, beats, "every requested beat should run");
  assert.ok(artifact.beats.every(beat => beat.state === "completed"), "every beat should complete");
  assert.ok(artifact.beats.every(beat => beat.narration), "every beat should carry narration");
});
