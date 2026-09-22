export interface SystemOneBudgetPolicy {
  maxTotalTokens: number;
  maxEstimatedCostUsd: number | null;
  maxRequestsPerWindow: number;
  rateWindowMs: number;
}

export interface SystemOneBudgetPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface SystemOneBudgetReservationRequest {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  pricing: SystemOneBudgetPricing;
  nowMs: number;
}

export type SystemOneBudgetDenialReason = "rate-limit" | "token-budget" | "dollar-budget";

export type SystemOneBudgetDecision = { allowed: true; reservationId: number } | { allowed: false; reason: SystemOneBudgetDenialReason };

export interface SystemOneBudgetSnapshot {
  reservedInputTokens: number;
  reservedOutputTokens: number;
  settledInputTokens: number;
  settledOutputTokens: number;
  costUsd: number;
  requestStartsMs: readonly number[];
}

interface SystemOneBudgetReservation {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  pricing: SystemOneBudgetPricing;
}

interface SystemOneLaneState {
  reservedInputTokens: number;
  reservedOutputTokens: number;
  settledInputTokens: number;
  settledOutputTokens: number;
  costUsd: number;
  requestStartsMs: number[];
  reservations: Map<number, SystemOneBudgetReservation>;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function createLaneState(): SystemOneLaneState {
  return {
    reservedInputTokens: 0,
    reservedOutputTokens: 0,
    settledInputTokens: 0,
    settledOutputTokens: 0,
    costUsd: 0,
    requestStartsMs: [],
    reservations: new Map(),
  };
}

function validatePolicy(policy: SystemOneBudgetPolicy): void {
  if (
    !Number.isFinite(policy.maxTotalTokens)
    || !Number.isFinite(policy.maxRequestsPerWindow)
    || !Number.isFinite(policy.rateWindowMs)
    || !positiveSafeInteger(policy.maxTotalTokens)
    || !positiveSafeInteger(policy.maxRequestsPerWindow)
    || !(policy.rateWindowMs > 0)
  ) {
    throw new RangeError("system one budget limits must be positive finite values and request counts must be positive safe integers");
  }
  if (policy.maxEstimatedCostUsd !== null && !finiteNonNegative(policy.maxEstimatedCostUsd)) {
    throw new RangeError("maxEstimatedCostUsd must be null or a non-negative finite number");
  }
}

function validateReservation(request: SystemOneBudgetReservationRequest): void {
  if (
    !Number.isFinite(request.estimatedInputTokens)
    || !Number.isFinite(request.maxOutputTokens)
    || !nonNegativeSafeInteger(request.estimatedInputTokens)
    || !nonNegativeSafeInteger(request.maxOutputTokens)
  ) {
    throw new RangeError("token estimates must be non-negative safe integers");
  }
  const { pricing } = request;
  if (
    !pricing
    || !Number.isFinite(pricing.inputPerMillionUsd)
    || !Number.isFinite(pricing.outputPerMillionUsd)
    || pricing.inputPerMillionUsd < 0
    || pricing.outputPerMillionUsd < 0
  ) {
    throw new RangeError("token pricing must be non-negative finite numbers");
  }
  if (!Number.isFinite(request.nowMs)) {
    throw new RangeError("nowMs must be a finite number");
  }
}

function projectCostUsd(inputTokens: number, outputTokens: number, pricing: SystemOneBudgetPricing): number {
  return (inputTokens * pricing.inputPerMillionUsd + outputTokens * pricing.outputPerMillionUsd) / 1_000_000;
}

/** Process-local, lane-scoped budget accounting for the System One (Jev) lane. */
export class SystemOneLaneBudgetManager {
  private readonly lanes = new Map<string, SystemOneLaneState>();
  private nextReservationId = 1;

  reserve(lane: string, policy: SystemOneBudgetPolicy, request: SystemOneBudgetReservationRequest): SystemOneBudgetDecision {
    validatePolicy(policy);
    validateReservation(request);
    const state = this.lanes.get(lane) ?? createLaneState();
    const windowStart = request.nowMs - policy.rateWindowMs;
    const recentStarts = state.requestStartsMs.filter((startedAt) => startedAt > windowStart);
    if (recentStarts.length >= policy.maxRequestsPerWindow) {
      return { allowed: false, reason: "rate-limit" };
    }
    const projectedCostUsd = projectCostUsd(request.estimatedInputTokens, request.maxOutputTokens, request.pricing);
    if (
      state.settledInputTokens
        + state.settledOutputTokens
        + state.reservedInputTokens
        + state.reservedOutputTokens
        + request.estimatedInputTokens
        + request.maxOutputTokens
      > policy.maxTotalTokens
    ) {
      return { allowed: false, reason: "token-budget" };
    }
    const reservedCostUsd = [...state.reservations.values()].reduce((sum, reservation) =>
      sum + projectCostUsd(reservation.estimatedInputTokens, reservation.maxOutputTokens, reservation.pricing), 0);
    if (policy.maxEstimatedCostUsd !== null && state.costUsd + reservedCostUsd + projectedCostUsd > policy.maxEstimatedCostUsd) {
      return { allowed: false, reason: "dollar-budget" };
    }
    state.reservedInputTokens += request.estimatedInputTokens;
    state.reservedOutputTokens += request.maxOutputTokens;
    state.requestStartsMs = [...recentStarts, request.nowMs];
    const reservationId = this.nextReservationId++;
    state.reservations.set(reservationId, {
      estimatedInputTokens: request.estimatedInputTokens,
      maxOutputTokens: request.maxOutputTokens,
      pricing: { ...request.pricing },
    });
    this.lanes.set(lane, state);
    return { allowed: true, reservationId };
  }

  settle(lane: string, usage: { inputTokens: number; outputTokens: number }, reservationId?: number): void {
    if (!nonNegativeSafeInteger(usage.inputTokens) || !nonNegativeSafeInteger(usage.outputTokens)) {
      throw new RangeError("usage token counts must be non-negative safe integers");
    }
    const state = this.lanes.get(lane);
    const id = this.resolveReservationId(state, reservationId);
    const reservation = id === undefined ? undefined : state?.reservations.get(id);
    if (!state || !reservation || id === undefined) {
      throw new Error(`no outstanding system one budget reservation for lane: ${lane}`);
    }
    state.reservedInputTokens -= reservation.estimatedInputTokens;
    state.reservedOutputTokens -= reservation.maxOutputTokens;
    state.settledInputTokens += usage.inputTokens;
    state.settledOutputTokens += usage.outputTokens;
    state.costUsd += projectCostUsd(usage.inputTokens, usage.outputTokens, reservation.pricing);
    state.reservations.delete(id);
  }

  release(lane: string, reservationId?: number): void {
    const state = this.lanes.get(lane);
    const id = this.resolveReservationId(state, reservationId);
    const reservation = id === undefined ? undefined : state?.reservations.get(id);
    if (!state || !reservation || id === undefined) return;
    state.reservedInputTokens -= reservation.estimatedInputTokens;
    state.reservedOutputTokens -= reservation.maxOutputTokens;
    state.reservations.delete(id);
  }

  // Single-request callers remain supported; ambiguous settlement fails closed.
  private resolveReservationId(state: SystemOneLaneState | undefined, id?: number): number | undefined {
    if (id !== undefined) return id;
    if (state && state.reservations.size > 1) {
      throw new Error("reservationId is required for concurrent system one budget reservations");
    }
    return state?.reservations.keys().next().value;
  }

  reset(lane?: string): void {
    if (lane === undefined) this.lanes.clear();
    else this.lanes.delete(lane);
  }

  snapshot(lane: string): SystemOneBudgetSnapshot {
    const state = this.lanes.get(lane);
    if (!state) {
      return {
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        settledInputTokens: 0,
        settledOutputTokens: 0,
        costUsd: 0,
        requestStartsMs: [],
      };
    }
    return {
      reservedInputTokens: state.reservedInputTokens,
      reservedOutputTokens: state.reservedOutputTokens,
      settledInputTokens: state.settledInputTokens,
      settledOutputTokens: state.settledOutputTokens,
      costUsd: state.costUsd,
      requestStartsMs: [...state.requestStartsMs],
    };
  }
}

export const systemOneLaneBudgets = new SystemOneLaneBudgetManager();
