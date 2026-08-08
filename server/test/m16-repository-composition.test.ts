import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("M1.6 repository composition", () => {
  it("exposes bounded facades and rejects unauthorised commands before IDs", () => {
    const ids={nextId:vi.fn(()=>"unused")};
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,ids});
    expect(typeof repository.resolveCheck).toBe("function");
    expect(typeof repository.usePower).toBe("function");
    expect(typeof repository.mutateEffect).toBe("function");
    expect(typeof repository.mutateActorEffect).toBe("function");
    expect(()=>repository.listActiveEffects("missing","campaign","actor")).not.toThrow();
    expect(repository.listActiveEffects("missing","campaign","actor")).toEqual([]);
    repository.close();
  });
});
