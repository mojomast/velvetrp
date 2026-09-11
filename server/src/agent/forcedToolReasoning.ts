/**
 * Some OpenAI-compatible reasoning models reject a forced named `tool_choice` while thinking
 * ("Thinking mode does not support this tool_choice"). For the bounded calls that must return one
 * exact tool, disable reasoning so the model returns the tool call directly. Callers merge this last
 * through the provider's reserved-key-protected `bodyOverrides`.
 */
export const FORCED_TOOL_BODY_OVERRIDES = { reasoning_effort: "none" } as const;
