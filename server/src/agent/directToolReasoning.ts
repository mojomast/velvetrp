/**
 * Some OpenAI-compatible reasoning models require thinking-mode `reasoning_content` to be replayed on
 * the next turn, and reject a forced named `tool_choice` while thinking. The bounded RPG tool calls
 * return one exact tool and may take several tool-result rounds, so they disable reasoning and get the
 * tool call directly. Callers merge this last through the provider's reserved-key-protected
 * `bodyOverrides`.
 */
export const DIRECT_TOOL_BODY_OVERRIDES = { reasoning_effort: "none" } as const;
