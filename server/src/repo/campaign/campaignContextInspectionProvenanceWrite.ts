import type DatabaseDriver from "better-sqlite3";

export type ContextInspectionProvenanceInput = { dispatchId: string; campaignId: string; sessionId: string; lane: "adventure-planning" | "adventure-narration" | "director-planning" | "director-narration"; recordedPhase: "planned" | "narrated"; createdAt: string };
export type ContextInspectionProvenanceMode = "normal" | "revoked" | "omit";

export const contextInspectionSectionLabels = (lane: ContextInspectionProvenanceInput["lane"]): readonly string[] => lane === "adventure-planning"
  ? ["Decision identity", "Campaign context", "Historical recall", "Provider tool registry"]
  : lane === "adventure-narration" ? ["Committed result context", "Public campaign context", "Narration provider request"]
    : lane === "director-planning" ? ["Private director context", "Legal candidate set", "Historical recall"]
      : ["Public committed context", "Narration provider request"];

/** Writes fixed safe provenance only; payloads, queries, and text are intentionally absent. */
export function recordContextInspectionProvenance(db: DatabaseDriver.Database, input: ContextInspectionProvenanceInput, mode: ContextInspectionProvenanceMode = "normal"): void {
  if (mode === "omit") return;
  db.prepare("INSERT INTO campaign_context_inspection_headers_v61(dispatch_id,provenance_version,campaign_id,session_id,lane,recorded_phase,source_visibility,created_at) VALUES(?,1,?,?,?,?,?,?)").run(input.dispatchId,input.campaignId,input.sessionId,input.lane,input.recordedPhase,mode === "revoked" ? "revoked" : "private",input.createdAt);
  const statement = db.prepare("INSERT INTO campaign_context_inspection_sources_v61(dispatch_id,source_order,source_kind,source_id,source_label,authority) VALUES(?,?,'none',NULL,?,'system-safety')");
  contextInspectionSectionLabels(input.lane).forEach((label, index) => statement.run(input.dispatchId,index,label));
}
