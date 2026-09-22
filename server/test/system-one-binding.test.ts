import { describe, expect, it } from "vitest";
import { defaultSystemOneSettings } from "../src/defaults.js";
import { matchesSystemOneBinding, systemOneEvaluationBinding, type SystemOneEvaluationBinding } from "../src/agent/systemOneBinding.js";
import { isLanePromoted, SYSTEM_ONE_PROMOTION_RECORDS } from "../src/agent/systemOnePromotion.js";
import { approveTestSystemOne } from "./fixtures/systemOnePromotion.js";

const settings = defaultSystemOneSettings();
const family = "exact_srd_check.select";
const binding = () => systemOneEvaluationBinding("adventure-selection", settings, settings.model, family);

describe("version-bound System One promotion", () => {
  it("fails closed for legacy evidence, absent configuration and missing response metadata", () => {
    expect(isLanePromoted("adventure-selection", binding())).toBe(false);
    approveTestSystemOne(settings, "adventure-selection", [family]);
    expect(isLanePromoted("adventure-selection")).toBe(false);
    expect(isLanePromoted("adventure-selection", systemOneEvaluationBinding("adventure-selection", settings, null, family))).toBe(false);
  });

  it("permits a matching evaluated configuration only when the metrics pass", () => {
    approveTestSystemOne(settings, "adventure-selection", [family]);
    expect(isLanePromoted("adventure-selection", binding())).toBe(true);
    const record = SYSTEM_ONE_PROMOTION_RECORDS["adventure-selection"]!;
    SYSTEM_ONE_PROMOTION_RECORDS["adventure-selection"] = { ...record, metrics: { ...record.metrics, accuracy: 0 } };
    expect(isLanePromoted("adventure-selection", binding())).toBe(false);
  });

  const changes: Partial<SystemOneEvaluationBinding>[] = [
    { schemaVersion: 2 as 1 }, { lane: "speaker-routing" }, { provider: "other" as "typesafe" },
    { baseUrl: "https://different.invalid" }, { requestedModel: "new-requested-model" }, { responseModel: "new-resolved-model" },
    { questionVersion: "new-questions" }, { compositionVersion: "new-composition" },
    { candidateStrategy: "family-lexical-round-robin-32-v2" }, { stateVersion: "deduplicated-state-v2" },
    { actionFamily: "exact_rest.select" }, { actionThreshold: 0.9 }, { reviewThreshold: 0.4 },
    { calibrationA: 2 }, { calibrationB: 1 },
  ];
  it.each(changes)("rejects stale approval for %j", change => {
    approveTestSystemOne(settings, "adventure-selection", [family]);
    expect(isLanePromoted("adventure-selection", { ...binding(), ...change })).toBe(false);
  });

  it("does not authorize other families or other lanes", () => {
    approveTestSystemOne(settings, "adventure-selection", [family]);
    expect(isLanePromoted("speaker-routing", binding())).toBe(false);
    expect(isLanePromoted("adventure-selection", { ...binding(), actionFamily: "exact_combat_power.select" })).toBe(false);
  });

  it("captures effective threshold overrides without mutating settings", () => {
    const overrides = { actionThreshold: 0.95, reviewThreshold: 0.8 };
    const current = systemOneEvaluationBinding("speaker-routing", settings, settings.model, "room-speaker-selection", {}, overrides);
    expect(current.actionThreshold).toBe(0.95);
    expect(current.reviewThreshold).toBe(0.8);
    expect(settings.confidencePolicy["speaker-routing"].actionThreshold).toBe(0.75);
  });

  it("ignores object key order, but rejects malformed equal bindings", () => {
    const current = binding();
    expect(matchesSystemOneBinding(current, Object.fromEntries(Object.entries(current).reverse()) as unknown as SystemOneEvaluationBinding)).toBe(true);
    for (const change of [{ responseModel: "" }, { actionThreshold: NaN }, { reviewThreshold: -1 },
      { actionThreshold: 0.1, reviewThreshold: 0.9 }, { calibrationA: Infinity }]) {
      const invalid = { ...current, ...change };
      expect(matchesSystemOneBinding(invalid, invalid)).toBe(false);
    }
  });

  it("does not bind secrets, timestamps or billing settings", () => {
    const original = binding();
    const changed = systemOneEvaluationBinding("adventure-selection", { ...settings,
      apiKey: "never-serialize-this", updatedAt: "different", requestTimeoutSeconds: 5 }, settings.model, family);
    expect(changed).toEqual(original);
    expect(JSON.stringify(changed)).not.toContain("never-serialize-this");
  });
});
