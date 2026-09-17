/**
 * Confidence-bound statistics for the System One promotion gate.
 *
 * A gate v2 criterion (see `docs/system-one-harvest-loop.md`, "Promotion gate v2") gates on the
 * lower bound of the evidence, not on the point estimate: a point estimate over tens of acted
 * samples cannot tell a 0.95 lane from a 1.00 lane, because a lane that has merely never been
 * wrong also scores 1.00. Requiring the lower bound of the interval the evidence supports to
 * clear the bar means "never observed wrong" is no longer by itself sufficient to promote.
 *
 * This module is pure and deterministic. `wilsonLowerBound` is closed-form;
 * `bootstrapAccuracyLowerBound` seeds an inline mulberry32 PRNG from its options and never calls
 * `Math.random`, so the same outcomes and options always produce the same bound and a gate
 * decision is reproducible from its inputs.
 */

/** Default z for a 95% two-sided normal interval (the 97.5th percentile of the standard normal). */
const WILSON_DEFAULT_Z = 1.959963984540054;

const BOOTSTRAP_DEFAULT_ITERATIONS = 2000;
const BOOTSTRAP_DEFAULT_CONFIDENCE = 0.95;
const BOOTSTRAP_DEFAULT_SEED = 0x9e3779b9; // golden-ratio fractional part, an arbitrary fixed seed

/** Options for `bootstrapAccuracyLowerBound`; every field has a deterministic default. */
export interface BootstrapAccuracyOptions {
  /** Number of resamples; a positive integer. Defaults to 2000. */
  iterations?: number;
  /** Interval confidence in (0, 1). Defaults to 0.95. */
  confidence?: number;
  /** PRNG seed; truncated to a 32-bit unsigned integer. Defaults to a fixed constant. */
  seed?: number;
}

function validateSuccessesAndSamples(successes: number, samples: number): void {
  if (!Number.isFinite(successes) || successes < 0) {
    throw new RangeError(`wilson successes must be a finite non-negative number: ${successes}`);
  }
  if (!Number.isFinite(samples) || samples <= 0) {
    throw new RangeError(`wilson samples must be a finite positive number: ${samples}`);
  }
  if (successes > samples) {
    throw new RangeError(`wilson successes must not exceed samples: ${successes} > ${samples}`);
  }
}

/**
 * The lower bound of the Wilson score interval for a binomial proportion.
 *
 * `successes / samples` is the point estimate; this returns the lower end of its 95% (by
 * default) score interval, clamped to [0, 1] so floating-point noise cannot leave the range.
 * The interval is the standard one (no continuity correction), so `wilsonLowerBound(9, 10)`
 * is about 0.596 while the point estimate is 0.9: the evidence supports much less than 0.9
 * until the sample grows.
 *
 * @throws RangeError when `successes` is not a finite number in `[0, samples]`, `samples` is
 * not finite and positive, or `z` is not finite and positive.
 */
export function wilsonLowerBound(successes: number, samples: number, z = WILSON_DEFAULT_Z): number {
  validateSuccessesAndSamples(successes, samples);
  if (!Number.isFinite(z) || z <= 0) {
    throw new RangeError(`wilson z must be a finite positive number: ${z}`);
  }
  const proportion = successes / samples;
  const denominator = 1 + (z * z) / samples;
  const center = (proportion + (z * z) / (2 * samples)) / denominator;
  const halfWidth =
    (z * Math.sqrt((proportion * (1 - proportion)) / samples + (z * z) / (4 * samples * samples))) /
    denominator;
  return Math.min(1, Math.max(0, center - halfWidth));
}

/** A small, deterministic mulberry32 PRNG; `Math.random` is never used. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The percentile lower bound of a nonparametric bootstrap over per-sample accuracies.
 *
 * Each iteration resamples `outcomes.length` booleans with replacement and records the
 * resampled accuracy; the bound is the `floor((1 - confidence) * iterations)`-th smallest of
 * those accuracies (the nearest-rank percentile). The result is always within [0, 1] and never
 * exceeds the point estimate. Because the PRNG is seeded, repeated calls are reproducible.
 *
 * @throws RangeError when `outcomes` is empty, `iterations` is not a positive integer,
 * `confidence` is not within `(0, 1)`, or `seed` is not finite.
 */
export function bootstrapAccuracyLowerBound(
  outcomes: readonly boolean[],
  options: BootstrapAccuracyOptions = {},
): number {
  const iterations = options.iterations ?? BOOTSTRAP_DEFAULT_ITERATIONS;
  const confidence = options.confidence ?? BOOTSTRAP_DEFAULT_CONFIDENCE;
  const seed = options.seed ?? BOOTSTRAP_DEFAULT_SEED;
  if (outcomes.length === 0) {
    throw new RangeError("bootstrap accuracy lower bound requires at least one outcome");
  }
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new RangeError(`bootstrap iterations must be a positive integer: ${iterations}`);
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError(`bootstrap confidence must be within (0, 1): ${confidence}`);
  }
  if (!Number.isFinite(seed)) {
    throw new RangeError(`bootstrap seed must be a finite number: ${seed}`);
  }
  const random = mulberry32(seed);
  const samples = outcomes.length;
  const resampled = new Float64Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let successes = 0;
    for (let draw = 0; draw < samples; draw += 1) {
      if (outcomes[Math.floor(random() * samples)]) successes += 1;
    }
    resampled[iteration] = successes / samples;
  }
  resampled.sort();
  const index = Math.min(iterations - 1, Math.floor((1 - confidence) * iterations));
  return resampled[index]!;
}
