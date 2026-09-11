import { useState } from "react";

export interface TradeInboxPanelProps {
  disabled?: boolean;
  onAccept: (tradeId: string) => void;
  onCancel: (tradeId: string) => void;
}

/** Accepts or cancels one exact open bilateral trade by ID. The server enforces party and lifecycle rules. */
export function TradeInboxPanel({ disabled = false, onAccept, onCancel }: TradeInboxPanelProps) {
  const [tradeId, setTradeId] = useState("");
  const valid = tradeId.trim().length > 0;
  return <section className="actor-section" aria-labelledby="trade-inbox-heading">
    <div className="actor-section-heading"><h2 id="trade-inbox-heading">Bilateral trades</h2></div>
    <p className="actor-help">Enter an exact open trade ID to accept (recipient only) or cancel (either party). The server rejects closed, expired, or unauthorized trades.</p>
    <label className="field">Trade ID<input value={tradeId} disabled={disabled} autoComplete="off" onChange={(event) => setTradeId(event.target.value)} /></label>
    <div className="button-row">
      <button className="primary" type="button" disabled={disabled || !valid} onClick={() => onAccept(tradeId.trim())}>Accept trade</button>
      <button className="ghost" type="button" disabled={disabled || !valid} onClick={() => onCancel(tradeId.trim())}>Cancel trade</button>
    </div>
  </section>;
}
