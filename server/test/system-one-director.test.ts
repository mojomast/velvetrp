import { describe, expect, it } from "vitest";
import {
  buildDirectorQuestions,
  composeDirectorSelection,
  DIRECTOR_BEST_KEY,
  DIRECTOR_HOLD_KEY,
  DIRECTOR_NONE,
  DIRECTOR_PRIORITY_PREFIX,
  DIRECTOR_PROGRESS_PREFIX,
  DIRECTOR_TRANSITION_PREFIX,
  type DirectorCandidateProjection,
} from "../src/agent/systemOneDirector.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

const candidates: DirectorCandidateProjection[] = [
  { candidateId: "dm-candidate:mill", digest: "a".repeat(64), action: "reveal-node", label: "Move to the mill" },
  { candidateId: "dm-candidate:miller", digest: "b".repeat(64), action: "ambient-beat", label: "Talk to the miller" },
  { candidateId: "dm-candidate:time", digest: "c".repeat(64), action: "advance-time", label: "Let time pass" },
];

const pacingCandidates: DirectorCandidateProjection[] = [
  { candidateId: "dm-candidate:ambient", digest: "d".repeat(64), action: "ambient-beat", label: "A moment of quiet", pacing: true },
  { candidateId: "dm-candidate:drift", digest: "e".repeat(64), action: "advance-time", label: "Let time drift", pacing: true },
  { candidateId: "dm-candidate:market", digest: "f".repeat(64), action: "ambient-beat", label: "Market noise", pacing: true },
];

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const priority = (score: number): SystemOneAnswer => ({ type: "score", score, confidence: 0.8, legend: { 0: "low", 1: "medium", 2: "high" }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } });
const progress = (id: string, value: number) => [`${DIRECTOR_PROGRESS_PREFIX}${id}`, noul(value)] as const;
const transition = (id: string, value: number) => [`${DIRECTOR_TRANSITION_PREFIX}${id}`, noul(value)] as const;
const prio = (id: string, score: number) => [`${DIRECTOR_PRIORITY_PREFIX}${id}`, priority(score)] as const;

describe("System One Director selector", () => {
  it("builds a hold noul, a progress noul and a priority score per candidate, plus a best choice", () => {
    const questions = buildDirectorQuestions(candidates);
    expect(questions[DIRECTOR_HOLD_KEY]).toMatchObject({ type: "noul" });
    expect(questions[`${DIRECTOR_PROGRESS_PREFIX}${candidates[0]!.candidateId}`]).toMatchObject({ type: "noul" });
    expect(questions[`${DIRECTOR_PRIORITY_PREFIX}${candidates[0]!.candidateId}`]).toMatchObject({ type: "score" });
    expect(questions[DIRECTOR_BEST_KEY]).toMatchObject({ type: "choice" });
  });

  it("holds when the hold answer is confident and no candidate can advance", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.9),
      ...Object.fromEntries(candidates.map((candidate) => progress(candidate.candidateId, 0.2))),
    };
    expect(composeDirectorSelection(candidates, answers, thresholds)).toMatchObject({ band: "act", method: "hold", hold: true, selections: [] });
  });

  it("forces a hold when there are no advertised candidates", () => {
    expect(composeDirectorSelection([], {}, thresholds)).toMatchObject({ band: "act", method: "hold", hold: true, selections: [], topSignal: 1 });
  });

  it("orders grounded candidates by priority and caps the beat", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.2),
      ...Object.fromEntries(candidates.map((candidate) => progress(candidate.candidateId, 0.9))),
      ...Object.fromEntries([
        prio(candidates[0]!.candidateId, 1),
        prio(candidates[1]!.candidateId, 2),
        prio(candidates[2]!.candidateId, 1.5),
      ]),
    };
    const composed = composeDirectorSelection(candidates, answers, thresholds, 2);
    expect(composed).toMatchObject({ band: "act", method: "candidates", hold: false });
    expect(composed.selections.map((selection) => selection.candidateId)).toEqual([candidates[1]!.candidateId, candidates[2]!.candidateId]);
    expect(composed.selections[0]).toEqual({ candidateId: candidates[1]!.candidateId, digest: candidates[1]!.digest });
  });

  it("lets a confident hold outrank the aggregate best-pick", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.9),
      ...Object.fromEntries(candidates.map((candidate) => progress(candidate.candidateId, 0.2))),
      [DIRECTOR_BEST_KEY]: { type: "choice", choice: candidates[0]!.candidateId, confidence: 0.9, probabilities: { [candidates[0]!.candidateId]: 0.9, [DIRECTOR_NONE]: 0.1 } },
    };
    expect(composeDirectorSelection(candidates, answers, thresholds)).toMatchObject({ band: "act", method: "hold", hold: true, selections: [] });
  });

  it("rescues a single candidate from the best choice when none are grounded", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.3),
      ...Object.fromEntries([progress(candidates[0]!.candidateId, 0.3)]),
      [DIRECTOR_BEST_KEY]: { type: "choice", choice: candidates[0]!.candidateId, confidence: 0.8, probabilities: { [candidates[0]!.candidateId]: 0.8, [candidates[1]!.candidateId]: 0.12, [candidates[2]!.candidateId]: 0.04, [DIRECTOR_NONE]: 0.04 } },
    };
    expect(composeDirectorSelection(candidates, answers, thresholds)).toMatchObject({
      band: "act", method: "best-pick", selections: [{ candidateId: candidates[0]!.candidateId, digest: candidates[0]!.digest }],
    });
  });

  it("defers when nothing is confident", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.4),
      ...Object.fromEntries([progress(candidates[0]!.candidateId, 0.45)]),
      [DIRECTOR_BEST_KEY]: { type: "choice", choice: DIRECTOR_NONE, confidence: 0.3, probabilities: { [DIRECTOR_NONE]: 0.6, [candidates[0]!.candidateId]: 0.4 } },
    };
    const composed = composeDirectorSelection(candidates, answers, thresholds);
    expect(composed).toMatchObject({ band: "fallback", method: "defer", selections: [] });
  });

  it("emits a transition noul only for a pacing candidate", () => {
    const mixed = [candidates[0]!, pacingCandidates[0]!];
    const questions = buildDirectorQuestions(mixed);
    expect(questions[`${DIRECTOR_TRANSITION_PREFIX}${pacingCandidates[0]!.candidateId}`]).toMatchObject({ type: "noul" });
    expect(questions[`${DIRECTOR_TRANSITION_PREFIX}${candidates[0]!.candidateId}`]).toBeUndefined();
  });

  it("falls back to a grounded transition on a pacing-only set", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.3),
      ...Object.fromEntries(pacingCandidates.map((candidate) => progress(candidate.candidateId, 0.4))),
      ...Object.fromEntries([transition(pacingCandidates[0]!.candidateId, 0.9)]),
    };
    const composed = composeDirectorSelection(pacingCandidates, answers, thresholds);
    expect(composed).toMatchObject({ band: "act", method: "transition", hold: false });
    expect(composed.selections).toEqual([{ candidateId: pacingCandidates[0]!.candidateId, digest: pacingCandidates[0]!.digest }]);
    expect(composed.topSignal).toBe(0.9);
  });

  it("orders transition selections by priority and caps the beat", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.2),
      ...Object.fromEntries(pacingCandidates.map((candidate) => progress(candidate.candidateId, 0.3))),
      ...Object.fromEntries([
        transition(pacingCandidates[0]!.candidateId, 0.8),
        transition(pacingCandidates[1]!.candidateId, 0.85),
        transition(pacingCandidates[2]!.candidateId, 0.9),
      ]),
      ...Object.fromEntries([
        prio(pacingCandidates[0]!.candidateId, 1),
        prio(pacingCandidates[1]!.candidateId, 2),
        prio(pacingCandidates[2]!.candidateId, 1.5),
      ]),
    };
    const composed = composeDirectorSelection(pacingCandidates, answers, thresholds, 2);
    expect(composed).toMatchObject({ method: "transition", hold: false });
    expect(composed.selections.map((selection) => selection.candidateId)).toEqual([
      pacingCandidates[1]!.candidateId,
      pacingCandidates[2]!.candidateId,
    ]);
    expect(composed.topSignal).toBe(0.85);
  });

  it("prefers grounded progress over a transition", () => {
    const mixed = [pacingCandidates[0]!, candidates[0]!];
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.2),
      ...Object.fromEntries([
        progress(pacingCandidates[0]!.candidateId, 0.9),
        progress(candidates[0]!.candidateId, 0.2),
      ]),
      ...Object.fromEntries([transition(pacingCandidates[0]!.candidateId, 0.9)]),
    };
    const composed = composeDirectorSelection(mixed, answers, thresholds);
    expect(composed).toMatchObject({ method: "candidates", hold: false });
    expect(composed.selections.map((selection) => selection.candidateId)).toEqual([pacingCandidates[0]!.candidateId]);
  });

  it("lets a confident hold outrank a grounded transition", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.9),
      ...Object.fromEntries(pacingCandidates.map((candidate) => progress(candidate.candidateId, 0.3))),
      ...Object.fromEntries([transition(pacingCandidates[0]!.candidateId, 0.9)]),
    };
    expect(composeDirectorSelection(pacingCandidates, answers, thresholds)).toMatchObject({
      band: "act", method: "hold", hold: true, selections: [],
    });
  });

  it("does not use the transition lane when a non-pacing candidate is advertised", () => {
    const mixed = [pacingCandidates[0]!, candidates[0]!];
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.6),
      ...Object.fromEntries(mixed.map((candidate) => progress(candidate.candidateId, 0.3))),
      ...Object.fromEntries([transition(pacingCandidates[0]!.candidateId, 0.9)]),
    };
    const composed = composeDirectorSelection(mixed, answers, thresholds);
    expect(composed.method).not.toBe("transition");
    expect(composed.selections).toEqual([]);
  });

  it("defers when every transition is below the action threshold", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: noul(0.2),
      ...Object.fromEntries(pacingCandidates.map((candidate) => progress(candidate.candidateId, 0.3))),
      ...Object.fromEntries([transition(pacingCandidates[0]!.candidateId, 0.5)]),
    };
    const composed = composeDirectorSelection(pacingCandidates, answers, thresholds);
    expect(composed.method).toBe("defer");
    expect(composed.selections).toEqual([]);
  });
});
