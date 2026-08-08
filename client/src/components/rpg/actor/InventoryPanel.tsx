import { resourceIdSchema } from "@velvet/contracts";
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

const exactReference = (item: InventoryHttpGetResponse["entries"][number]["item"]) =>
  `${item.packId} @ ${item.packVersion} / ${item.definitionId}`;

const snapshot = (command: InventoryIntent, expectedRevision: number) => JSON.stringify({ command, expectedRevision });

function consequence(kind: InventoryIntent["kind"]): string {
  if (kind === "equip" || kind === "unequip") return "The server will enforce slot and item binding policy and return the resulting equipment state.";
  if (kind === "consume") return "The server will enforce consumption eligibility and return the resulting inventory state; any item effects remain server-owned.";
  if (kind === "drop") return "The server will enforce drop and binding policy before removing the exact quantity.";
  return "The server will enforce ownership, binding, recipient, and capacity policy before gifting the exact quantity.";
}

export function InventoryPanel({ inventory, disabled = false, describeItem, onCommand }: InventoryPanelProps) {
  const [review, setReview] = useState<InventoryIntent | null>(null);
  const [confirmedSnapshot, setConfirmedSnapshot] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [recipient, setRecipient] = useState("");
  const parsedQuantity = /^\d+$/.test(quantity) ? Number(quantity) : 0;
  const resetConfirmation = () => setConfirmedSnapshot(null);
  const editSource = () => { setReview(null); resetConfirmation(); };
  const begin = (command: InventoryIntent) => { setReview(command); resetConfirmation(); };
  const finish = () => { if (!review || confirmedSnapshot !== snapshot(review, inventory.revision)) return; onCommand(review); setReview(null); resetConfirmation(); };
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
              {entry.kind === "stackable" && <label className="compact-number">Quantity<input aria-label={`Quantity for ${presentation.name}`} inputMode="numeric" value={quantity} onChange={(event) => { setQuantity(event.target.value); editSource(); }} /></label>}
              <button className="ghost" type="button" disabled={disabled || !legalQuantity} onClick={() => itemCommand("consume")}>Review consume</button>
              <button className="ghost" type="button" disabled={disabled || !legalQuantity} onClick={() => itemCommand("drop")}>Review drop</button>
              <label className="compact-recipient">Recipient actor ID<input aria-label={`Gift ${presentation.name} recipient actor ID`} value={recipient} onChange={(event) => { setRecipient(event.target.value); editSource(); }} /></label>
              <button className="ghost" type="button" disabled={disabled || !legalQuantity || !resourceIdSchema.safeParse(recipient).success} onClick={() => begin({ kind: "gift", recipientActorId: recipient, entryId: entry.entryId, item: entry.item, quantity: exactQuantity })}>Review gift</button>
            </div>
          </li>;
        })}
      </ul>}
      <p className="actor-help">Capacity and quantities are the latest values returned by the server.</p>
    </section>
    {review && <section className="command-review" aria-labelledby="inventory-review-heading">
      <h3 id="inventory-review-heading">Confirm inventory command</h3>
      <dl className="command-detail-list"><div><dt>Command</dt><dd>{review.kind}</dd></div><div><dt>Expected revision</dt><dd>{inventory.revision}</dd></div>{"entryId" in review && <div><dt>Entry</dt><dd>{review.entryId}</dd></div>}{"item" in review && <div><dt>Exact item</dt><dd>{exactReference(review.item)}</dd></div>}{"quantity" in review && <div><dt>Quantity</dt><dd>{review.quantity}</dd></div>}{"slot" in review && <div><dt>Slot</dt><dd>{review.slot}</dd></div>}{review.kind === "gift" && <div><dt>Recipient</dt><dd>{review.recipientActorId}</dd></div>}</dl>
      <p>{consequence(review.kind)}</p>
      <label className="actor-confirm"><input type="checkbox" checked={confirmedSnapshot === snapshot(review, inventory.revision)} onChange={(event) => setConfirmedSnapshot(event.target.checked ? snapshot(review, inventory.revision) : null)} /> Confirm these exact submitted values</label>
      <div className="button-row"><button className="primary" type="button" disabled={confirmedSnapshot !== snapshot(review, inventory.revision) || disabled} onClick={finish}>Submit once</button><button className="ghost" type="button" disabled={disabled} onClick={() => { setReview(null); resetConfirmation(); }}>Cancel</button></div>
    </section>}
  </>;
}
