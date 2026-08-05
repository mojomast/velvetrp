import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("M1.5 repository composition", () => {
  it("exposes factory-only facades and rejects unauthorized writes before clock/IDs", () => {
    const ids={nextId:vi.fn(()=>"never-used")};
    const clock={now:vi.fn(()=>new Date("2030-01-01T00:00:00.000Z"))};
    const repository=createRepository({dataDir:process.env.VELVET_DATA_DIR as string,ids,clock});
    expect(typeof repository.mutateActorResource).toBe("function");
    expect(typeof repository.mutateInventory).toBe("function");
    expect(typeof repository.mutateEconomy).toBe("function");
    expect(typeof repository.takeRest).toBe("function");
    expect(()=>repository.mutateActorResource("missing",{type:"change_actor_resource",campaignId:"campaign",actorId:"actor",resourceId:"health",amount:-1,expectedRevision:0,idempotencyKey:"key"})).toThrow();
    expect(ids.nextId).not.toHaveBeenCalled();
    expect(clock.now).not.toHaveBeenCalled();
    repository.close();
  });
});
