import { describe, expect, it } from "vitest";
import {
  adventureNarrationMessages,
  adventurePlanningMessages,
  conversationNarrationMessages,
} from "../src/agent/adventurePrompt.js";
import { dmNarrationMessages } from "../src/agent/dmNarration.js";
import { preferredCastFromRepositories } from "../src/agent/rosterCastContext.js";
import { mergeRosterNpcs, rankNpcsForLocation, rosterPreferenceInstructions } from "../src/agent/rosterPreference.js";
import { defaultHarnessSettings } from "../src/defaults.js";

const HN = [
  { name: "I Sneeze Kittens", homeLocation: "ASK HERMES Plaza", archetype: "Snarky plaza regular" },
  { name: "GGB the Gummy Bee", homeLocation: "Psyche Spire", archetype: "Sticky gardener of Psyche Spire" },
  { name: "FatCat", homeLocation: "Hackathon Carnival", archetype: "Comfort-stall keeper" },
  { name: "realtimeuk", homeLocation: "Hackathon Carnival", archetype: "Patient card player" },
  { name: "The Proprietor", homeLocation: "Hackathon Carnival", factionIds: ["black-box-consortium"] },
  { name: "GottZ", homeLocation: "Hermes Hellcarrier Flight Deck", archetype: "Loud night kart racer" },
  { name: "TunaCookie", homeLocation: "Hermes Hellcarrier Flight Deck", archetype: "Quiet night kart strategist" },
  { name: "Emozilla", homeLocation: "Teknium's Lighthouse Tower", factionIds: ["hermes-agent-squad"] },
  {
    name: "Kainan",
    homeLocation: "Gateway Exchange",
    factionIds: ["house-of-gold"],
    archetype: "House of Gold broker",
  },
  { name: "Witcheer", homeLocation: "Hackathon Carnival", factionIds: ["house-of-gold"] },
] as const;

describe("rankNpcsForLocation", () => {
  it("puts home-location NPCs in tiedToLocation and keeps other-home NPCs on the wider roster", () => {
    const plaza = rankNpcsForLocation({ locationName: "ASK HERMES Plaza", npcs: HN });
    expect(plaza.present).toEqual([]);
    expect(plaza.tiedToLocation).toEqual(["I Sneeze Kittens"]);
    expect(plaza.widerRoster).toEqual(
      expect.arrayContaining(["GGB the Gummy Bee", "FatCat", "GottZ", "TunaCookie", "Emozilla"]),
    );
    expect(plaza.widerRoster).not.toContain("I Sneeze Kittens");

    const carnival = rankNpcsForLocation({ locationName: "Hackathon Carnival", npcs: HN });
    expect(carnival.tiedToLocation).toEqual(["FatCat", "realtimeuk", "The Proprietor", "Witcheer"]);
    expect(carnival.widerRoster).toContain("GGB the Gummy Bee");
    expect(carnival.tiedToLocation).not.toContain("GGB the Gummy Bee");

    const deck = rankNpcsForLocation({ locationName: "Hermes Hellcarrier Flight Deck", npcs: HN });
    expect(deck.tiedToLocation).toEqual(["GottZ", "TunaCookie"]);
  });

  it("keeps a Psyche Spire gardener off the plaza present and tied lists (hn1 gummy-bee drift)", () => {
    const ranked = rankNpcsForLocation({
      locationName: "ASK HERMES Plaza",
      presentNames: ["I Sneeze Kittens"],
      npcs: HN,
    });
    expect(ranked.present).toEqual(["I Sneeze Kittens"]);
    expect(ranked.tiedToLocation).toEqual([]);
    expect(ranked.widerRoster).toContain("GGB the Gummy Bee");
    expect(ranked.present).not.toContain("GGB the Gummy Bee");
    expect(ranked.tiedToLocation).not.toContain("GGB the Gummy Bee");
  });

  it("offers the kart racers from the wider roster at the Night Kart Circuit, and never invents extras", () => {
    const ranked = rankNpcsForLocation({ locationName: "Night Kart Circuit", npcs: HN });
    expect(ranked.present).toEqual([]);
    expect(ranked.tiedToLocation).toEqual([]);
    expect(ranked.widerRoster).toEqual(expect.arrayContaining(["GottZ", "TunaCookie"]));
    for (const invented of ["Ovi", "Sable", "Wren"]) {
      expect(ranked.present.concat(ranked.tiedToLocation, ranked.widerRoster)).not.toContain(invented);
    }
  });

  it("ties NPCs that share a faction or quest with the location after home-location matches", () => {
    const ranked = rankNpcsForLocation({
      locationName: "Gateway Exchange",
      npcs: HN,
      locationTies: { locationName: "Gateway Exchange", factionIds: ["house-of-gold"] },
    });
    expect(ranked.tiedToLocation[0]).toBe("Kainan");
    expect(ranked.tiedToLocation).toContain("Witcheer");
    expect(ranked.tiedToLocation).not.toContain("The Proprietor");
  });

  it("does not repeat a present NPC in the tied or wider lists", () => {
    const ranked = rankNpcsForLocation({
      locationName: "Hackathon Carnival",
      presentNames: ["FatCat", "FatCat"],
      npcs: HN,
    });
    expect(ranked.present).toEqual(["FatCat"]);
    expect(ranked.tiedToLocation).toEqual(["realtimeuk", "The Proprietor", "Witcheer"]);
    expect(ranked.widerRoster).not.toContain("FatCat");
  });
});

describe("rosterPreferenceInstructions", () => {
  it("tells the GM to use present, then tied, then the wider roster, and not to invent named extras or move people", () => {
    const text = rosterPreferenceInstructions(rankNpcsForLocation({ locationName: "Night Kart Circuit", npcs: HN }));
    expect(text).toMatch(/present/i);
    expect(text).toMatch(/tied|linked|associated/i);
    expect(text).toMatch(/wider roster|rest of the roster|known roster/i);
    expect(text).toMatch(/do not invent named (extras|npcs)|before inventing named/i);
    expect(text).toMatch(/not (established as )?present|do not place/i);
    expect(text).toContain("GottZ");
    expect(text).toContain("TunaCookie");
    expect(text).not.toMatch(/\bOvi\b|\bSable\b|\bWren\b/);
  });
});

const harness = defaultHarnessSettings();
const preferredCast = rankNpcsForLocation({ locationName: "Night Kart Circuit", npcs: HN });

function allContent(messages: ReadonlyArray<{ content?: string | null }>): string {
  return messages.map((message) => message.content ?? "").join("\n");
}

describe("adventure prompts carry roster preference", () => {
  it("includes the ranked lists and the no-invent / no-drift rules in planning and both narration lanes", () => {
    const publicContext = { preferredCast };
    const narration = allContent(
      adventureNarrationMessages({
        declaration: "I look for a race official.",
        currentLocation: "Night Kart Circuit",
        currentActorName: "Teknium",
        publicContext,
        receipts: [],
        history: [],
        harness,
      }),
    );
    const conversation = allContent(
      conversationNarrationMessages({
        declaration: "I ask who runs the track.",
        currentLocation: "Night Kart Circuit",
        currentActorName: "Teknium",
        publicContext,
        history: [],
        harness,
      }),
    );
    const planning = allContent(
      adventurePlanningMessages({
        authorityContext: "public world facts",
        declaration: "I look for a race official.",
        audience: "player",
        campaignRole: "player",
        control: "full",
        limitations: [],
        history: [],
        harness,
        preferredCast,
      }),
    );
    for (const [label, text] of [
      ["narration", narration],
      ["conversation", conversation],
      ["planning", planning],
    ] as const) {
      expect(text, label).toContain("GottZ");
      expect(text, label).toContain("TunaCookie");
      expect(text, label).toMatch(/do not invent named (extras|npcs)|before inventing named/i);
      expect(text, label).toMatch(
        /only (?:those |NPCs listed in )?presentNpcNames|not (established as )?present|do not place/i,
      );
    }
  });

  it("tells DM narration the same roster-first rule when preferredCast is in public context", () => {
    const text = allContent(
      dmNarrationMessages({ preferredCast, currentLocation: "Night Kart Circuit" }, "The scene holds."),
    );
    expect(text).toContain("GottZ");
    expect(text).toMatch(/do not invent named (extras|npcs)|before inventing named/i);
  });
});

describe("mergeRosterNpcs", () => {
  it("keeps the first spelling and fills a home location from a later row", () => {
    const merged = mergeRosterNpcs(
      [{ name: "GottZ", archetype: "Loud night kart racer" }, { name: "TunaCookie" }],
      [{ name: "gottz", homeLocation: "Hermes Hellcarrier Flight Deck" }],
    );
    expect(merged).toEqual([
      { name: "GottZ", homeLocation: "Hermes Hellcarrier Flight Deck", archetype: "Loud night kart racer" },
      { name: "TunaCookie" },
    ]);
  });
});

describe("preferredCastFromRepositories", () => {
  it("ranks listed and placed NPCs without inventing extras or treating a wider-roster racer as present", () => {
    const ranked = preferredCastFromRepositories({
      locationName: "Night Kart Circuit",
      presentNames: [],
      listNpcs: () => ({
        npcs: [
          { publicState: { name: "GottZ", archetype: "Loud night kart racer" } },
          { publicState: { name: "TunaCookie" } },
          { publicState: { name: "FatCat" } },
        ],
      }),
      getCast: () => ({
        state: "running",
        presentCast: [
          { publicState: { name: "GottZ" }, location: { label: "Hermes Hellcarrier Flight Deck" } },
          { publicState: { name: "TunaCookie" }, location: { label: "Hermes Hellcarrier Flight Deck" } },
        ],
      }),
    });
    expect(ranked?.present).toEqual([]);
    expect(ranked?.tiedToLocation).toEqual([]);
    expect(ranked?.widerRoster).toEqual(expect.arrayContaining(["GottZ", "TunaCookie", "FatCat"]));
    for (const invented of ["Ovi", "Sable", "Wren"]) {
      expect(ranked?.present.concat(ranked.tiedToLocation, ranked.widerRoster)).not.toContain(invented);
    }
  });

  it("puts a co-located NPC in present and a differently placed NPC on the wider roster", () => {
    const ranked = preferredCastFromRepositories({
      locationName: "ASK HERMES Plaza",
      presentNames: ["I Sneeze Kittens"],
      listNpcs: () => ({
        npcs: [{ publicState: { name: "I Sneeze Kittens" } }, { publicState: { name: "GGB the Gummy Bee" } }],
      }),
      getCast: () => ({
        state: "running",
        presentCast: [
          { publicState: { name: "I Sneeze Kittens" }, location: { label: "ASK HERMES Plaza" } },
          { publicState: { name: "GGB the Gummy Bee" }, location: { label: "Psyche Spire" } },
        ],
      }),
    });
    expect(ranked?.present).toEqual(["I Sneeze Kittens"]);
    expect(ranked?.tiedToLocation).toEqual([]);
    expect(ranked?.widerRoster).toContain("GGB the Gummy Bee");
    expect(ranked?.present).not.toContain("GGB the Gummy Bee");
  });
});
