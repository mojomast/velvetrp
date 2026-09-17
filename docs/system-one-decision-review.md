# System One decision review

Status: implemented read-only review path. The pure selection/rendering module
(`server/src/agent/systemOneReview.ts`) and the review CLI
(`scripts/review-system-one-decisions.ts`) make **no provider call and no database
write**. They read the immutable `system_one_decisions_v1` sidecar described in
[Jev integration](jev-integration.md), let a human judge acted decisions, and render a
sheet a reviewer can work from. Incorrect verdicts are the raw material for negative
examples in a lane's evaluation corpus.

## Purpose

Every System One lane records a would-be decision for each turn it participates in, but
only a human can say whether a decisive call was actually right. The decision log is
immutable and the HTTP read API hides the raw payloads, so a reviewer needs a local path
that exposes one decision's context at a time.

A verdict of `incorrect` is the raw material for a **negative example**: a case where the
lane's promoted signal chose the wrong action. The Director calibration corpus and the
narration benchmark currently contain no acted errors, so they cannot distinguish a lane
that is merely lucky from one that is calibrated. The review queue is how those error
cases are collected.

## Lane modes and recording

`SystemOneSettings.laneModes` is a per-lane map of `off` / `shadow` / `active`:
`off` makes no call, `shadow` calls and records its would-be decision but never acts, and
`active` may act only when the lane also carries a passing promotion record. `enabled` is
the master switch. Recording is independent of acting: an unpromoted lane in `shadow`
keeps recording while a promoted lane in `active` acts, so the queue can collect evidence
for the next promotion without enabling it.

## What the review queue selects

By default the queue contains `act` decisions — the calls that took a positive stance.
`--include-flagged` additionally includes `fallback` decisions whose recorded `selection`
carries a non-empty hazard `flags` array. Optional `--lane` and `--max-signal` narrow the
set.

Candidates are ordered uncertain-first: ascending calibrated `selection.topSignal`,
missing signals last, then `createdAt`, then `decisionId`. `--max-signal` drops candidates
whose signal is missing or above the bound, so it focuses the queue on low-confidence acted
calls. The limit defaults to 20 and is clamped to 1..200.

## CLI usage

The review path is read-only, so it does **not** need provider credentials or the
`jev.env` sourcing used for live lanes. Point it at the world's data directory directly:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --lane director-selection --limit 20
```

Focus on low-confidence Director calls:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --lane director-selection --max-signal 0.7
```

Include flagged narration fallbacks:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --include-flagged --lane narration-verification
```

Apply human verdicts and write a sheet to a file:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --annotations annotations.json --out docs/system-one-review-sheet.md
```

Print usage and every option:

```bash
npx tsx scripts/review-system-one-decisions.ts --help
```

## Annotations file

The annotations file is a JSON object mapping each `decisionId` to `"correct"` or
`"incorrect"`:

```json
{
  "decision:abc123": "correct",
  "decision:def456": "incorrect"
}
```

Unknown decision ids and any value other than `"correct"` or `"incorrect"` are ignored.
A candidate with no valid annotation stays `unjudged`, and the sheet summary counts it
separately from reviewed candidates. Marking a decision `incorrect` never mutates the
decision log or the database; the verdict exists only in the annotations file and the
rendered sheet.

## Privacy

The CLI reads the raw `state`, `questions`, `answers`, and `selection` payloads directly
from the local SQLite database so a reviewer can judge a case. The HTTP
`GET /api/provider/system-one/decisions` API deliberately hides those raw payloads and
returns only projected metadata. The CLI never writes to the database, so the immutable
log, the promotion records, and the settings row are unchanged by a review session.

## Negative examples and re-evaluation

To turn a verdict into training signal, copy the candidate's `lane`, `state`, and
`answers` into that lane's evaluation corpus — for example the Director calibration
corpus or the narration benchmark — as a labeled negative example, then re-run the lane's
evaluation. The promotion gate scores the calibrated signal against the updated corpus, so
the added error cases tighten the calibration that gates `active` mode. This is the
intended loop for adding the acted errors the existing corpora lack.

## Offline tests

The review path has two deterministic, provider-free unit test files:

- `server/test/system-one-review.test.ts` covers the pure module: queue selection,
  `--include-flagged`, signal ordering, limit clamping, annotation application, and sheet
  rendering.
- `scripts/test/review-system-one-decisions.test.ts` covers CLI argument parsing.

Neither test opens the database or calls a provider.
