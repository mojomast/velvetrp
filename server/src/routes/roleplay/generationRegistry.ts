interface ActiveGeneration {
  generationId: string;
  controller: AbortController;
}

/**
 * Process-local coordination for every generation route. Session lifecycle
 * routes use this same registry so stop/delete operations abort streamed work.
 */
class GenerationRegistry {
  private readonly inFlight = new Set<string>();
  private readonly active = new Map<string, ActiveGeneration>();

  tryAcquire(sessionId: string): (() => void) | null {
    if (this.inFlight.has(sessionId)) return null;
    this.inFlight.add(sessionId);
    return () => {
      this.inFlight.delete(sessionId);
    };
  }

  setActive(sessionId: string, generation: ActiveGeneration): void {
    this.active.set(sessionId, generation);
  }

  getActive(sessionId: string): ActiveGeneration | undefined {
    return this.active.get(sessionId);
  }

  clearActive(sessionId: string): void {
    this.active.delete(sessionId);
  }

  abort(sessionId: string): void {
    this.active.get(sessionId)?.controller.abort();
  }
}

export const generationRegistry = new GenerationRegistry();
