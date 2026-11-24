import { personaProfileSchema } from "@velvet/contracts";
import { SINTERMARK_HEROES, SINTERMARK_HERO_PROFILES, type HeroSpec } from "./sintermarkParty.js";
import hermesPartyJson from "./recipes/hermes-nous-party.json" with { type: "json" };
import hermesWorldJson from "./recipes/hermes-nous-world.json" with { type: "json" };
import sintermarkRecipeJson from "./recipes/sintermark-world.json" with { type: "json" };

export const QUICK_ADVENTURE_ADVENTURE_IDS = ["sintermark", "hermes-nous"] as const;
export type QuickAdventureId = (typeof QUICK_ADVENTURE_ADVENTURE_IDS)[number];

export type PersonaProfile = ReturnType<typeof personaProfileSchema.parse>;

export interface QuickAdventurePartySpec {
  heroes: readonly HeroSpec[];
  profiles: Record<string, PersonaProfile>;
}

export interface QuickAdventureDefinition {
  id: QuickAdventureId;
  recipeJson: unknown;
  party: QuickAdventurePartySpec;
  openingLine: string;
}

const SINTERMARK_OPENING_LINE =
  "Those readings disagree. Orra, keep the street clear while I compare the raw log with the gauge.";

type HermesPartyHero = Omit<HeroSpec, "knownCantrips"> & {
  knownCantrips?: readonly string[];
  profile: unknown;
};

const HERMES_PARTY_HEROES = hermesPartyJson.heroes as unknown as readonly HermesPartyHero[];

const HERMES_HEROES: readonly HeroSpec[] = HERMES_PARTY_HEROES.map((hero) => ({
  ...hero,
  knownCantrips: hero.knownCantrips ?? [],
}));

const HERMES_HERO_PROFILES: Record<string, PersonaProfile> = Object.fromEntries(
  HERMES_PARTY_HEROES.map((hero) => [hero.key, personaProfileSchema.parse(hero.profile)]),
);

const DEFINITIONS: Record<QuickAdventureId, QuickAdventureDefinition> = {
  sintermark: {
    id: "sintermark",
    recipeJson: sintermarkRecipeJson,
    party: { heroes: SINTERMARK_HEROES, profiles: SINTERMARK_HERO_PROFILES },
    openingLine: SINTERMARK_OPENING_LINE,
  },
  "hermes-nous": {
    id: "hermes-nous",
    recipeJson: hermesWorldJson,
    party: { heroes: HERMES_HEROES, profiles: HERMES_HERO_PROFILES },
    openingLine: "Hellcarrier's docked over the Carnival. Hermes, what do we fix first?",
  },
};

function recipeName(recipeJson: unknown): string {
  if (!recipeJson || typeof recipeJson !== "object") throw new Error("quick adventure recipe name is required");
  const name = (recipeJson as Record<string, unknown>).name;
  if (typeof name !== "string" || !name) throw new Error("quick adventure recipe name is required");
  return name;
}

export function getQuickAdventure(id: string): QuickAdventureDefinition {
  if (!QUICK_ADVENTURE_ADVENTURE_IDS.includes(id as QuickAdventureId)) {
    throw new Error(`unknown quick adventure: ${id}`);
  }
  return DEFINITIONS[id as QuickAdventureId];
}

export function listQuickAdventures(): Array<{ id: QuickAdventureId; name: string; heroes: string[] }> {
  return QUICK_ADVENTURE_ADVENTURE_IDS.map((id) => {
    const definition = DEFINITIONS[id];
    return {
      id,
      name: recipeName(definition.recipeJson),
      heroes: definition.party.heroes.map((hero) => hero.name),
    };
  });
}
