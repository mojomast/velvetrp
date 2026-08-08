import type { RestHttpRequest } from "@velvet/contracts";
import { useEffect, useRef, useState } from "react";

export type RestIntent = Omit<RestHttpRequest, "expectedRevision" | "idempotencyKey">;

export interface RestDialogProps {
  open: boolean;
  disabled?: boolean;
  onClose: () => void;
  onSubmit: (command: RestIntent) => void;
}

export function RestDialog({ open, disabled = false, onClose, onSubmit }: RestDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [type, setType] = useState<RestIntent["type"]>("take_short_rest");
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) { restoreRef.current = document.activeElement as HTMLElement | null; dialog.showModal(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const close = () => { onClose(); queueMicrotask(() => restoreRef.current?.focus()); };
  return <dialog ref={dialogRef} className="actor-dialog" onCancel={(event) => { event.preventDefault(); if (!disabled) close(); }} onClose={() => { if (open) close(); }}>
    <div className="dialog-heading"><div><p className="eyebrow">RECOVERY COMMAND</p><h2>Take a rest</h2></div><button className="ghost" type="button" disabled={disabled} onClick={close} aria-label="Close rest dialog">Close</button></div>
    <form method="dialog" onSubmit={(event) => { event.preventDefault(); if (confirmed) onSubmit({ type }); }}>
      <fieldset disabled={disabled}><legend>Exact rest type</legend>
        <label className="actor-option"><input type="radio" name="rest-kind" checked={type === "take_short_rest"} onChange={() => { setType("take_short_rest"); setConfirmed(false); }} /> Short rest</label>
        <label className="actor-option"><input type="radio" name="rest-kind" checked={type === "take_long_rest"} onChange={() => { setType("take_long_rest"); setConfirmed(false); }} /> Long rest</label>
      </fieldset>
      <section className="command-review"><h3>Server recovery policy</h3><p>No recovery is predicted in the browser. The server decides whether this rest is legal and returns every recovered resource in its receipt.</p><p>Command: <code>{type}</code></p><label className="actor-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm this rest command</label></section>
      <div className="dialog-actions"><button className="ghost" type="button" disabled={disabled} onClick={close}>Cancel</button><button className="primary" type="submit" disabled={disabled || !confirmed}>Rest once</button></div>
    </form>
  </dialog>;
}
