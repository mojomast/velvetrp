import {
  imageGenerationRequestSchema,
  type ImageGenerationHealth,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from "@velvet/contracts";
import type { ImageGenerationClient } from "./imageGeneration.js";

/**
 * A deterministic, provider-free image client for unit tests and the future
 * deterministic E2E suite. It records every parsed request and never performs
 * I/O.
 */

/** A deterministic 1x1 transparent PNG. */
export const FAKE_IMAGE_GENERATION_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

export interface FakeImageGenerationOptions {
  /** When set, every generate call rejects with this error after being recorded. */
  failWith?: Error;
  /** When set, every health call rejects with this error. */
  healthFailWith?: Error;
  /** Reported health model; defaults to `fake-image`. */
  model?: string;
  /** Reported generation duration in seconds; defaults to zero. */
  seconds?: number;
}

export interface FakeImageGenerationClient extends ImageGenerationClient {
  /** Every parsed generate request, in call order. */
  calls: ImageGenerationRequest[];
  /** Number of health probes served (or attempted when failing). */
  readonly healthCalls: number;
}

/**
 * Builds the deterministic fake. Results mirror the request's seed and count so
 * callers can assert propagation; failures are recorded before they throw.
 */
export function createFakeImageGenerationClient(options: FakeImageGenerationOptions = {}): FakeImageGenerationClient {
  const calls: ImageGenerationRequest[] = [];
  let healthCalls = 0;
  return {
    calls,
    get healthCalls(): number {
      return healthCalls;
    },
    async health(): Promise<ImageGenerationHealth> {
      healthCalls += 1;
      if (options.healthFailWith) throw options.healthFailWith;
      return { status: "ok", model: options.model ?? "fake-image", commit: null, device: "cpu" };
    },
    async generate(request): Promise<ImageGenerationResult> {
      const parsed = imageGenerationRequestSchema.parse(request);
      calls.push(parsed);
      if (options.failWith) throw options.failWith;
      return {
        images: Array.from({ length: parsed.count }, () => ({ format: "png", base64: FAKE_IMAGE_GENERATION_PNG_BASE64 })),
        seed: parsed.seed,
        seconds: options.seconds ?? 0,
      };
    },
  };
}
