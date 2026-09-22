/** Best-effort advisory work only. Never submit a task capable of committing gameplay. */
export class SystemOneShadowQueue {
  private readonly tasks: Array<() => Promise<void>> = [];
  private running = 0;
  private dropped = 0;
  private failed = 0;

  get stats(): { running: number; queued: number; dropped: number; failed: number } {
    return { running: this.running, queued: this.tasks.length, dropped: this.dropped, failed: this.failed };
  }
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency = 4, private readonly capacity = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(capacity) || capacity < concurrency) {
      throw new Error("Invalid shadow queue limits");
    }
  }

  /** Overflow is dropped rather than delaying a player or growing memory without bound. */
  submit(task: () => Promise<unknown>): boolean {
    if (this.running + this.tasks.length >= this.capacity) {
      this.dropped += 1;
      return false;
    }
    this.tasks.push(async () => { await task(); });
    this.pump();
    return true;
  }

  /** Test/shutdown hook: wait for admitted work, including queued jobs. */
  async drain(): Promise<void> {
    if (this.running === 0 && this.tasks.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      this.running += 1;
      void Promise.resolve().then(task).catch(() => {
        this.failed += 1;
        // Advisory failures must not become unhandled rejections or gameplay failures.
      }).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.running === 0 && this.tasks.length === 0) {
          for (const resolve of this.waiters.splice(0)) resolve();
        }
      });
    }
  }
}

export const systemOneShadowQueue = new SystemOneShadowQueue();
