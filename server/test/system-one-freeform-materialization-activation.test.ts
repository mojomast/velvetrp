import { afterEach, describe, expect, it } from "vitest";
import {
  FREEFORM_CANDIDATE_KEY,
  FREEFORM_LEGAL_KEY,
  FREEFORM_MATERIALIZATION_ACTION_FAMILY,
  FREEFORM_MATERIALIZATION_NONE,
  FREEFORM_NEEDS_CONTENT_KEY,
  executeFreeformMaterializationLane,
  type FreeformMaterializationCandidate,
  type FreeformMaterializationExecutionPort,
} from "../src/agent/systemOneFreeformMaterialization.js";
import { systemOneEvaluationBinding } from "../src/agent/systemOneBinding.js";
import { SYSTEM_ONE_PROMOTION_RECORDS } from "../src/agent/systemOnePromotion.js";
import { defaultSystemOneLaneModes, defaultSystemOneSettings } from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import type { Repository } from "../src/repo/index.js";
import type { SystemOneSettings } from "../src/types.js";

// Compile-time proof that the real repository satisfies the narrow execution port without a cast.
type AssertAssignable<_T extends U, U> = true;
type _RepositorySatisfiesExecutionPort = AssertAssignable<Repository, FreeformMaterializationExecutionPort>;

const LANE = "freeform-materialization" as const;

const LOCATION: FreeformMaterializationCandidate = {
  candidateId: "ffc-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  kind: "materialize-location",
  label: "Glassblower's district",
};
const NPC: FreeformMaterializationCandidate = {
  candidateId: "ffn-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  kind: "materialize-npc",
  label: "The glassblower",
};

const KIND_CANDIDATE: Record<FreeformMaterializationCandidate["kind"], FreeformMaterializationCandidate> = {
  "materialize-location": LOCATION,
  "materialize-npc": NPC,
  "hostile-encounter": { candidateId: "ffe-cccccccccccccccccccccccccccccccccccccccc", kind: "hostile-encounter", label: "Goblin raiders" },
  "shop-stock": { candidateId: "ffsc-dddddddddddddddddddddddddddddddddddddddd", kind: "shop-stock", label: "The merchant's wares" },
  "new-clue": { candidateId: "ffl-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", kind: "new-clue", label: "The drowned courier" },
  "materialize-faction": { candidateId: "fff-ffffffffffffffffffffffffffffffffffffffff", kind: "materialize-faction", label: "The thieves' guild" },
  "materialize-quest": { candidateId: "ffq-1111111111111111111111111111111111111111", kind: "materialize-quest", label: "A bounty on the road bandits" },
  "materialize-rumor": { candidateId: "ffr-2222222222222222222222222222222222222222", kind: "materialize-rumor", label: "The pale tide" },
};

/** The single receipted repository method each advertised kind may route to. */
const KIND_METHOD: Record<FreeformMaterializationCandidate["kind"], keyof FreeformMaterializationExecutionPort> = {
  "materialize-location": "materializeFreeformTravel",
  "materialize-npc": "materializeFreeformNpc",
  "hostile-encounter": "materializeFreeformEncounter",
  "shop-stock": "materializeFreeformShop",
  "new-clue": "materializeFreeformLore",
  "materialize-faction": "materializeFreeformFaction",
  "materialize-quest": "materializeFreeformQuest",
  "materialize-rumor": "materializeFreeformRumor",
};

interface PortCall {
  method: keyof FreeformMaterializationExecutionPort;
  args: readonly unknown[];
}

function answers(options: {
  choice?: string;
  choiceProbability?: number;
  needsContent?: number;
  legal?: number;
} = {}): Record<string, SystemOneAnswer> {
  const choice = options.choice ?? LOCATION.candidateId;
  const probability = options.choiceProbability ?? 0.95;
  return {
    [FREEFORM_NEEDS_CONTENT_KEY]: { type: "noul", noul: options.needsContent ?? 0.95 },
    [FREEFORM_LEGAL_KEY]: { type: "noul", noul: options.legal ?? 0.95 },
    [FREEFORM_CANDIDATE_KEY]: {
      type: "choice",
      choice,
      confidence: probability,
      probabilities: { [choice]: probability, [FREEFORM_MATERIALIZATION_NONE]: 1 - probability },
    },
  };
}

function fakePort(failWith?: Error): FreeformMaterializationExecutionPort & { calls: PortCall[] } {
  const calls: PortCall[] = [];
  const record = (method: keyof FreeformMaterializationExecutionPort, args: readonly unknown[]): void => {
    calls.push({ method, args });
    if (failWith) throw failWith;
  };
  return {
    calls,
    materializeFreeformTravel(...args) {
      record("materializeFreeformTravel", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformTravel"]>;
    },
    materializeFreeformNpc(...args) {
      record("materializeFreeformNpc", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformNpc"]>;
    },
    materializeFreeformEncounter(...args) {
      record("materializeFreeformEncounter", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformEncounter"]>;
    },
    materializeFreeformShop(...args) {
      record("materializeFreeformShop", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformShop"]>;
    },
    materializeFreeformLore(...args) {
      record("materializeFreeformLore", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformLore"]>;
    },
    materializeFreeformFaction(...args) {
      record("materializeFreeformFaction", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformFaction"]>;
    },
    materializeFreeformQuest(...args) {
      record("materializeFreeformQuest", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformQuest"]>;
    },
    materializeFreeformRumor(...args) {
      record("materializeFreeformRumor", args);
      return { status: "materialized" } as unknown as ReturnType<FreeformMaterializationExecutionPort["materializeFreeformRumor"]>;
    },
  };
}

function laneSettings(overrides: Partial<SystemOneSettings> = {}): SystemOneSettings {
  return {
    ...defaultSystemOneSettings(),
    enabled: true,
    laneModes: { ...defaultSystemOneLaneModes(), [LANE]: "active" },
    apiKey: "test-key",
    ...overrides,
  };
}

/** Test-only promotion override; removed after every test so the lane stays unpromoted elsewhere. */
function approveForTest(settings: SystemOneSettings, responseModel = settings.model): void {
  SYSTEM_ONE_PROMOTION_RECORDS[LANE] = {
    evaluatedBindings: [systemOneEvaluationBinding(LANE, settings, responseModel, FREEFORM_MATERIALIZATION_ACTION_FAMILY)],
    metrics: { samples: 60, accuracy: 0.98, brier: 0.02, expectedCalibrationError: 0.02 },
    calibration: null,
    promotedAt: "2026-01-01",
    evidence: "test-only",
  };
}

afterEach(() => {
  delete SYSTEM_ONE_PROMOTION_RECORDS[LANE];
});

const INPUT = {
  campaignId: "campaign-activation",
  sessionId: "session-activation",
  actorId: "actor-activation",
  attempt: "I go to the glassblower's district.",
  candidates: [LOCATION, NPC] as FreeformMaterializationCandidate[],
};

describe("executeFreeformMaterializationLane", () => {
  it("never runs when System One is disabled", async () => {
    const caller = createFakeSystemOneCaller({ scripted: answers(), responseModel: "jev-1.13.0" });
    const port = fakePort();
    const result = await executeFreeformMaterializationLane(
      "local-owner",
      laneSettings({ enabled: false }),
      caller,
      { port, deterministicFallback: () => ({ intent: "none", reason: "disabled" }) },
      INPUT,
    );
    expect(result.source).toBe("deterministic");
    expect(result.decision).toBeNull();
    expect(caller.calls).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
    if (result.source === "deterministic") expect(result.fallback).toEqual({ intent: "none", reason: "disabled" });
  });

  it("never runs the composition in shadow mode", async () => {
    const caller = createFakeSystemOneCaller({ scripted: answers() });
    const port = fakePort();
    const result = await executeFreeformMaterializationLane(
      "local-owner",
      laneSettings({ laneModes: { ...defaultSystemOneLaneModes(), [LANE]: "shadow" } }),
      caller,
      { port, deterministicFallback: () => "classifier" },
      INPUT,
    );
    expect(result.source).toBe("deterministic");
    expect(caller.calls).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
  });

  it("composes in active mode but fails closed when the lane is unpromoted", async () => {
    const caller = createFakeSystemOneCaller({ scripted: answers(), responseModel: "jev-1.13.0" });
    const port = fakePort();
    const result = await executeFreeformMaterializationLane(
      "local-owner",
      laneSettings(),
      caller,
      { port, deterministicFallback: () => "classifier" },
      INPUT,
    );
    expect(caller.calls).toHaveLength(1);
    expect(result.source).toBe("deterministic");
    expect(result.decision).toMatchObject({ band: "act", candidateId: LOCATION.candidateId });
    expect(port.calls).toHaveLength(0);
  });

  it("executes the matching receipted materialization only through the promoted binding", async () => {
    const caller = createFakeSystemOneCaller({ scripted: answers(), responseModel: "jev-1.13.0" });
    const port = fakePort();
    const settings = laneSettings();
    approveForTest(settings, "jev-1.13.0");
    const result = await executeFreeformMaterializationLane(
      "local-owner",
      settings,
      caller,
      { port, deterministicFallback: () => "classifier" },
      INPUT,
    );
    expect(result.source).toBe("lane");
    if (result.source === "lane") {
      expect(result.decision.candidateId).toBe(LOCATION.candidateId);
      expect(result.execution.kind).toBe("materialize-location");
    }
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.method).toBe("materializeFreeformTravel");
    // The lane hands the repository the server-authored candidate id; it never writes directly.
    expect(port.calls[0]!.args).toEqual([
      "local-owner", INPUT.campaignId, INPUT.sessionId, INPUT.actorId, INPUT.attempt,
      { candidateId: LOCATION.candidateId },
    ]);
  });

  it("routes each advertised kind to its own receipted repository method", async () => {
    for (const kind of Object.keys(KIND_CANDIDATE) as FreeformMaterializationCandidate["kind"][]) {
      const candidate = KIND_CANDIDATE[kind];
      const caller = createFakeSystemOneCaller({
        scripted: answers({ choice: candidate.candidateId }),
        responseModel: "jev-1.13.0",
      });
      const port = fakePort();
      const settings = laneSettings();
      approveForTest(settings, "jev-1.13.0");
      const result = await executeFreeformMaterializationLane(
        "local-owner",
        settings,
        caller,
        { port, deterministicFallback: () => "classifier" },
        { ...INPUT, attempt: `attempt for ${kind}`, candidates: [candidate], merchantNpcId: "npc-merchant" },
      );
      expect(result.source).toBe("lane");
      if (result.source !== "lane") throw new Error("expected a lane selection");
      expect(result.execution.kind).toBe(kind);
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]!.method).toBe(KIND_METHOD[kind]);
      expect(port.calls[0]!.args.at(-1)).toEqual({ candidateId: candidate.candidateId });
    }
  });

  it("fails closed on an out-of-set, none, low-confidence, or illegal answer without touching the repository", async () => {
    const settings = laneSettings();
    approveForTest(settings, "jev-1.13.0");
    const cases: Array<Record<string, SystemOneAnswer>> = [
      answers({ choice: "ffc-invented", choiceProbability: 0.99 }),
      answers({ choice: FREEFORM_MATERIALIZATION_NONE, choiceProbability: 0.99 }),
      answers({ choiceProbability: 0.1 }),
      answers({ legal: 0.1 }),
      answers({ needsContent: 0.1 }),
    ];
    for (const scripted of cases) {
      const caller = createFakeSystemOneCaller({ scripted, responseModel: "jev-1.13.0" });
      const port = fakePort();
      const result = await executeFreeformMaterializationLane(
        "local-owner",
        settings,
        caller,
        { port, deterministicFallback: () => "classifier" },
        INPUT,
      );
      expect(result.source).toBe("deterministic");
      expect(port.calls).toHaveLength(0);
    }
  });

  it("requires an authored merchant for a shop-stock selection", async () => {
    const candidate = KIND_CANDIDATE["shop-stock"];
    const caller = createFakeSystemOneCaller({
      scripted: answers({ choice: candidate.candidateId }),
      responseModel: "jev-1.13.0",
    });
    const port = fakePort();
    const settings = laneSettings();
    approveForTest(settings, "jev-1.13.0");
    const result = await executeFreeformMaterializationLane(
      "local-owner",
      settings,
      caller,
      { port, deterministicFallback: () => "classifier" },
      { ...INPUT, attempt: "I browse the merchant's wares.", candidates: [candidate] },
    );
    expect(result.source).toBe("deterministic");
    expect(port.calls).toHaveLength(0);
  });

  it("falls back to the deterministic classifier when the receipted path declines or throws", async () => {
    const settings = laneSettings();
    approveForTest(settings, "jev-1.13.0");

    const declining = fakePort();
    declining.materializeFreeformTravel = ((...args: unknown[]) => {
      declining.calls.push({ method: "materializeFreeformTravel", args });
      return { status: "declined", reason: "current-location-unmapped" };
    }) as FreeformMaterializationExecutionPort["materializeFreeformTravel"];
    const first = await executeFreeformMaterializationLane(
      "local-owner", settings,
      createFakeSystemOneCaller({ scripted: answers(), responseModel: "jev-1.13.0" }),
      { port: declining, deterministicFallback: () => "classifier" }, INPUT,
    );
    expect(first.source).toBe("deterministic");

    const throwing = fakePort(new Error("repository unavailable"));
    const second = await executeFreeformMaterializationLane(
      "local-owner", settings,
      createFakeSystemOneCaller({ scripted: answers(), responseModel: "jev-1.13.0" }),
      { port: throwing, deterministicFallback: () => "classifier" }, INPUT,
    );
    expect(second.source).toBe("deterministic");
    expect(throwing.calls).toHaveLength(1);
  });

  it("rejects malformed authored state without calling anything", async () => {
    const caller = createFakeSystemOneCaller({ scripted: answers() });
    const port = fakePort();
    const malformed: FreeformMaterializationCandidate[][] = [
      [],
      [{ candidateId: "x", kind: "invented-kind", label: "x" } as unknown as FreeformMaterializationCandidate],
      Array.from({ length: 33 }, (_value, index) => ({ candidateId: `candidate:${index}`, kind: "new-clue", label: `clue ${index}` })),
    ];
    for (const candidates of malformed) {
      const result = await executeFreeformMaterializationLane(
        "local-owner",
        laneSettings(),
        caller,
        { port, deterministicFallback: () => "classifier" },
        { ...INPUT, candidates },
      );
      expect(result.source).toBe("deterministic");
    }
    expect(caller.calls).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
  });
});
