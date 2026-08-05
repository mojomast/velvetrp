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

export function checkCharacter(character: Character): PolicyResult {
  void character;
  return { allowed: true, violations: [] };
}

export function checkUserMessage(content: string): PolicyResult {
  void content;
  return { allowed: true, violations: [] };
}

export function checkAssistantOutput(content: string): PolicyResult {
  void content;
  return { allowed: true, violations: [] };
}

export const SAFE_WORDS = ["red", "safeword", "stop", "halt"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSafeWord(content: string, extraWords: Array<string | null | undefined> = []): boolean {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  const custom = extraWords
    .filter((word): word is string => typeof word === "string" && word.trim() !== "")
    .map((word) => word.trim().toLowerCase().replace(/\s+/g, " "));
  const words = [...SAFE_WORDS, ...custom];
  return words.some((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(normalized));
}
