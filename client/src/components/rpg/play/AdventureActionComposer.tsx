import { FormEvent, useId } from "react";
import { sheetReferenceKey, type SheetContextEntry } from "@velvet/contracts";
import "./sheetContext.css";

/** A server-authorized actor offered by the campaign play bootstrap. */
export interface AdventureComposerActor {
  actorId: string;
  name: string;
}

/** Public props for the declaration-only campaign play composer. */
export interface AdventureActionComposerProps {
  actors: readonly AdventureComposerActor[];
  selectedActorId: string;
  role: "owner" | "gm" | "player" | "observer";
  eligible: boolean;
  inactive: boolean;
  phase: "ready" | "inflight" | "ambiguous";
  declaration: string;
  onDeclarationChange: (declaration: string) => void;
  onActorChange: (actorId: string) => void;
  onSubmit: (declaration: string) => void;
  composerRef?: React.RefObject<HTMLTextAreaElement>;
  sheetContext?: readonly SheetContextEntry[];
  onRemoveReference?: (key: string) => void;
  onClearReferences?: () => void;
  onOpenSheet?: () => void;
  contextNotice?: string;
  presentation?: "table";
}

/** Renders exact actor selection and declaration submission without client-side mechanics. */
export function AdventureActionComposer({ actors, selectedActorId, role, eligible, inactive, phase,
  declaration, onDeclarationChange, onActorChange, onSubmit, composerRef, sheetContext = [], onRemoveReference, onClearReferences, onOpenSheet, contextNotice, presentation }: AdventureActionComposerProps) {
  const observer = role === "observer";
  const id = useId();
  const actorAvailable = actors.some((actor) => actor.actorId === selectedActorId);
  const disabled = observer || inactive || !eligible || !actorAvailable || phase !== "ready";
  const status = observer ? "Observer access is read-only."
    : inactive ? "This room is inactive."
      : !eligible ? "Adventure turns are unavailable for this room."
        : !actorAvailable ? "Select an available actor to declare an action."
          : phase === "inflight" ? "Action delivery is in progress."
            : phase === "ambiguous" ? "Your last action is still unconfirmed. Check what happened before acting again."
              : "Ready for an in-fiction declaration. Mechanics are resolved by the server.";

  function submit(event: FormEvent) {
    event.preventDefault();
    const exact = declaration.trim();
    if (disabled || exact.length === 0 || exact.length > 8000) return;
    onSubmit(exact);
  }

  const references = <div className="action-context"><div className="action-context-heading"><span>Context for the DM{sheetContext.length ? ` · ${sheetContext.length}` : ""}</span>{onOpenSheet && <button type="button" disabled={disabled} onClick={onOpenSheet}>Add from character sheet</button>}</div>
    {sheetContext.length > 0 ? <><ul aria-label="Selected character references">{sheetContext.map((entry) => <li key={sheetReferenceKey(entry.reference)}><span><strong>{entry.label}</strong><span>{entry.value}</span></span><button type="button" disabled={disabled} aria-label={`Remove ${entry.label} reference`} onClick={() => { onRemoveReference?.(sheetReferenceKey(entry.reference)); composerRef?.current?.focus(); }}>Remove</button></li>)}</ul><button type="button" className="context-clear" disabled={disabled} onClick={() => { onClearReferences?.(); composerRef?.current?.focus(); }}>Clear references</button></> : <p className="action-context-hint">Attach an item, spell, skill, or any sheet detail. Your words describe the action.</p>}
    <p role="status" aria-atomic="true" className={contextNotice ? "sheet-context-note" : "sr-only"}>{contextNotice ?? ""}</p></div>;

  const actorSelection = <label className="composer-identity"><span>{presentation === "table" ? "Playing as" : "Acting character"}</span><select aria-label="Acting character" value={actorAvailable ? selectedActorId : ""}
      disabled={observer || inactive || phase !== "ready" || actors.length === 0}
      onChange={(event) => onActorChange(event.target.value)}>
      <option value="">Select a character</option>
      {actors.map((actor) => <option key={actor.actorId} value={actor.actorId}>{actor.name}</option>)}
    </select></label>;
  const textField = <textarea id={`${id}-declaration`} ref={composerRef} rows={presentation === "table" ? 2 : 3} maxLength={8000}
    aria-describedby={`${id}-help`} value={declaration} disabled={disabled} onChange={(event) => onDeclarationChange(event.target.value)} placeholder="What are you trying to do, and how?" />;
  return <form className={`adventure-composer${presentation === "table" ? " table-composer" : ""}`} onSubmit={submit} aria-describedby={`${id}-status`}>
    {presentation === "table" ? <div className="composer-topline"><label htmlFor={`${id}-declaration`}>What do you do?</label>{actorSelection}</div> : actorSelection}
    {presentation !== "table" && references}
    {presentation === "table" ? <div className="adventure-declaration">{textField}</div> : <label className="adventure-declaration"><span>What do you do?</span>{textField}</label>}
    {presentation === "table" && references}
    <p id={`${id}-help`} className="declaration-help">{sheetContext.length ? "Your words and references are sent together, using current sheet values. " : ""}{declaration.length.toLocaleString()} / 8,000 characters</p>
    <button className="primary" type="submit" disabled={disabled || declaration.trim().length === 0 || declaration.trim().length > 8000}>{presentation === "table" ? "Send action" : "Declare action"}</button>
    <p id={`${id}-status`} className="adventure-composer-status" data-ready={!disabled} role="status" aria-label="Action availability">{status}</p>
  </form>;
}
