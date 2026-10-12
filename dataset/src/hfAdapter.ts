/**
 * Production-to-HuggingFace message adapter.
 *
 * WHY
 * ---
 * VelvetRP's production message shapes are NOT already HF-shaped. Production uses
 * `toolCalls` (not `tool_calls`), JSON-STRING arguments, `content: null` on
 * call-only assistant messages, and unwrapped `{name, description, parameters}`
 * tool schemas. HF wants `tool_calls`, dictionary arguments, `content: ""`, and
 * tools wrapped as `{type:"function", function:{...}}`.
 *
 * Getting this wrong is silent: the export loads fine, trains fine, and teaches
 * the wrong thing. Notably, the RPMax template renders `content | trim`, so a null
 * tool-call content becomes the literal string "None" (see templateProfiles.ts).
 *
 * This adapter is the ONLY sanctioned path from production to training.
 */

import type {
  MessageRole,
  StoredMessage,
  StoredTool,
  StoredToolCall,
} from "./spec.js";

export const HF_ADAPTER_VERSION = "production-to-hf-v1";

export class AdapterError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`cannot adapt production messages: ${problems.join("; ")}`);
    this.name = "AdapterError";
    this.problems = problems;
  }
}

/** A production-shaped tool call as VelvetRP emits it. */
export interface ProductionToolCall {
  id: string;
  toolName: string;
  /** JSON string, as production stores it. */
  argumentsJson: string;
}

/** A production-shaped message. */
export interface ProductionMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Production assistant messages may carry a null content with only tool calls. */
  content: string | null;
  toolCalls?: readonly ProductionToolCall[] | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
}

/** A production-shaped tool declaration: already unwrapped. */
export interface ProductionToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface AdaptResult {
  messages: StoredMessage[];
  tools?: StoredTool[];
  /** Diagnostics the caller may assert on. */
  stats: {
    toolCallsParsed: number;
    nullContentsNormalized: number;
    argumentBytes: number;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses a JSON argument string into an object exactly once.
 *
 * HF requires `arguments` to be an OBJECT. Transformers warns explicitly that the
 * OpenAI API's JSON string "may cause errors or strange model behavior" if passed
 * through. A JSON string here is a hard error, not something to stringify twice.
 */
export function parseArgumentsOnce(argumentsJson: string, problems: string[], callId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch (error) {
    problems.push(`tool call ${callId} has unparseable arguments: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (!isRecord(parsed)) {
    problems.push(`tool call ${callId} arguments must be a JSON object, not ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
    return {};
  }
  return parsed;
}

/** Wraps a production tool schema into the HF `{type:"function"}` envelope. */
export function adaptTool(schema: ProductionToolSchema): StoredTool {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description ?? "",
      parameters: schema.parameters,
    },
  };
}

/**
 * Adapts one conversation.
 *
 * Also enforces the structural invariants HF's `apply_chat_template` will not
 * check for you: unique tool-call ids, every `tool` message answering a preceding
 * call, and no dangling results.
 */
export function adaptMessages(input: {
  messages: readonly ProductionMessage[];
  tools?: readonly ProductionToolSchema[] | undefined;
}): AdaptResult {
  const problems: string[] = [];
  const messages: StoredMessage[] = [];
  const seenCallIds = new Set<string>();
  /** Calls awaiting a result, so a `tool` message cannot dangle. */
  const pendingCalls = new Map<string, string>();
  let toolCallsParsed = 0;
  let nullContentsNormalized = 0;
  let argumentBytes = 0;

  for (const [index, message] of input.messages.entries()) {
    const where = `messages[${index}]`;
    if (!["system", "user", "assistant", "tool"].includes(message.role)) {
      problems.push(`${where} has unknown role "${message.role}"`);
      continue;
    }
    if (message.role === "tool") {
      const callId = message.toolCallId;
      if (!callId) {
        problems.push(`${where} is a tool result with no tool_call_id`);
        continue;
      }
      if (!pendingCalls.has(callId)) {
        problems.push(`${where} answers tool call "${callId}" which was never made`);
        continue;
      }
      pendingCalls.delete(callId);
      messages.push({
        role: "tool",
        // HF accepts a plain string body; the id is what binds it to the call.
        content: message.content ?? "",
        tool_call_id: callId,
        name: message.toolName ?? pendingCalls.get(callId),
      } as StoredMessage);
      continue;
    }

    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const toolCalls: StoredToolCall[] = [];
      for (const call of message.toolCalls) {
        if (!call.id) problems.push(`${where} has a tool call with no id`);
        if (seenCallIds.has(call.id)) problems.push(`${where} duplicates tool call id "${call.id}"`);
        seenCallIds.add(call.id);
        pendingCalls.set(call.id, call.toolName);
        const args = parseArgumentsOnce(call.argumentsJson, problems, call.id);
        argumentBytes += call.argumentsJson.length;
        toolCallsParsed += 1;
        toolCalls.push({ id: call.id, type: "function", function: { name: call.toolName, arguments: args } });
      }
      // A call-only assistant message has null content in production. HF needs a
      // string; an empty string is correct and the template renders it as such.
      const content = message.content ?? "";
      if (message.content === null) nullContentsNormalized += 1;
      messages.push({ role: "assistant", content, tool_calls: toolCalls });
      continue;
    }

    if (message.toolCalls && message.toolCalls.length > 0) {
      problems.push(`${where} carries tool calls but has role "${message.role}"`);
      continue;
    }
    const content = message.content ?? "";
    if (message.content === null) nullContentsNormalized += 1;
    messages.push({ role: message.role as MessageRole, content });
  }

  if (pendingCalls.size > 0) {
    problems.push(`unanswered tool calls: ${[...pendingCalls.keys()].sort().join(", ")}`);
  }
  if (problems.length > 0) throw new AdapterError(problems);

  const result: AdaptResult = {
    messages,
    stats: { toolCallsParsed, nullContentsNormalized, argumentBytes },
  };
  if (input.tools && input.tools.length > 0) result.tools = input.tools.map(adaptTool);
  return result;
}

/**
 * Asserts that a tool-call assistant message has usable content.
 *
 * Guards the specific RPMax hazard: if a template renders `null` as the string
 * "None", the training target silently becomes that literal. This must be checked
 * on the ADAPTED message, before rendering.
 */
export function assertNoNullContentTargets(messages: readonly StoredMessage[]): string[] {
  const problems: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      if (message.content === null) problems.push(`messages[${index}] has a null assistant content alongside tool calls`);
      if (typeof message.content !== "string") problems.push(`messages[${index}] assistant content is not a string`);
      for (const call of message.tool_calls) {
        if (!call.function.name.trim()) problems.push(`messages[${index}] has an unnamed tool call`);
        if (typeof call.function.arguments !== "object" || call.function.arguments === null
          || Array.isArray(call.function.arguments)) {
          problems.push(`messages[${index}] tool call "${call.function.name}" arguments are not an object`);
        }
      }
    }
  }
  return problems;
}

/**
 * Selects which assistant spans may be supervised.
 *
 * Context assistant turns (earlier history) MUST be masked unless they are
 * themselves an approved target. Otherwise `assistant_only_loss=True` trains on
 * every historical assistant message placed in the prompt, which for harvested
 * transcripts includes prior errors or student attempts.
 */
export interface TargetSelection {
  /** Indices into `messages` whose assistant content is supervised. */
  supervisedAssistantIndices: readonly number[];
  /** Tool-call indices supervised; tool RESULTS are never supervised. */
  supervisedToolCallIndices: readonly number[];
}

export function selectTargets(
  messages: readonly StoredMessage[],
  options: { targetAssistantIndex: number },
): TargetSelection {
  const problems: string[] = [];
  const target = messages[options.targetAssistantIndex];
  if (!target || target.role !== "assistant") {
    problems.push(`target index ${options.targetAssistantIndex} is not an assistant message`);
    return { supervisedAssistantIndices: [], supervisedToolCallIndices: [] };
  }
  const supervisedAssistantIndices: number[] = [];
  const supervisedToolCallIndices: number[] = [];
  if (target.content.trim().length > 0) supervisedAssistantIndices.push(options.targetAssistantIndex);
  if (target.tool_calls) {
    messages.forEach((message, index) => {
      if (index === options.targetAssistantIndex && message.tool_calls) supervisedToolCallIndices.push(index);
    });
  }
  if (supervisedAssistantIndices.length === 0 && supervisedToolCallIndices.length === 0) {
    problems.push(`target assistant message at ${options.targetAssistantIndex} has nothing to supervise`);
  }
  if (problems.length > 0) throw new AdapterError(problems);
  return { supervisedAssistantIndices, supervisedToolCallIndices };
}

/** Verifies no `tool` result was selected as a supervision target. */
export function assertNoToolResultSupervision(
  messages: readonly StoredMessage[],
  selection: TargetSelection,
): string[] {
  const problems: string[] = [];
  for (const index of selection.supervisedAssistantIndices) {
    if (messages[index]?.role === "tool") {
      problems.push(`tool result at ${index} was selected for supervision; the model would learn to emit environment output`);
    }
  }
  return problems;
}