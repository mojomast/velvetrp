import { describe, expect, it } from "vitest";
import {
  buildDirectorQuestions,
  composeDirectorSelection,
  DIRECTOR_BEST_KEY,
  DIRECTOR_HOLD_KEY,
  DIRECTOR_NONE,
  type DirectorCandidateProjection,
} from "../src/agent/systemOneDirector.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };

const candidates: DirectorCandidateProjection[] = [
  { candidateId: "dm-candidate:mill", digest: "a".repeat(64), action: "reveal-node", label: "Move to the mill" },
  { candidateId: "dm-candidate:miller", digest: "b".repeat(64), action: "ambient-beat", label: "Talk to the miller" },
  { candidateId: "dm-candidate:time", digest: "c".repeat(64), action: "advance-time", label: "Let time pass" },
];

const support = (id: string, noul: number): SystemOneAnswer => ({ type: "noul", noul });
const priority = (id: string, score: number): SystemOneAnswer => ({ type: "score", score, confidence: 0.8, legend: { 0: "low", 1: "medium", 2: "high" }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } });

describe("System One Director selector", () => {
  it("builds a hold noul, a support noul and a priority score per candidate, plus a best choice", () => {
    const questions = buildDirectorQuestions(candidates);
    expect(questions[DIRECTOR_HOLD_KEY]).toMatchObject({ type: "noul" });
    expect(questions[`supported:${candidates[0]!.candidateId}`]).toMatchObject({ type: "noul" });
    expect(questions[`priority:${candidates[0]!.candidateId}`]).toMatchObject({ type: "score" });
    expect(questions[DIRECTOR_BEST_KEY]).toMatchObject({ type: "choice" });
  });

  it("holds when the hold answer is confident", () => {
    const answers = { [DIRECTOR_HOLD_KEY]: support("hold", 0.9), [`supported:${candidates[0]!.candidateId}`]: support("x", 0.95) };
    expect(composeDirectorSelection(candidates, answers, thresholds)).toMatchObject({ band: "act", method: "hold", hold: true, selections: [] });
  });

  it("orders grounded candidates by priority and caps the beat", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: support("hold", 0.2),
      [`supported:${candidates[0]!.candidateId}`]: support("a", 0.9),
      [`supported:${candidates[1]!.candidateId}`]: support("b", 0.85),
      [`supported:${candidates[2]!.candidateId}`]: support("c", 0.8),
      [`priority:${candidates[0]!.candidateId}`]: priority("a", 1),
      [`priority:${candidates[1]!.candidateId}`]: priority("b", 2),
      [`priority:${candidates[2]!.candidateId}`]: priority("c", 1.5),
    };
    const composed = composeDirectorSelection(candidates, answers, thresholds, 2);
    expect(composed).toMatchObject({ band: "act", method: "candidates", hold: false });
    expect(composed.selections.map((selection) => selection.candidateId)).toEqual([candidates[1]!.candidateId, candidates[2]!.candidateId]);
    expect(composed.selections[0]).toEqual({ candidateId: candidates[1]!.candidateId, digest: candidates[1]!.digest });
  });

  it("rescues a single candidate from the best choice when none are grounded", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: support("hold", 0.3),
      [`supported:${candidates[0]!.candidateId}`]: support("a", 0.4),
      [DIRECTOR_BEST_KEY]: { type: "choice", choice: candidates[0]!.candidateId, confidence: 0.7, probabilities: { [candidates[0]!.candidateId]: 0.7, [candidates[1]!.candidateId]: 0.2, [candidates[2]!.candidateId]: 0.05, [DIRECTOR_NONE]: 0.05 } },
    };
    expect(composeDirectorSelection(candidates, answers, thresholds)).toMatchObject({
      band: "act", method: "best-pick", selections: [{ candidateId: candidates[0]!.candidateId, digest: candidates[0]!.digest }],
    });
  });

  it("defers when nothing is confident", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [DIRECTOR_HOLD_KEY]: support("hold", 0.4),
      [`supported:${candidates[0]!.candidateId}`]: support("a", 0.45),
      [DIRECTOR_BEST_KEY]: { type: "choice", choice: DIRECTOR_NONE, confidence: 0.3, probabilities: { [DIRECTOR_NONE]: 0.6, [candidates[0]!.candidateId]: 0.4 } },
    };
    const composed = composeDirectorSelection(candidates, answers, thresholds);
    expect(composed).toMatchObject({ band: "fallback", method: "defer", selections: [] });
  });
});
