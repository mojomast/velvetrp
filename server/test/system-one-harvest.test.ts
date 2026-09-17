import { describe, expect, it } from "vitest";
import type { SystemOneDecisionRecord } from "../src/repo/systemOneDecisionRepo.js";
import {
  buildHarvestProposals,
  confirmedHarvestProposals,
  harvestProposal,
  summarizeHarvest,
  type HarvestAnnotation,
} from "../src/agent/systemOneHarvest.js";

const record = (overrides: Partial<SystemOneDecisionRecord> = {}): SystemOneDecisionRecord => ({
  decisionId: "d1", lane: "guardrails", campaignId: null, sessionId: null, turnId: null,
  provider: "typesafe", model: "jev-1.13.0", confidencePolicyVersion: "system-one-confidence-v1",
  requestDigest: "r", questionsDigest: "q", stateDigest: "state-1",
  request: {}, questions: {}, state: { message: "I draw my sword." }, answers: {},
  selection: { disposition: "pass" }, confidenceBand: "fallback", fallbackUsed: true, shadow: true,
  usage: null, latencyMs: 10, createdAt: "2026-09-17T00:00:00.000Z",
  ...overrides,
});

describe("harvestProposal", () => {
  it("confirms a decision a human marked correct, using the recorded outcome", () => {
    const proposal = harvestProposal(record(), { verdict: "correct" })!;
    expect(proposal).toMatchObject({
      lane: "guardrails", provenance: "review-annotated", status: "confirmed", expected: { disposition: "pass" },
    });
    expect(proposal.proposalId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("confirms a correction only when the annotation carries a valid expectation", () => {
    const withExpected = harvestProposal(record(), { verdict: "incorrect", expected: { disposition: "review" } })!;
    expect(withExpected.status).toBe("confirmed");
    expect(withExpected.expected).toEqual({ disposition: "review" });
    const withoutExpected = harvestProposal(record(), { verdict: "incorrect" })!;
    expect(withoutExpected.status).toBe("proposed");
    expect(withoutExpected.expected).toBeNull();
    const invalid = harvestProposal(record(), { verdict: "incorrect", expected: { disposition: "explode" } })!;
    expect(invalid.status).toBe("proposed");
  });

  it("projects lane-specific recorded expectations for the Director and adventure lanes", () => {
    const director = harvestProposal(record({
      lane: "director-selection",
      selection: { selections: [{ candidateId: "beat-a" }, { candidateId: "beat-b" }] },
    }), { verdict: "correct" })!;
    expect(director.expected).toEqual({ selections: ["beat-a", "beat-b"] });
    const held = harvestProposal(record({ lane: "director-selection", selection: { selections: [] } }), { verdict: "correct" })!;
    expect(held.expected).toEqual({ selections: [] });

    const adventure = harvestProposal(record({
      lane: "adventure-selection",
      selection: { method: "choice", selection: { candidateId: "travel:mill", digest: "a".repeat(64) }, topSignal: 0.8 },
    }), { verdict: "correct" })!;
    expect(adventure.expected).toEqual({ candidateId: "travel:mill" });
    const defer = harvestProposal(record({
      lane: "adventure-selection",
      selection: { method: "defer", selection: null, topSignal: null },
    }), { verdict: "correct" })!;
    expect(defer.expected).toEqual({ candidateId: null });
  });

  it("proposes a Director disagreement with the authoritative provider selection as the label", () => {
    const proposal = harvestProposal(record({ lane: "director-selection", selection: { selections: [] } }), undefined, {
      agreement: "disagree", authoritativeCandidateIds: ["beat-a", "beat-b"],
    })!;
    expect(proposal).toMatchObject({ provenance: "provider-disagreement", status: "proposed" });
    expect(proposal.expected).toEqual({ selections: ["beat-a", "beat-b"] });

    const held = harvestProposal(record({ lane: "director-selection", selection: { selections: [] } }), undefined, {
      agreement: "disagree", authoritativeCandidateIds: null,
    })!;
    expect(held.expected).toBeNull();
    expect(held.status).toBe("proposed");
  });

  it("decodes a legacy state stored as a canonical JSON string", () => {
    const proposal = harvestProposal(record({
      lane: "adventure-selection",
      state: JSON.stringify({ declaration: "I drop my longsword.", candidates: [{ candidateId: "c1" }] }),
      selection: { method: "defer", selection: null, topSignal: null },
    }), { verdict: "correct" })!;
    expect(proposal.state).toEqual({ declaration: "I drop my longsword.", candidates: [{ candidateId: "c1" }] });
    const unparsable = harvestProposal(record({ lane: "guardrails", state: "not-json" }), { verdict: "correct" })!;
    expect(unparsable.state).toBe("not-json");
  });

  it("skips agreements, unknown lanes, and unactionable corrections", () => {
    expect(harvestProposal(record(), undefined)).toBeNull();
    expect(harvestProposal(record({ lane: "cost-router" }), { verdict: "correct" })).toBeNull();
    expect(harvestProposal(record({ lane: "adventure-selection", selection: {} }), { verdict: "correct" })).toBeNull();
    expect(harvestProposal(record({ lane: "director-selection", selection: {} }), undefined, {
      agreement: "agree", authoritativeCandidateIds: [],
    })).toBeNull();
  });
});

describe("buildHarvestProposals", () => {
  const annotations: Record<string, HarvestAnnotation> = {
    d1: { verdict: "correct" },
    d2: { verdict: "incorrect" },
    d3: { verdict: "incorrect", expected: { disposition: "block" } },
  };

  it("deduplicates by state and expectation, preferring a confirmed label", () => {
    const proposals = buildHarvestProposals({
      records: [
        record({ decisionId: "d2", createdAt: "2026-09-17T00:00:02.000Z", selection: { disposition: "pass" } }),
        record({ decisionId: "d3", createdAt: "2026-09-17T00:00:03.000Z", selection: { disposition: "pass" } }),
      ],
      annotations,
    });
    // d2 and d3 share the same state but carry different expectations, so both survive.
    expect(proposals).toHaveLength(2);
    expect(proposals.map((entry) => entry.sourceDecisionId)).toEqual(["d2", "d3"]);
    expect(proposals.find((entry) => entry.sourceDecisionId === "d3")!.expected).toEqual({ disposition: "block" });

    const idempotent = buildHarvestProposals({
      records: [record({ decisionId: "d3", createdAt: "2026-09-17T00:00:03.000Z", selection: { disposition: "pass" } })],
      annotations,
    });
    expect(idempotent).toHaveLength(1);
    expect(idempotent[0]!.proposalId).toBe(proposals[1]!.proposalId);
  });

  it("summarizes and filters confirmed proposals per lane", () => {
    const proposals = buildHarvestProposals({
      records: [
        record({ decisionId: "d1" }),
        record({ decisionId: "d2", selection: { disposition: "block" } }),
        record({ decisionId: "d3", selection: { disposition: "review" } }),
      ],
      annotations,
    });
    const summary = summarizeHarvest(proposals);
    expect(summary.total).toBe(3);
    expect(summary.confirmed).toBe(2);
    expect(summary.proposed).toBe(1);
    expect(summary.byLane).toEqual([{ lane: "guardrails", confirmed: 2, proposed: 1 }]);
    expect(confirmedHarvestProposals(proposals, "guardrails")).toHaveLength(2);
    expect(confirmedHarvestProposals(proposals, "director-selection")).toHaveLength(0);
  });

  it("keeps a provider-disagreement proposal out of the confirmed set", () => {
    const proposals = buildHarvestProposals({
      records: [record({ lane: "director-selection", decisionId: "d9", selection: { selections: [] } })],
      authority: { d9: { agreement: "disagree", authoritativeCandidateIds: ["beat-a"] } },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("proposed");
    expect(confirmedHarvestProposals(proposals, "director-selection")).toHaveLength(0);
  });
});
