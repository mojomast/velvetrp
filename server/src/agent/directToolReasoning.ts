/**
 * Some OpenAI-compatible reasoning models require thinking-mode `reasoning_content` to be replayed on
 * the next turn, and reject a forced named `tool_choice` while thinking. The bounded RPG tool calls
 * return one exact tool and may take several tool-result rounds, so they disable reasoning and get the
 * tool call directly. Callers merge this last through the provider's reserved-key-protected
 * `bodyOverrides`.
 *
 * `reasoning_effort: "none"` is the OpenAI/OpenRouter spelling; the same server also maps a
 * `samplers.reasoningEffort` of `"none"` to `reasoning: { enabled: false }` in `buildRequestBody`.
 * Either spelling turns thinking off, which is required before a named or required tool choice is
 * accepted. Omitting both lets a thinking-mode upstream burn the whole completion budget on hidden
 * deliberation and answer with an empty message, or reject the forced tool choice outright.
 *
 * A gateway that ignores this switch keeps thinking on; `completeWithProvider` then adapts a forced
 * named/required choice to `auto` for the exact authorized live-validation router so callers do not
 * pay that rejected round-trip. Local argument validation stays authoritative either way.
 */
export const DIRECT_TOOL_BODY_OVERRIDES = { reasoning_effort: "none" } as const;
