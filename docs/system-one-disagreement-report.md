# System One Director disagreement report

Status: implemented read-only report. The pure comparison module
(`server/src/agent/systemOneDisagreement.ts`), the repository read side
(`listDirectorDecisionsWithAuthority` in `server/src/repo/systemOneDecisionRepo.ts`), and
the report CLI (`scripts/report-system-one-disagreements.ts`) make **no provider call and
no database write**. They compare the Director lane's would-be selections against the
authoritative provider composition committed for the same run and render a review queue.
This report is a deterministic detector, not a verdict — a divergence only marks a case as
worth human review.

## Why

The Director lane (`director-selection`) is shadow-only: its lane mode is `shadow`, or
`active` but unpromoted. In both cases it records what it *would* have committed while the
provider selection stays authoritative, so the committed composition is the ground truth a
reviewer compares against. A divergence is not proof that the Director was wrong — the
provider may be right, or both may be defensible — but it is the sharpest deterministic
signal that a case deserves human attention.

Once a divergent case is labelled, it becomes a candidate **negative example** for the
Director corpus. That corpus currently lacks acted errors, so it cannot distinguish a lane
that is merely lucky from one that is calibrated; the disagreement queue is the cheapest
way to surface the cases that would add them.

## How it works

The Director decision records `turnId` equal to the DM run id. The authoritative
composition is the `dm_runs.proposal_json` for that run:

- an **ordered array** of `{candidateId, digest}` entries,
- a **legacy single object** (normalized to a one-element list),
- or `null` for a **hold**.

Comparison is on the ordered candidate ids. Order matters because the Director composes
beats and the executor runs them in sequence, so the same set in a different order is a
disagreement. A held Director decision and a held provider both normalize to an empty
list, which reads as agreement. A run that does not exist (or a `turnId` that is absent,
or a missing run table) degrades to `unknown` rather than throwing.

The pure module exposes:

- `compareDirectorAuthority(rows)` — maps each `DirectorDecisionAuthority` to a row with
  `agreement` of `agree`, `disagree`, or `unknown`.
- `summarizeDirectorDisagreement(rows)` — counts `total`, `agree`, `disagree`, `unknown`,
  and `actedDisagree` (disagreements where the Director would have committed at least one
  beat), plus the disagreeing decision ids.
- `renderDirectorDisagreementReport(rows, options)` — renders the deterministic Markdown
  report. Agreements are omitted by default so the output is a review queue; set
  `includeAgreements` to list every decision.

## CLI usage

The report is read-only, so it does **not** need provider credentials or the `jev.env`
sourcing used for live lanes. Point it at the world's data directory directly:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/report-system-one-disagreements.ts --limit 50
```

By default agreements are omitted, so the output is a review queue. Use `--all` to list
agreements too:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/report-system-one-disagreements.ts --all
```

Write the rendered report to a file:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/report-system-one-disagreements.ts --out docs/system-one-disagreement-report.md
```

Print usage and every option:

```bash
npx tsx scripts/report-system-one-disagreements.ts --help
```

## Relationship to the review path

[System One decision review](system-one-decision-review.md) and this report are
complementary. The review CLI (`scripts/review-system-one-decisions.ts`) is
human-verdict driven and can run over any lane; this report is a deterministic
Director-only disagreement detector over the same immutable decision log. Use them
together: run the disagreement report to find divergent cases, then copy the candidate
into the Director calibration corpus and re-run
`scripts/evaluate-system-one-director.ts` so the promotion gate scores the calibrated
signal against the updated corpus. The [System One harvest loop](system-one-harvest-loop.md)
describes how reviewed divergences become provenance-tagged corpus proposals once a human
confirms them.

## Privacy

The report reads `dm_runs` and the local `system_one_decisions_v1` decision log directly
so it can compare raw payloads. The HTTP
`GET /api/provider/system-one/decisions` API deliberately hides those raw payloads and
returns only projected metadata. The CLI never writes to the database, so the immutable
log, the promotion records, and the settings row are unchanged by a report run.

## Offline tests

The report path has two deterministic, provider-free unit test files:

- `server/test/system-one-disagreement.test.ts` covers the pure module: ordered
  comparison, held-vs-held normalization, missing-run `unknown`, summary counts, and
  report rendering.
- `scripts/test/report-system-one-disagreements.test.ts` covers CLI argument parsing.

Neither test opens the database or calls a provider.
