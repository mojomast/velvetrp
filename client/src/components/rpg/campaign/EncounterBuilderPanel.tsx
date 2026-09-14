import { useState, type FormEvent } from "react";
import type { EncounterPlanResponse, EncounterPlanningRequest } from "@velvet/contracts";
import { planCampaignEncounter } from "../../../api";

export interface EncounterBuilderApi {
  planCampaignEncounter: typeof planCampaignEncounter;
}

export interface EncounterBuilderPanelProps {
  campaignId: string;
  defaultPartyLevels?: readonly number[];
  api?: EncounterBuilderApi;
}

const DIFFICULTIES: ReadonlyArray<EncounterPlanningRequest["targetDifficulty"]> = ["easy", "medium", "hard", "deadly"];

function parseLevels(value: string): number[] {
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => Number(entry));
}

export function EncounterBuilderPanel({ campaignId, defaultPartyLevels = [1, 1, 1, 1], api }: EncounterBuilderPanelProps) {
  const client = api ?? { planCampaignEncounter };
  const [levels, setLevels] = useState(defaultPartyLevels.join(", "));
  const [difficulty, setDifficulty] = useState<EncounterPlanningRequest["targetDifficulty"]>("medium");
  const [result, setResult] = useState<EncounterPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await client.planCampaignEncounter(campaignId, { partyLevels: parseLevels(levels), targetDifficulty: difficulty });
      setResult(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Encounter planning failed");
    } finally {
      setPending(false);
    }
  };

  const names = new Map((result?.candidates ?? []).map((candidate) => [candidate.id, candidate.name]));

  return (
    <section aria-labelledby="encounter-builder-heading">
      <h3 id="encounter-builder-heading">Encounter builder</h3>
      <form onSubmit={submit}>
        <label htmlFor="encounter-builder-levels">Party levels (comma separated)</label>
        <input id="encounter-builder-levels" name="partyLevels" value={levels} onChange={(event) => setLevels(event.target.value)} />
        <label htmlFor="encounter-builder-difficulty">Target difficulty</label>
        <select id="encounter-builder-difficulty" value={difficulty} onChange={(event) => setDifficulty(event.target.value as EncounterPlanningRequest["targetDifficulty"])}>
          {DIFFICULTIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button type="submit" disabled={pending}>{pending ? "Planning…" : "Plan encounter"}</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <div aria-label="Encounter plan">
          <p>Resulting difficulty: <strong>{result.plan.difficulty}</strong></p>
          <p>Target {result.plan.targetXp} XP · adjusted {result.plan.adjustedXp} XP · {result.plan.monsterCount} monsters</p>
          {result.plan.roster.length > 0 ? (
            <ul>
              {result.plan.roster.map((entry) => (
                <li key={entry.id}>{names.get(entry.id) ?? entry.id} ×{entry.count} (CR {entry.challengeRating})</li>
              ))}
            </ul>
          ) : <p>No monsters were selected.</p>}
          {result.plan.legal ? null : <p role="status">The plan is outside the target band.</p>}
        </div>
      ) : null}
    </section>
  );
}
