import { describe, expect, it } from "vitest";
import {
  characterDraftHttpFinalizationResultSchema,
  characterDraftHttpViewSchema,
  createCharacterDraftHttpInputSchema,
  finalizeCharacterDraftHttpInputSchema,
} from "../src/character-builder-http.js";

const at = "2030-01-01T00:00:00.000Z";
const derived = {
  maxHp: 10, defenses: { guard: 10, evasion: 10, will: 10 }, initiative: 0, speed: 30,
  carryingLimit: 100, spellAttack: 0, saveDc: 10,
  explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"].map((statistic) => ({ statistic, formula: "base", inputs: {}, result: 0 })),
};
const finalization = {
  character: { id: "character-1", createdAt: at, updatedAt: at },
  sheet: {
    id: "sheet-1",
    race: { packId: "pack", packVersion: "1", kind: "race", definitionId: "race" },
    background: { packId: "pack", packVersion: "1", kind: "background", definitionId: "background" },
    classes: [{ class: { packId: "pack", packVersion: "1", kind: "class", definitionId: "class" }, level: 1 }],
    attributes: [], proficiencies: [], choices: [], createdAt: at, updatedAt: at,
  },
  resources: [{ name: "health", current: 10, max: 10 }],
  receipt: { idempotencyKey: "finalize-1", revisionBefore: 1, revisionAfter: 2, occurredAt: at, derived, startingGrants: [] },
};

describe("character builder HTTP projections", () => {
  it("rejects controller and audit fields rather than passing them through", () => {
    const result = createCharacterDraftHttpInputSchema.safeParse({
      personaId: "persona-1", durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: "idem-1",
      controllerPrincipalId: "attacker",
    });
    expect(result.success).toBe(false);
    expect(characterDraftHttpViewSchema.safeParse({ id: "draft-1", controllerPrincipalId: "secret" }).success).toBe(false);
  });

  it("uses a strict minimal finalize request", () => {
    expect(finalizeCharacterDraftHttpInputSchema.parse({ expectedRevision: 1, idempotencyKey: "finalize-1" })).toEqual({ expectedRevision: 1, idempotencyKey: "finalize-1" });
    expect(finalizeCharacterDraftHttpInputSchema.safeParse({ expectedRevision: 1, idempotencyKey: "finalize-1", progressionMode: "xp" }).success).toBe(false);
  });

  it("returns public finalized state without private identities", () => {
    expect(characterDraftHttpFinalizationResultSchema.parse(finalization)).toEqual(finalization);
    expect(characterDraftHttpFinalizationResultSchema.safeParse({ ...finalization, extra: true }).success).toBe(false);
    expect(characterDraftHttpFinalizationResultSchema.safeParse({
      ...finalization,
      character: { ...finalization.character, characterId: "persona-1" },
    }).success).toBe(false);
    expect(characterDraftHttpFinalizationResultSchema.safeParse({
      ...finalization,
      receipt: { ...finalization.receipt, actorId: "actor-1" },
    }).success).toBe(false);
    for (const privateField of ["draft", "controllerPrincipalId", "role", "commandId", "eventId", "actorId", "campaignId", "characterId", "sheetId"] as const) {
      expect(characterDraftHttpFinalizationResultSchema.safeParse({ ...finalization, [privateField]: "private" }).success).toBe(false);
    }
  });

  it("requires the initialized health resource to match derived HP", () => {
    expect(characterDraftHttpFinalizationResultSchema.safeParse({
      ...finalization,
      resources: [{ name: "health", current: 9, max: 10 }],
    }).success).toBe(false);
    expect(characterDraftHttpFinalizationResultSchema.safeParse({
      ...finalization,
      receipt: { ...finalization.receipt, revisionAfter: 3 },
    }).success).toBe(false);
  });
});
