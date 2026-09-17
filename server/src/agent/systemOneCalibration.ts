/**
 * Probability calibration for System One confidence signals.
 *
 * The live model is systematically under-confident: on the frozen Director corpus it makes
 * correct composed decisions at raw probabilities around 0.6, which fails the promotion
 * gate's Brier/ECE bars even though decision accuracy is 100%. This module fits a monotonic
 * Platt map (a logistic transform of the logit) on a development split and applies it to a
 * held-out split, so a lane can report confidence that reflects measured reliability.
 *
 * The map is intentionally simple and monotonic so a low raw signal can never outrank a
 * high one after calibration. Parameters are fit by gradient descent on the regularized
 * log-loss; the regularization keeps the fit finite when a split has no errors (which would
 * otherwise drive the slope to infinity).
 */

/** A monotonic Platt map `sigmoid(a * logit(p) + b)`. */
export interface PlattCalibration {
  a: number;
  b: number;
}

/** One labeled observation: the raw confidence and whether the decision was correct. */
export interface CalibrationSample {
  predictedProbability: number;
  correct: boolean;
}

const PROBABILITY_EPSILON = 1e-6;
const DEFAULT_ITERATIONS = 2_000;
const DEFAULT_LEARNING_RATE = 0.1;
const DEFAULT_REGULARIZATION = 0.001;

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`predicted probability must be finite: ${value}`);
  return Math.min(1 - PROBABILITY_EPSILON, Math.max(PROBABILITY_EPSILON, value));
}

/** The log-odds of a probability clamped away from 0 and 1. */
export function logit(probability: number): number {
  const clamped = clampProbability(probability);
  return Math.log(clamped / (1 - clamped));
}

/** The logistic function, evaluated without overflow for large magnitudes. */
export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

/** Applies a fitted Platt map, preserving the raw signal's order. */
export function applyCalibration(probability: number, calibration: PlattCalibration): number {
  return sigmoid(calibration.a * logit(probability) + calibration.b);
}

export interface PlattFitOptions {
  /** Gradient-descent steps. Default 2,000. */
  iterations?: number;
  /** Gradient-descent step size. Default 0.1. */
  learningRate?: number;
  /** L2 penalty on the fitted parameters; keeps the slope finite when a split has no errors. Default 0.001. */
  regularization?: number;
}

function validateOptions(iterations: number, learningRate: number, regularization: number): void {
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError("iterations must be a positive integer");
  if (!Number.isFinite(learningRate) || learningRate <= 0) throw new RangeError("learningRate must be positive");
  if (!Number.isFinite(regularization) || regularization < 0) throw new RangeError("regularization must be non-negative");
}

/**
 * Fits a monotonic Platt calibration by minimizing the regularized log-loss.
 *
 * With no samples the identity map `{ a: 1, b: 0 }` is returned. A split with no errors
 * still yields a finite, steeper map because of the L2 penalty.
 */
export function fitPlattCalibration(
  samples: readonly CalibrationSample[],
  options: PlattFitOptions = {},
): PlattCalibration {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const learningRate = options.learningRate ?? DEFAULT_LEARNING_RATE;
  const regularization = options.regularization ?? DEFAULT_REGULARIZATION;
  validateOptions(iterations, learningRate, regularization);
  for (const sample of samples) clampProbability(sample.predictedProbability);
  if (samples.length === 0) return { a: 1, b: 0 };

  let a = 1;
  let b = 0;
  const count = samples.length;
  for (let step = 0; step < iterations; step += 1) {
    let gradientA = 0;
    let gradientB = 0;
    for (const sample of samples) {
      const x = logit(sample.predictedProbability);
      const predicted = sigmoid(a * x + b);
      const error = predicted - (sample.correct ? 1 : 0);
      gradientA += error * x;
      gradientB += error;
    }
    gradientA = gradientA / count + 2 * regularization * a;
    gradientB = gradientB / count + 2 * regularization * b;
    a -= learningRate * gradientA;
    b -= learningRate * gradientB;
  }
  return { a, b };
}
