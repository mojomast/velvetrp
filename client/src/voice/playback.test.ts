import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoicePlayback } from "./playback";
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = ""; onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve()); pause = vi.fn(); load = vi.fn();
  constructor() { FakeAudio.instances.push(this); }
}
const reply = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const source = { kind: "adventure", id: "s" };
const line = (index: number, ready = true) => ({ index, text: `Line ${index}`, speakerId: "narrator", state: ready ? "ready" : "pending", ...(ready ? { audioUrl: `/api/campaigns/c/voice/jobs/j/audio/${index}` } : {}) });
beforeEach(() => { vi.useFakeTimers(); FakeAudio.instances = []; vi.stubGlobal("Audio", FakeAudio); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("waits for the first utterance despite later ready audio and pauses a buffering queue", async () => {
  let ready = false;
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: ready ? "ready" : "pending", segments: [line(1), line(0, ready)] })));
  const update = vi.fn(); const player = new VoicePlayback("c", update, 10);
  await player.play(source); expect(FakeAudio.instances[0]!.play).not.toHaveBeenCalled();
  player.pause(); ready = true; await vi.advanceTimersByTimeAsync(10);
  expect(FakeAudio.instances[0]!.play).not.toHaveBeenCalled();
  player.resume(); expect(FakeAudio.instances[0]!.src).toBe("/api/campaigns/c/voice/jobs/j/audio/0");
  FakeAudio.instances[0]!.onended?.(); expect(FakeAudio.instances[0]!.src).toBe("/api/campaigns/c/voice/jobs/j/audio/1");
  FakeAudio.instances[0]!.onended?.(); expect(update).toHaveBeenLastCalledWith({ state: "finished" }); player.stop();
});
it("starts the first ready WAV while the job is pending, then consumes only in utterance order", async () => {
  let firstReady = false;
  // Emulate the backend's one-lookahead contract: polling cannot unlock line 1;
  // browser playback of line 0 (a real browser GETs its src) must happen first.
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return reply({});
    const consumedFirst = FakeAudio.instances[0]?.play.mock.calls.length > 0;
    return reply({ id: "j", state: consumedFirst ? "ready" : "pending", segments: [line(0, firstReady), line(1, consumedFirst)] });
  });
  vi.stubGlobal("fetch", fetcher);
  const player = new VoicePlayback("c", vi.fn(), 10);
  await player.play(source);
  await vi.advanceTimersByTimeAsync(20);
  const audio = FakeAudio.instances[0]!;
  expect(audio.play).not.toHaveBeenCalled();
  firstReady = true;
  await vi.advanceTimersByTimeAsync(10);
  expect(audio.play).toHaveBeenCalledOnce();
  expect(audio.src).toBe(line(0).audioUrl);
  await vi.advanceTimersByTimeAsync(10);
  expect(audio.play).toHaveBeenCalledOnce();
  expect(audio.src).toBe(line(0).audioUrl);
  audio.onended?.();
  expect(audio.src).toBe(line(1).audioUrl);
  expect(audio.play).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c/voice/play", expect.objectContaining({ method: "POST", body: JSON.stringify(source) }));
  player.stop();
});

it("cancels a late creation response after stop and never starts its audio", async () => {
  let resolve!: (value: Response) => void;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => init?.method === "DELETE" ? reply({}) : new Promise<Response>(r => { resolve = r; }));
  vi.stubGlobal("fetch", fetcher); const player = new VoicePlayback("c", vi.fn());
  const pending = player.play(source); const audio = FakeAudio.instances[0]!; player.stop();
  resolve(new Response(JSON.stringify({ id: "j", state: "ready", segments: [line(0)] }))); await pending;
  expect(audio.play).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith("/api/campaigns/c/voice/jobs/j", expect.objectContaining({ method: "DELETE" }));
});
it("bounds polling and cancels synthesis without retrying a game action", async () => {
  const fetcher = vi.fn(() => reply({ id: "j", state: "pending", segments: [line(0, false)] })); vi.stubGlobal("fetch", fetcher);
  const update = vi.fn(); const player = new VoicePlayback("c", update, 10, 2); await player.play(source);
  await vi.advanceTimersByTimeAsync(50);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error", error: expect.stringContaining("timed out") }));
  expect(fetcher.mock.calls).toHaveLength(4);
});
it("does not play partially ready audio from a failed job", async () => {
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: "failed", error: "Synthesis failed", segments: [line(0)] })));
  const update = vi.fn(); const player = new VoicePlayback("c", update); await player.play(source);
  expect(FakeAudio.instances[0]!.play).not.toHaveBeenCalled();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
});
it("rejects audio outside the selected campaign", async () => {
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: "ready", segments: [{ ...line(0), audioUrl: "https://studio.invalid/private.wav" }] })));
  const player = new VoicePlayback("c", vi.fn()); await player.play(source);
  expect(FakeAudio.instances[0]!.play).not.toHaveBeenCalled();
});

it("reports a terminal job missing its audio instead of buffering forever", async () => {
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: "ready", segments: [line(0, false)] })));
  const update = vi.fn(); const player = new VoicePlayback("c", update); await player.play(source);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "error" }));
});
it("handles browser autoplay rejection with explicit resume, not synthesis retry", async () => {
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: "ready", segments: [line(0)] })));
  const update = vi.fn(); const player = new VoicePlayback("c", update);
  const pending = player.play(source);
  FakeAudio.instances[0]!.play.mockRejectedValueOnce(new Error("NotAllowedError"));
  await pending; await Promise.resolve();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ state: "paused", error: expect.stringContaining("Resume voice") }));
  player.resume(); expect(FakeAudio.instances[0]!.play).toHaveBeenCalledTimes(2); player.stop();
});

it.each(["pause", "resume", "stop", "source", "ended"])("ignores an obsolete play rejection after %s", async boundary => {
  vi.stubGlobal("fetch", vi.fn(() => reply({ id: "j", state: "ready", segments: [line(0)] })));
  const update = vi.fn(); const player = new VoicePlayback("c", update);
  let reject!: (error: Error) => void;
  const pending = player.play(source);
  const audio = FakeAudio.instances[0]!;
  audio.play.mockReturnValueOnce(new Promise<void>((_resolve, r) => { reject = r; }));
  await pending;
  if (boundary === "pause" || boundary === "resume") player.pause();
  if (boundary === "resume") player.resume();
  if (boundary === "stop") player.stop();
  if (boundary === "source") await player.play({ kind: "dm", id: "other" });
  if (boundary === "ended") audio.onended?.();
  const calls = update.mock.calls.length;
  reject(new DOMException("Interrupted", "AbortError")); await Promise.resolve();
  expect(update).toHaveBeenCalledTimes(calls);
  player.stop();
});

it("fetches audio status when a cached play response contains only caption metadata", async () => {
  const fetcher = vi.fn((_url: string, init?: RequestInit) => reply({ id: "j", state: "ready", segments: [line(0, init?.method !== "POST")] }));
  vi.stubGlobal("fetch", fetcher);
  const player = new VoicePlayback("c", vi.fn()); await player.play(source);
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeAudio.instances[0]!.play).toHaveBeenCalledOnce(); player.stop();
});
