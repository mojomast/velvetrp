import { DND_5E_RULESET } from "./dnd5e.js";
import { VELVET_LEGACY_RULESET } from "./velvetLegacy.js";
import type { RulesetModule } from "./types.js";

export const DEFAULT_RULESET_ID = DND_5E_RULESET.descriptor.id;
export const DEFAULT_RULESET = DND_5E_RULESET;

export class RulesetRegistry {
  readonly #rulesets = new Map<string, RulesetModule>();

  constructor(rulesets: readonly RulesetModule[] = []) {
    for (const ruleset of rulesets) this.register(ruleset);
  }

  register(ruleset: RulesetModule): void {
    const key = `${ruleset.descriptor.id}@${ruleset.descriptor.version}`;
    if (this.#rulesets.has(key)) throw new Error(`duplicate ruleset identity: ${key}`);
    this.#rulesets.set(key, ruleset);
  }

  get(id: string, version?: string): RulesetModule {
    const matches = [...this.#rulesets.values()].filter((candidate) => candidate.descriptor.id === id);
    const ruleset = version === undefined ? (matches.length === 1 ? matches[0] : undefined) : this.#rulesets.get(`${id}@${version}`);
    if (ruleset === undefined) throw new Error(`unknown ruleset identity: ${id}@${version ?? "unspecified"}`);
    return ruleset;
  }

  list(): readonly RulesetModule[] {
    return Object.freeze([...this.#rulesets.values()]);
  }
}

export function createDefaultRulesetRegistry(): RulesetRegistry {
  return new RulesetRegistry([DEFAULT_RULESET, VELVET_LEGACY_RULESET]);
}
