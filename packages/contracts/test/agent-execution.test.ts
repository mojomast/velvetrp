import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_REGISTRY_VERSION, DEFAULT_AGENT_EXECUTION_LIMITS,
  MAX_AGENT_DECISION_ROUNDS, MAX_AGENT_EXECUTION_DURATION_MS, MAX_AGENT_MUTATION_CALLS,
  MAX_AGENT_PROVIDER_CALLS, MAX_AGENT_TOOL_CALLS, agentExecutionLimitsSchema,
  agentJsonObjectSchema, canonicalAgentJson, persistAgentDecisionRoundInputSchema,
} from "../src/agent-execution.js";

const identity = { turnId: "turn", expectedCampaignRevision: 0, expectedTurnRevision: 1,
  expectedExecutionRevision: 1, idempotencyKey: "round" };
const base = { ...identity, round: 1, providerCallId: "provider-call", toolRegistryVersion: AGENT_TOOL_REGISTRY_VERSION,
  request: { context: "bounded" }, result: "tool-calls" as const,
  calls: [{ providerToolCallId: "call", toolName: "campaign_context.read" as const, kind: "read" as const, arguments: {} }] };

describe("M4.2 durable agent execution contracts", () => {
  it("publishes exact hard defaults and permits only lower configured limits", () => {
    expect(DEFAULT_AGENT_EXECUTION_LIMITS).toEqual({ decisionRounds: 5, toolCalls: 12, mutationCalls: 4, providerCalls: 7, durationMs: 90_000 });
    expect([MAX_AGENT_DECISION_ROUNDS, MAX_AGENT_TOOL_CALLS, MAX_AGENT_MUTATION_CALLS, MAX_AGENT_PROVIDER_CALLS,
      MAX_AGENT_EXECUTION_DURATION_MS]).toEqual([5, 12, 4, 7, 90_000]);
    expect(agentExecutionLimitsSchema.parse(DEFAULT_AGENT_EXECUTION_LIMITS)).toEqual(DEFAULT_AGENT_EXECUTION_LIMITS);
    for (const limits of [{ ...DEFAULT_AGENT_EXECUTION_LIMITS, decisionRounds: 6 }, { ...DEFAULT_AGENT_EXECUTION_LIMITS, toolCalls: 13 },
      { ...DEFAULT_AGENT_EXECUTION_LIMITS, mutationCalls: 5 }, { ...DEFAULT_AGENT_EXECUTION_LIMITS, providerCalls: 8 },
      { ...DEFAULT_AGENT_EXECUTION_LIMITS, durationMs: 90_001 }]) expect(agentExecutionLimitsSchema.safeParse(limits).success).toBe(false);
  });

  it("strictly validates whole response batches and complete optimistic identity", () => {
    expect(persistAgentDecisionRoundInputSchema.parse(base)).toEqual(base);
    expect(persistAgentDecisionRoundInputSchema.safeParse({ ...base, unknown: true }).success).toBe(false);
    expect(persistAgentDecisionRoundInputSchema.safeParse({ ...base, calls: [{ ...base.calls[0], kind: "mutation" }] }).success).toBe(false);
    expect(persistAgentDecisionRoundInputSchema.safeParse({ ...base, result: "complete" }).success).toBe(false);
    expect(persistAgentDecisionRoundInputSchema.safeParse({ ...base, expectedExecutionRevision: undefined }).success).toBe(false);
  });

  it("rejects every non-JSON value, cycle, hole, excessive depth, and oversized object", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hole = new Array(1);
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    let deep: Record<string, unknown> = {}; const root = deep;
    for (let index = 0; index < 34; index += 1) { deep.next = {}; deep = deep.next as Record<string, unknown>; }
    for (const invalid of [{ value: undefined }, { value: 1n }, { value: () => true }, { value: Number.POSITIVE_INFINITY },
      { value: new Date() }, cycle, { hole }, { accessor }, root]) expect(agentJsonObjectSchema.safeParse(invalid).success).toBe(false);
    expect(persistAgentDecisionRoundInputSchema.safeParse({ ...base, request: { huge: "x".repeat(262_145) } }).success).toBe(false);
  });

  it("canonicalizes by fixed UTF-16 code units rather than locale", () => {
    const value = { "\uffff": 1, "😀": 2, A: 3, a: 4 };
    expect(canonicalAgentJson(value)).toBe('{"A":3,"a":4,"😀":2,"￿":1}');
  });
});
