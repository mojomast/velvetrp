export interface TurnTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TurnTokenPricing {
  promptPerMillionUsd: number;
  completionPerMillionUsd: number;
}

export interface TurnBudgetPolicy {
  maxPromptTokens: number;
  maxCompletionTokens: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd: number | null;
  pricing: TurnTokenPricing | null;
  maxConcurrentRequests: number;
  maxRequestsPerWindow: number;
  rateWindowMs: number;
  /** Defaults to three UTF-8 bytes per token, conservatively below the common four-character heuristic. */
  bytesPerEstimatedToken?: number;
}

export interface TurnBudgetReservation {
  id: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  startedAtMs: number;
}

export interface TurnBudgetAccounting {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  providerMeasuredTokens: number;
  locallyEstimatedTokens: number;
}

export interface TurnBudgetState {
  policy: TurnBudgetPolicy;
  accounting: TurnBudgetAccounting;
  reservations: Readonly<Record<string, TurnBudgetReservation>>;
  requestStartsMs: readonly number[];
}

export interface TurnBudgetRequest {
  id: string;
  promptText?: string;
  estimatedPromptTokens?: number;
  maxCompletionTokens: number;
}

export type TurnBudgetDenialReason =
  | "duplicate-reservation"
  | "concurrency"
  | "rate-limit"
  | "prompt-token-budget"
  | "completion-token-budget"
  | "total-token-budget"
  | "estimated-dollar-budget";

export type TurnBudgetDecision =
  | { allowed: true; reservation: TurnBudgetReservation }
  | { allowed: false; reason: TurnBudgetDenialReason; retryAtMs: number | null };

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validatePolicy(policy: TurnBudgetPolicy): void {
  if (![policy.maxPromptTokens, policy.maxCompletionTokens, policy.maxTotalTokens,
    policy.maxConcurrentRequests, policy.maxRequestsPerWindow, policy.rateWindowMs].every(finiteNonNegative)
      || !Number.isSafeInteger(policy.maxPromptTokens) || !Number.isSafeInteger(policy.maxCompletionTokens)
      || !Number.isSafeInteger(policy.maxTotalTokens) || !Number.isSafeInteger(policy.maxConcurrentRequests)
      || !Number.isSafeInteger(policy.maxRequestsPerWindow) || policy.maxConcurrentRequests < 1
      || policy.maxRequestsPerWindow < 1 || policy.rateWindowMs <= 0) {
    throw new RangeError("turn budget limits must be positive finite values and token limits must be safe integers");
  }
  const bytesPerToken = policy.bytesPerEstimatedToken ?? 3;
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) throw new RangeError("bytesPerEstimatedToken must be positive");
  if (policy.maxEstimatedCostUsd !== null && (!finiteNonNegative(policy.maxEstimatedCostUsd) || policy.pricing === null)) {
    throw new RangeError("a dollar budget requires non-negative pricing");
  }
  if (policy.pricing && (![policy.pricing.promptPerMillionUsd, policy.pricing.completionPerMillionUsd].every(finiteNonNegative))) {
    throw new RangeError("token pricing must be non-negative");
  }
}

export function estimateTurnTokens(text: string, bytesPerEstimatedToken = 3): number {
  if (!Number.isFinite(bytesPerEstimatedToken) || bytesPerEstimatedToken <= 0) {
    throw new RangeError("bytesPerEstimatedToken must be positive");
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / bytesPerEstimatedToken);
}

export function estimateTurnCostUsd(usage: Pick<TurnTokenUsage, "promptTokens" | "completionTokens">, pricing: TurnTokenPricing | null): number {
  if (!pricing) return 0;
  return (usage.promptTokens * pricing.promptPerMillionUsd + usage.completionTokens * pricing.completionPerMillionUsd) / 1_000_000;
}

export function createTurnBudget(policy: TurnBudgetPolicy): TurnBudgetState {
  validatePolicy(policy);
  return {
    policy: { ...policy, ...(policy.pricing ? { pricing: { ...policy.pricing } } : {}) },
    accounting: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, providerMeasuredTokens: 0, locallyEstimatedTokens: 0 },
    reservations: {},
    requestStartsMs: [],
  };
}

function activeTotals(state: TurnBudgetState): TurnBudgetAccounting {
  return Object.values(state.reservations).reduce<TurnBudgetAccounting>((total, reservation) => ({
    promptTokens: total.promptTokens + reservation.promptTokens,
    completionTokens: total.completionTokens + reservation.completionTokens,
    totalTokens: total.totalTokens + reservation.promptTokens + reservation.completionTokens,
    estimatedCostUsd: total.estimatedCostUsd + reservation.estimatedCostUsd,
    providerMeasuredTokens: total.providerMeasuredTokens,
    locallyEstimatedTokens: total.locallyEstimatedTokens,
  }), { ...state.accounting });
}

/** Evaluates token, dollar, concurrency, and rolling-window limits without mutating state. */
export function decideTurnBudget(state: TurnBudgetState, request: TurnBudgetRequest, nowMs: number): TurnBudgetDecision {
  validatePolicy(state.policy);
  if (!request.id.trim() || state.reservations[request.id]) {
    return { allowed: false, reason: "duplicate-reservation", retryAtMs: null };
  }
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(request.maxCompletionTokens) || request.maxCompletionTokens < 0) {
    throw new RangeError("budget request values are invalid");
  }
  if (Object.keys(state.reservations).length >= state.policy.maxConcurrentRequests) {
    return { allowed: false, reason: "concurrency", retryAtMs: null };
  }
  const windowStart = nowMs - state.policy.rateWindowMs;
  const recentStarts = state.requestStartsMs.filter((startedAt) => startedAt > windowStart);
  if (recentStarts.length >= state.policy.maxRequestsPerWindow) {
    return { allowed: false, reason: "rate-limit", retryAtMs: recentStarts[0]! + state.policy.rateWindowMs };
  }
  const promptTokens = request.estimatedPromptTokens
    ?? estimateTurnTokens(request.promptText ?? "", state.policy.bytesPerEstimatedToken ?? 3);
  if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) throw new RangeError("estimatedPromptTokens must be a non-negative safe integer");
  const reservation: TurnBudgetReservation = {
    id: request.id,
    promptTokens,
    completionTokens: request.maxCompletionTokens,
    estimatedCostUsd: estimateTurnCostUsd({ promptTokens, completionTokens: request.maxCompletionTokens }, state.policy.pricing),
    startedAtMs: nowMs,
  };
  const projected = activeTotals(state);
  if (projected.promptTokens + promptTokens > state.policy.maxPromptTokens) {
    return { allowed: false, reason: "prompt-token-budget", retryAtMs: null };
  }
  if (projected.completionTokens + request.maxCompletionTokens > state.policy.maxCompletionTokens) {
    return { allowed: false, reason: "completion-token-budget", retryAtMs: null };
  }
  if (projected.totalTokens + promptTokens + request.maxCompletionTokens > state.policy.maxTotalTokens) {
    return { allowed: false, reason: "total-token-budget", retryAtMs: null };
  }
  if (state.policy.maxEstimatedCostUsd !== null
      && projected.estimatedCostUsd + reservation.estimatedCostUsd > state.policy.maxEstimatedCostUsd) {
    return { allowed: false, reason: "estimated-dollar-budget", retryAtMs: null };
  }
  return { allowed: true, reservation };
}

export type TurnBudgetReserveResult =
  | { allowed: true; state: TurnBudgetState; reservation: TurnBudgetReservation }
  | { allowed: false; state: TurnBudgetState; reason: TurnBudgetDenialReason; retryAtMs: number | null };

/** Atomically decides and reserves worst-case capacity for a provider dispatch. */
export function reserveTurnBudget(state: TurnBudgetState, request: TurnBudgetRequest, nowMs: number): TurnBudgetReserveResult {
  const decision = decideTurnBudget(state, request, nowMs);
  if (!decision.allowed) return { ...decision, state };
  const windowStart = nowMs - state.policy.rateWindowMs;
  return {
    allowed: true,
    reservation: decision.reservation,
    state: {
      ...state,
      reservations: { ...state.reservations, [request.id]: decision.reservation },
      requestStartsMs: [...state.requestStartsMs.filter((startedAt) => startedAt > windowStart), nowMs],
    },
  };
}

export interface TurnBudgetSettlement {
  usage?: TurnTokenUsage | null;
  /** Used only when provider usage is absent. */
  promptText?: string;
  /** Used only when provider usage is absent; omitted text charges the reserved completion maximum. */
  completionText?: string;
}

function validUsage(usage: TurnTokenUsage): boolean {
  return [usage.promptTokens, usage.completionTokens, usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    && usage.totalTokens >= usage.promptTokens + usage.completionTokens;
}

/** Settles one reservation, preferring provider usage and conservatively estimating missing usage. */
export function settleTurnBudget(state: TurnBudgetState, reservationId: string, settlement: TurnBudgetSettlement): TurnBudgetState {
  const reservation = state.reservations[reservationId];
  if (!reservation) throw new Error(`unknown turn budget reservation: ${reservationId}`);
  const measured = settlement.usage ?? null;
  if (measured && !validUsage(measured)) throw new RangeError("provider token usage is invalid");
  const usage: TurnTokenUsage = measured ?? (() => {
    const promptTokens = settlement.promptText === undefined
      ? reservation.promptTokens
      : Math.max(reservation.promptTokens, estimateTurnTokens(settlement.promptText, state.policy.bytesPerEstimatedToken ?? 3));
    const completionTokens = settlement.completionText === undefined
      ? reservation.completionTokens
      : estimateTurnTokens(settlement.completionText, state.policy.bytesPerEstimatedToken ?? 3);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  })();
  const { [reservationId]: _, ...reservations } = state.reservations;
  return {
    ...state,
    reservations,
    accounting: {
      promptTokens: state.accounting.promptTokens + usage.promptTokens,
      completionTokens: state.accounting.completionTokens + usage.completionTokens,
      totalTokens: state.accounting.totalTokens + usage.totalTokens,
      estimatedCostUsd: state.accounting.estimatedCostUsd + estimateTurnCostUsd(usage, state.policy.pricing),
      providerMeasuredTokens: state.accounting.providerMeasuredTokens + (measured ? usage.totalTokens : 0),
      locallyEstimatedTokens: state.accounting.locallyEstimatedTokens + (measured ? 0 : usage.totalTokens),
    },
  };
}

/** Releases capacity for a request proven not to have been dispatched; rate usage remains consumed. */
export function releaseTurnBudgetReservation(state: TurnBudgetState, reservationId: string): TurnBudgetState {
  if (!state.reservations[reservationId]) return state;
  const { [reservationId]: _, ...reservations } = state.reservations;
  return { ...state, reservations };
}

export interface SettledTurnBudgetUsage extends TurnTokenUsage {
  source: "provider" | "estimated";
}

/** Process-local atomic coordinator. Durable provider claims remain the cross-worker dispatch lock. */
export class AdventureTurnBudgetManager {
  private readonly states = new Map<string, TurnBudgetState>();

  initialize(turnId: string, policy: TurnBudgetPolicy, settlements: readonly (TurnTokenUsage & {
    source: "provider" | "estimated"; startedAtMs: number;
  })[]): void {
    if (this.states.has(turnId)) return;
    const state = createTurnBudget(policy);
    state.accounting = settlements.reduce<TurnBudgetAccounting>((total, usage) => ({
      promptTokens: total.promptTokens + usage.promptTokens,
      completionTokens: total.completionTokens + usage.completionTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      estimatedCostUsd: total.estimatedCostUsd + estimateTurnCostUsd(usage, policy.pricing),
      providerMeasuredTokens: total.providerMeasuredTokens + (usage.source === "provider" ? usage.totalTokens : 0),
      locallyEstimatedTokens: total.locallyEstimatedTokens + (usage.source === "estimated" ? usage.totalTokens : 0),
    }), state.accounting);
    state.requestStartsMs = settlements.map((settlement) => settlement.startedAtMs).filter(Number.isFinite);
    this.states.set(turnId, state);
  }

  reserve(turnId: string, policy: TurnBudgetPolicy, request: TurnBudgetRequest, nowMs: number): TurnBudgetDecision {
    const current = this.states.get(turnId) ?? createTurnBudget(policy);
    const reserved = reserveTurnBudget(current, request, nowMs);
    if (reserved.allowed) this.states.set(turnId, reserved.state);
    return reserved.allowed ? { allowed: true, reservation: reserved.reservation }
      : { allowed: false, reason: reserved.reason, retryAtMs: reserved.retryAtMs };
  }

  settle(turnId: string, reservationId: string, settlement: TurnBudgetSettlement): SettledTurnBudgetUsage {
    const current = this.states.get(turnId);
    if (!current) throw new Error(`unknown adventure turn budget: ${turnId}`);
    const before = current.accounting;
    const next = settleTurnBudget(current, reservationId, settlement);
    this.states.set(turnId, next);
    return {
      promptTokens: next.accounting.promptTokens - before.promptTokens,
      completionTokens: next.accounting.completionTokens - before.completionTokens,
      totalTokens: next.accounting.totalTokens - before.totalTokens,
      source: settlement.usage ? "provider" : "estimated",
    };
  }

  release(turnId: string, reservationId: string): void {
    const current = this.states.get(turnId);
    if (current) this.states.set(turnId, releaseTurnBudgetReservation(current, reservationId));
  }

  clear(turnId: string): void { this.states.delete(turnId); }
}

export const adventureTurnBudgets = new AdventureTurnBudgetManager();
