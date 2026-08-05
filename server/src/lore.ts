import type { LoreEntry } from "./types.js";

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

export function selectLoreEntries(
  entries: LoreEntry[],
  characterId: string | string[],
  recentText: string,
  maxChars: number,
): LoreEntry[] {
  const haystack = recentText.toLowerCase();
  const characterIds = new Set(Array.isArray(characterId) ? characterId : [characterId]);
  const matched = entries
    .filter((entry) => entry.enabled)
    .filter((entry) => entry.characterIds.length === 0 || entry.characterIds.some((id) => characterIds.has(id)))
    .filter((entry) => entry.keys.length === 0 || entry.keys.some((key) => key.trim() !== "" && haystack.includes(key.toLowerCase())))
    .sort((a, b) => a.insertionOrder - b.insertionOrder);
  const selected: LoreEntry[] = [];
  let remaining = Math.max(0, maxChars);
  for (const entry of matched) {
    if (selected.length >= 6 || remaining <= 0) break;
    const content = clip(entry.content, remaining);
    selected.push({ ...entry, content });
    remaining -= content.length;
  }
  return selected;
}

export function loreBlock(entries: LoreEntry[]): string {
  if (entries.length === 0) return "No lore entries triggered.";
  return entries.map((entry) => `- [${entry.keys.join(", ")}] ${entry.content}`).join("\n");
}
