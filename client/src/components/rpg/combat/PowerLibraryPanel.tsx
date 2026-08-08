import type { ActorPowersResponse, PowerReference } from "@velvet/contracts";

export interface PowerLibraryPanelProps {
  powers: ActorPowersResponse | null;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}

const referenceKey = (power: PowerReference) =>
  `${power.kind}\0${power.packId}\0${power.packVersion}\0${power.definitionId}`;

function availabilityText(reason: ActorPowersResponse["legalNow"][number]["reasons"][number]): string {
  if (reason === "execution-pin-unavailable") return "execution pin unavailable";
  if (reason === "finite-uses-exhausted") return "finite uses exhausted";
  return "spell slot unavailable";
}

/** Read-only server projection. Power activation is intentionally not offered here. */
export function PowerLibraryPanel({ powers, loading = false, error = "", onRefresh }: PowerLibraryPanelProps) {
  const legalByPower = new Map(powers?.legalNow.map((entry) => [referenceKey(entry.powerRef), entry]) ?? []);
  const usesByPower = new Map(powers?.uses.map((entry) => [referenceKey(entry.powerRef), entry]) ?? []);
  return <section className="combat-panel power-library" aria-labelledby="power-library-heading" aria-busy={loading}>
    <div className="combat-panel-heading"><div><p className="eyebrow">SERVER AVAILABILITY</p><h2 id="power-library-heading">Powers</h2></div>{powers && <span className="status-pill">Revision {powers.revision}</span>}</div>
    {loading && <p role="status">Loading authoritative powers…</p>}
    {error && <div className="combat-inline-error" role="alert"><p>{error}</p>{onRefresh && <button type="button" className="ghost" onClick={onRefresh}>Retry powers</button>}</div>}
    {!loading && !error && !powers && <p className="combat-empty">Connect an actor to load powers.</p>}
    {powers && <>
      <dl className="power-slot-list" aria-label="Server-returned spell slots">
        {powers.slots.map((slot) => <div key={slot.slotId}><dt>Level {slot.level} slot</dt><dd>{slot.current} / {slot.max}</dd></div>)}
      </dl>
      {powers.known.length === 0 ? <p className="combat-empty">No known powers returned.</p> : <ul className="power-list">
        {powers.known.map((power) => {
          const key = referenceKey(power);
          const availability = legalByPower.get(key);
          const use = usesByPower.get(key);
          const prepared = powers.prepared.some((entry) => referenceKey(entry) === key);
          return <li key={key}>
            <div className="power-title"><strong><bdi dir="auto">{power.definitionId}</bdi></strong><span>{power.kind}</span></div>
            <dl>
              <div><dt>Prepared</dt><dd>{prepared ? "Yes" : "No"}</dd></div>
              <div><dt>Available now</dt><dd>{availability?.legal ? "Yes" : "No"}</dd></div>
              {use && <><div><dt>Uses</dt><dd>{use.current} / {use.max}</dd></div><div><dt>Recovery</dt><dd>{use.recovery.replaceAll("_", " ")}</dd></div></>}
            </dl>
            {availability && !availability.legal && <p className="combat-restriction">{availability.reasons.map(availabilityText).join("; ")}</p>}
          </li>;
        })}
      </ul>}
      <p className="combat-authority-note">Availability, slots, and uses are displayed exactly from the server. This panel does not infer targets or permit activation.</p>
    </>}
  </section>;
}
