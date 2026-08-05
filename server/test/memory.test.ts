import { describe, expect, it } from "vitest";
import { buildEpisodeSummary, buildTurnMemories, extractContextualCharacterMemory, extractExplicitMemories, extractImplicitMemories, shouldUpdateSummary } from "../src/memory.js";
import type { Message } from "../src/types.js";

function msg(role: Message["role"], content: string, id = Math.random().toString(36)): Message {
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

describe("extractExplicitMemories", () => {
  it("extracts facts from a remember instruction", () => {
    const facts = extractExplicitMemories("remember that I prefer slow pacing", "turn-1");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ kind: "preference", content: "I prefer slow pacing", sourceTurnId: "turn-1", userApproved: true });
  });

  it("splits multiple facts on semicolons", () => {
    const facts = extractExplicitMemories("remember that I like tea; I dislike crowds", "turn-1");
    expect(facts).toHaveLength(2);
  });

  it("caps facts per turn and minimum length", () => {
    const facts = extractExplicitMemories("remember that aaa; bbb; ccc; ddd", "turn-1");
    expect(facts.length).toBeLessThanOrEqual(3);
    expect(extractExplicitMemories("remember that ab", "turn-1")).toHaveLength(0);
  });

  it("accepts facts under the deliberately permissive policy", () => {
    const facts = extractExplicitMemories("remember that the character is a teen", "turn-1");
    expect(facts).toHaveLength(1);
  });

  it("returns nothing without a remember cue", () => {
    expect(extractExplicitMemories("just chatting", "turn-1")).toHaveLength(0);
  });

  it("does not store a generic remember-the-characters instruction as a fact", () => {
    expect(extractExplicitMemories("will you remember your characters please", "turn-1")).toHaveLength(0);
  });
});

describe("implicit and contextual memory", () => {
  it("creates pending memories for natural user preferences and names", () => {
    expect(extractImplicitMemories("My name is Mo. I prefer quiet taverns.", "turn-1")).toEqual([
      expect.objectContaining({ kind: "fact", content: "The user's name is Mo.", userApproved: false }),
      expect.objectContaining({ kind: "preference", content: "I prefer quiet taverns.", userApproved: false }),
    ]);
  });

  it("snapshots recent self-established character details on explicit request", () => {
    const history = [
      { ...msg("character", "*I lift my sheet.* My character is Vesper, a tiefling bard with a cursed lute."), speakerCharacterId: "c1" },
      { ...msg("character", "My oath follows a chained dragon, and my holy symbol is rusting."), speakerCharacterId: "c2" },
    ];
    const facts = extractContextualCharacterMemory("please remember your characters", "turn-1", history, "c1");
    expect(facts).toEqual([expect.objectContaining({ kind: "event", userApproved: true })]);
    expect(facts[0]?.content).toContain("Vesper");
    expect(facts[0]?.content).not.toContain("chained dragon");
  });

  it("builds an immediately approved explicit memory without a duplicate pending copy", () => {
    const facts = buildTurnMemories("remember that I prefer tea", "turn-1", [], "c1");
    expect(facts).toEqual([expect.objectContaining({ content: "I prefer tea", userApproved: true })]);
  });
});

describe("shouldUpdateSummary", () => {
  it("triggers every 6 messages", () => {
    expect(shouldUpdateSummary(6)).toBe(true);
    expect(shouldUpdateSummary(12)).toBe(true);
    expect(shouldUpdateSummary(5)).toBe(false);
    expect(shouldUpdateSummary(0)).toBe(false);
  });
});

describe("buildEpisodeSummary", () => {
  it("retains foundational and recent events within the budget", () => {
    const messages = [
      msg("system", "setup note"),
      ...Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? "user" : "character", `turn ${i}`)),
    ];
    const summary = buildEpisodeSummary(messages, 1600);
    expect(summary.keyEvents).toHaveLength(12);
    expect(summary.keyEvents[0]).toContain("turn 0");
    expect(summary.keyEvents[4]).toContain("turn 12");
    expect(summary.keyEvents.at(-1)).toContain("turn 19");
    expect(summary.keyEvents.every((event) => !event.startsWith("system:"))).toBe(true);
    expect(summary.summary.length).toBeLessThanOrEqual(1600);
    expect(summary.emotionalBeat).toBe("steady");
  });

  it("honors a smaller summary character budget", () => {
    const summary = buildEpisodeSummary([msg("user", "x".repeat(200)), msg("character", "y".repeat(200))], 100);
    expect(summary.summary).toHaveLength(100);
  });

  it("has a fallback for empty histories", () => {
    expect(buildEpisodeSummary([]).summary).toMatch(/no major events/i);
  });

  it.each([
    ["tense", "The DANGER is closing in."],
    ["tender", "She offers a GENTLE embrace."],
    ["playful", "They LAUGH at the joke."],
    ["solemn", "They MOURN the fallen king."],
    ["steady", "They continue down the road."],
  ] as const)("infers a %s emotional beat from recent dialogue", (emotionalBeat, content) => {
    expect(buildEpisodeSummary([msg("user", content)]).emotionalBeat).toBe(emotionalBeat);
  });

  it("uses documented emotional-beat precedence for recent dialogue", () => {
    const messages = [
      msg("user", "We laugh together."),
      msg("character", "A gentle kiss follows."),
      msg("user", "Danger approaches."),
    ];

    expect(buildEpisodeSummary(messages).emotionalBeat).toBe("tense");
  });

  it("only considers the last four non-system messages for emotional beats", () => {
    const messages = [
      msg("user", "Danger approaches."),
      msg("system", "ignore this"),
      ...Array.from({ length: 4 }, () => msg("character", "The road continues.")),
    ];

    expect(buildEpisodeSummary(messages).emotionalBeat).toBe("steady");
  });
});
