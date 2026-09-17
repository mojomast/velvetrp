/** One lane evaluation at a candidate action threshold. */
export interface ThresholdSample {
  /** The candidate action threshold this sample was evaluated at. */
  threshold: number;
  /** Whether the lane actually acted at this threshold. */
  acted: boolean;
  /** Whether the acted decision was correct (ignored when `acted` is false). */
  correct: boolean;
  /** The composed signal, for reporting only. */
  predictedProbability: number;
}

/** Aggregated outcome of every sample sharing one candidate threshold. */
export interface ThresholdPoint {
  threshold: number;
  acted: number;
  total: number;
  coverage: number; // acted / total (0 when total 0)
  actedAccuracy: number; // correct-among-acted / acted (0 when acted 0)
}

export interface ThresholdSelectOptions {
  /** Candidate thresholds to report, sorted; defaults to the distinct sample thresholds. */
  thresholds?: readonly number[];
  /** Minimum acted accuracy required to accept a point. Default 0.9. */
  minAccuracy?: number;
  /** Minimum acted count required to accept a point. Default 20. */
  minActed?: number;
  /** When set, prefer the highest threshold that still reaches this coverage; otherwise maximize coverage. */
  targetCoverage?: number;
}

export interface ThresholdSelection {
  selected: ThresholdPoint | null;
  points: ThresholdPoint[];
  reasons: string[];
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateThresholdArgument(thresholds: readonly number[]): void {
  const seen = new Set<number>();
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold)) {
      throw new RangeError("threshold values must be finite numbers");
    }
    if (seen.has(threshold)) {
      throw new RangeError(`duplicate threshold ${threshold} in the thresholds argument`);
    }
    seen.add(threshold);
  }
}

function validateSamples(samples: readonly ThresholdSample[]): void {
  for (const sample of samples) {
    if (!Number.isFinite(sample.threshold)) {
      throw new RangeError("sample thresholds must be finite numbers");
    }
    if (!isProbability(sample.predictedProbability)) {
      throw new RangeError("predictedProbability must be a finite value between 0 and 1");
    }
  }
}

/**
 * Groups samples by their candidate threshold and reports acted counts,
 * coverage, and acted accuracy per group. When `thresholds` is supplied it
 * fixes the reported set and order; thresholds with no samples report zeros.
 */
export function aggregateThresholdSamples(
  samples: readonly ThresholdSample[],
  thresholds?: readonly number[],
): ThresholdPoint[] {
  if (thresholds) validateThresholdArgument(thresholds);
  validateSamples(samples);

  const distinct = [...new Set(samples.map((sample) => sample.threshold))].sort((a, b) => a - b);
  const order = thresholds ? [...thresholds] : distinct;

  const groups = new Map<number, { acted: number; total: number; correct: number }>();
  for (const threshold of order) {
    groups.set(threshold, { acted: 0, total: 0, correct: 0 });
  }

  for (const sample of samples) {
    let group = groups.get(sample.threshold);
    if (!group) {
      group = { acted: 0, total: 0, correct: 0 };
      groups.set(sample.threshold, group);
    }
    group.total += 1;
    if (sample.acted) {
      group.acted += 1;
      if (sample.correct) group.correct += 1;
    }
  }

  return order.map((threshold) => {
    const group = groups.get(threshold) ?? { acted: 0, total: 0, correct: 0 };
    return {
      threshold,
      acted: group.acted,
      total: group.total,
      coverage: group.total === 0 ? 0 : group.acted / group.total,
      actedAccuracy: group.acted === 0 ? 0 : group.correct / group.acted,
    };
  });
}

function validateOptions(minAccuracy: number, minActed: number, targetCoverage: number | undefined): void {
  if (!isProbability(minAccuracy)) {
    throw new RangeError("minAccuracy must be a finite value between 0 and 1");
  }
  if (!Number.isInteger(minActed) || minActed < 0) {
    throw new RangeError("minActed must be a non-negative integer");
  }
  if (targetCoverage !== undefined && !isProbability(targetCoverage)) {
    throw new RangeError("targetCoverage must be a finite value between 0 and 1");
  }
}

/** Picks the qualifying point with the greatest coverage, breaking ties toward the higher threshold. */
function greatestCoverage(points: readonly ThresholdPoint[]): ThresholdPoint {
  let best = points[0]!;
  for (const point of points) {
    if (point.coverage > best.coverage || (point.coverage === best.coverage && point.threshold > best.threshold)) {
      best = point;
    }
  }
  return best;
}

/**
 * Chooses an action threshold from labeled per-threshold samples.
 *
 * Only points meeting the acted-count and acted-accuracy floors are eligible.
 * Without `targetCoverage` the greatest-coverage eligible point wins (ties go
 * to the higher, more conservative threshold). With `targetCoverage`, the
 * highest eligible threshold that still reaches the coverage target wins;
 * when none reaches it, the greatest-coverage eligible point is used and the
 * fallback is recorded in `reasons`.
 */
export function selectActionThreshold(
  samples: readonly ThresholdSample[],
  options: ThresholdSelectOptions = {},
): ThresholdSelection {
  const minAccuracy = options.minAccuracy ?? 0.9;
  const minActed = options.minActed ?? 20;
  const targetCoverage = options.targetCoverage;
  validateOptions(minAccuracy, minActed, targetCoverage);

  const points = aggregateThresholdSamples(samples, options.thresholds);
  const reasons: string[] = [];
  const floors = `actedAccuracy >= ${minAccuracy} with at least ${minActed} acted decisions`;

  const qualifying = points.filter((point) => point.acted >= minActed && point.actedAccuracy >= minAccuracy);
  if (qualifying.length < points.length) {
    reasons.push(`filtered ${points.length - qualifying.length} of ${points.length} threshold(s) for failing ${floors}`);
  }

  if (qualifying.length === 0) {
    reasons.push(`no threshold reached ${floors}`);
    return { selected: null, points, reasons };
  }

  if (targetCoverage !== undefined) {
    const meetingTarget = qualifying.filter((point) => point.coverage >= targetCoverage);
    if (meetingTarget.length > 0) {
      const selected = meetingTarget.reduce((best, point) => (point.threshold > best.threshold ? point : best));
      reasons.push(
        `selected highest threshold ${selected.threshold} reaching coverage >= ${targetCoverage} while meeting ${floors}`,
      );
      return { selected, points, reasons };
    }
    reasons.push(`no qualifying threshold reached coverage >= ${targetCoverage}`);
    const selected = greatestCoverage(qualifying);
    reasons.push(`fell back to greatest-coverage qualifying threshold ${selected.threshold} (coverage ${selected.coverage})`);
    return { selected, points, reasons };
  }

  const selected = greatestCoverage(qualifying);
  reasons.push(`selected greatest-coverage threshold ${selected.threshold} (coverage ${selected.coverage}) meeting ${floors}`);
  return { selected, points, reasons };
}
