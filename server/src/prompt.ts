import { loreBlock } from "./lore.js";
import type { PromptPreset } from "./presets.js";
import type { Character, EpisodeSummary, HarnessSettings, LoreEntry, MemoryFact, Message, MessageRole, Session } from "./types.js";
import { resolvePromptTemplate } from "./promptTemplates.js";
import { bindCampaignAgentContextToTurn, campaignContextBasketText, type CampaignAgentContextBasket } from "./context.js";

type OpenAIRole = "system" | "user" | "assistant";

export interface OrchestratedMessage {
  role: OpenAIRole;
  content: string;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function toOpenAIRole(role: MessageRole): OpenAIRole {
  if (role === "character") return "assistant";
  return role;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cleanCharacterReply(content: string, participants: Character[]): string {
  const labels = [...participants.map((participant) => participant.name), "Character", "Assistant"]
    .filter((label) => label.trim() !== "")
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  if (!labels) return content.trim();
  const leadingLabels = new RegExp(`^(?:\\s*(?:\\[(?:${labels})\\]|(?:${labels})\\s*:)\\s*)+`, "i");
  const cleaned = content.replace(leadingLabels, "").trim();
  return cleaned || content.trim();
}

function memoryBlock(memories: MemoryFact[], maxChars: number): string {
  if (memories.length === 0) return "No approved long-term memories yet.";
  const lines = memories.map((m) => `- ${m.kind}: ${m.content}`);
  return clip(lines.join("\n"), maxChars);
}

export function buildOrchestratedMessages(input: {
  character: Character;
  participants?: Character[];
  targetCharacter?: Character;
  session: Session;
  history: Message[];
  memories: MemoryFact[];
  summary: EpisodeSummary | null;
  preset: PromptPreset;
  lore: LoreEntry[];
  harness: HarnessSettings;
  userContent: string;
  sharedContext?: string;
  /** Optional server-internal campaign layer; legacy session generations omit it unchanged. */
  campaignContext?: CampaignAgentContextBasket;
}): OrchestratedMessage[] {
  const { character, session, history, memories, summary, preset, lore, harness, userContent } = input;
  const participants = input.participants?.length ? input.participants : [character];
  const targetCharacter = input.targetCharacter ?? character;
  void preset;
  const overrides = harness.promptOverrides;
  const system = resolvePromptTemplate("character.safety", overrides, { "session.state": session.state });

  const participantById = new Map(participants.map((participant) => [participant.id, participant]));
  const participantCards = participants.map((participant) => [
      `Name: ${participant.name}${participant.id === targetCharacter.id ? " (TARGET SPEAKER)" : ""}`,
      `Age statement: ${participant.age}`,
      `Archetype/vibe: ${participant.archetype}`,
      `Boundaries and hard limits: ${participant.boundaries}`,
    ].join("\n")).join("\n");
  const persona = resolvePromptTemplate("character.persona", overrides, {
    "persona.preamble": harness.personaPreamble.trim() ? `User persona preamble: ${clip(harness.personaPreamble.trim(), 500)}` : "",
    "participants.cards": participantCards,
  });

  const constraints = resolvePromptTemplate("character.constraints", overrides, { "target.name": targetCharacter.name });

  const customSystem = harness.systemPrompt.trim()
      ? resolvePromptTemplate("character.customSystem", overrides, { "custom.system": clip(harness.systemPrompt.trim(), 64_000) })
    : "";

  const editableStyle = harness.styleGuide.trim()
      ? resolvePromptTemplate("character.style", overrides, { "style.guide": clip(harness.styleGuide.trim(), 900) })
    : "";

  const loreText = resolvePromptTemplate("character.lore", overrides, { "lore.triggered": loreBlock(lore) });
  if (input.campaignContext && targetCharacter.id !== character.id) {
    throw new Error("campaign context target speaker does not match generation character");
  }
  const campaignContext = input.campaignContext
    ? campaignContextBasketText(bindCampaignAgentContextToTurn(input.campaignContext, session.id, character.id, userContent))
    : "";

  const memory = resolvePromptTemplate("character.memory", overrides, {
    "memory.approved": memoryBlock(memories, harness.memoryChars),
    "summary.text": summary ? clip(summary.summary, harness.summaryChars) : "none yet",
  });
  const sharedContext = resolvePromptTemplate("character.context", overrides, { "context.basket": input.sharedContext ?? "No shared context available." });

  const postHistory = harness.postHistoryInstructions.trim()
      ? resolvePromptTemplate("character.postHistory", overrides, { "postHistory.instructions": clip(harness.postHistoryInstructions.trim(), 700) })
    : "";

  const finalTurnContract = resolvePromptTemplate("character.final", overrides, { "target.name": targetCharacter.name });

  const messages: OrchestratedMessage[] = [
    { role: "system", content: system },
    { role: "system", content: persona },
    { role: "system", content: constraints },
    ...(customSystem ? [{ role: "system" as const, content: customSystem }] : []),
    ...(editableStyle ? [{ role: "system" as const, content: editableStyle }] : []),
    ...(campaignContext
      ? [{ role: "system" as const, content: campaignContext }]
      : [{ role: "system" as const, content: loreText }, { role: "system" as const, content: memory },
        { role: "system" as const, content: sharedContext }]),
    ...(postHistory ? [{ role: "system" as const, content: postHistory }] : []),
    { role: "system", content: finalTurnContract },
    ...history.slice(-harness.recentTurns).map((m) => ({
      role: toOpenAIRole(m.role),
      content: m.role === "character"
        ? `[${participantById.get(m.speakerCharacterId ?? "")?.name ?? "Character"}] ${cleanCharacterReply(m.content, participants)}`
        : m.content,
    })),
    { role: "user", content: userContent },
  ];

  return messages;
}
