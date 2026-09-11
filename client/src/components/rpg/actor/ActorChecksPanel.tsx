import type { ActorCheckCommandRequest, ActorCheckCommandResponse } from "@velvet/contracts";
import { useState } from "react";

type CheckKind = ActorCheckCommandRequest["kind"];
type CheckIntent = ActorCheckCommandRequest extends infer Command ? Command extends ActorCheckCommandRequest
  ? Omit<Command, "expectedRevision" | "idempotencyKey"> : never : never;
const CHECK_KINDS: CheckKind[] = ["ability", "skill", "save", "attack", "opposed"];
const DIFFICULTIES = ["easy", "standard", "hard", "very-hard"] as const;

export interface ActorChecksPanelProps {
  disabled?: boolean;
  result?: ActorCheckCommandResponse | null;
  onSubmit?: (intent: CheckIntent) => void;
}

/** Server-owned ability, skill, save, attack, and opposed checks. No caller supplies modifiers or totals. */
export function ActorChecksPanel({ disabled = false, result = null, onSubmit }: ActorChecksPanelProps) {
  const [kind, setKind] = useState<CheckKind>("skill");
  const [skillOrAttribute, setSkillOrAttribute] = useState("");
  const [difficultyRef, setDifficultyRef] = useState<(typeof DIFFICULTIES)[number]>("standard");
  const [targetActorId, setTargetActorId] = useState("");
  const needsTarget = kind === "attack" || kind === "opposed";
  const valid = skillOrAttribute.trim().length > 0 && (!needsTarget || targetActorId.trim().length > 0);
  const submit = () => {
    if (!valid) return;
    const base = { kind, skillOrAttribute: skillOrAttribute.trim() } as { kind: CheckKind; skillOrAttribute: string; difficultyRef?: string; targetActorId?: string };
    if (kind === "opposed") base.targetActorId = targetActorId.trim();
    else {
      base.difficultyRef = difficultyRef;
      if (kind === "attack" && targetActorId.trim()) base.targetActorId = targetActorId.trim();
    }
    onSubmit?.(base as CheckIntent);
  };
  return <section className="actor-section" aria-labelledby="actor-checks-heading">
    <div className="actor-section-heading"><h2 id="actor-checks-heading">Checks</h2><span className="status-pill">Server-resolved</span></div>
    <p className="actor-help">The server derives the modifier and target number. The client never submits a total.</p>
    <div className="actor-check-form">
      <label className="field">Check kind<select value={kind} disabled={disabled} onChange={(event) => setKind(event.target.value as CheckKind)}>{CHECK_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="field">Skill or attribute ID<input value={skillOrAttribute} disabled={disabled} autoComplete="off" onChange={(event) => setSkillOrAttribute(event.target.value)} /></label>
      {kind !== "opposed" && <label className="field">Difficulty<select value={difficultyRef} disabled={disabled} onChange={(event) => setDifficultyRef(event.target.value as (typeof DIFFICULTIES)[number])}>{DIFFICULTIES.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
      {needsTarget && <label className="field">Target actor ID<input value={targetActorId} disabled={disabled || kind === "opposed"} autoComplete="off" onChange={(event) => setTargetActorId(event.target.value)} /></label>}
      <div className="button-row"><button className="primary" type="button" disabled={disabled || !valid} onClick={submit}>Resolve check</button></div>
    </div>
    {result && <div className="check-result" role="status"><dl className="command-detail-list"><div><dt>Outcome</dt><dd>{result.check.outcome}</dd></div><div><dt>Total</dt><dd>{result.check.total}</dd></div><div><dt>Target</dt><dd>{result.check.target.kind === "difficulty_class" ? result.check.target.value : `${result.check.target.actorId} (${result.check.target.value})`}</dd></div><div><dt>Modifier</dt><dd>{result.check.modifier}</dd></div><div><dt>Revision</dt><dd>{result.receipt.revisionBefore} → {result.receipt.revisionAfter}</dd></div></dl><details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></div>}
  </section>;
}
