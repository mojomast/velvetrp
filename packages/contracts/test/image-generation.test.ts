import { describe, expect, it } from "vitest";
import {
  IMAGE_GENERATION_MAX_BASE64_LENGTH,
  imageGenerationErrorSchema,
  imageGenerationHealthSchema,
  imageGenerationImageSchema,
  imageGenerationRequestSchema,
  imageGenerationResultSchema,
} from "../src/index.js";

describe("image generation contracts", () => {
  it("applies request defaults and trims the prompt", () => {
    expect(imageGenerationRequestSchema.parse({ prompt: "  a lighthouse  " })).toEqual({
      prompt: "a lighthouse", seed: 0, steps: 50, guidanceScale: 3, count: 1,
    });
  });

  it("bounds the prompt, seed, steps, guidance scale, and count", () => {
    expect(imageGenerationRequestSchema.safeParse({ prompt: "   " }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x".repeat(2_001) }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", seed: -1 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", seed: 2_147_483_648 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", seed: 1.5 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", steps: 9 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", steps: 101 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", guidanceScale: 0.99 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", guidanceScale: 8.01 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", count: 0 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", count: 5 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({
      prompt: "x", seed: 2_147_483_647, steps: 10, guidanceScale: 8, count: 4,
    }).success).toBe(true);
  });

  it("rejects unknown request fields instead of forwarding them", () => {
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", width: 256, height: 256 }).success).toBe(false);
    expect(imageGenerationRequestSchema.safeParse({ prompt: "x", executeCommand: "run" }).success).toBe(false);
  });

  it("bounds result images, formats, seed, and seconds", () => {
    const image = { format: "png", base64: "aGVsbG8=" };
    const result = { images: [image], seed: 0, seconds: 0 };
    expect(imageGenerationResultSchema.parse(result)).toEqual(result);
    expect(imageGenerationResultSchema.safeParse({ ...result, images: [] }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, images: Array.from({ length: 5 }, () => image) }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, images: [{ format: "gif", base64: "x" }] }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, images: [{ format: "webp", base64: "" }] }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({
      ...result, images: [{ format: "webp", base64: "a".repeat(IMAGE_GENERATION_MAX_BASE64_LENGTH + 1) }],
    }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, seconds: -0.1 }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, seconds: Number.NaN }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, seed: -1 }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({ ...result, model: "smuggled" }).success).toBe(false);
    expect(imageGenerationResultSchema.safeParse({
      images: Array.from({ length: 4 }, () => image), seed: 2_147_483_647, seconds: 1.5,
    }).success).toBe(true);
  });

  it("keeps health strict and nullable-commit aware", () => {
    expect(imageGenerationHealthSchema.parse({ status: "ok", model: "supra2-img", commit: null, device: "cuda:0" }))
      .toEqual({ status: "ok", model: "supra2-img", commit: null, device: "cuda:0" });
    expect(imageGenerationHealthSchema.safeParse({ status: "degraded", model: "m", commit: null, device: "cpu" }).success).toBe(false);
    expect(imageGenerationHealthSchema.safeParse({ status: "ok", model: "m", device: "cpu" }).success).toBe(false);
    expect(imageGenerationHealthSchema.safeParse({ status: "ok", model: "m", commit: null, device: "cpu", extra: 1 }).success).toBe(false);
    expect(imageGenerationHealthSchema.safeParse({ status: "ok", model: "", commit: null, device: "cpu" }).success).toBe(false);
    expect(imageGenerationHealthSchema.safeParse({ status: "ok", model: "m", commit: "abc123", device: "cpu" }).success).toBe(true);
  });

  it("bounds provider error bodies", () => {
    expect(imageGenerationErrorSchema.parse({ error: "model not loaded" })).toEqual({ error: "model not loaded" });
    expect(imageGenerationErrorSchema.safeParse({ error: "" }).success).toBe(false);
    expect(imageGenerationErrorSchema.safeParse({ error: "x".repeat(2_001) }).success).toBe(false);
    expect(imageGenerationErrorSchema.safeParse({ error: "x", detail: "extra" }).success).toBe(false);
  });

  it("keeps the single-image shape strict", () => {
    expect(imageGenerationImageSchema.safeParse({ format: "png", base64: "x", bytes: 1 }).success).toBe(false);
  });
});
