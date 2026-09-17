import { describe, expect, it } from "vitest";
import {
  compareDirectorAuthority,
  directorSelectedCandidateIds,
  renderDirectorDisagreementReport,
  summarizeDirectorDisagreement,
} from "../src/agent/systemOneDisagreement.js";
import type {
  DirectorDisagreementRow,
  DirectorDisagreementSummary,
} from "../src/agent/systemOneDisagreement.js";
import type {
  DirectorDecisionAuthority,
  SystemOneDecisionRecord,
} from "../src/repo/systemOneDecisionRepo.js";

function decision(overrides: Partial<SystemOneDecisionRecord> = {}): SystemOneDecisionRecord {
  return {
    decisionId: "decision-1",
    lane: "director-selection",
    campaignId: "campaign-1",
    sessionId: "session-1",
    turnId: "turn-1",
    provider: "test-provider",
    model: "test-model",
    confidencePolicyVersion: "policy-v1",
    requestDigest: "request-digest",
    questionsDigest: "questions-digest",
    stateDigest: "state-digest",
    request: { prompt: "advance the scene" },
    questions: [{ id: "q1", text: "what next?" }],
    state: { hp: 10 },
    answers: { q1: "press on" },
    selection: { selections: [{ candidateId: "c1", digest: "d1" }] },
    confidenceBand: "act",
    fallbackUsed: false,
    shadow: true,
    usage: null,
    latencyMs: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function authority(overrides: Partial<DirectorDecisionAuthority> = {}): DirectorDecisionAuthority {
  return {
    decision: decision(),
    authoritativeCandidateIds: ["c1"],
    authoritativeMissing: false,
    ...overrides,
  };
}

function selection(ids: ReadonlyArray<unknown>): { selections: unknown[] } {
  return { selections: ids.map((candidateId) => ({ candidateId, digest: "d" })) };
}

describe("directorSelectedCandidateIds", () => {
  it("reads the ordered selection.selections candidate ids", () => {
    expect(directorSelectedCandidateIds(selection(["c1", "c2", "c3"]))).toEqual(["c1", "c2", "c3"]);
  });

  it("ignores items without a string candidateId", () => {
    const value = {
      selections: [
        { candidateId: "c1", digest: "d1" },
        null,
        { digest: "d2" },
        { candidateId: 7 },
        "not-an-object",
        { candidateId: "c2" },
      ],
    };
    expect(directorSelectedCandidateIds(value)).toEqual(["c1", "c2"]);
  });

  it("returns [] for null, non-object, and non-array selection", () => {
    expect(directorSelectedCandidateIds(null)).toEqual([]);
    expect(directorSelectedCandidateIds(undefined)).toEqual([]);
    expect(directorSelectedCandidateIds(42)).toEqual([]);
    expect(directorSelectedCandidateIds("c1")).toEqual([]);
    expect(directorSelectedCandidateIds(true)).toEqual([]);
  });

  it("returns [] for an array selection and for an object without selections", () => {
    expect(directorSelectedCandidateIds([])).toEqual([]);
    expect(directorSelectedCandidateIds({})).toEqual([]);
    expect(directorSelectedCandidateIds({ selections: "c1" })).toEqual([]);
    expect(directorSelectedCandidateIds({ selections: { candidateId: "c1" } })).toEqual([]);
  });
});

describe("compareDirectorAuthority", () => {
  it("agrees when the ordered ids are equal", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection(["a", "b"]) }), authoritativeCandidateIds: ["a", "b"] }),
    ]);
    expect(rows[0]).toMatchObject({
      decisionId: "decision-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      shadow: true,
      directorCandidateIds: ["a", "b"],
      authoritativeCandidateIds: ["a", "b"],
      agreement: "agree",
      directorActed: true,
    });
  });

  it("agrees when both the Director and the provider held", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection([]) }), authoritativeCandidateIds: null }),
    ]);
    expect(rows[0]!.agreement).toBe("agree");
    expect(rows[0]!.directorActed).toBe(false);
    expect(rows[0]!.directorCandidateIds).toEqual([]);
    expect(rows[0]!.authoritativeCandidateIds).toBeNull();
  });

  it("disagrees for the same ids in a different order", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection(["a", "b"]) }), authoritativeCandidateIds: ["b", "a"] }),
    ]);
    expect(rows[0]!.agreement).toBe("disagree");
    expect(rows[0]!.directorActed).toBe(true);
  });

  it("disagrees for different counts", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection(["a", "b"]) }), authoritativeCandidateIds: ["a"] }),
    ]);
    expect(rows[0]!.agreement).toBe("disagree");
  });

  it("disagrees when the Director held but the provider acted", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection([]) }), authoritativeCandidateIds: ["a"] }),
    ]);
    expect(rows[0]!.agreement).toBe("disagree");
    expect(rows[0]!.directorActed).toBe(false);
  });

  it("disagrees when the Director acted but the provider held", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ selection: selection(["a"]) }), authoritativeCandidateIds: null }),
    ]);
    expect(rows[0]!.agreement).toBe("disagree");
    expect(rows[0]!.directorActed).toBe(true);
  });

  it("marks a missing authoritative run unknown even when the ids would agree", () => {
    const rows = compareDirectorAuthority([
      authority({
        decision: decision({ selection: selection(["a"]) }),
        authoritativeCandidateIds: ["a"],
        authoritativeMissing: true,
      }),
    ]);
    expect(rows[0]!.agreement).toBe("unknown");
    expect(rows[0]!.directorActed).toBe(true);
  });

  it("marks a missing authoritative run unknown even when the ids would disagree", () => {
    const rows = compareDirectorAuthority([
      authority({
        decision: decision({ selection: selection(["a"]) }),
        authoritativeCandidateIds: ["b", "c"],
        authoritativeMissing: true,
      }),
    ]);
    expect(rows[0]!.agreement).toBe("unknown");
  });

  it("sets directorActed exactly when the Director selected at least one candidate", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ decisionId: "held", selection: selection([]) }) }),
      authority({ decision: decision({ decisionId: "acted", selection: selection(["a"]) }) }),
    ]);
    expect(rows.map((row) => [row.decisionId, row.directorActed])).toEqual([
      ["held", false],
      ["acted", true],
    ]);
  });

  it("preserves input order and copies decision metadata", () => {
    const rows = compareDirectorAuthority([
      authority({ decision: decision({ decisionId: "first", shadow: false }) }),
      authority({ decision: decision({ decisionId: "second", shadow: true }) }),
    ]);
    expect(rows.map((row) => row.decisionId)).toEqual(["first", "second"]);
    expect(rows.map((row) => row.shadow)).toEqual([false, true]);
  });
});

function row(overrides: Partial<DirectorDisagreementRow> = {}): DirectorDisagreementRow {
  return {
    decisionId: "decision-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    shadow: true,
    directorCandidateIds: ["a"],
    authoritativeCandidateIds: ["a"],
    agreement: "agree",
    directorActed: true,
    ...overrides,
  };
}

describe("summarizeDirectorDisagreement", () => {
  const rows: DirectorDisagreementRow[] = [
    row({ decisionId: "agree-1", agreement: "agree" }),
    row({ decisionId: "disagree-acted", agreement: "disagree", directorActed: true }),
    row({ decisionId: "unknown-1", agreement: "unknown", directorActed: false }),
    row({ decisionId: "disagree-held", agreement: "disagree", directorActed: false }),
  ];

  it("counts each verdict exactly", () => {
    const summary = summarizeDirectorDisagreement(rows);
    expect(summary).toEqual({
      total: 4,
      agree: 1,
      disagree: 2,
      unknown: 1,
      actedDisagree: 1,
      disagreementDecisionIds: ["disagree-acted", "disagree-held"],
    });
  });

  it("counts actedDisagree only for disagreements where the Director acted", () => {
    const summary = summarizeDirectorDisagreement([
      row({ decisionId: "agree-acted", agreement: "agree", directorActed: true }),
      row({ decisionId: "disagree-acted", agreement: "disagree", directorActed: true }),
      row({ decisionId: "unknown-acted", agreement: "unknown", directorActed: true }),
      row({ decisionId: "disagree-held", agreement: "disagree", directorActed: false }),
    ]);
    expect(summary.actedDisagree).toBe(1);
    expect(summary.disagree).toBe(2);
  });

  it("preserves the input order of disagreementDecisionIds", () => {
    const summary = summarizeDirectorDisagreement([
      row({ decisionId: "d-3", agreement: "disagree" }),
      row({ decisionId: "a-1", agreement: "agree" }),
      row({ decisionId: "d-1", agreement: "disagree" }),
      row({ decisionId: "u-2", agreement: "unknown" }),
      row({ decisionId: "d-2", agreement: "disagree" }),
    ]);
    expect(summary.disagreementDecisionIds).toEqual(["d-3", "d-1", "d-2"]);
  });

  it("summarizes an empty input as all zeroes", () => {
    const summary: DirectorDisagreementSummary = summarizeDirectorDisagreement([]);
    expect(summary).toEqual({
      total: 0,
      agree: 0,
      disagree: 0,
      unknown: 0,
      actedDisagree: 0,
      disagreementDecisionIds: [],
    });
  });
});

describe("renderDirectorDisagreementReport", () => {
  const mixed: DirectorDisagreementRow[] = [
    row({ decisionId: "agree-1", agreement: "agree", directorCandidateIds: ["a"], authoritativeCandidateIds: ["a"] }),
    row({
      decisionId: "disagree-acted",
      agreement: "disagree",
      directorCandidateIds: ["a", "b"],
      authoritativeCandidateIds: null,
      directorActed: true,
    }),
    row({
      decisionId: "disagree-held",
      agreement: "disagree",
      directorCandidateIds: [],
      authoritativeCandidateIds: ["z"],
      directorActed: false,
    }),
    row({ decisionId: "unknown-1", agreement: "unknown", directorActed: false }),
  ];

  it("is byte-identical for two identical calls", () => {
    const options = { generatedAt: "2026-01-01T00:00:00.000Z", source: "fixture" };
    expect(renderDirectorDisagreementReport(mixed, options)).toBe(renderDirectorDisagreementReport(mixed, options));
  });

  it("omits agree rows from the table by default while still counting them", () => {
    const report = renderDirectorDisagreementReport(mixed);
    expect(report).toContain("## Summary");
    expect(report).toContain("## Review queue");
    expect(report).toContain("- Director decisions: 4");
    expect(report).toContain("- Agree: 1");
    expect(report).not.toContain("| agree-1 |");
    expect(report).toContain("| disagree-acted |");
    expect(report).toContain("| disagree-held |");
    expect(report).toContain("| unknown-1 |");
  });

  it("lists every row when includeAgreements is true", () => {
    const report = renderDirectorDisagreementReport(mixed, { includeAgreements: true });
    expect(report).toContain("| agree-1 |");
    expect(report).toContain("| disagree-acted |");
    expect(report).toContain("| disagree-held |");
    expect(report).toContain("| unknown-1 |");
  });

  it("renders an empty input with the no-decisions message", () => {
    const report = renderDirectorDisagreementReport([]);
    expect(report).toContain("No Director decisions were recorded.");
    expect(report).toContain("- Director decisions: 0");
  });

  it("renders an all-agree input with the agreement message", () => {
    const report = renderDirectorDisagreementReport([
      row({ decisionId: "agree-1", agreement: "agree" }),
      row({ decisionId: "agree-2", agreement: "agree" }),
    ]);
    expect(report).toContain("Every Director decision agreed with the authoritative composition.");
    expect(report).not.toContain("| agree-1 |");
  });

  it("shows held for an empty or null side", () => {
    const report = renderDirectorDisagreementReport(mixed, { includeAgreements: true });
    expect(report).toContain("| disagree-acted | 2026-01-01T00:00:00.000Z | disagree | a, b | held | yes |");
    expect(report).toContain("| disagree-held | 2026-01-01T00:00:00.000Z | disagree | held | z | yes |");
  });

  it("uses the decided decisionId and createdAt columns", () => {
    const report = renderDirectorDisagreementReport(mixed);
    expect(report).toContain("| Decision | Created | Agreement | Director | Authoritative | Shadow |");
    expect(report).toContain("| disagree-held | 2026-01-01T00:00:00.000Z | disagree | held | z | yes |");
  });

  it("renders the disagreement id list and the em-dash placeholder when empty", () => {
    const withDisagreements = renderDirectorDisagreementReport(mixed);
    expect(withDisagreements).toContain("Disagreeing decisions: disagree-acted, disagree-held");

    const onlyUnknown = renderDirectorDisagreementReport([
      row({ decisionId: "unknown-1", agreement: "unknown", directorActed: false }),
    ]);
    expect(onlyUnknown).toContain("Disagreeing decisions: —");
  });
});

describe("purity", () => {
  it("does not mutate authority or decision inputs across every function", () => {
    const inputs: DirectorDecisionAuthority[] = [
      authority({
        decision: decision({
          decisionId: "a",
          selection: selection(["a", "b"]),
          usage: { inputTokens: 3, outputTokens: 4 },
          request: { nested: { deep: [1, 2, 3] } },
        }),
        authoritativeCandidateIds: ["b", "a"],
      }),
      authority({
        decision: decision({ decisionId: "b", selection: selection([]) }),
        authoritativeCandidateIds: null,
      }),
      authority({
        decision: decision({ decisionId: "c", selection: selection(["x"]) }),
        authoritativeCandidateIds: ["y"],
        authoritativeMissing: true,
      }),
    ];
    const snapshot = structuredClone(inputs);

    const compared = compareDirectorAuthority(inputs);
    summarizeDirectorDisagreement(compared);
    summarizeDirectorDisagreement([...compared, row({ decisionId: "extra", agreement: "disagree" })]);
    renderDirectorDisagreementReport(compared);
    renderDirectorDisagreementReport(compared, { includeAgreements: true, source: "purity" });
    directorSelectedCandidateIds(inputs[0]!.decision.selection);

    expect(inputs).toEqual(snapshot);
  });

  it("does not mutate the rows passed to summarize or render", () => {
    const rows: DirectorDisagreementRow[] = [
      row({ decisionId: "agree-1", agreement: "agree" }),
      row({
        decisionId: "disagree-1",
        agreement: "disagree",
        directorCandidateIds: ["a", "b"],
        authoritativeCandidateIds: null,
      }),
    ];
    const snapshot = structuredClone(rows);
    summarizeDirectorDisagreement(rows);
    renderDirectorDisagreementReport(rows, { includeAgreements: true });
    expect(rows).toEqual(snapshot);
  });
});
