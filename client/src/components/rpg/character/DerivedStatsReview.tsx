import type { CharacterDerivedStats, CharacterStartingGrant } from "@velvet/contracts";

export interface DerivedStatsReviewProps {
  derived: CharacterDerivedStats;
  startingGrants: CharacterStartingGrant[];
}

const statisticLabels: Record<string, string> = {
  "max-hp": "Maximum health", "defense-guard": "Guard", "defense-evasion": "Evasion", "defense-will": "Will",
  initiative: "Initiative", speed: "Speed", "carrying-limit": "Carrying limit", "spell-attack": "Spell attack", "save-dc": "Save DC",
};

/** Displays authoritative server preview values; no statistic is calculated in the browser. */
export function DerivedStatsReview({ derived, startingGrants }: DerivedStatsReviewProps) {
  const values = [
    ["Maximum health", derived.maxHp], ["Guard", derived.defenses.guard], ["Evasion", derived.defenses.evasion],
    ["Will", derived.defenses.will], ["Initiative", derived.initiative], ["Speed", derived.speed],
    ["Carrying limit", derived.carryingLimit], ["Spell attack", derived.spellAttack], ["Save DC", derived.saveDc],
  ] as const;
  return <section className="builder-section derived-review" aria-labelledby="derived-heading">
    <div className="builder-section-heading"><div><p className="eyebrow">SERVER PREVIEW</p><h2 id="derived-heading">Derived statistics and starter grants</h2></div><span className="status-pill">Not finalized</span></div>
    <p className="builder-help">These values and explanations were returned by the server. Finalization will validate them again against current pinned content.</p>
    <dl className="derived-stat-grid">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <details className="derived-explanations"><summary>Server calculation explanations</summary><ul>{derived.explanations.map((item) => <li key={item.statistic}><strong>{statisticLabels[item.statistic] ?? item.statistic}</strong><span>{item.formula}</span><span>Result: {item.result}</span></li>)}</ul></details>
    <section className="starting-grants" aria-labelledby="starting-grants-heading"><h3 id="starting-grants-heading">Exact starter grants</h3>
      {startingGrants.length === 0 ? <p>No starter items or currency will be granted.</p> : <ul>{startingGrants.map((grant, index) => <li key={`${grant.kind}-${grant.reference.definitionId}-${index}`}>
        <strong>{grant.kind === "item" ? `${grant.quantity} × item` : `${grant.amount} currency`}</strong>
        <code>{grant.reference.packId} @ {grant.reference.packVersion} / {grant.reference.definitionId}</code>
      </li>)}</ul>}
    </section>
  </section>;
}
