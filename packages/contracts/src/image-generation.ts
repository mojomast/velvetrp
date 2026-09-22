import { z } from "zod";

/**
 * Image-generation transport contracts.
 *
 * These shapes are provider-agnostic: the first adapter targets a self-hosted
 * Supra2-IMG wrapper, but storage, review, and UI only see this bounded
 * request/result pair. Every object is strict so a provider cannot smuggle
 * unbounded or executable fields through a successful parse.
 */

/** Largest accepted base64 payload per image, in encoded characters (16 MiB). */
export const IMAGE_GENERATION_MAX_BASE64_LENGTH = 16 * 1024 * 1024;
/** Largest accepted number of images per request or result. */
export const IMAGE_GENERATION_MAX_IMAGES = 4;
/** Largest accepted generation prompt, after trimming. */
export const IMAGE_GENERATION_MAX_PROMPT_LENGTH = 2_000;
/** Highest accepted seed; the provider script accepts signed 32-bit seeds. */
export const IMAGE_GENERATION_MAX_SEED = 2_147_483_647;
/** Default seed, matching the provider script's `--seed 0` example. */
export const IMAGE_GENERATION_DEFAULT_SEED = 0;
/** Default denoising steps, matching the provider script's `--steps 50` example. */
export const IMAGE_GENERATION_DEFAULT_STEPS = 50;
/** Default classifier-free guidance scale, matching the provider script's `--cfg 3.0` example. */
export const IMAGE_GENERATION_DEFAULT_GUIDANCE_SCALE = 3;

export const imageGenerationPromptSchema = z.string().trim().min(1).max(IMAGE_GENERATION_MAX_PROMPT_LENGTH);

export const imageGenerationRequestSchema = z.object({
  prompt: imageGenerationPromptSchema,
  seed: z.number().int().min(0).max(IMAGE_GENERATION_MAX_SEED).default(IMAGE_GENERATION_DEFAULT_SEED),
  steps: z.number().int().min(10).max(100).default(IMAGE_GENERATION_DEFAULT_STEPS),
  guidanceScale: z.number().min(1).max(8).default(IMAGE_GENERATION_DEFAULT_GUIDANCE_SCALE),
  count: z.number().int().min(1).max(IMAGE_GENERATION_MAX_IMAGES).default(1),
}).strict();

export const imageGenerationFormatSchema = z.enum(["png", "webp"]);

export const imageGenerationImageSchema = z.object({
  format: imageGenerationFormatSchema,
  base64: z.string().min(1).max(IMAGE_GENERATION_MAX_BASE64_LENGTH),
}).strict();

export const imageGenerationResultSchema = z.object({
  images: z.array(imageGenerationImageSchema).min(1).max(IMAGE_GENERATION_MAX_IMAGES),
  seed: z.number().int().min(0).max(IMAGE_GENERATION_MAX_SEED),
  seconds: z.number().min(0),
}).strict();

export const imageGenerationHealthSchema = z.object({
  status: z.literal("ok"),
  model: z.string().trim().min(1).max(200),
  commit: z.string().trim().min(1).max(200).nullable(),
  device: z.string().trim().min(1).max(200),
}).strict();

export const imageGenerationErrorSchema = z.object({
  error: z.string().trim().min(1).max(2_000),
}).strict();

/** Parsed generation request with every bound and default applied. */
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
/** Caller-supplied generation request; omitted fields take the declared defaults. */
export type ImageGenerationRequestInput = z.input<typeof imageGenerationRequestSchema>;
/** One generated image as an encoded payload. */
export type ImageGenerationImage = z.infer<typeof imageGenerationImageSchema>;
/** Parsed generation result. */
export type ImageGenerationResult = z.infer<typeof imageGenerationResultSchema>;
/** Provider health response. */
export type ImageGenerationHealth = z.infer<typeof imageGenerationHealthSchema>;
/** Provider error body. */
export type ImageGenerationErrorBody = z.infer<typeof imageGenerationErrorSchema>;
/** Accepted encoded image formats. */
export type ImageGenerationFormat = z.infer<typeof imageGenerationFormatSchema>;
