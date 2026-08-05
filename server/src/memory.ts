import type { Message, NewMemoryFact } from "./types.js";
import { checkUserMessage } from "./policy.js";

const MAX_FACTS_PER_TURN = 3;
const MAX_FACT_CHARS = 160;

// Episode mood is intentionally a small, deterministic heuristic. When several
// moods match, the first category below wins: tense, tender, playful, solemn.
const EMOTIONAL_BEAT_KEYWORDS: Array<{ beat: "tense" | "tender" | "playful" | "solemn"; keywords: string[] }> = [
  { beat: "tense", keywords: ["danger", "afraid", "fear", "threat", "panic", "attack"] },
  { beat: "tender", keywords: ["love", "gentle", "embrace", "kiss", "care"] },
  { beat: "playful", keywords: ["laugh", "joke", "tease", "grin", "playful"] },
  { beat: "solemn", keywords: ["death", "grief", "mourn", "vow", "funeral"] },
];

function cleanFact(text: string): string {
  return text.replace(/^[\s"']+|[\s"']+$/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
}

function isContextMemoryRequest(content: string): boolean {
  return /\bremember\b/i.test(content) && (
    /\b(?:your|their|our)\s+(?:characters?|backstor(?:y|ies)|details?|sheets?)\b/i.test(content)
    || /\bremember\s+(?:this|that|it)(?:\s+please)?[.!?]*$/i.test(content.trim())
  );
}

export function extractExplicitMemories(content: string, sourceTurnId: string): NewMemoryFact[] {
  if (isContextMemoryRequest(content)) return [];
  const match = /(?:^|\b)remember(?:\s+that)?\s+(.+)$/i.exec(content.trim());
  if (!match?.[1]) return [];
  return match[1]
    .split(/[;\n]/)
    .map(cleanFact)
    .filter((fact) => fact.length >= 3)
    .filter((fact) => checkUserMessage(fact).allowed)
    .slice(0, MAX_FACTS_PER_TURN)
    .map((fact) => ({
      kind: "preference" as const,
      content: fact,
      sourceTurnId,
      userApproved: true,
    }));
}

export function extractImplicitMemories(content: string, sourceTurnId: string): NewMemoryFact[] {
  if (/\bremember\b/i.test(content)) return [];
  const sentences = content.split(/[;\n]|(?<=[.!?])\s+/).map(cleanFact).filter(Boolean);
  const facts: NewMemoryFact[] = [];
  for (const sentence of sentences) {
    const name = /\b(?:my name is|call me)\s+(.+)/i.exec(sentence);
    const preference = /\bI\s+(?:really\s+)?(?:like|love|prefer|enjoy|dislike|hate)\s+(.+)/i.exec(sentence);
    if (name?.[1]) {
      facts.push({ kind: "fact", content: cleanFact(`The user's name is ${name[1]}`), sourceTurnId, userApproved: false });
    } else if (preference?.[0]) {
      facts.push({ kind: "preference", content: cleanFact(sentence), sourceTurnId, userApproved: false });
    }
    if (facts.length >= MAX_FACTS_PER_TURN) break;
  }
  return facts.filter((fact) => fact.content.length >= 3 && checkUserMessage(fact.content).allowed);
}

export function extractContextualCharacterMemory(
  content: string,
  sourceTurnId: string,
  history: Message[],
  characterId: string,
): NewMemoryFact[] {
  if (!isContextMemoryRequest(content)) return [];
  const recent = history.filter((message) => message.role === "character" && message.speakerCharacterId === characterId).slice(-6);
  const candidates = recent.flatMap((message, messageIndex) => message.content
    .replace(/\*[^*]*\*/g, " ")
    .split(/\n+|(?<=[.!?])\s+/)
    .map(cleanFact)
    .filter((sentence) => sentence.length >= 8)
    .map((sentence, sentenceIndex) => ({
      sentence,
      order: messageIndex * 100 + sentenceIndex,
      score:
        (/\b(?:name|class|bard|ranger|paladin|wizard|warlock|rogue|fighter|druid|cleric|character|backstory|oath|curse|familiar|companion)\b/i.test(sentence) ? 4 : 0)
        + (/\b(?:I|I'm|I've|my|mine)\b/i.test(sentence) ? 2 : 0),
    })));
  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, 2)
    .sort((a, b) => a.order - b.order)
    .map((candidate) => candidate.sentence);
  const fallback = candidates.at(-1)?.sentence;
  const summary = cleanFact((selected.length > 0 ? selected : fallback ? [fallback] : []).join(" "));
  return summary ? [{ kind: "event", content: summary, sourceTurnId, userApproved: true }] : [];
}

export function buildTurnMemories(
  content: string,
  sourceTurnId: string,
  history: Message[],
  characterId: string,
): NewMemoryFact[] {
  const facts = [
    ...extractExplicitMemories(content, sourceTurnId),
    ...extractImplicitMemories(content, sourceTurnId),
    ...extractContextualCharacterMemory(content, sourceTurnId, history, characterId),
  ];
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = fact.content.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_FACTS_PER_TURN);
}

export function shouldUpdateSummary(messageCount: number): boolean {
  return messageCount > 0 && messageCount % 6 === 0;
}

function inferEmotionalBeat(messages: Message[]): "tense" | "tender" | "playful" | "solemn" | "steady" {
  const recentDialogue = messages.filter((message) => message.role !== "system").slice(-4);
  const content = recentDialogue.map((message) => message.content.toLowerCase()).join(" ");
  return EMOTIONAL_BEAT_KEYWORDS.find(({ keywords }) => keywords.some((keyword) => content.includes(keyword)))?.beat ?? "steady";
}

export function buildEpisodeSummary(
  messages: Message[],
  maxChars = 1600,
  characterNames: Record<string, string> = {},
): { summary: string; keyEvents: string[]; emotionalBeat: string } {
  const dialogue = messages.filter((message) => message.role !== "system");
  const selected = dialogue.length <= 12 ? dialogue : [...dialogue.slice(0, 4), ...dialogue.slice(-8)];
  const keyEvents = selected
    .map((m) => `${m.role === "character" ? (characterNames[m.speakerCharacterId ?? ""] ?? "character") : m.role}: ${m.content.replace(/\s+/g, " ").trim().slice(0, 90)}`)
    .slice(0, 12);
  const summary = keyEvents.join(" | ").slice(0, maxChars);
  return {
    summary: summary || "Scene started; no major events yet.",
    keyEvents,
    emotionalBeat: inferEmotionalBeat(messages),
  };
}
