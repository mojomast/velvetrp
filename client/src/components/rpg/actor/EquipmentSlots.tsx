import { equipmentSlotSchema } from "@velvet/contracts";
import type { InventoryHttpCommandRequest, InventoryHttpGetResponse } from "@velvet/contracts";
import { useState } from "react";

type EquipIntent = Omit<Extract<InventoryHttpCommandRequest, { kind: "equip" }>, "expectedRevision" | "idempotencyKey">;
type UnequipIntent = Omit<Extract<InventoryHttpCommandRequest, { kind: "unequip" }>, "expectedRevision" | "idempotencyKey">;

export interface EquipmentSlotsProps {
  inventory: InventoryHttpGetResponse;
  itemLabel: (item: InventoryHttpGetResponse["entries"][number]["item"]) => string;
  disabled?: boolean;
  onCommand: (command: EquipIntent | UnequipIntent) => void;
}

export function EquipmentSlots({ inventory, itemLabel, disabled = false, onCommand }: EquipmentSlotsProps) {
  const [entryId, setEntryId] = useState(inventory.entries[0]?.entryId ?? "");
  const [slot, setSlot] = useState<(typeof equipmentSlotSchema.options)[number]>(equipmentSlotSchema.options[0]);
  const entryById = new Map(inventory.entries.map((entry) => [entry.entryId, entry]));
  return <section className="actor-section" aria-labelledby="equipment-heading">
    <div className="actor-section-heading"><h2 id="equipment-heading">Equipment</h2><span className="count-badge">{inventory.equipment.length}</span></div>
    {inventory.equipment.length === 0 ? <p className="actor-empty">No equipped items.</p> : <ul className="equipment-list">
      {inventory.equipment.map((equipped) => <li key={equipped.slot}>
        <div><span>{equipped.slot}</span><strong><bdi dir="auto">{entryById.has(equipped.entryId) ? itemLabel(entryById.get(equipped.entryId)!.item) : equipped.entryId}</bdi></strong></div>
        <button className="ghost" type="button" disabled={disabled} onClick={() => onCommand({ kind: "unequip", slot: equipped.slot })}>Review unequip</button>
      </li>)}
    </ul>}
    {inventory.entries.length > 0 && <fieldset className="equipment-picker" disabled={disabled}>
      <legend>Equip an inventory entry</legend>
      <label className="field">Item<select value={entryId} onChange={(event) => setEntryId(event.target.value)}>{inventory.entries.map((entry) => <option key={entry.entryId} value={entry.entryId}>{itemLabel(entry.item)}</option>)}</select></label>
      <label className="field">Slot<select value={slot} onChange={(event) => setSlot(equipmentSlotSchema.parse(event.target.value))}>{equipmentSlotSchema.options.map((value) => <option key={value}>{value}</option>)}</select></label>
      <button className="ghost" type="button" disabled={!entryId || disabled} onClick={() => onCommand({ kind: "equip", entryId, slot })}>Review equip</button>
      <p className="actor-help">The server checks whether this item may occupy the selected slot.</p>
    </fieldset>}
  </section>;
}
