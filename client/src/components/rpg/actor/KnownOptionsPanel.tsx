export interface KnownOptionView {
  id: string;
  label: string;
  selectionLabel: string;
  kind: string;
}

export interface KnownOptionsPanelProps {
  options: readonly KnownOptionView[];
  pendingChoiceCount?: number;
}

/** Read-only view of the actor's recorded advancement choices (feats, subclasses, and similar). */
export function KnownOptionsPanel({ options, pendingChoiceCount }: KnownOptionsPanelProps) {
  return (
    <section className="actor-section" aria-labelledby="known-options-heading">
      <div className="actor-section-heading">
        <h2 id="known-options-heading">Feats, subclass &amp; advancement</h2>
        {pendingChoiceCount === undefined ? null : <span className="status-pill">{pendingChoiceCount > 0 ? `${pendingChoiceCount} pending` : "Up to date"}</span>}
      </div>
      {options.length ? (
        <dl className="command-detail-list">
          {options.map((option) => (
            <div key={option.id}>
              <dt>{option.label}</dt>
              <dd>{option.selectionLabel} <span className="status-pill">{option.kind}</span></dd>
            </div>
          ))}
        </dl>
      ) : <p className="actor-empty">No advancement choices recorded.</p>}
    </section>
  );
}
