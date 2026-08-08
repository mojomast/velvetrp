import type { ActorResourcesHttpGetResponse, RestHttpRequest } from "@velvet/contracts";
import { useEffect, useRef, useState } from "react";

export type RestIntent = Omit<RestHttpRequest, "expectedRevision" | "idempotencyKey">;

export interface RestDialogProps {
  open: boolean;
  disabled?: boolean;
  resources: ActorResourcesHttpGetResponse;
  onClose: () => void;
  onSubmit: (command: RestIntent) => void;
}

export function RestDialog({ open, disabled = false, resources, onClose, onSubmit }: RestDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [type, setType] = useState<RestIntent["type"]>("take_short_rest");
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const exactIntent: RestIntent = { type };
  const exactSnapshot = JSON.stringify({ intent: exactIntent, resourceContext: resources });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { restoreRef.current = document.activeElement as HTMLElement | null; dialog.showModal(); }
    if (!open) { if (dialog.open) dialog.close(); queueMicrotask(() => restoreRef.current?.focus()); }
  }, [open]);
  const close = () => { onClose(); };
  return <dialog ref={dialogRef} className="actor-dialog" onKeyDown={(event) => { if (event.key === "Escape" && !disabled) { event.preventDefault(); close(); } }} onCancel={(event) => { event.preventDefault(); if (!disabled) close(); }} onClose={() => { if (open) close(); }}>
    <div className="dialog-heading"><div><p className="eyebrow">RECOVERY COMMAND</p><h2>Take a rest</h2></div><button className="ghost" type="button" disabled={disabled} onClick={close} aria-label="Close rest dialog">Close</button></div>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (confirmedSnapshot === exactSnapshot) onSubmit(exactIntent); }}>
      <fieldset disabled={disabled}><legend>Exact rest type</legend>
        <label className="actor-option"><input type="radio" name="rest-kind" checked={type === "take_short_rest"} onChange={() => { setType("take_short_rest"); setConfirmedSnapshot(null); }} /> Short rest</label>
        <label className="actor-option"><input type="radio" name="rest-kind" checked={type === "take_long_rest"} onChange={() => { setType("take_long_rest"); setConfirmedSnapshot(null); }} /> Long rest</label>
      </fieldset>
      <section className="command-review"><h3>Exact rest and current server context</h3><p>Command: <code>{type}</code> at actor-resource revision {resources.revision}.</p>{resources.resources.length ? <dl className="command-detail-list">{resources.resources.map((resource) => <div key={resource.name}><dt>{resource.name}</dt><dd>Current {resource.current} · maximum {resource.max}</dd></div>)}</dl> : <p>No resources were returned in the current context.</p>}<p>No recovery is predicted in the browser. The server decides whether this rest is legal and returns every recovered resource and before/after value in its receipt.</p><label className="actor-confirm"><input type="checkbox" checked={confirmedSnapshot === exactSnapshot} onChange={(event) => setConfirmedSnapshot(event.target.checked ? exactSnapshot : null)} /> Confirm this exact rest type and reviewed current context</label></section>
      <div className="dialog-actions"><button className="ghost" type="button" disabled={disabled} onClick={close}>Cancel</button><button className="primary" type="submit" disabled={disabled || confirmedSnapshot !== exactSnapshot}>Rest once</button></div>
    </form>
  </dialog>;
}
