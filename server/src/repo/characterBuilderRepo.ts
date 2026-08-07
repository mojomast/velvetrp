import type DatabaseDriver from "better-sqlite3";
import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  characterBuilderAllocationSchema,
  type CharacterBuilderAllocation,
  type CharacterDraftMutationReceipt,
  type CharacterDraftView,
} from "@velvet/contracts";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../runtime.js";
import {
  CharacterBuilderAuthorizationError,
  CharacterBuilderConflictError,
  CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError,
  CharacterBuilderStaleError,
  CharacterBuilderUnavailableError,
  createCharacterBuilderReadRepository,
  createCharacterBuilderWriteRepository,
  type CharacterBuilderWriteRepository,
} from "./characterBuilder/index.js";

export {
  CharacterBuilderAuthorizationError,
  CharacterBuilderConflictError,
  CharacterBuilderExpiredError,
  CharacterBuilderIncompleteError,
  CharacterBuilderStaleError,
  CharacterBuilderUnavailableError,
} from "./characterBuilder/index.js";

type Dependencies = { clock: Clock; ids: IdGenerator; rng: RandomNumberGenerator };

/** Roll each physical die independently through the injected bounded RNG. */
export function rollCharacterBuilderAttributes(rng: RandomNumberGenerator): Extract<CharacterBuilderAllocation, { method: "server-roll" }> {
  const nextDie = () => {
    const value = rng.integer(1, 7);
    if (!Number.isSafeInteger(value) || value < 1 || value > 6) throw new Error("character builder RNG returned an out-of-range die");
    return value;
  };
  const terms = CHARACTER_BUILDER_ATTRIBUTE_IDS.map((attributeId) => {
    const dice = [nextDie(), nextDie(), nextDie(), nextDie()];
    const minimum = Math.min(...dice);
    const droppedIndex = dice.indexOf(minimum);
    return { attributeId, dice, droppedIndex, score: dice.reduce((sum, die) => sum + die, 0) - minimum };
  });
  const scores = Object.fromEntries(terms.map((term) => [term.attributeId, term.score]));
  return characterBuilderAllocationSchema.parse({ method: "server-roll", algorithm: "velvet-4d6-drop-first-lowest-v1", scores, terms }) as Extract<CharacterBuilderAllocation, { method: "server-roll" }>;
}

/** Public character-builder repository, composed from independent read and write factories. */
export interface CharacterBuilderRepository extends CharacterBuilderWriteRepository {
  getCharacterDraft(actorPrincipalId: string, draftId: string): CharacterDraftView | null;
  getCharacterDraftReceipt(actorPrincipalId: string, draftId: string, commandId: string): CharacterDraftMutationReceipt | import("@velvet/contracts").CharacterFinalizationReceipt | null;
}

/** Creates the public character-builder facade while sharing one read repository with commands. */
export function createCharacterBuilderRepository(
  db: DatabaseDriver.Database,
  dependencies: Dependencies,
  assertFactoryMutation: () => void,
): CharacterBuilderRepository {
  const reads = createCharacterBuilderReadRepository(db, dependencies);
  const writes = createCharacterBuilderWriteRepository(db, { ...dependencies, reads, assertFactoryMutation });
  return {
    ...writes,
    getCharacterDraft: reads.getCharacterDraft,
    getCharacterDraftReceipt: reads.getCharacterDraftReceipt,
  };
}
