import { describe, expect, it } from "vitest";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { isMonsterKnockdown, monsterBehavior } from "../src/repo/encounter/monsterTurnPlanner.js";

describe("monster turn policies", () => {
  it("keeps supported traits deterministic and bounded by the combat model", () => {
    expect(monsterBehavior("srd-5.1:enemy-template:wolf")).toEqual({
      targetPriority: "lowest-hit-points", packTactics: true, knockdown: true, nimbleEscape: false,
    });
    expect(monsterBehavior("srd-5.1:enemy-template:goblin")).toMatchObject({
      targetPriority: "lowest-hit-points", nimbleEscape: true,
    });
    expect(monsterBehavior("srd-5.1:enemy-template:bandit")).toMatchObject({
      targetPriority: "lowest-hit-points", packTactics: false,
    });
    expect(monsterBehavior("velvet:test-fixture:enemy-template:training-dummy")).toEqual({
      targetPriority: "first-legal", packTactics: false, knockdown: false, nimbleEscape: false,
    });
  });

  it("keeps catalog-pinned trait evidence closed and deterministic", () => {
    expect(monsterBehavior("srd-5.1:enemy-template:goblin").nimbleEscape).toBe(true);
    expect(monsterBehavior("srd-5.1:enemy-template:wolf")).toMatchObject({ packTactics: true, knockdown: true });
  });

  it("pins alternate monster profiles without changing the Training Dummy", () => {
    const enemy = (name: string) => SRD_5_1_STARTER_CATALOG.definitions.find((entry) => entry.reference.kind === "enemy-template" && entry.name === name)! as any;
    expect(enemy("Training Dummy").mechanics.abilityRefs).toHaveLength(1);
    expect(enemy("Goblin").mechanics.abilityRefs.map((ref: any) => ref.definitionId)).toEqual([
      "srd-5.1:ability:goblin-scimitar", "srd-5.1:ability:goblin-nimble-escape",
    ]);
    expect(enemy("Wolf").mechanics.abilityRefs.map((ref: any) => ref.definitionId)).toEqual([
      "srd-5.1:ability:wolf-bite", "srd-5.1:ability:wolf-pack-tactics", "srd-5.1:ability:wolf-knockdown",
    ]);
  });

  it("only applies Wolf knockdown after a confirmed hit", () => {
    const wolf = { knockdown: true } as unknown as Parameters<typeof isMonsterKnockdown>[0];
    expect(isMonsterKnockdown(wolf, true)).toBe(true);
    expect(isMonsterKnockdown(wolf, false)).toBe(false);
  });
});
