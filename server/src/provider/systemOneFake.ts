import type { SystemOneAnswer, SystemOneCaller, SystemOneCompletionInput, SystemOneCompletionResult } from "./systemOneCompletion.js";

/** Options for the deterministic in-process System One double. */
export interface FakeSystemOneOptions {
  /** Exact answers keyed by question id; missing ids get a deterministic default. */
  scripted?: Record<string, SystemOneAnswer>;
  /** Reported model, defaulting to the requested model. */
  responseModel?: string;
  usage?: { input_tokens: number; output_tokens: number };
  requestId?: string;
  /** When set, every call rejects with this error after being recorded. */
  failWith?: Error;
}

function evenSpread(keys: readonly string[], winner: string, winnerProbability = 0.9): Record<string, number> {
  const probabilities: Record<string, number> = {};
  const remaining = keys.filter((key) => key !== winner);
  const share = remaining.length > 0 ? (1 - winnerProbability) / remaining.length : 0;
  for (const key of keys) probabilities[key] = key === winner ? winnerProbability : share;
  if (remaining.length === 0) probabilities[winner] = 1;
  return probabilities;
}

function defaultAnswer(input: SystemOneCompletionInput, questionId: string): SystemOneAnswer {
  const question = input.questions[questionId]!;
  if (question.type === "noul") return { type: "noul", noul: 0.9 };
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const winner = options[0]!;
    return { type: "choice", choice: winner, confidence: 0.9, probabilities: evenSpread(options, winner) };
  }
  const levels = question.criteria.map((_, index) => String(index));
  const winner = levels[Math.floor(levels.length / 2)]!;
  return {
    type: "score",
    score: Number(winner),
    confidence: 0.9,
    legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
    probabilities: evenSpread(levels, winner, 0.8),
  };
}

/**
 * A faithful, provider-free `SystemOneCaller` for unit tests and the
 * deterministic E2E suite. It records every call and never performs I/O.
 */
export function createFakeSystemOneCaller(
  options: FakeSystemOneOptions = {},
): SystemOneCaller & { calls: SystemOneCompletionInput[] } {
  const calls: SystemOneCompletionInput[] = [];
  const caller = (async (input: SystemOneCompletionInput): Promise<SystemOneCompletionResult> => {
    calls.push(input);
    if (options.failWith) throw options.failWith;
    const answers: Record<string, SystemOneAnswer> = {};
    for (const questionId of Object.keys(input.questions)) {
      answers[questionId] = options.scripted?.[questionId] ?? defaultAnswer(input, questionId);
    }
    const usage = options.usage ?? { input_tokens: 128, output_tokens: 16 };
    return {
      model: { requestedModel: input.settings.model, responseModel: options.responseModel ?? input.settings.model },
      answers,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.input_tokens + usage.output_tokens },
      provenance: { requestId: options.requestId ?? "req_fake", latencyMs: 1, attempts: 1 },
    };
  }) as SystemOneCaller & { calls: SystemOneCompletionInput[] };
  caller.calls = calls;
  return caller;
}
