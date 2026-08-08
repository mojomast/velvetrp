import { useState } from "react";
import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  CHARACTER_BUILDER_POINT_BUY_BUDGET,
  CHARACTER_BUILDER_STANDARD_ARRAY,
  characterBuilderAllocationRequestSchema,
  characterBuilderPointBuyCost,
  type CharacterBuilderAllocationRequest,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";

export interface AttributeAllocatorProps {
  disabled?: boolean;
  onContinue: (allocation: CharacterBuilderAllocationRequest) => void;
}

const labels: Record<(typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number], string> = {
  might: "Might", agility: "Agility", resolve: "Resolve", insight: "Insight", presence: "Presence", craft: "Craft",
};

const defaultScores = Object.fromEntries(CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;

/** Selects only allocation methods accepted by the server contract. It never rolls dice or derives statistics. */
export function AttributeAllocator({ disabled = false, onContinue }: AttributeAllocatorProps) {
  const [method, setMethod] = useState<CharacterBuilderAllocationRequest["method"]>("standard-array");
  const [scores, setScores] = useState<CharacterBuilderAttributeScores>(defaultScores);

  function updateScore(id: keyof CharacterBuilderAttributeScores, value: number) {
    setScores((current) => ({ ...current, [id]: value }));
  }

  const candidate = method === "server-roll" ? { method } : { method, scores };
  const parsed = characterBuilderAllocationRequestSchema.safeParse(candidate);
  const pointCost = method === "point-buy" ? characterBuilderPointBuyCost(scores) : null;

  function submit() { if (parsed.success) onContinue(parsed.data); }

  return <section className="builder-section attribute-allocator" aria-labelledby="allocation-heading">
    <div className="builder-section-heading"><div><p className="eyebrow">STEP 1</p><h2 id="allocation-heading">Allocate attributes</h2></div></div>
    <p className="builder-help">Choose a rules-supported method. Rolls and all derived statistics are calculated only by the server.</p>
    <fieldset disabled={disabled}>
      <legend>Allocation method</legend>
      <div className="allocation-methods">
        {(["standard-array", "point-buy", "manual", "server-roll"] as const).map((value) => <label key={value}>
          <input type="radio" name="allocation-method" value={value} checked={method === value} onChange={() => setMethod(value)} />
          <span>{value === "server-roll" ? "Server roll" : value.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ")}</span>
        </label>)}
      </div>
    </fieldset>
    {method !== "server-roll" ? <fieldset className="attribute-grid" disabled={disabled} aria-describedby={!parsed.success ? "allocation-error" : undefined}>
      <legend>Attribute scores</legend>
      {CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => <label className="field" key={id}>
        <span>{labels[id]}</span>
        {method === "standard-array" ? <select aria-label={`${labels[id]} score`} value={scores[id]} onChange={(event) => updateScore(id, Number(event.target.value))}>
          {CHARACTER_BUILDER_STANDARD_ARRAY.map((score) => <option key={`${id}-${score}`} value={score}>{score}</option>)}
        </select> : <input aria-label={`${labels[id]} score`} type="number" min={method === "point-buy" ? 8 : 3} max={method === "point-buy" ? 15 : 20} value={scores[id]} onChange={(event) => updateScore(id, Number(event.target.value))} />}
        {method === "standard-array" && <small>Use each array value once. Position {index + 1}.</small>}
      </label>)}
    </fieldset> : <p className="builder-callout">The server will make and persist one auditable 4d6 roll for each attribute when the draft is created.</p>}
    {method === "point-buy" && <p className="builder-help">Point-buy budget: {pointCost ?? "invalid"} / {CHARACTER_BUILDER_POINT_BUY_BUDGET} points.</p>}
    {!parsed.success && <p className="form-error" id="allocation-error" role="alert">{method === "standard-array" ? "Assign each standard-array value exactly once." : method === "point-buy" ? `Spend exactly ${CHARACTER_BUILDER_POINT_BUY_BUDGET} points using scores from 8 through 15.` : "Enter a score from 3 through 20 for every attribute."}</p>}
    <button className="primary" type="button" disabled={disabled || !parsed.success} onClick={submit}>Create draft with this allocation</button>
  </section>;
}
