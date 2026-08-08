import { useEffect, useRef, useState } from "react";
import type { CampaignTransferHttpExportDocument } from "@velvet/contracts";

const INCLUDED = ["Campaign settings and lifecycle", "Timeline events and fork ancestry", "Actors and mechanical state", "Checkpoints and recaps", "Memberships and room attachment references", "Administration provenance"];
const EXCLUDED = ["Credentials", "Local paths", "Usage history", "Private actor state"];
export interface CampaignExportApi { export: (campaignId: string, includeMessages: boolean) => Promise<CampaignTransferHttpExportDocument> }
export interface CampaignExportDialogProps { campaignId: string; campaignName: string; open: boolean; api: CampaignExportApi; onClose: () => void }

export function CampaignExportDialog({ campaignId, campaignName, open, api, onClose }: CampaignExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null), closeRef = useRef<HTMLButtonElement>(null), triggerFocus = useRef<HTMLElement | null>(null);
  const [messages, setMessages] = useState<boolean | null>(null), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (open && !dialog.open) { triggerFocus.current = document.activeElement as HTMLElement | null; setMessages(null); setReviewed(false); setError(""); dialog.showModal(); queueMicrotask(() => closeRef.current?.focus()); } else if (!open && dialog.open) dialog.close(); }, [open]);
  function close() { dialogRef.current?.close(); onClose(); queueMicrotask(() => triggerFocus.current?.focus()); }
  async function download() {
    if (!reviewed || messages === null || busy) return; setBusy(true); setError("");
    try {
      const document = await api.export(campaignId, messages);
      const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(document)], { type: "application/json" }));
      const link = window.document.createElement("a"); link.href = blobUrl; link.download = `${campaignName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "campaign"}-velvet-export-v1.json`; link.click(); URL.revokeObjectURL(blobUrl);
      close();
    } catch { setError("The exact export document could not be fetched. Nothing was downloaded; review and retry this read."); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialogRef} className="rpg-dialog transfer-dialog" onCancel={(event) => { event.preventDefault(); if (!busy) close(); }} onClose={() => { if (open) onClose(); }} aria-labelledby="export-heading">
    <div className="dialog-heading"><div><p className="eyebrow">EXPORT REVIEW</p><h2 id="export-heading">Download campaign document</h2></div><button ref={closeRef} type="button" className="ghost" disabled={busy} onClick={close}>Close</button></div>
    <p>Review the portable document before it is fetched and downloaded. No server filesystem path is requested or shown.</p>
    <section><h3>Always included</h3><ul>{INCLUDED.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <section><h3>Always excluded</h3><ul>{EXCLUDED.map((item) => <li key={item}>{item}</li>)}</ul></section>
    <fieldset><legend>Messages (choose one)</legend><label><input type="radio" name="export-messages" checked={messages === true} onChange={() => { setMessages(true); setReviewed(false); }} /> Include messages from attached rooms</label><label><input type="radio" name="export-messages" checked={messages === false} onChange={() => { setMessages(false); setReviewed(false); }} /> Exclude all message content</label></fieldset>
    {messages !== null && <div className="review-card"><h3>Exact download choice</h3><p>{messages ? "Attached-room messages will be included." : "No message content will be included."} Fixed exclusions remain excluded.</p><label className="checkbox"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>I reviewed all included and excluded categories.</span></label></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="primary" disabled={!reviewed || messages === null || busy} onClick={() => void download()}>{busy ? "Fetching exact document…" : "Fetch and download exact document"}</button></div>
  </dialog>;
}
