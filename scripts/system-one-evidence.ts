import { createHash } from "node:crypto";
import { systemOneEvaluationBinding, type SystemOneEvaluationBinding } from "../server/src/agent/systemOneBinding.js";
import type { SystemOneSettings } from "../server/src/types.js";

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
