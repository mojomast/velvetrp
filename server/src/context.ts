import type { LoreEntry, MemoryFact, Message, Session, SessionContextBasket } from "./types.js";

function compact(text: string, max = 180): string {
  const cleaned = text.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function buildSessionContextBasket(
  session: Session,
  messages: Message[],
  memories: Array<{ characterName: string; memory: MemoryFact }>,
  lore: LoreEntry[],
  source: { sourceOfTruth: string; updatedAt: string | null; synthesizedSource?: string; synthesizedUpdatedAt?: string | null } = { sourceOfTruth: "", updatedAt: null },
): SessionContextBasket {
  const names = new Map(session.participants.map((participant) => [participant.id, participant.name]));
  const recentEvents = messages.filter((message) => message.role !== "system").slice(-10).map((message) => {
    const speaker = message.role === "user" ? "User" : names.get(message.speakerCharacterId ?? "") ?? "Character";
    return `${speaker}: ${compact(message.content)}`;
  });
  const openThreads = messages.filter((message) => message.role !== "system" && /\?|\b(?:need|want|plan|goal|should|next|promise|remember)\b/i.test(message.content))
    .slice(-4).map((message) => compact(message.content, 140));
  const manualCanon = source.sourceOfTruth.trim();
  const synthesizedCanon = source.synthesizedSource?.trim() || "No synthesized scene facts yet.";
  const sourceOfTruth = `${manualCanon ? `MANUAL CANON (highest priority):\n${manualCanon}\n\n` : ""}SYNTHESIZED CURRENT SCENE FACTS:\n${synthesizedCanon}`;
  return {
    sessionId: session.id,
    state: session.state,
    sourceOfTruth,
    editableSource: source.sourceOfTruth,
    sourceUpdatedAt: source.updatedAt,
    synthesizedSource: source.synthesizedSource ?? "",
    synthesizedUpdatedAt: source.synthesizedUpdatedAt ?? null,
    participants: session.participants.map(({ id, name, archetype }) => ({ id, name, archetype })),
    recentEvents,
    rememberedFacts: memories.slice(0, 18).map(({ characterName, memory }) => `${characterName}: ${memory.content}`),
    activeLore: lore.slice(0, 6).map((entry) => compact(entry.content, 180)),
    openThreads: [...new Set(openThreads)],
  };
}

export function contextBasketText(basket: SessionContextBasket): string {
  const section = (title: string, values: string[]) => `${title}:\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- none"}`;
  return [
    `AUTHORITATIVE CURRENT SCENE (not optional flavor; reconcile the reply with it before writing and never contradict it):\n${basket.sourceOfTruth}`,
    `Session state: ${basket.state}`,
    section("Participants", basket.participants.map((participant) => `${participant.name} — ${participant.archetype}`)),
    section("Recent shared events", basket.recentEvents),
    section("Approved shared memories", basket.rememberedFacts),
    section("Active lore", basket.activeLore),
    section("Open threads", basket.openThreads),
  ].join("\n\n");
}
