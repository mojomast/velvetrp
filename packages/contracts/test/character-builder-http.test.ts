import { describe, expect, it } from "vitest";
import { characterDraftHttpViewSchema, createCharacterDraftHttpInputSchema } from "../src/character-builder-http.js";

describe("character builder HTTP projections", () => {
  it("rejects controller and audit fields rather than passing them through", () => {
    const result = createCharacterDraftHttpInputSchema.safeParse({
      personaId: "persona-1", durability: "durable", allocation: { method: "server-roll" }, idempotencyKey: "idem-1",
      controllerPrincipalId: "attacker",
    });
    expect(result.success).toBe(false);
    expect(characterDraftHttpViewSchema.safeParse({ id: "draft-1", controllerPrincipalId: "secret" }).success).toBe(false);
  });
});
