import { createHash } from "node:crypto";
import { systemOneEvaluationBinding, type SystemOneEvaluationBinding } from "../server/src/agent/systemOneBinding.js";
import type { SystemOneSettings } from "../server/src/types.js";

/** Capture the direct speaker benchmark, not the production gated/fallback arm.
 * The benchmark composes raw signals (identity calibration), then fits a map post hoc.
 * Neither that fitted map nor repeated fixture observations constitute an approval.
 */
export function beginSpeakerEvidence(input: {
  settings: SystemOneSettings;
  caseId: string;
  repeat: number;
  state: unknown;
  questions: unknown;
  corpus: unknown;
}) {
  const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const binding = systemOneEvaluationBinding("speaker-routing", input.settings, null, "speaker-selection", {
    compositionVersion: "benchmark-raw-room-routing-group-expansion-v1",
  });
  binding.calibrationA = 1;
  binding.calibrationB = 0;
  const snapshot = {
    schemaVersion: 1 as const, caseId: input.caseId, repeat: input.repeat,
    capturedAt: new Date().toISOString(),
    requestDigest: digest({ state: input.state, questions: input.questions }),
    corpusDigest: digest(input.corpus),
  };
  return (responseModel: string | null | undefined) => ({
    ...snapshot,
    bindings: [{ ...binding, responseModel: responseModel ?? "" }],
    approvalEligible: false as const,
  });
}

/** Freeze before awaiting transport. Deliberately excludes credentials and budget settings. */
export function beginAdventureEvidence(input: {
  settings: SystemOneSettings;
  caseId: string;
  repeat: number;
  state: unknown;
  questions: unknown;
  candidates: readonly { kind: string }[];
  corpus: unknown;
}) {
  const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const bindings = [...new Set(input.candidates.map(candidate => candidate.kind))].sort().map(kind =>
    systemOneEvaluationBinding("adventure-selection", input.settings, null, kind, {
      candidateStrategy: "benchmark-curated-candidates-v1",
    }));
  const snapshot = {
    schemaVersion: 1 as const,
    caseId: input.caseId,
    repeat: input.repeat,
    capturedAt: new Date().toISOString(),
    requestDigest: digest({ state: input.state, questions: input.questions }),
    corpusDigest: digest(input.corpus),
  };
  return (responseModel: string | null | undefined): typeof snapshot & {
    bindings: SystemOneEvaluationBinding[];
    approvalEligible: false;
  } => ({
    ...snapshot,
    bindings: bindings.map(binding => ({ ...binding, responseModel: responseModel ?? "" })),
    // Curated candidates do not exercise production retrieval/shortlisting. Family presence
    // is not kind-specific accuracy; these observations alone cannot authorize execution.
    approvalEligible: false,
  });
}
