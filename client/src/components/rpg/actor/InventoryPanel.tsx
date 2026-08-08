import type { InventoryHttpCommandRequest, InventoryHttpGetResponse } from "@velvet/contracts";
import { useState } from "react";
import { EquipmentSlots } from "./EquipmentSlots";

export type InventoryIntent = InventoryHttpCommandRequest extends infer Command
  ? Command extends InventoryHttpCommandRequest ? Omit<Command, "expectedRevision" | "idempotencyKey"> : never
  : never;

export interface InventoryItemPresentation {
  name: string;
  category?: string;
  slot?: string | null;
}

export interface InventoryPanelProps {
  inventory: InventoryHttpGetResponse;
  disabled?: boolean;
  describeItem: (item: InventoryHttpGetResponse["entries"][number]["item"]) => InventoryItemPresentation;
  onCommand: (command: InventoryIntent) => void;
}

export function InventoryPanel({ inventory, disabled = false, describeItem, onCommand }: InventoryPanelProps) {
  const [review, setReview] = useState<InventoryIntent | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [recipient, setRecipient] = useState("");
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const begin = (command: InventoryIntent) => { setReview(command); setConfirmed(false); };
  const finish = () => { if (!review || !confirmed) return; onCommand(review); setReview(null); setConfirmed(false); };
  return <>
    <EquipmentSlots inventory={inventory} itemLabel={(item) => describeItem(item).name} disabled={disabled || review !== null} onCommand={begin} />
    <section className="actor-section" aria-labelledby="inventory-heading">
      <div className="actor-section-heading"><h2 id="inventory-heading">Inventory</h2><span className="count-badge">{inventory.entries.length} / {inventory.capacity} entries</span></div>
      {inventory.entries.length === 0 ? <p className="actor-empty">Inventory is empty.</p> : <ul className="inventory-list">
        {inventory.entries.map((entry) => {
          const presentation = describeItem(entry.item);
          const exactQuantity = entry.kind === "stackable" ? parsedQuantity : 1;
          const legalQuantity = Number.isSafeInteger(exactQuantity) && exactQuantity >= 1 && exactQuantity <= 1_000_000;
          const itemCommand = (kind: "consume" | "drop") => begin({ kind, entryId: entry.entryId, item: entry.item, quantity: exactQuantity });
          return <li key={entry.entryId}>
            <div className="inventory-copy"><strong><bdi dir="auto">{presentation.name}</bdi></strong><span>{entry.kind === "stackable" ? `Quantity ${entry.quantity}` : "Instanced item"}{presentation.category ? ` · ${presentation.category}` : ""}</span>
              {presentation.slot && <span className="binding-notice" role="status">Equipment binding: {presentation.slot} slot</span>}
            </div>
            <div className="inventory-actions">
              {entry.kind === "stackable" && <label className="compact-number">Quantity<input aria-label={`Quantity for ${presentation.name}`} inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>}
              <button className="ghost" type="button" disabled={disabled || !legalQuantity} onClick={() => itemCommand("consume")}>Review consume</button>
              <button className="ghost" type="button" disabled={disabled || !legalQuantity} onClick={() => itemCommand("drop")}>Review drop</button>
              <label className="compact-recipient">Recipient actor ID<input aria-label={`Gift ${presentation.name} recipient actor ID`} value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label>
              <button className="ghost" type="button" disabled={disabled || !legalQuantity || recipient.length === 0} onClick={() => begin({ kind: "gift", recipientActorId: recipient, entryId: entry.entryId, item: entry.item, quantity: exactQuantity })}>Review gift</button>
            </div>
          </li>;
        })}
      </ul>}
      <p className="actor-help">Capacity and quantities are the latest values returned by the server.</p>
    </section>
    {review && <section className="command-review" aria-labelledby="inventory-review-heading">
      <h3 id="inventory-review-heading">Confirm inventory command</h3>
      <p>This will submit exactly one <strong>{review.kind}</strong> command. The server decides item binding, capacity, and eligibility.</p>
      <label className="actor-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm this exact command</label>
      <div className="button-row"><button className="primary" type="button" disabled={!confirmed || disabled} onClick={finish}>Submit once</button><button className="ghost" type="button" disabled={disabled} onClick={() => setReview(null)}>Cancel</button></div>
    </section>}
  </>;
}
