import { describe, expect, it } from "vitest";
import { buildSessionContextBasket, contextBasketText } from "../src/context.js";
import type { Character, LoreEntry, MemoryFact, Message, Session } from "../src/types.js";

const character = (id: string, name: string): Character => ({ id, name, age: 30, archetype: `${name} archetype`, boundaries: "fictional", safeWord: `${name}-safe`, fictionalConfirmed: true, isRealPerson: false, createdAt: "2026-01-01T00:00:00.000Z" });
const one = character("c1", "Aria"); const two = character("c2", "Bex");
const session: Session = { id: "s1", characterId: one.id, primaryCharacterId: one.id, participants: [one, two], title: "", state: "active", presetId: "default", consentLog: [], activeLeafId: null, createdAt: "", stoppedAt: null, stopReason: null };
const message = (id: string, role: Message["role"], content: string, speakerCharacterId: string | null): Message => ({ id, sessionId: session.id, role, speakerCharacterId, content, parentId: null, swipeGroupId: id, swipeIndex: 0, seq: Number(id.slice(1)), status: "final", createdAt: "" });

describe("session context basket", () => {
  it("shares participants, recent events, memories, lore, and open threads", () => {
    const memory: MemoryFact = { id: "mem", characterId: one.id, kind: "fact", content: "Carries a silver compass", sourceTurnId: "u1", createdAt: "", userApproved: true, forgottenAt: null };
    const lore: LoreEntry = { id: "l1", characterId: null, characterIds: [], keys: [], content: "The harbor closes at midnight.", enabled: true, insertionOrder: 1, createdAt: "" };
    const basket = buildSessionContextBasket(session, [message("m1", "user", "What should we do next?", null), message("m2", "character", "Bex points toward the harbor.", two.id)], [{ characterName: one.name, memory }], [lore], { sourceOfTruth: "They are inside the observatory, not at the harbor.", updatedAt: "2026-01-02T00:00:00.000Z", synthesizedSource: "Location & time:\n- Observatory at night\nParticipants:\n- Bex is pointing west", synthesizedUpdatedAt: "2026-01-02T00:01:00.000Z" });
    expect(basket.participants.map((entry) => entry.name)).toEqual(["Aria", "Bex"]);
    expect(basket.recentEvents.at(-1)).toContain("Bex points toward the harbor");
    expect(basket.rememberedFacts).toEqual(["Aria: Carries a silver compass"]);
    expect(basket.activeLore).toEqual(["The harbor closes at midnight."]);
    expect(basket.openThreads).toContain("What should we do next?");
    expect(basket.sourceOfTruth).toContain("inside the observatory");
    expect(basket.editableSource).toBe("They are inside the observatory, not at the harbor.");
    expect(basket.sourceOfTruth).toContain("SYNTHESIZED CURRENT SCENE FACTS");
    expect(basket.sourceOfTruth).toContain("Bex is pointing west");
    expect(basket.sourceOfTruth).not.toContain("Bex: Bex points toward the harbor");
    expect(contextBasketText(basket)).toMatch(/^AUTHORITATIVE CURRENT SCENE/);
    expect(contextBasketText(basket)).toContain("never contradict it");
    expect(contextBasketText(basket)).toContain("Approved shared memories");
  });
});
