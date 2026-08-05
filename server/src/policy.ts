import type { Character, PolicyResult } from "./types.js";

export function normalizeForPolicy(text: string): string {
  return text;
}

export function sanitizeInjectionText(content: string): string {
  return content
    .replace(/\[\s*system\s*\]/gi, "[user-text]")
    .replace(/<\s*system\s*>/gi, "<user-text>")
    .replace(/```\s*system/gi, "```user-text")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

export function sanitizeUserContent(content: string): string {
  return sanitizeInjectionText(content).slice(0, 1000).trim();
}

const ASSISTANT_OUTPUT_BLOCKLIST = [
  "ignore your boundaries",
  "ignore your safety guidelines",
  "bypass your boundaries",
  "bypass your safety guidelines",
  "bypass the refusal",
  "refusal bypass",
];

export function checkCharacter(character: Character): PolicyResult {
  void character;
  return { allowed: true, violations: [] };
}

/**
 * Checks user messages for prompt-injection markers.
 * Violations contain `prompt-injection-marker` when sanitization alters the message.
 */
export function checkUserMessage(content: string): PolicyResult {
  if (sanitizeInjectionText(content) !== content.trim()) {
    return { allowed: false, violations: ["prompt-injection-marker"] };
  }

  return { allowed: true, violations: [] };
}

/**
 * Checks assistant output for boundary or refusal-bypass phrases.
 * Violations contain `boundary-or-refusal-bypass` for each matched phrase.
 */
export function checkAssistantOutput(content: string): PolicyResult {
  const normalized = content.toLowerCase();
  const violations = ASSISTANT_OUTPUT_BLOCKLIST
    .filter((phrase) => normalized.includes(phrase))
    .map(() => "boundary-or-refusal-bypass");

  return { allowed: violations.length === 0, violations };
}
