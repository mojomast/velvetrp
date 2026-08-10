import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** Hard maximum decision rounds in one durable agent execution. */
export const MAX_AGENT_DECISION_ROUNDS = 5;
/** Hard maximum tool calls in one durable agent execution. */
export const MAX_AGENT_TOOL_CALLS = 12;
/** Hard maximum mutation calls in one durable agent execution. */
export const MAX_AGENT_MUTATION_CALLS = 4;
/** Hard maximum provider starts in one durable agent execution. */
export const MAX_AGENT_PROVIDER_CALLS = 7;
/** Hard maximum wall-clock duration of one durable agent execution. */
export const MAX_AGENT_EXECUTION_DURATION_MS = 90_000;
/** Maximum recursive JSON depth accepted at the agent boundary. */
export const MAX_AGENT_JSON_DEPTH = 32;
/** Maximum values and object members traversed in one agent JSON value. */
export const MAX_AGENT_JSON_NODES = 4_096;
/** Maximum canonical argument JSON length in UTF-16 code units. */
export const MAX_AGENT_ARGUMENT_JSON_LENGTH = 32_768;
/** Maximum canonical provider or command request JSON length in UTF-16 code units. */
export const MAX_AGENT_REQUEST_JSON_LENGTH = 262_144;
/** Maximum canonical read-result JSON length in UTF-16 code units. */
export const MAX_AGENT_RESULT_JSON_LENGTH = 262_144;
/** Version of the closed server-selected tool registry represented by these contracts. */
export const AGENT_TOOL_REGISTRY_VERSION = "v1" as const;
/** Additive registry for consequential tools that cannot alter sealed v38 DDL. */
export const POST_V38_AGENT_TOOL_REGISTRY_VERSION = "v2" as const;

/** A finite recursive JSON value accepted by durable agent contracts. */
export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };
/** A finite recursive JSON object accepted by durable agent contracts. */
export type AgentJsonObject = { [key: string]: AgentJsonValue };

function validateJsonValue(root: unknown): root is AgentJsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_AGENT_JSON_NODES || depth > MAX_AGENT_JSON_DEPTH) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.some((key) => {
      const descriptor = descriptors[key as keyof typeof descriptors];
      return !descriptor || !("value" in descriptor);
    })) return false;
    if (!Array.isArray(value) && ownKeys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return false;
    ancestors.add(value);
    const valid = Array.isArray(value)
      ? ownKeys.every((key) => key === "length" || (typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key)
        && /^(0|[1-9][0-9]*)$/.test(key)
        && Number(key) < value.length && visit(value[Number(key)], depth + 1)))
        && ownKeys.filter((key) => key !== "length").length === value.length
      : ownKeys.every((key) => visit((value as Record<string, unknown>)[String(key)], depth + 1));
    ancestors.delete(value);
    return valid;
  };
  return visit(root, 0);
}

/** Strict recursive JSON-value schema rejecting non-finite numbers, exotic objects, holes, cycles, and non-JSON values. */
export const agentJsonValueSchema = z.custom<AgentJsonValue>(validateJsonValue, "value must be finite strict JSON");
/** Strict recursive JSON-object schema used for all private arguments, requests, and results. */
export const agentJsonObjectSchema = z.custom<AgentJsonObject>((value) => validateJsonValue(value)
  && value !== null && typeof value === "object" && !Array.isArray(value), "value must be a finite strict JSON object");

function compareUtf16(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Canonicalizes strict JSON with deterministic binary UTF-16 object-key ordering. */
export function canonicalAgentJson(value: AgentJsonValue): string {
  const parsed = agentJsonValueSchema.parse(value);
  const render = (nested: AgentJsonValue): string => {
    if (nested === null || typeof nested !== "object") return JSON.stringify(nested);
    if (Array.isArray(nested)) return `[${nested.map(render).join(",")}]`;
    return `{${Object.keys(nested).sort(compareUtf16).map((key) => `${JSON.stringify(key)}:${render(nested[key]!)}`).join(",")}}`;
  };
  return render(parsed);
}

const boundedObject = (maximum: number) => agentJsonObjectSchema.refine((value) => canonicalAgentJson(value).length <= maximum,
  `canonical JSON exceeds ${maximum} UTF-16 code units`);
/** Strict bounded argument object schema. */
export const agentArgumentObjectSchema = boundedObject(MAX_AGENT_ARGUMENT_JSON_LENGTH);
/** Strict bounded request object schema. */
export const agentRequestObjectSchema = boundedObject(MAX_AGENT_REQUEST_JSON_LENGTH);
/** Strict bounded result object schema. */
export const agentResultObjectSchema = boundedObject(MAX_AGENT_RESULT_JSON_LENGTH);

/** A canonical lower-case SHA-256 digest. */
export const canonicalSha256DigestSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/);
/** Closed tool-registry version persisted with every provider decision. */
export const agentToolRegistryVersionSchema = z.literal(AGENT_TOOL_REGISTRY_VERSION);
/** Neutral distinction between non-mutating reads and command-service mutations. */
export const agentToolCallKindSchema = z.enum(["read", "mutation"]);
/** Closed first-version tool registry; availability is selected by the server for each round. */
export const agentToolNameSchema = z.enum([
  "campaign_context.read", "actor_resources.read", "actor_inventory.read", "actor_powers.read",
   "combat_state.read", "world_state.read", "quest_state.read",
    "actor_attribute.set", "actor_resource.initialize", "actor_dice.roll",
]);
/** Closed mutation-tool vocabulary. */
export const agentMutationToolNameSchema = z.enum(["actor_attribute.set", "actor_resource.initialize", "actor_dice.roll"]);
/** Post-v38 consequential tools are persisted in versioned additive ledgers. */
export const postV38AgentToolNameSchema = z.enum(["combat_action.execute"]);
/** Reachable durable progress states before an authoritative mutation bridge exists. */
export const durableAgentToolCallStatusSchema = z.enum(["pending", "read-succeeded", "read-failed"]);
/** Provider decision-round completion reason, independent of any RPG rules. */
export const agentDecisionRoundResultSchema = z.enum(["tool-calls", "complete", "refused"]);

/** Configurable limits bounded by the non-negotiable substrate maxima. */
export const agentExecutionLimitsSchema = z.object({
  decisionRounds: z.number().int().min(1).max(MAX_AGENT_DECISION_ROUNDS),
  toolCalls: z.number().int().min(0).max(MAX_AGENT_TOOL_CALLS),
  mutationCalls: z.number().int().min(0).max(MAX_AGENT_MUTATION_CALLS),
  providerCalls: z.number().int().min(1).max(MAX_AGENT_PROVIDER_CALLS),
  durationMs: z.number().int().min(1).max(MAX_AGENT_EXECUTION_DURATION_MS),
}).strict();

/** Persisted limits permit only a migration-grandfathered provider-start ceiling above seven. */
export const durableAgentExecutionLimitsSchema = agentExecutionLimitsSchema.omit({ providerCalls: true }).extend({
  providerCalls: z.number().int().min(1).max(1_000_000),
}).strict();

/** Default hard limits used unless a turn is created with lower limits. */
export const DEFAULT_AGENT_EXECUTION_LIMITS = Object.freeze({
  decisionRounds: MAX_AGENT_DECISION_ROUNDS, toolCalls: MAX_AGENT_TOOL_CALLS, mutationCalls: MAX_AGENT_MUTATION_CALLS,
  providerCalls: MAX_AGENT_PROVIDER_CALLS, durationMs: MAX_AGENT_EXECUTION_DURATION_MS,
});

/** Optimistic identity required by every durable planning mutation. */
export const agentExecutionMutationIdentitySchema = z.object({
  turnId: resourceIdSchema,
  expectedCampaignRevision: revisionSchema,
  expectedTurnRevision: expectedRevisionSchema,
  expectedExecutionRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Starts one provider call through the durable planning substrate. */
export const startAgentProviderCallInputSchema = agentExecutionMutationIdentitySchema.extend({
  providerCallId: resourceIdSchema,
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  attempt: z.number().int().min(1).max(32),
}).strict();

/** Stable acknowledgement returned by an exactly replayable planning mutation. */
export const agentExecutionMutationResultSchema = z.object({
  turnId: resourceIdSchema,
  resultingExecutionRevision: revisionSchema,
}).strict();

/** One locally validated call from a complete provider decision response. */
export const agentDecisionToolCallInputSchema = z.object({
  providerToolCallId: resourceIdSchema, toolName: agentToolNameSchema, kind: agentToolCallKindSchema,
  arguments: agentArgumentObjectSchema,
}).strict().superRefine((value, context) => {
  const mutation = agentMutationToolNameSchema.safeParse(value.toolName).success;
  if (mutation !== (value.kind === "mutation")) context.addIssue({ code: "custom", path: ["kind"], message: "tool kind must match the closed registry" });
});

/** Atomic input for persisting a complete, validated provider decision before any call executes. */
export const persistAgentDecisionRoundInputSchema = agentExecutionMutationIdentitySchema.extend({
  round: z.number().int().min(1).max(MAX_AGENT_DECISION_ROUNDS), providerCallId: resourceIdSchema,
  toolRegistryVersion: agentToolRegistryVersionSchema, request: agentRequestObjectSchema,
  result: agentDecisionRoundResultSchema, calls: z.array(agentDecisionToolCallInputSchema).max(MAX_AGENT_TOOL_CALLS),
}).strict().superRefine((value, context) => {
  if ((value.result === "tool-calls") !== (value.calls.length > 0)) context.addIssue({ code: "custom", path: ["calls"], message: "round result and call batch must agree" });
  if (new Set(value.calls.map((call) => call.providerToolCallId)).size !== value.calls.length) {
    context.addIssue({ code: "custom", path: ["calls"], message: "provider tool-call IDs must be unique" });
  }
});

/** Exact success or failure persisted for a read call. */
export const markAgentReadOutcomeInputSchema = agentExecutionMutationIdentitySchema.extend({
  providerToolCallId: resourceIdSchema,
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal("succeeded"), result: agentResultObjectSchema }).strict(),
    z.object({ status: z.literal("failed"), errorCode: resourceIdSchema }).strict(),
  ]),
}).strict();

/** Private durable tool-call projection; arguments never belong in role-safe or HTTP projections. */
export const durableAgentToolCallSchema = z.object({
  providerToolCallId: resourceIdSchema, round: z.number().int().min(1).max(MAX_AGENT_DECISION_ROUNDS),
  position: z.number().int().min(0).max(MAX_AGENT_TOOL_CALLS - 1), toolName: agentToolNameSchema, kind: agentToolCallKindSchema,
  arguments: agentArgumentObjectSchema, argumentDigest: canonicalSha256DigestSchema, status: durableAgentToolCallStatusSchema,
  readOutcome: z.object({ status: z.enum(["succeeded", "failed"]), result: agentResultObjectSchema.nullable(),
    resultDigest: canonicalSha256DigestSchema.nullable(), errorCode: resourceIdSchema.nullable() }).strict().nullable(),
}).strict();

/** Private restart-safe planning state and exact persisted counters for one turn. */
export const durableAgentPlanningStateSchema = z.object({
  turnId: resourceIdSchema, toolRegistryVersion: agentToolRegistryVersionSchema, executionRevision: revisionSchema,
  limits: durableAgentExecutionLimitsSchema, startedAt: utcIsoTimestampSchema, deadlineAt: utcIsoTimestampSchema,
  decisionRounds: z.number().int().min(0).max(MAX_AGENT_DECISION_ROUNDS),
  toolCalls: z.array(durableAgentToolCallSchema).max(MAX_AGENT_TOOL_CALLS),
  /** Includes sealed v38 calls and post-v38 consequential tool accounting. */
  totalToolCalls: z.number().int().min(0).max(MAX_AGENT_TOOL_CALLS),
  mutationCalls: z.number().int().min(0).max(MAX_AGENT_MUTATION_CALLS),
  // Historical v37 turns may already exceed the new planning limit. The exact
  // baseline remains visible, while v38 refuses every additional start.
  providerStarts: z.number().int().min(0).max(1_000_000), deadlineExceeded: z.boolean(),
}).strict();

/** Configured execution limits. */
export type AgentExecutionLimits = z.infer<typeof agentExecutionLimitsSchema>;
/** Optimistic identity for durable execution mutations. */
export type AgentExecutionMutationIdentity = z.infer<typeof agentExecutionMutationIdentitySchema>;
/** Durable provider start input. */
export type StartAgentProviderCallInput = z.infer<typeof startAgentProviderCallInputSchema>;
/** Exactly replayable planning-mutation acknowledgement. */
export type AgentExecutionMutationResult = z.infer<typeof agentExecutionMutationResultSchema>;
/** Complete provider decision-round persistence input. */
export type PersistAgentDecisionRoundInput = z.infer<typeof persistAgentDecisionRoundInputSchema>;
/** Durable read outcome input. */
export type MarkAgentReadOutcomeInput = z.infer<typeof markAgentReadOutcomeInputSchema>;
/** Private durable planning state. */
export type DurableAgentPlanningState = z.infer<typeof durableAgentPlanningStateSchema>;
