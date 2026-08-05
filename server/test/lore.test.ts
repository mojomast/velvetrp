import { describe, expect, it } from "vitest";
import { loreBlock, selectLoreEntries } from "../src/lore.js";
import type { LoreEntry } from "../src/types.js";

function entry(overrides: Partial<LoreEntry> = {}): LoreEntry {
  return {
    id: Math.random().toString(36),
    characterId: null,
    characterIds: [],
    keys: ["nebula"],
    content: "The nebula glows violet at dusk.",
    enabled: true,
    insertionOrder: 100,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("selectLoreEntries", () => {
  it("matches entries whose keys appear in recent text", () => {
    const selected = selectLoreEntries([entry()], "c1", "we fly toward the nebula", 700);
    expect(selected).toHaveLength(1);
  });

  it("always selects enabled entries with zero keys", () => {
    const selected = selectLoreEntries([entry({ keys: [] })], "c1", "text with no trigger", 700);
    expect(selected).toHaveLength(1);
  });

  it("skips disabled and non-matching entries", () => {
    const entries = [entry({ enabled: false }), entry({ keys: ["volcano"] })];
    expect(selectLoreEntries(entries, "c1", "the nebula awaits", 700)).toHaveLength(0);
  });

  it("scopes character-specific entries to the active character", () => {
    const forOther = entry({ characterId: "other", characterIds: ["other"] });
    const forActive = entry({ characterId: "c1", characterIds: ["c1"] });
    expect(selectLoreEntries([forOther], "c1", "nebula", 700)).toHaveLength(0);
    expect(selectLoreEntries([forActive], "c1", "nebula", 700)).toHaveLength(1);
  });

  it("respects insertion order and the char budget", () => {
    const first = entry({ insertionOrder: 1, content: "a".repeat(50) });
    const second = entry({ insertionOrder: 2, content: "b".repeat(50) });
    const selected = selectLoreEntries([second, first], "c1", "nebula", 60);
    expect(selected[0]?.content.startsWith("a")).toBe(true);
    expect(selected[1]?.content.length).toBeLessThanOrEqual(10);
  });

  it("caps at 6 entries", () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry({ insertionOrder: i, content: "short" }));
    expect(selectLoreEntries(entries, "c1", "nebula", 5000)).toHaveLength(6);
  });
});

describe("loreBlock", () => {
  it("renders a fallback when empty", () => {
    expect(loreBlock([])).toMatch(/No lore entries triggered/);
  });

  it("renders keys and content", () => {
    expect(loreBlock([entry()])).toContain("[nebula]");
  });
});
