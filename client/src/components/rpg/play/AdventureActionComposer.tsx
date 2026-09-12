import { FormEvent } from "react";

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
}

/** Renders exact actor selection and declaration submission without client-side mechanics. */
export function AdventureActionComposer({ actors, selectedActorId, role, eligible, inactive, phase,
  declaration, onDeclarationChange, onActorChange, onSubmit, composerRef }: AdventureActionComposerProps) {
  const observer = role === "observer";
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
    if (disabled || exact.length === 0) return;
    onSubmit(exact);
  }

  return <form className="adventure-composer" onSubmit={submit} aria-describedby="adventure-composer-status">
    <label><span>Acting character</span><select aria-label="Acting character" value={actorAvailable ? selectedActorId : ""}
      disabled={observer || inactive || phase !== "ready" || actors.length === 0}
      onChange={(event) => onActorChange(event.target.value)}>
      <option value="">Select a character</option>
      {actors.map((actor) => <option key={actor.actorId} value={actor.actorId}>{actor.name}</option>)}
    </select></label>
    <label className="adventure-declaration"><span>What do you do?</span><textarea ref={composerRef} rows={2} maxLength={8000}
      value={declaration} disabled={disabled} onChange={(event) => onDeclarationChange(event.target.value)}
      placeholder="Describe an action in the fiction…" /></label>
    <button className="primary" type="submit" disabled={disabled || declaration.trim().length === 0}>Declare action</button>
    <p id="adventure-composer-status" className="adventure-composer-status" role="status">{status}</p>
  </form>;
}
