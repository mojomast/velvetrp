# System One harvest loop

Status: design plus the implemented core. The harvest projection
(`server/src/agent/systemOneHarvest.ts`), stability measurement
(`server/src/agent/systemOneStability.ts`), and harvest CLI (`scripts/harvest-system-one-negatives.ts`)
are implemented and unit-tested, and the adventure-selection evaluation merges confirmed cases from
`server/test/fixtures/system-one-harvested/adventure-selection.json` when that fixture exists. The
review-CLI correction form is **planned**; the gate v2 changes below are marked implemented or
planned individually, and the accuracy lower bound is adopted in the default gates. The
first loop pass has run against the demo shadow log; see
[First measured loop pass](#first-measured-loop-pass). The
[decision review](system-one-decision-review.md) and [Director disagreement
report](system-one-disagreement-report.md) are the current read-only paths; [Jev
integration](jev-integration.md) remains the design authority. Everything stays disabled by default.

## Why the loop exists

Every promoted lane passes on a frozen corpus with almost no acted errors. The L1 Director corpus
has no trap state and the model defers on every mixed state; the L2 adventure corpus acted 54 times
with no unacceptable pick (it now also carries one confirmed live case the lane still defers on, a
stable coverage miss); the advisory lanes' acted subsets have no observed errors. A passing gate
there is a **promotion candidate, not proof**: it cannot distinguish a calibrated lane from one that
has merely never been wrong, and it leaves the calibration tail untested.

Live shadow decisions are the missing material. A lane in `shadow` records each would-be decision
immutably in `system_one_decisions_v1` while the deterministic or generative path stays
authoritative, so the log accumulates what the frozen corpora lack: live states, candidate sets,
deferrals, and disagreements. The loop turns *reviewed* live decisions into labelled corpus cases so
the next evaluation is error-rich; it never edits the decision log, calls a provider, or changes lane
authority.

## Sources

Four kinds of evidence can propose a case; only a human verdict may confirm a label, and the
provider comparison is the one narrow exception, recorded as a *proposed* label.

**Human annotations.** `scripts/review-system-one-decisions.ts` renders the queue of `act` decisions
(plus flagged `fallback` decisions with `--include-flagged`), ordered uncertain-first by the
recorded calibrated signal, and applies an annotations file mapping each decision id to `correct` or
`incorrect`. The harvest annotation type adds an optional, lane-specific `expected` correction (a
`selections` array for the Director, a `candidateId` for adventure selection, a `disposition` for
guardrails). `correct` confirms the recorded outcome; `incorrect` without a usable `expected` stays
`proposed` ("wrong, but the right answer is still unknown"); `incorrect` with a valid `expected` is
`confirmed`. The review CLI still parses string verdicts only; the harvest CLI's `--annotations` file
accepts both that shorthand and the extended `{ verdict, expected?, note? }` form, and entries whose
shape is invalid are counted as skipped rather than applied.

**Provider disagreements.** For the Director alone, `scripts/report-system-one-disagreements.ts`
compares the shadow lane's ordered would-be selection against the authoritative
`dm_runs.proposal_json` composition through `compareDirectorAuthority`. A divergence is a
deterministic detector, not a verdict: the provider may be right, or both may be defensible. The
proposal records the provider composition as the `expected` label with `provider-disagreement`
provenance and status `proposed` — the explicit exception where the comparison is the proposed label.

**Stability conflicts.** `systemOneStability.ts` groups repeated evaluations of the same state by
case and reports raw agreement (the share of repeats producing the most common decision), the
distinct decisions, whether the case conflicted, and the per-question signal mean and standard
deviation; it aggregates mean agreement, conflict count, conflict rate, and mean/max signal standard
deviation. A decision that flips between repeats would give the same game state different outcomes,
so it is dangerous to activate even when each draw looks correct. Stability is a review signal, not
a label.

**Shadow deferrals worth reviewing.** `--include-flagged` surfaces `fallback` decisions carrying
hazard flags, and the shadow report (`scripts/report-system-one-decisions.ts`) summarizes recorded
bands per lane. Reviewing why a lane deferred on a case it should have acted on is as valuable as
reviewing an acted mistake: it produces a case whose `expected` correction can confirm an act.

**The labelling rule.** A human verdict, not the provider, is the only thing that turns a proposal
into a training label, except where the Director disagreement comparison is explicitly being used as
the proposed label. Even then the proposal stays `proposed` until a human confirms it, and
unconfirmed proposals never score in a gate.

## Pipeline and provenance

```
annotate -> scripts/harvest-system-one-negatives.ts --annotations
  -> proposals (status proposed|confirmed; provenance review-annotated|agent-review|provider-disagreement)
  -> human review -> --write-fixture -> server/test/fixtures/system-one-harvested/<lane>.json
  -> lane eval merges confirmed cases -> re-run -> updated promotion record
```

An annotation may set `reviewer: "agent"` (with a `note` carrying the evidence); those labels keep a
distinct `agent-review` provenance and proposal identity so they can never alias a human verdict, and
a corpus can report exactly how much of it is agent-labelled pending human confirmation. The rest of
this section describes the human path. Provisional rule: agent-reviewed cases may score in a
benchmark, but a promotion record is re-derived only from human-confirmed labels — the Director
record is the first lane that follows this rule.

`buildHarvestProposals` is implemented. It projects one proposal per reviewable decision, keeps
`confirmed` over `proposed` for the same state, keeps the earliest otherwise, and returns a stable
lane/created-at/proposal-id order, so re-harvesting the same state is idempotent. Proposal identity is
a digest of lane, state digest, expectation, and provenance. `summarizeHarvest` reports the split by
lane and provenance, and `confirmedHarvestProposals` is the only accessor an evaluation may use:
unconfirmed proposals are excluded from scoring, so an unreviewed correction never becomes a label.

Confirmed proposals carry their provenance, source decision id, original state, and expectation into
the fixture, so a reviewer can see which came from live data and how each was labelled.
`--write-fixture` writes the confirmed-only fixture for one lane, sorted by proposal id so repeated
runs are idempotent; the adventure-selection evaluation already merges those cases and tags them
`harvested:`. The decision log is never rewritten in place; proposal and fixture files are generated,
reviewable artifacts.

## First measured loop pass

The loop ran end to end against the demo shadow log on 2026-09-17:

- **Harvest.** 19 Director decisions, 1 adventure-selection decision, and 1 guardrails decision were
  read. Two human annotations (a confirmed guardrails `pass`, and a corrected adventure deferral
  whose `expected` is the `unequip` candidate the server had bound) plus 12 deduplicated Director
  provider disagreements produced 14 proposals: **2 confirmed and 12 proposed**. Confirmed fixtures
  were written to `server/test/fixtures/system-one-harvested/{adventure-selection,guardrails}.json`;
  the Director proposals remain a review queue.
- **Re-evaluation.** The adventure benchmark then ran 129 live calls over 30 frozen cases plus 13
  harvested cases (1 human-confirmed, 12 agent-reviewed from synthetic play), production-shaped
  (no `uid` decorrelator). At the server default 0.75, 6 calls acted; at the sweep's recommended
  0.40 the gate passed with 57 acted, 100% accuracy, calibrated Brier 0.0001 and ECE 0.0105
  (held-out 0.0109). All 13 harvested cases defer in this run, so the acted subset stays
  human-labeled; the human drop-my-longsword case is still a **stable coverage miss** the corpus
  records instead of hiding, which is the point of the loop. The promotion record was re-derived
  from this run.
- **First synthetic harvest pass.** A five-persona synthetic batch (harness per
  [synthetic player simulation](synthetic-player-simulation.md)) drove ~24 real turns and produced
  23 adventure-selection shadow decisions. A conservative agent review labelled 12 of them (11
  correct deferrals plus one historical mis-pick, against 1 rest commit) and left 11 proposed; the
  fixture now holds 13 cases (1 human-confirmed + 12 agent-reviewed). Because all 13 defer in the
  current lane, they add coverage and stability rather than scored labels. Two follow-ups surfaced:
  provider narration asserted a short rest and a purchase that no receipt establishes, and the
  lane's 32-candidate union cap can crowd out advertised quest-lifecycle rows on check-heavy turns.
  Both findings have since been fixed: the cap now fills round-robin across advertised families
  (small unions unchanged), and the narration gate fails closed for mechanically loaded prose on
  zero-receipt turns (regression-tested with the recorded failures).
- **Second synthetic wave and the provenance split.** Two more batches (~50 turns) raised the
  fixture to 56 cases (1 human-confirmed + 55 agent-reviewed). The family-diverse union visibly
  worked: every recorded request now carries the full advertised set, so the lane can see quest
  accepts it previously could not. Agent review labelled 43 more cases (40 correct, 3 incorrect).
  One agent-reviewed case acts and disagrees with its label, which on the mixed corpus moved the
  sweep to 0.35 and dropped acted accuracy to 0.95 — exactly the error-rich signal the loop exists
  to produce. To keep promotion evidence human-based, the adventure evaluator now gates frozen +
  human-confirmed cases only and reports agent-reviewed cases separately; a promotion record is
  never re-derived from agent labels. The split run returns the gate to 0.40 with 54 acted at 100%
  accuracy, Brier 0.0002 and ECE 0.0110, and 100% stability (0 of 116 cases conflicted); the 85
  agent-reviewed cases scored 90.6% on their asserted subset with none acting.
- **Third wave (canary and batch 3).** Thirty more reviewed decisions raised the fixture to 86
  cases (1 human + 85 agent-reviewed; 29 correct, one genuine mismap where an explicit rest
  declaration drew a Second Wind power pick). Four turns committed through the live
  `origin='lane'` check path and all four matched their declarations. The review also caught the
  provider committing a Survival check outside the lane's advertised sample and a narration that
  played a rest scene with no receipt — both recorded as advertisement/narration divergences rather
  than label changes.
- **Fourth wave (SRD world, advertisement-guided).** The first v2 synthetic batch (harness per
  [synthetic player simulation](synthetic-player-simulation.md#first-measured-v2-batch-2026-09-18))
  ran 12 live turns in the reviewed SRD 5.1 world `.velvet/synth-srd-1` ("The Last Harbor Light")
  with advertisement reading, reachability re-targeting and menu-aligned generation live. Advertised
  share rose from 30 of 94 turns (32%) to 10 of 12 (83%) and band `act` from 6 of 94 (6%) to 5 of
  12 (42%); six target swaps moved unreachable cells (commerce, combat consumable, power, quest
  objective) onto families the world actually advertised, and the world advertised six families in
  12 turns (travel, SRD check, inventory, power, quest lifecycle, quest objective). Agent review
  labelled all six acted decisions correct and judged all seven deferrals reasonable, so the wave
  produced six confirmed cases (`agent-review`) and no new errors; the fixture now holds **92 cases
  (1 human-confirmed + 91 agent-reviewed)**. The lane still defers on every agent-reviewed case in
  the production-shaped evaluation, so they add coverage and stability rather than scored labels:
  stability is 100% (0 of 122 cases conflicted), the gated record is unchanged at 54 acted/100%
  with Brier 0.0002 and ECE 0.0107 at the recommended 0.40, and the agent subset scores 231/273
  exact preferred. Two follow-ups recorded rather than fixed: the reviewer flagged near-duplicate
  declaration motifs across personas (diversity check due), and SRD checks are declaration-driven,
  so a scheduler that keeps only the previous turn's menu under-reports them — keep a recent union.
- **Fifth wave (SRD combat and the merge flag).** The reviewed SRD world's goblin ambush was
  activated (materialized with a past clock, because the fixture's default 2036 timestamps make
  every live write fail the encounter immutability guard) and a two-persona batch ran eight turns
  against it. The adventure lane's battery only exists when combat candidates are built: run a
  advertised the combat power 4 of 4 turns and acted 2 of 4, while run b's rest declarations and
  one rejected combat declaration produced no L2 battery at all, and the harness reported 0 of 4
  rather than claiming coverage. Both combat-power acts (`Second Wind`, signals 0.96 and 0.78)
  were confirmed by review and merged with the new
  `scripts/harvest-system-one-negatives.ts --merge-fixture` flag, so the corpus now holds **94
  cases (1 human-confirmed + 93 agent-reviewed)**. The regenerated benchmark: stability stays 100%
  (0 of 124 cases conflicted) and the gated record is unchanged (54 acted/100%, Brier 0.0002,
  ECE 0.0107 at the recommended 0.40), while the agent-reviewed subset carries acted decisions for
  the first time — 3 acted calls at 100% over 279 calls, exact preferred 234/279, still scored but
  never gated. Measurement aids shipped with the wave: `--menu-window` keeps a recent
  advertised-family union for re-targeting (SRD checks are declaration-driven), `--direct-weight`
  biases the coverage matrix toward harvest volume, and every manifest reports the human-likeness
  proxies (near-duplicate share, distinct-1/2, burstiness, OOC/noise/mixed-intent shares) that the
  fourth-wave review asked for. Two cosmetic divergences recorded: the encounter-start failure
  message is misleading when the cause is a clock-order violation, and three combat turns aborted
  at `decision-rejected`/`awaiting-confirmation` as game outcomes the harness reported honestly.
- **Sixth wave (realism controls and SRD rest).** A historical audit of 27 runs (118 turns) with
  the new human-likeness report measured a median declaration of 77 words against the design
  target of 8–18, and a trigram near-duplicate share of 0 despite a reviewer seeing repeated
  themes. The harness now injects persona word budgets (terse 4–12, plain 8–20, precise 10–24,
  florid 14–35) and reports motif-level repetition (`topRepeatedPhrases`, `repeatedPhraseTurns`);
  post-change batches report 14–22 word medians, and the motif signal caught `"take a short rest"`
  twice in its first run. `--focus-family`/`--focus-mode` force an exact cell for focused
  campaigns. With the actor wounded and a hit die available, rest advertised and the lane acted
  three times (signals 0.62, 0.85, 0.92) plus one quest-objective act (0.54); all four were
  confirmed by review and merged, taking the corpus to **98 cases (1 human-confirmed + 97
  agent-reviewed)**. The regenerated benchmark holds the gated record (54 acted/100%, Brier
  0.0002, ECE 0.0107 at 0.40) and the agent subset carries 3 acted calls at 100% over 291 calls
  (exact preferred 234/291, asserted 80.4%). Stability is 99.7% with the **first conflict in many
  waves**: `harvested:b1e4dfc2f2e2` (agreement 66.7%) is the first live SRD check probe, which
  flips between its Investigation candidate (live signal 0.55) and defer at the evaluator's 0.75
  composition threshold — a genuinely borderline state the corpus now records rather than hides.
- **Seventh wave (combat behavior).** Combat coverage required three fixes. (1) Healing potions in
  the SRD starter pack were description-only (`effects: []`), so no consume action could exist;
  the four healing potions now carry executable effects (2d4+2 through 10d4+20) and the pack was
  republished (`1.6.0+c1b2d4fd32d6`). (2) The earlier "inconsistent combat composition" resolved to
  two measurable causes: fresh worlds materialize without the `system-one` settings row (copying
  it makes the lane compose), and the combat battery is exactly the actor-owned turn's available
  actions, so a spent Second Wind plus a spent action correctly yields zero candidates. (3) With
  three identical potion entries, the model split its `best_candidate` mass and answered
  `none_of_these` at 0.72 despite ~0.9 relevance on every copy — interchangeable duplicates were
  unselectable; the composer now collapses candidates by exact `(kind, label)` to the
  lowest-candidateId representative. The active lane commit path also gained
  `exact_combat_consumable.select`/`exact_combat_power.select`: the lane appends the ordinary
  confirmation-required proposal bound `origin='lane'` and mechanics commit only through the
  normal confirmation API. Live proof: with the fighter at 1 HP, the lane picked an advertised
  Potion of Healing at 0.95, confirmation approved, and a lane-origin execution (no provider
  evidence, combat revision 10) healed the fighter 1 → 10 HP; a sibling proposal the persona never
  approved correctly did not execute. The two combat cases were reviewed and merged, taking the
  corpus to **100 cases (1 human-confirmed + 99 agent-reviewed)**. The regenerated benchmark holds
  the gated record (54 acted/100%, Brier 0.0002, ECE 0.0110 at 0.40) and the agent subset carries 3
  acted calls at 100% over 297 calls (exact preferred 234/297, asserted 78.8%); stability is 99.7%
  with the same single conflict. Honesty note: the two new combat cases evaluate as `defer 3/3` on
  re-ask despite the live 0.95 act — the live commit is real receipt evidence, but the state is not
  reproducing across draws, which is exactly why agent-reviewed cases never gate.
- **Combat gap (found by the sixth wave, fixed).** Focused combat batches surfaced that the
  adventure path never resolved D&D enemy turns, so a goblin that won initiative wedged the
  encounter in `failed` player turns. The deterministic fallback now invokes
  `executeCombatEnemyTurn` for enemy-owned D&D turns instead of writing a failed terminal, with a
  focused regression test and the server quick lane green (286 files, 2921 passed); the
  reproduction and remaining uncertainties are in
  [synthetic player simulation](synthetic-player-simulation.md#v22-realism-controls-focus-targeting-and-the-srd-combat-gap-2026-09-18).
  The wedged world additionally needed a data repair (actor health vs combatant hit points).
- **Reliability finding.** Planning budget denials hard-failed ~9% of executed turns because the
  conservative prompt estimate over-counts measured tokens; denials now degrade to deterministic
  fallback narration (see [provider hardening](provider-hardening.md)) and the harness records a
  failure trail in its manifests.
- **Stability.** Across all 116 cases and 348 repeats, decision agreement was 100% with 0 conflicted
  cases; mean per-case signal standard deviation was 0.0127 and the maximum 0.0492. A separate live
  probe of the two most recent shadow messages (10 repeats each) agreed 10/10 at a mean standard
  deviation of 0.0015, in line with the vendor's published jev-1.13 figure (~0.0098 mean).
- **Guardrails re-run.** The L6 guardrails benchmark re-ran the same way: production-shaped, 171
  calls over 56 frozen cases plus the confirmed benign harvested case, 75 acted at 100% accuracy,
  calibrated ECE 0.0022, and 100% decision stability (0 of 57 cases conflicted; mean signal std dev
  0.0031). Its promotion record was re-derived from that run.
- **Director re-measurement.** The Director calibration was re-derived with the stability
  instrumentation: at the documented `--repeat 10` protocol it acts on 41 samples with 100%
  acceptable and 100% exact accuracy, calibrated ECE 0.0069 (held-out 0.0054), and 100% decision
  stability (0 of 6 scenarios conflicted). Two sensitivities were found and are recorded instead
  of hidden: at `--repeat 8` the acted count falls to 29, below the 30-sample gate, and adding
  the vendor `uid` decorrelator moved the selected threshold from 0.60 to 0.30 with a degenerate
  negative-slope Platt map (calibrated ECE 0.1344 > 0.10). The gate protocol now uses the
  production-shaped request for every lane; the vendor decorrelator is reserved for dedicated
  stability probes.
  This is the first concrete case for gate v2's bootstrap lower bounds and coverage floors: a
  point-estimate gate on 30-40 acted samples swings between pass and fail on measurement-condition
  noise alone.
- **Director harvest pass.** The first harvest pass added 9 confirmed live cases, agent-reviewed and
  confirmed by the user on 2026-09-17 (all pacing-only empty-world states where the shadow Director
  held and the provider committed an `ambient-beat`; the review marked 3 Director picks correct, 6
  holds incorrect, and left 2 ambiguous cases proposed). With the harvested cases merged, the
  benchmark passes with 94 acted, 100% acceptable/exact, calibrated ECE 0.0068 and 100% stability
  (0 of 15 scenarios conflicted). The Director promotion record still uses the frozen-only
  measurement so one state family cannot dominate it; the diverse-play harvest is expected to
  supersede this fixture. The gain is coverage, not proof: the corpus now records the exact failure
  mode the shadow log exposed instead of hiding it.
- **A decorrelation caveat.** Adding the `uid` field coincided with higher raw signals than the
  pre-loop runs (18 acted at 0.75 versus 6), which moved the recommended threshold from 0.40 to 0.55.
  The vendor cookbook states that this measurement design "cannot separate sensitivity to the
  irrelevant field from variation that would occur on identical requests". The protocol now runs
  gate measurements production-shaped (no `uid`), which is why the re-derived thresholds returned
  to the pre-loop values; the decorrelator is reserved for dedicated stability probes.

## Promotion gate v2

The current gate (`evaluatePromotionGate`) checks `minSamples`, `minAccuracy`, `maxBrier`, and
`maxExpectedCalibrationError` on a recorded metric snapshot, and `isLanePromoted` re-checks that
snapshot against the lane's current gate, so changing a gate constant already invalidates a record.
Everything below is planned unless marked implemented; the order is priority order.

1. **A static, never-tuned holdout per lane.** L2's 0.40 action threshold was selected on the same
   corpus that scores it, and the benchmark says so explicitly. Gate v2 reserves a holdout never
   used for threshold selection, criteria tuning, or calibration fitting.
2. **Bootstrap confidence intervals, gating on the lower bound (adopted).** A point estimate over
   tens of acted samples cannot tell a 0.95 lane from a 1.00 lane, so every default gate now also
   requires the Wilson lower bound (`minAccuracyLowerBound`) to clear the tier bar: 0.80 for the base
   lanes, 0.85 for guardrails/cost-router, 0.75 for `memory-reranking`. `systemOneGateStatistics.ts`
   also ships a seeded `bootstrapAccuracyLowerBound` for callers that want a resampled interval.
   Every frozen record clears its bound (narration is closest at 0.8408 against 0.80), and the
   Director's `--repeat 8` run (29 acted) now fails the bound as well as the sample floor — the
   intended behavior for a borderline measurement.
3. **Acted-coverage and false-act floors (mechanism implemented; no lane opts in yet).** "Defer
   everything" currently shrinks the acted subset until it either fails `minSamples` or passes on a
   handful of easy cases. The optional `minActedRate` gate plus a `SystemOneGateContext.coverage`
   supply (`actedSamples`/`opportunities`) now let a lane require both acting and being right; no lane
   sets it yet.
4. **Asymmetric safety gates for guardrails and narration (mechanism implemented; no lane opts in
   yet).** Missing a hazard is worse than flagging benign fiction. The optional `minHazardousAccuracy`
   and `maxBenignFalsePositiveRate` gates read a hazardous/benign split from
   `SystemOneGateContext.safety`, so the hazard false-negative ceiling is separate from the benign
   false-positive ceiling. No lane opts in yet; the guardrails/cost-router bars are still the only
   asymmetry (`minAccuracy 0.95`, Brier/ECE 0.05).
5. **Self-consistency from the vendor cookbooks (measured by L2, L6, and L1; gating planned).** The
   adventure-selection evaluation now reports repeat agreement, conflict cases, and signal variance
   through `summarizeStability` (same-state repeats; `stabilityUid` is reserved for dedicated
   probes). Gating should add raw agreement, policy agreement
   with an explicit uncertain outcome, per-question probability standard deviation, and the conflict
   count. The vendor's self-consistency measurements for `jev-1.13` report a mean per-question
   standard deviation near **0.0098** and **99.2%** policy agreement at a 0.60 uncertain threshold
   (TypeSafe documentation, reviewed 2026-09-16); those are vendor reference points, not numbers
   measured here.
6. **Pinned model version, corpus version, and record expiry.** A record currently names only
   metrics, the Platt map, `promotedAt`, and the evidence path. Gate v2 adds the pinned model and
   corpus versions plus an expiry, so `isLanePromoted` refuses a stale record after drift.
7. **A live drift gate with automatic demotion.** Rolling reviewed metrics from shadow decisions
   (accuracy, disagreement rate, conflict rate) should be compared with the record, and crossing a
   bound should demote the lane to shadow automatically instead of waiting for a human.
8. **Optional band-on-calibrated-confidence.** The runtime records the calibrated `topSignal` for
   observability while the band is decided on raw signals, so thresholds are not comparable across
   lanes. Banding on the calibrated signal would make a threshold mean a comparable reliability; it
   stays optional until each lane's calibration is stable.

## Model-version and integration cautions (Jev 1.13)

The vendor's published [Jev 1.13 jaggedness
page](https://docs.typesafe.ai/model-jaggedness/jev-1.13) (reviewed 2026-09-16) names failure modes
that apply directly to these lanes. Treat them as integration constraints, not defects to tune
around.

- **Pin the versioned model id once thresholds are tuned.** The vendor's
  [Models page](https://docs.typesafe.ai/models) states that aliases move when a release ships and
  answers can change without a code change, and recommends pinning the versioned id wherever
  thresholds were tuned against a specific version. The demo environment and persisted settings are
  pinned to `jev-1.13.0` (verified 2026-09-18); every recorded decision stores the resolved
  response model, so an alias move or drift is auditable rather than silent.

- **Literal reading.** The model reads requests literally and does not map informal player phrasing
  onto a canonical mechanic. Our live "drop my longsword" case is exactly this edge: the model
  recognized the commitment (supported ~0.48) but declined to equate it with the `unequip`
  candidate, so the lane deferred while the authoritative provider path committed the correct
  action. Keep labels literal, accept deferral as a valid outcome, and never tune labels to match
  model semantics.
- **Adversarial content is not treated as hostile by default.** Our guardrail batteries embed the
  bounded message in the question instructions today (`systemOneGuardrails.ts`), which can frame
  content as hostile. Prefer structured state with path references once the request schemas accept
  them, and never describe the lane as moderation: the deterministic policy checks stay
  authoritative.
- **Context rot.** Irrelevant candidates cost accuracy. This is directly relevant to the L2
  candidate-union cap (32): widening the union for coverage trades accuracy, so keep the advertised
  set tight and measure before raising the cap.
- **Contradictory instructions versus criteria.** Keep one authority per question and one property
  per question; instructions and criteria that disagree produce unstable judgments.
- **No numeric precision.** The model is not a calculator. Keep arithmetic, thresholding, weighting,
  and score normalization in code (`systemOnePolicy.ts` and the lane composition functions).

## Vendor-pattern alignment (reviewed 2026-09-18)

The vendor's [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)
pattern is the shipped shape of these lanes: one typed question names the action, and code picks a
threshold per action according to consequence (their voice-banking example uses a 0.6 floor and 0.85
for a high-stakes action). The
[classification-using-confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence)
cookbook adds the other half: when confidence is low, a coarser but still useful answer beats a
forced one (39/60 useful when always naming the fine label, 48/60 when falling back one level). Our
bands implement the same idea with a deterministic provider fallback instead of a coarser lane
answer; falling back to the action family rather than the exact candidate is a possible refinement
once the corpora carry errors. The [AutoResearch
cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) runs an error-driven
loop for feature discovery on a downstream model, not lane promotion, so the harvest loop is not
duplicating a vendor capability.

## Vendor-aligned battery direction (planned, not shipped)

- **Structured instructions and criteria.** Use the vendor's named instruction fields (`question`,
  `focus`, `compare`, `inspect`) and per-option contrastive criteria (`what`, `not_for`, `examples`)
  once the request schemas accept them. The repo's [question design
  conventions](jev-integration.md#question-design-conventions) already require contrastive criteria;
  today's wire shape is a string `instructions` plus type-specific `criteria`.
- **Guardrails severity as harm.** Reframe the severity question as "how much harm would complying
  do?" following the vendor's [LLM guardrails
  cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails), and let severity upgrade a `review`
  disposition to `block`. Today a high severity with no flagged hazard can only recommend `review`.
- **A fresh throwaway `uid` per repeat.** The vendor cookbooks add a new `uid` to every repeated
  call so the draws are decorrelated. `stabilityUid(lane, caseId, repeat)` builds that
  deterministically, and it is reserved for dedicated stability probes: gate measurements use the
  production-shaped request, because a measured `uid` perturbation moved the Director's selected
  threshold and produced a degenerate calibration map (see the first measured loop pass).

## Commands

All review and report commands are read-only, need no provider credentials, and select a world
through `VELVET_DATA_DIR`.

```bash
# Review acted decisions and apply human verdicts (existing).
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --lane director-selection \
  --max-signal 0.7 --limit 20 --annotations annotations.json --out docs/system-one-review-sheet.md
# Deterministic Director disagreement queue (existing).
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/report-system-one-disagreements.ts --limit 50
```

The harvest CLI builds proposals from annotations (and, for the Director, the disagreement rows) and
writes the confirmed-only fixture a lane evaluation merges:

```bash
# Build and inspect proposals, then write the confirmed fixture for one lane.
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/harvest-system-one-negatives.ts --disagreements \
  --annotations annotations.json --out proposals.json
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/harvest-system-one-negatives.ts --lane adventure-selection \
  --annotations annotations.json --write-fixture
```

Per-lane evaluations are live (provider-credentialed) and regenerate their evidence documents:

```bash
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-director.ts         # docs/system-one-director-calibration.md
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-adventure-lane.ts  # docs/system-one-adventure-benchmark.md
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-narration-lane.ts  # docs/system-one-narration-benchmark.md
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-rerank-lane.ts     # docs/system-one-rerank-benchmark.md
TYPESAFE_API_KEY=... npx tsx scripts/benchmark-system-one-lanes.ts          # docs/system-one-benchmark.md
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-guardrails-lane.ts # docs/system-one-guardrails-benchmark.md
TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-router-lane.ts     # docs/system-one-router-benchmark.md
```

Confirmed fixtures live at `server/test/fixtures/system-one-harvested/<lane>.json`; the
adventure-selection evaluation merges them today, then the promotion record is updated from the new
run. Generated benchmark documents are script outputs: regenerate them with the commands above, never
edit them by hand.

## Limitations and non-claims

- Human labelling is the bottleneck and it is subjective; the verdict and any `expected` correction
  are judgment calls.
- Proposals from provider disagreements are not ground truth: the authoritative composition is the
  provider's decision, not a measured better answer.
- Stability is not accuracy. A lane can be perfectly self-consistent and still consistently wrong;
  self-consistency narrows the risk of outcome flipping, not of error.
- A green gate on harvested cases is still a promotion candidate, not proof. Harvested cases are
  few, human-labelled, and drawn from whatever live traffic happened to occur; the holdout,
  coverage, and drift work above limits that.
- Harvesting covers three lanes today (`director-selection`, `adventure-selection`, `guardrails`),
  and only adventure-selection merges a fixture so far; other lanes need a lane-specific expectation.
- Nothing here enables a lane: every lane stays disabled by default, a promoted lane still needs
  `active` plus `isLanePromoted`, and the deterministic fallback remains the authority on failure.
