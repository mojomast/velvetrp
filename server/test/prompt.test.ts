import { describe, expect, it } from "vitest";
import { buildOrchestratedMessages, cleanCharacterReply } from "../src/prompt.js";
import { getPromptPreset } from "../src/presets.js";
import { defaultHarnessSettings } from "../src/defaults.js";
import type { Character, MemoryFact, Message, Session } from "../src/types.js";

const character: Character = {
  id: "c1",
  name: "Aria",
  age: 29,
  archetype: "confident space captain",
  boundaries: "keep it fictional",
  safeWord: "anchor",
  fictionalConfirmed: true,
  isRealPerson: false,
  createdAt: new Date().toISOString(),
};

const session: Session = {
  id: "s1",
  characterId: "c1",
  primaryCharacterId: "c1",
  participants: [character],
  title: "",
  state: "active",
  presetId: "default",
  consentLog: [],
  activeLeafId: null,
  createdAt: new Date().toISOString(),
  stoppedAt: null,
  stopReason: null,
};

function msg(role: Message["role"], content: string): Message {
  const id = Math.random().toString(36);
  return {
    id,
    sessionId: "s1",
    role,
    speakerCharacterId: role === "character" ? "c1" : null,
    content,
    parentId: null,
    swipeGroupId: id,
    swipeIndex: 0,
    seq: 0,
    status: "final",
    createdAt: new Date().toISOString(),
  };
}

const memory: MemoryFact = {
  id: "m1",
  characterId: "c1",
  kind: "preference",
  content: "prefers slow pacing",
  sourceTurnId: "t1",
  createdAt: new Date().toISOString(),
  userApproved: true,
  forgottenAt: null,
};

describe("buildOrchestratedMessages", () => {
  const preset = getPromptPreset("default");

  it("leads with non-overridable adult/consent rules", () => {
    const messages = buildOrchestratedMessages({
      character,
      session,
      history: [],
      memories: [],
      summary: null,
      preset,
      lore: [],
      harness: defaultHarnessSettings(),
      userContent: "hello",
    });
    const first = messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain("NON-OVERRIDABLE RULES");
    expect(first?.content).toMatch(/fictional and 18 or older/);
    expect(first?.content).toMatch(/[Nn]ever depict minors/);
    expect(first?.content).toMatch(/real person or celebrity/);
    expect(first?.content).toMatch(/consensual/);
    expect(first?.content).toContain("Current scene state: active");
  });

  it("includes persona, constraints, memory and ends with the user message", () => {
    const harness = { ...defaultHarnessSettings(), styleGuide: "lyrical, second person" };
    const messages = buildOrchestratedMessages({
      character,
      session,
      history: [msg("user", "hi"), msg("character", "hello there")],
      memories: [memory],
      summary: null,
      preset,
      lore: [],
      harness,
      userContent: "what now?",
    });
    const joined = messages.map((m) => m.content).join("\n");
    expect(joined).toContain("Name: Aria");
    expect(joined).toContain("Age statement: 29");
    expect(joined).toContain("Safe word: anchor");
    expect(joined).toContain("EDITABLE STYLE GUIDE");
    expect(joined).toContain("prefers slow pacing");
    expect(joined).toContain("do not ask the user to repeat information");
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "what now?" });
  });

  it("places the editable system prompt after locked rules", () => {
    const harness = { ...defaultHarnessSettings(), systemPrompt: "Write cinematic two-paragraph replies." };
    const messages = buildOrchestratedMessages({
      character,
      session,
      history: [],
      memories: [],
      summary: null,
      preset,
      lore: [],
      harness,
      userContent: "begin",
    });
    const customIndex = messages.findIndex((message) => message.content.includes("USER SYSTEM PROMPT"));
    expect(customIndex).toBeGreaterThan(0);
    expect(messages[0]?.content).toContain("NON-OVERRIDABLE RULES");
    expect(messages[customIndex]?.content).toContain("Write cinematic two-paragraph replies.");
    const contractIndex = messages.findIndex((message) => message.content.includes("FINAL TURN CONTRACT"));
    expect(contractIndex).toBeGreaterThan(customIndex);
    expect(messages[contractIndex]?.content).toContain("You are Aria");
    expect(messages[contractIndex]?.content).toContain("Do not prefix it with a speaker name");
  });

  it("maps character history to the assistant role", () => {
    const messages = buildOrchestratedMessages({
      character,
      session,
      history: [msg("character", "in-character line")],
      memories: [],
      summary: null,
      preset,
      lore: [],
      harness: defaultHarnessSettings(),
      userContent: "next",
    });
    expect(messages.some((m) => m.role === "assistant" && m.content === "[Aria] in-character line")).toBe(true);
  });

  it("limits history to recentTurns", () => {
    const harness = { ...defaultHarnessSettings(), recentTurns: 4 };
    const history = Array.from({ length: 10 }, (_, i) => msg("user", `turn ${i}`));
    const messages = buildOrchestratedMessages({
      character,
      session,
      history,
      memories: [],
      summary: null,
      preset,
      lore: [],
      harness,
      userContent: "latest",
    });
    const historyContents = messages.filter((m) => m.content.startsWith("turn "));
    expect(historyContents).toHaveLength(4);
    expect(historyContents[0]?.content).toBe("turn 6");
  });

  it("clips memory to the configured budget", () => {
    const longMemory = { ...memory, content: "x".repeat(500) };
    const harness = { ...defaultHarnessSettings(), memoryChars: 200 };
    const messages = buildOrchestratedMessages({
      character,
      session,
      history: [],
      memories: [longMemory],
      summary: null,
      preset,
      lore: [],
      harness,
      userContent: "go",
    });
    const memoryBlock = messages.find((m) => m.content.includes("RETRIEVED MEMORY"));
    expect(memoryBlock).toBeDefined();
    expect(memoryBlock!.content.length).toBeLessThan(500);
  });

  it("includes participant cards, attributed history, and a target-speaker instruction", () => {
    const second = { ...character, id: "c2", name: "Bex", safeWord: "harbor" };
    const groupSession = { ...session, participants: [character, second] };
    const history = msg("character", "Bex speaks");
    history.speakerCharacterId = second.id;
    const messages = buildOrchestratedMessages({
      character: second,
      targetCharacter: second,
      participants: [character, second],
      session: groupSession,
      history: [history], memories: [memory], summary: null, preset,
      lore: [], harness: defaultHarnessSettings(), userContent: "continue",
    });
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("PARTICIPANT CARDS");
    expect(joined).toContain("durable profiles");
    expect(joined).not.toContain("immutable during session");
    expect(joined).toContain("Name: Aria");
    expect(joined).toContain("Name: Bex (TARGET SPEAKER)");
    expect(joined).toContain("exactly one reply as Bex");
    expect(messages.some((message) => message.content === "[Bex] Bex speaks")).toBe(true);
  });

  it("injects shared context and natural action/emote guidance", () => {
    const messages = buildOrchestratedMessages({ character, session, history: [], memories: [], summary: null, preset, lore: [], harness: defaultHarnessSettings(), userContent: "continue", sharedContext: "Aria stands beside Bex at the harbor." });
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("SHARED CONTEXT BASKET");
    expect(joined).toContain("Aria stands beside Bex");
    expect(joined).toContain("Avoid beginning consecutive sentences");
    expect(joined).toContain("Parse *emotes* as physical action beats");
  });

  it("does not feed repeated model-generated speaker labels back into history", () => {
    const repeated = msg("character", "[Aria] [Aria] Aria: A clean line.");
    const messages = buildOrchestratedMessages({
      character, session, history: [repeated], memories: [], summary: null, preset,
      lore: [], harness: defaultHarnessSettings(), userContent: "next",
    });
    expect(messages.some((message) => message.content === "[Aria] A clean line.")).toBe(true);
  });

  it("strips only leading participant attribution from generated replies", () => {
    expect(cleanCharacterReply("[Aria] [Aria] Aria: Hello [Aria].", [character])).toBe("Hello [Aria].");
    expect(cleanCharacterReply("[A note] remains intact.", [character])).toBe("[A note] remains intact.");
  });
});
