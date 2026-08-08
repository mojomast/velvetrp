import type { CombatLogEntryPublic } from "@velvet/contracts";

export interface CombatLogProps {
  entries: readonly CombatLogEntryPublic[];
  nextAfterSequence: number | null;
  loading?: boolean;
  error?: string;
  onLoadMore?: () => void;
  onRetry?: () => void;
}

function title(entry: CombatLogEntryPublic): string {
  switch (entry.event.kind) {
    case "encounter_created": return "Encounter created";
    case "combatant_joined": return "Combatant joined";
    case "initiative_resolved": return "Initiative resolved";
    case "round_advanced": return `Round ${entry.event.round}`;
    case "turn_advanced": return "Turn advanced";
    case "combat_terminal": return "Combat reached terminal state";
    case "encounter_completed": return "Encounter completed";
    case "action_resolved": return `${entry.event.action.replace("-", " ")} resolved`;
    case "combatant_state_changed": return "Combatant state changed";
    case "rewards_granted": return "Rewards granted";
    case "reward_claimed": return "Reward claimed";
  }
}

function detail(entry: CombatLogEntryPublic): string | null {
  const event = entry.event;
  if (event.kind === "combatant_joined" || event.kind === "initiative_resolved" || event.kind === "turn_advanced") return event.combatantId;
  if (event.kind === "action_resolved") return `Action ${event.action} · receipt ${event.actionId}`;
  if (event.kind === "combatant_state_changed") return `${event.combatantId} · ${event.hitPoints} HP · ${event.status}`;
  if (event.kind === "rewards_granted") return `${event.rewardBundleIds.length} reward bundle${event.rewardBundleIds.length === 1 ? "" : "s"}`;
  if (event.kind === "reward_claimed") return `Claim ${event.rewardClaimId}`;
  return null;
}

export function CombatLog({ entries, nextAfterSequence, loading = false, error = "", onLoadMore, onRetry }: CombatLogProps) {
  return <section className="combat-panel combat-log" aria-labelledby="combat-log-heading" aria-busy={loading}>
    <div className="combat-panel-heading"><div><p className="eyebrow">AUTHORITATIVE EVENTS</p><h2 id="combat-log-heading">Combat log</h2></div><span>{entries.length}</span></div>
    {entries.length === 0 && !loading && !error && <p className="combat-empty">No combat events returned.</p>}
    <ol>{entries.map((entry) => <li key={entry.logEntryId}>
      <div><strong>{title(entry)}</strong><span>#{entry.sequence}</span></div>
      {detail(entry) && <p><bdi dir="auto">{detail(entry)}</bdi></p>}
      <time dateTime={entry.occurredAt}>{entry.occurredAt}</time>
    </li>)}</ol>
    {error && <div className="combat-inline-error" role="alert"><p>{error}</p>{onRetry && <button type="button" className="ghost" onClick={onRetry}>Retry log</button>}</div>}
    {loading && <p role="status">Loading combat events…</p>}
    {!error && nextAfterSequence !== null && onLoadMore && <button type="button" className="ghost combat-log-more" disabled={loading} onClick={onLoadMore}>Load later events</button>}
  </section>;
}
