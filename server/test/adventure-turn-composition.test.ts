import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("M4.2 repository composition", () => {
  it("exposes planning persistence without exposing execution through a unit of work", () => {
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    expect(typeof repository.startAgentProviderCall).toBe("function");
    expect(typeof repository.persistAgentDecisionRound).toBe("function");
    expect(typeof repository.markAgentReadOutcome).toBe("function");
    expect("bindAgentMutation" in repository).toBe(false);
    expect("linkAgentReceipt" in repository).toBe(false);
    expect(typeof repository.getDurableAgentPlanningState).toBe("function");
    repository.transaction((unit) => {
      expect("startAgentProviderCall" in unit).toBe(false);
      expect("persistAgentDecisionRound" in unit).toBe(false);
      return null;
    });
    repository.close();
  });
});
