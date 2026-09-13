export type VoiceSegment = { index: number; text: string; speakerId: string; state?: string; audioUrl?: string };
export type VoiceJob = { id: string; state: string; segments: VoiceSegment[]; error?: string };
export type PlaybackView = { state: "idle" | "buffering" | "playing" | "paused" | "finished" | "error"; caption?: VoiceSegment; error?: string };
export const voiceBase = (id: string) => `/api/campaigns/${encodeURIComponent(id)}/voice`;

/** Only Velvet's scoped presentation endpoints are called; never a game command. */
export async function voiceRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) abort();
  const timer = setTimeout(abort, 20_000);
  try {
    const response = await fetch(url, { ...init, signal: timeout.signal });
    if (!response.ok) throw new Error(`Voice unavailable (${response.status}). Text and gameplay are unaffected.`);
    return response.status === 204 ? undefined as T : await response.json() as T;
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}

/** One explicit listening queue, progressive short WAV utterances (not token realtime). */
export class VoicePlayback {
  private generation = 0;
  private playAttempt = 0;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private audio?: HTMLAudioElement;
  private job?: VoiceJob;
  private cursor = 0;
  private paused = false;
  private playing = false;
  private polls = 0;
  constructor(private readonly campaignId: string, private readonly update: (view: PlaybackView) => void,
    private readonly pollMs = 1000, private readonly maxPolls = 600) {}
  private cancel(id: string) {
    void voiceRequest(`${voiceBase(this.campaignId)}/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
  stop() {
    this.generation++; this.playAttempt++; this.abort?.abort(); clearTimeout(this.timer);
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio.src = ""; this.audio.load(); }
    if (this.job) this.cancel(this.job.id);
    this.audio = undefined; this.job = undefined; this.playing = false; this.paused = false;
    this.update({ state: "idle" });
  }
  async play(source: { kind: string; id: string }) {
    this.stop(); const generation = this.generation; this.abort = new AbortController(); this.cursor = 0; this.polls = 0;
    this.audio = new Audio(); this.update({ state: "buffering" });
    try {
      // Do not abort creation: a late returned ID must still be cancelled server-side.
      const job = await voiceRequest<VoiceJob>(`${voiceBase(this.campaignId)}/play`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(source),
      });
      if (generation !== this.generation) { this.cancel(job.id); return; }
      this.job = job;
      // The creation contract carries captions only, even for a cached ready job.
      if (["ready", "completed"].includes(job.state) && job.segments.some(segment => !segment.audioUrl)) {
        await this.poll(generation);
      } else { this.advance(generation); this.schedule(generation); }
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  pause() { this.playAttempt++; this.paused = true; this.audio?.pause(); this.update({ state: "paused", caption: this.current() }); }
  resume() {
    this.paused = false;
    if (this.playing && this.audio) this.startAudio(this.generation);
    else this.advance(this.generation);
  }
  private current() { return this.job?.segments.find(segment => segment.index === this.cursor); }
  private fail(error: unknown) {
    const message = error instanceof Error ? error.message : "Voice unavailable. Text is still available.";
    this.stop(); this.update({ state: "error", error: message });
  }
  private startAudio(generation: number) {
    const attempt = ++this.playAttempt;
    this.update({ state: "playing", caption: this.current() });
    void this.audio!.play().catch(() => {
      if (generation !== this.generation || attempt !== this.playAttempt) return;
      this.paused = true;
      this.update({ state: "paused", caption: this.current(), error: "Browser blocked audio. Select Resume voice to listen." });
    });
  }
  private advance(generation: number) {
    if (generation !== this.generation || !this.job || this.playing || this.paused) return;
    if (["failed", "cancelled"].includes(this.job.state)) { this.fail(new Error(this.job.error || "Voice unavailable. Text is still available.")); return; }
    const segment = this.current();
    if (!segment) {
      if (this.cursor >= this.job.segments.length && ["ready", "completed"].includes(this.job.state)) this.update({ state: "finished" });
      return;
    }
    if (!segment.audioUrl) {
      if (["ready", "completed"].includes(this.job.state)) this.fail(new Error("Voice audio is missing. Text is still available."));
      else this.update({ state: "buffering", caption: segment });
      return;
    }
    // Never navigate to a provider-supplied or cross-campaign audio endpoint.
    if (!segment.audioUrl.startsWith(`${voiceBase(this.campaignId)}/`) || segment.audioUrl.includes("..") || /[\\?#%]/.test(segment.audioUrl)) {
      this.fail(new Error("Invalid campaign voice audio URL.")); return;
    }
    this.playing = true; this.audio!.src = segment.audioUrl;
    this.audio!.onended = () => {
      if (generation !== this.generation) return;
      this.playAttempt++; this.playing = false; this.cursor++; this.advance(generation);
    };
    this.audio!.onerror = () => { if (generation === this.generation) this.fail(new Error("Voice audio could not be decoded. Text is still available.")); };
    this.startAudio(generation);
  }
  private schedule(generation: number) {
    if (generation !== this.generation || !this.job) return;
    if (["failed", "cancelled"].includes(this.job.state)) { this.fail(new Error(this.job.error || "Voice unavailable. Text is still available.")); return; }
    if (["ready", "completed"].includes(this.job.state)) return;
    if (++this.polls > this.maxPolls) { this.fail(new Error("Voice timed out. Replay voice to try again; text is ready.")); return; }
    this.timer = setTimeout(() => { void this.poll(generation); }, this.pollMs);
  }
  private async poll(generation: number) {
    try {
      const job = await voiceRequest<VoiceJob>(`${voiceBase(this.campaignId)}/jobs/${encodeURIComponent(this.job!.id)}`, { signal: this.abort!.signal });
      if (generation !== this.generation) return;
      this.job = job; this.advance(generation); this.schedule(generation);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
}
