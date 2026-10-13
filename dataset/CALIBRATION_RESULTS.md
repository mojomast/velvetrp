# Foundry calibration measurements

Measured teacher-data quality and pipeline yield; **no student training or
controlled stock-retention experiment**. All paid requests used operator-funded
RouteTok and retained source-bound journals. These are actual outputs, not fixture
acceptance rates. Working artifacts live under `.dataset/`; credentials/private
relay URLs are excluded.

## Version 1 — stopped on inference configuration

Run `calibration-2026-10-13-v1`, source `14192e1`, 20 planned seeds/K=1.
Ten captured Flash responses covered four initial scenarios before the first
Kimi review failed with HTTP 400 (fixed-temperature model rejected temperature 0).
Eight responses had empty final answers, one was partial world JSON, and one was
a valid candidate selection awaiting review. No records were admitted. The RP
scenario was not dispatched; its frozen census retains that missing initial
output. This attempt does not supply an RP style score.

## Version 2 — completed, pilot held for low yield

Run `calibration-2026-10-13-v2`, source `bee989314b286bfb624b55e9592193f4c3662cc0`.
Same frozen 20-scenario inventory, K=1, corrected inference settings documented
in `CALIBRATION_PROTOCOL.md`.

| Family | Planned scenarios | Generation attempts | Initial admissions | Final admissions |
|---|---:|---:|---:|---:|
| World generation | 6 | 17 | 0 | 1 |
| Tool selection | 6 | 15 | 1 | 2 |
| Grounded narration | 4 | 12 | 0 | 0 |
| Boundary recovery | 3 | 9 | 0 | 0 |
| Roleplay conversation | 1 | 2 | 0 | 1 |
| **Total** | **20** | **55** | **1** | **4** |

- Actual physical requests: **79**, comprising 55 generations and 24 reviews.
  All 79 have retained logical responses; no unresolved/unmeasured outcomes.
- Parsing: **17/20 initial attempts**, **48/55 all attempts**. Parsing only proves
  the relevant response surface can be decoded, not semantic validity.
- Thirty-five repairs. Four records selected across four clusters, all train;
  4/20 final scenario admission yield. Selection admitted no twin preferences.
- Masked supervised-token spend: **11,503** under the real Qwen3-8B bridge. This
  includes refused attempts and both initial/repair outputs. It is not provider
  billing or a dollar spend estimate.
- Selected unique-text ratio: **4/4**; average pairwise Jaccard 0.125. With just
  four selected records, this is a lexical diagnostic, not established diversity
  or semantic novelty.

### Blinded ordinary-RP census

Two actual outputs from **one** RP scenario (initial and one repair) were frozen
and graded in separate fresh GPT-6 Astra xhigh contexts. Both passed the four-
dimension rubric. The initial had a local article error (naturalness 1/2); the
repair scored 2/2 on all four dimensions. This is 2/2 output-level coverage and
style passes, with dependent attempts; it is not two independent scenes, human
annotation, or a student-retention result. Grounding and protocol validity are
reviewed separately after this style lock.

### Artifact identities

- Plan: `cc4bd039dd180f38f84f2f0357c303528089fa73f3746a01fed65af0b5151fe1`.
- Runner binding: `5486830db95c3cb3da6853559523b1ca310e21d080f1823ef186370effdc1e57`.
- Report: `98e839feb8c372853e785b5e74c16a59c93ed3b3d89db896a5d2ea369bdbce40`.
- Selection: `deddc50fdb65a6f70e1656c49f10d6f2a238ca8aac6b27abf973ea904e3d5883`.
- Prose inventory: `13a65cb4ee19e1314b1fccb3bb7af294698cf30088e5125fc8fd2afd9f33da18`.

Run store: `.dataset/runs/calibration-2026-10-13-v2/`.
Measurement artifacts: `.dataset/measurements/calibration-2026-10-13-v2/`, containing
the frozen full-source inventory, blind packets, exact judge responses/provenance,
style report, complete grounding-review inventory and source-bound summary.

### Progression

The 175-seed pilot is **held** pending correction and another small campaign.
GPT-6 Astra independently inspected all **4/4 admissions** and found **0 false
admissions** on the stated functional criteria. It also substantively reviewed
**39/51 refused attempts** and all **24/24 review-output contracts**.

- **8/12 grounded refusals** were factually faithful and transport-compliant.
  Possessive HP/status clauses were misread; unknown field formatting also lost
  role/value associations. Three attempts added unsupported consequences; one
  faithful surface had the wrong transport. None is retroactively admitted.
- One clear whole-answer boundary false refusal preserved the stair with “The
  stair stays sealed.” Other outputs included over-refusal or unsupported context.
- **20/24 reviewer outputs** used unsupported verdict strings because the prompt
  never specified the parser's exact enum. ReviewerCount was pipeline-supplied 1,
  consistent with one judge; it was not a model-emitted multiple-reviewer claim.
- All **79/79 retained responses** were reconciled to their actual captured HTTP
  bodies. Four admitted records contain **806 measured target tokens**, distinct
  from 11,503 tokens spent across all generation attempts.

The independently inspected, approved canonical prose-ledger pin is:
`1607afb639561690f2cc489c732f42f041c1dbb350daf8564aca41bc19480dce`.
The ledger reproduces 2/2 coverage and style passes from one RP seed, zero pairs,
and `studentRetention: unmeasured`. Judgment timestamps are raw-file retention
mtimes; backend revision is `not-exposed`.

Full independent report: `/tmp/opencode/foundry-calibration-v2-independent-review.md`;
source-bound machine verdicts: `/tmp/opencode/foundry-calibration-v2-independent-review.json`
in the implementation environment. Historical yields and reviews remain immutable;
no corrected yield is estimated from these fixes.

## Version 2 independently approved export

All four exact train records received independent certificate/source/implementation
approval and were exported to
`.dataset/exports/calibration-2026-10-13-v2-approved/`. Real CPU preprocessing
materialized all four rows. Independent byte inspection reconstructed and matched
**3,014 input IDs**, **806 supervised labels**, and **2,208 masked labels**, including
selected tool/prose terminators and masked prompts/history/thinking scaffolds.

Consumer `checksumDigest` (exact published `checksums.json` bytes):
`e6713e87fc54c213d1dde7a45bc98513b62310ff671ddc8e9368e2ff90f0e262`.
Certificate approval file SHA-256:
`d7797dcc5711d814c1a4c701113ce3d3e004abfe5045791ab8b4080449edfc2a`.
Independent bundle-byte approval SHA-256:
`09c140a94205b0705845d5e90f1039203e31bcc2a5c6f4a4f2b8c8ad5eab3571`.
These approvals cover the four exported rows and preprocessing, not model training.

## Version 3 interrupted read-tool coverage

At source `bde4ede`, eight of 20 scenarios completed before the first read-tool
schema was refused upstream. Captured generation responses: **15**; captured
reviews: **7**, all using the specified verdict enum. Durable admissions before
the stop: **6** (three exact-tool, two boundary, one RP). These are prefix counts,
not completed-campaign or independently approved quality rates. The remaining
read schema failure was explicit HTTP 400, with retained raw outcome and no
logical completion. A complete planned/actual ordinary-RP inventory is frozen
under `.dataset/measurements/calibration-2026-10-13-v3/`.

Independent review approved the three exact-tool and two boundary admissions and
found no definite false admission. RP's added Ninth Watch customs/location remain
uncorroborated creative setting fiction, rather than a proved private-oracle
contradiction under the open-RP task. Its two captured answers are **byte-identical**,
yet their usable reviews changed from revise to accept. This is reviewer
disagreement, not demonstrated repair improvement; later runs prevent obtaining a
fresh review for an unchanged candidate, including changed tool-call IDs alone.
Both locked style grades pass at 2/1/2/2, from two fresh contexts for **one scene**.
Independently inspected ledger pin:
`82487b9f6b353d8e77400e39f32a069c9d3cc3702e53d8ccf5ce373b7e896a3c`.

The correction explicitly adds `required: []` for read tools. A fresh version-4
campaign preserves the same scenario identities and the interrupted run's artifacts.

## Version 4 — completed with improved yield, grounding held

Run `calibration-2026-10-13-v4`, producer
`222041098cc3a61bc50436aed574899945cbb70b`, 20 seeds/K=1. The explicit read schema
was accepted; all 20 scheduled scenario loops completed.

| Family | Planned | Attempts | Initial admissions | Final admissions |
|---|---:|---:|---:|---:|
| World generation | 6 | 14 | 2 | 2 |
| Tool selection | 6 | 9 | 4 | 5 |
| Grounded narration | 4 | 12 | 0 | 0 |
| Boundary recovery | 3 | 3 | 3 | 3 |
| Roleplay | 1 | 1 | 1 | 1 |
| **Total** | **20** | **39** | **10** | **11** |

- **51** captured physical/logical responses: 39 generations plus 12 reviews.
  All 12 reviews used the specified output contract; no contract retry needed.
- Parsed initial attempts **19/20**, parsed all attempts **38/39**; 19 repairs.
- Actual supervised-label spend **7,691**, including refused targets; no unresolved
  or unmeasured outcomes. Eleven selected records in eleven clusters.
- Frozen ordinary-RP inventory has **one captured initial output**, independently
  style-pass in a fresh context. Independently inspected ledger pin:
  `1f384a539a41b66744566c1dd6cc30c36472cf345e852e60c261e2ea58013c63`.
  The separate functional review also approves its bounded setting fiction under
  the actual open-RP contract; no student-retention result follows.
- The grounded outputs predominantly used sentence-separated mechanical fields
  that the bounded parser split apart, and several omitted native submission.
  Independent inspection found all 12 preserve both receipts, six with correct
  transport (whole-target false refusals) and six with real transport defects.

Bindings: plan
`a43ede3743db919190b82107a346069f3a455187d57a7991443172d64dd2aa07`;
report `cb6799f9140f7b4784de7b0fda1feb65184a65d1732ac99a64aed05bfd3590f3`;
selection `792a3662c8fec311c38ba31c0e8068ccbbe56645c355d4291cace725e9a6b50a`.
Artifacts: `.dataset/measurements/calibration-2026-10-13-v4/` and matching run store.
The pilot remains held until actual sound grounded admissions are established and
the independent functional review resolves the remaining issues.

GPT-6 Astra inspected **39/39 generation outputs**, **11/11 admissions**, and
**12/12 review contracts**. All eleven admissions are semantically approved; no
false admission was found. The narration-submit tool's three refused targets
include one sound narrow paraphrase and two unsupported consequences. The world
audit found compatible-kind and exact catalog-identity encoding mismatches, plus
underspecified NPC roster exclusions. The sole usable revise review misunderstands
inert mechanics versus an incompatible pin; it remains a historical refusal.
All **51/51 responses** reconcile to captured HTTP bodies. Actual admitted target
tokens: **1,847**, distinct from 7,691 tokens spent across all attempts.

Independent report and machine verdicts:
`/tmp/opencode/foundry-calibration-v4-independent-review.md` and
`/tmp/opencode/foundry-calibration-v4-independent-review.machine.json`.
Semantic inspection does not itself supply the full certificate/artifact export
registry; v4 export approval remains pending.

## Version 5 — complete, world contracts validated, grounding still held

Run `calibration-2026-10-13-v5`, producer
`7dc235d9230b0ff94488a03416d8937ff4d294c1`, 20 seeds/K=1.

| Family | Planned | Attempts | Initial admissions | Final admissions |
|---|---:|---:|---:|---:|
| World generation | 6 | 12 | 2 | 5 |
| Tool selection | 6 | 8 | 5 | 5 |
| Grounded narration | 4 | 12 | 0 | 0 |
| Boundary recovery | 3 | 3 | 3 | 3 |
| Roleplay | 1 | 1 | 1 | 1 |
| **Total** | **20** | **36** | **11** | **14** |

Actual physical/logical responses: **50** (36 generation outputs + 14 reviews).
All reviews are usable: **13 accept + one accept-with-notes**. The original local
summary counted only `accept` in its review tally; the separately retained
`summary-corrected-accept-with-notes.json` fixes that derived count without changing
any historical review, admission or producer report.

Parsing: **18/20 initial**, **32/36 all attempts**. Sixteen repairs. Measured label
spend **6,890**; fourteen selected train targets contain **3,732** labels, across
thirteen selection clusters. No unknown/unmeasured outcome remains.

Independent audit verified **14/14 certificates, supervised targets and semantic
admissions**, and reconciled all 50 responses. No concrete false admission was
found. All five world targets pass the production validation chain without
sanitization; compatible kind, exact identity and roster rules are sound. The
fifteen refused narration targets all use correct native submission. Common
sentence forms still lose receipt scope; some surfaces also violate the requested
prose form, and one adds “You read the ground,” an unsupported specific action.
Those historical refusals remain unchanged.

Ordinary RP: complete **1/1** captured census, style-pass at **2/2/1/2**, independently
pinned ledger
`1a3ff4cd9205f76ea791ac5ea82531d23c728cb0925ab25a05d1cf32d6863353`.
This is one generated-data scene, not controlled student retention or twin parity.

Bindings: plan
`ecd5135a00fa9eabdb55b313f9357944d8b0bafab5159ba3b83db8bdc3284c22`;
report `7494b1ad9070360b7fc415f4cb9e7c2f39315fc00b76b1d1c7a216bfcbdabcd7`;
selection `05ddc4e5fb405960b0b7cf6b60fa149eef180bbd48a7deb8eca51ac379e85f54`.
Artifacts: `.dataset/measurements/calibration-2026-10-13-v5/` and matching run store.
Independent report: `/tmp/opencode/foundry-calibration-v5-independent-review.md`;
machine verdicts: `/tmp/opencode/foundry-calibration-v5-independent-review.machine.json`.

**Pilot HOLD:** focused grounded/tool calibration is appropriate after the remaining
scope corrections pass validation, with separate grounded-prose grading. Full
artifact/certificate export approval for v5 remains a separate pending check.

## Version 6 — functional yield recovered, grounded prose quality held

Run `calibration-2026-10-13-v6`, producer
`c8f0a10246c7fbdeee444fe27cfb6866a6689613`, thirteen seeds/K=1.

| Family | Planned | Attempts | Initial admissions | Final admissions |
|---|---:|---:|---:|---:|
| Grounded narration | 6 | 7 | 5 | 6 |
| Tool selection | 7 | 8 | 6 | 7 |
| **Total** | **13** | **15** | **11** | **13** |

All four tool subtypes admitted: four exact-candidate, one narration-submit,
one read-tool and one no-tool. Thirteen selected records span twelve clusters;
the planned split is twelve train and one dev. Parsing: **13/13 initial** and
**15/15 all attempts**. Actual captured physical/logical responses: **28**
(15 generations + 13 reviews). Two content repairs, **1,092** measured supervised
labels spent, no unresolved/unmeasured outcome in the producer report.
Independent reconciliation confirms **969 admitted labels** (877 train, 92 dev)
plus **123 refused-attempt labels**; the all-attempt spend remains 1,092. Thirteen
review contracts have usable `accept` verdicts, with no `accept-with-notes`.

The complete separately blinded **generated-grounded** census contains eight
captured outputs, including the actual grounded repair and narration-submit.
Seven were gradeable: **one pass, six fail**; one was ungradeable because its
capture mixed assistant content with a tool call. Coverage **7/8**, conditional
style quality **1/7**, acceptable yield **1/8**. All six style failures have
naturalness zero; four also have voice zero. The repeated short actor/attack/HP
sentences read as checklists rather than cohesive roleplay narration. The one
passing check-only output is not evidence that the six combat scenes have
acceptable style. No ordinary RP or twin-parity observations were scheduled.

Frozen prose ledger:
`f9d80aa2cb086b12e676ee5ae868f0672016ec36da401ea4e58c1c7f6b66650a`.
Independent functional/census inspection confirms this canonical ledger pin,
all thirteen certificates and final receipt-backed answers, all fifteen generation
outputs and all twenty-eight captured responses. Both mixed-content attempts
were refused and freshly regenerated; no admitted target silently loses assistant
text. The no-tool decision is legitimate, but its invented room details are not
source-verified observations. No export/training authorization is granted.

Reporting qualifications: the original summary counted failed validator rows and
omitted the separate narration-transport refusal. The retained
`summary-corrected-stage-failures.json` counts both actual stage failures from the
immutable event log and keeps validator-row diagnostics separate. The read-tool
failure was extra assistant text, not incorrect function/argument values.
`manifest.json.spend` is an unpopulated zero projection; measured spend and dispatch
counts come from retained label measurements and the physical journal. Reviewer
prompt bytes resolve through dispatch checkpoints; a future export registry must
include those inspected bytes rather than assuming every source is an `artifact:*`
entry. Historical producer reports and admissions remain unchanged.

Independent report: `/tmp/opencode/foundry-calibration-v6-independent-review.md`;
machine verdicts: `/tmp/opencode/foundry-calibration-v6-independent-review.json`.

Bindings: plan
`d07529276a23a5f1be1e3bea3a04c34226adfb7dfc4f995e19b117865fdf6b46`;
report `acdcc40b7a0cbdb7bc4c0f330b1bdef5c7cd54c4d3f302698b8e1d85f99a040a`;
selection `1d4fe9b776fc14c626bd1cd5bca38722c5e9746d1a6b5240264fc823e98bd3ab`.
Artifacts: `.dataset/measurements/calibration-2026-10-13-v6/` and matching run store.

**Pilot HOLD:** grounded prose does not meet the inherited style floor. Preserve
the locked ratings and historical attempts while correcting the narration
guidance and measuring fresh outputs. No training has run.

## Version 7 — composed-beat diagnostic, public-context stop rule triggered

Run `calibration-2026-10-13-v7`, producer
`2711ea60b00497aceb8dd2f30fd8039c2089037b`, thirteen matched seeds/K=1.
Receipts, identities, requested voices, slots, lineage and splits match v6;
the generator-v9 composition guide is the intervention.

| Family | Planned | Attempts | Initial admissions | Final admissions |
|---|---:|---:|---:|---:|
| Grounded narration | 6 | 11 | 1 | 6 |
| Tool selection | 7 | 8 | 6 | 7 |
| **Total** | **13** | **19** | **7** | **13** |

Producer outcomes: all four tool subtypes admitted, thirteen selected records,
six content repairs, **32** physical/logical captured responses (19 generations
+ 13 reviews). Parsing **13/13 initial**, **19/19 all attempts**. All-attempt
supervised-label spend **1,540**, comprising **989 admitted + 551 refused labels**.
Independent reconciliation confirms **897 selected train labels and 92 dev labels**.
Reviews are **12 accept + one accept-with-notes**; all thirteen are usable.
No unresolved/unmeasured outcome remains in the report. Event-level failure counts
are five binding-grounding failures and one tool argument-binding failure; the
derived summary retains validator-row diagnostics separately.

The complete `generated-grounded` census includes **12 captured, gradeable outputs**:
seven planned initial narration outputs and five actual grounded repairs.
Locked style: **eight pass, four fail**, coverage **12/12**, conditional quality
and acceptable yield **8/12**. The loader's all-attempt cohort floor is `meets`.
This is not the style rate of admitted targets: some passing attempts contain
richer wording that the functional pipeline refused. The functional/style
intersection requires separate reconciliation; rejected attempts cannot make a
later admitted target style-clean. Independent inspection reconciles the actual
final intersection:

| Final narration measure | v6 | v7 |
|---|---:|---:|
| Receipt-grounded narrations | 7/7 | 7/7 |
| Joint style/function passes | 1/7 | 3/7 |
| Paired check/damage joint passes | 0/6 | 2/6 |
| Warm/evasive joint passes | 0/2 | 0/2 |
| Wary joint passes | 0/2 | 0/2 |

All five refused grounded initials pass style: three add unsupported
scene/perception details, while two preserve the facts but use unrecognized
present-tense check grammar. Refusal reasons and grades stay unchanged. Final
improvements are confined to transactional Maren and procedural Oswin, plus the
already-passing check-only tool output.

Warm/wary challenges still have voice or naturalness failures. The preregistered
stop rule therefore triggers the **source-bound public-context diagnostic**, not
another prompt-only tuning loop. No ratings are replaced, no historical refusal
is readmitted, and the matched comparison is not controlled student retention.
No ordinary-RP or twin-parity samples were scheduled.

Frozen prose ledger:
`a4097368e0de07551c2cc0977f9092f8419f28cef1e96f3a92b4b705c0b6f98e`.
Independent inspection confirmed this canonical pin, all nineteen generations,
thirteen certificates/review contracts, thirty-two captured responses and all
seven final receipt narrations. Actor/target, check, damage, HP and stable status
bindings are sound; complete actual admitted outputs are preserved. The no-tool
decision is correct, but room/furnishings/window/door/street/silence details are
unsupported observations. The reviewer calling them observed facts does not
establish public authority. Twelve fresh non-forked Astra contexts and ledger
lock before functional unblinding were independently verified.

Physical responses report 43,019 provider tokens, separate from label counts and
not a dollar-cost estimate. Manifest zero-spend fields remain unused projections.
Independent reports: `/tmp/opencode/foundry-calibration-v7-independent-review.md`
and `/tmp/opencode/foundry-calibration-v7-independent-review.json`.

Bindings: plan
`4ba77018ff32497f1e431508f4ffc602f37179efac1782170fa9b78d29b38e04`;
report `9ab75ee8e19c797aebb9f99527dbab46ff02eccd6441009ee31959ff8ed117af`;
selection `ae54afaf780e9d15e3a78622fde35a2cec35bec2c774dfde726ba4730ee86e01`.
Artifacts: `.dataset/measurements/calibration-2026-10-13-v7/` and matching run store.
**Pilot HOLD; no training or export approval follows from these results.**

## Version 8 — public-context diagnostic: the intervention does not fix prose

Run `calibration-public-context-2026-10-13-v8`, producer tree `d2dd8c0`
(source digest `86585a80f0c8dc6f74296decfe01da66963699341907a9fcf5116a9af8edad76`),
three matched base pairs / six initial tasks, K=1.

Each pair compares a receipt-only narration against the same narration with two
independently authored public observations (amber lamplight, closed shutters).

| Measure | Value |
|---|---:|
| Planned initial tasks | 6 |
| Total generation attempts | 9 |
| Final admissions / selected | 6 / 6 |
| Bounded repairs | 3 (all `binding-grounding`, i.e. functional) |
| Captured logical responses | 15 (9 generations + 6 reviews) |
| Independent review verdicts | 6 accept |
| Supervised labels, all attempts | 764 (503 admitted + 261 refused) |
| Unmeasured attempts | 0 |

Repairs were authorized only by genuine functional failures, confirming the
`functional-only` repair policy in a live run. No style-driven regeneration
occurred.

### Blinded prose census (all 9 surfaces, 6 initial + 3 repairs)

| Arm | Surfaces | Style passes |
|---|---:|---:|
| Receipt-only control | 5 | 1 |
| Observations supplied | 4 | 0 |
| **Total** | **9** | **1** |

Coverage 9/9, conditional quality and acceptable yield **1/9**. Ledger floor
state `below`. Frozen ledger:
`106a9cf086b680011986ad06b19967e3d7beea4ad7aa6b68c975c8ae19fdfba1`.

**The observations were used in every observation-arm output**, so the
integration works. It did not help: the observation arm passed 0/4 against the
control arm's 1/5, and the failure rationale is unchanged — checklist cadence,
voice absent, `naturalness` 0. The one pass is again the plain procedural Oswin
check-and-damage narration.

### What the diagnostic actually established

1. Registered public observations can be integrated into grounded narration
   coherently while mechanical coverage stays intact. That narrow claim holds.
2. **Supplying two inert observations does not remedy warm/evasive or wary
   narration.** The model writes the same mechanical report; when it does reach
   for a richer register it adds claims the receipts do not establish, which the
   grounding gate correctly refuses.
3. A repair that follows a functional refusal can also strip expressive wording:
   the warm/evasive attempt `unit-8c28b0ce238d1727-pc-observations-a0`
   ("…whatever you were reaching for stayed out of reach…") was refused and its
   replacement was plainer. This is correct fail-closed behaviour, but it shows
   the grounding constraint and the requested register are in direct tension for
   this task shape.

### Decision

**The public-context intervention is closed as tested and does not clear the
quality gate.** Per the preregistered stop rule, the pilot remains on **HOLD**.
No further prompt tuning against these six frozen cases is authorized; a further
intervention would require a newly versioned experiment with an identified
mechanism, not a retry.

### New false refusal found in this run

Three first attempts used a first-person check form the validator rejects:

```text
My Survival check comes to 9 against DC 15: a failure.
```

`My <skill> check` binds to the player but is refused (`subject-binding-mismatch`
for the possessive form; `I failed on …` is refused as `actor-binding-mismatch`).
The model produces this naturally. It is the same class of defect as the
present-tense gap closed in `edf834b`, and it was not repaired here: this run
used the grammar as frozen. It is recorded as a known false refusal, not
retroactively re-admitted.

## Creative roleplay — the stream that does produce engaging prose

The creative stream (`dataset/src/creativeRoleplay.ts`, wired into the pipeline as
an opt-in path) was calibrated in four runs. Unlike grounded narration, this
family produces the kind of prose the project is actually for.

| Run | Admitted | Empty completions | Transcript refusals | Note |
|---|---:|---:|---:|---|
| v1 | few | many | many | Recorded failure: the impersonation detector refused ordinary dialogue |
| v2 | 4 | 5 | 15 | Output budget 4096 still truncated longer conversations |
| v3 | 6 | **0** | 13 | Budget 16384 fixed truncation entirely |
| v4 | **8 / 10** | 0 | 11 | Exact-turn-count demand relaxed to a valid range |
| v5 | **partial** | — | — | Abandoned, not failed: see below |
| v6 | **22 / 30** | 0 | 34 | The creative half of the exported corpus |

**v5 is recorded as a partial run, not a result.** It stopped at 14 attempts /
6 admitted after a `fetch failed` on `creative-unit-6bb0aa1b3f484370-a2-review`.
Resume was refused because the tree had changed, which is the journal doing its
job: a run whose source has moved is not resumable. Its store is preserved and it
is **never** counted as an admitted-yield measurement. v6 is a fresh run id with
the same 30-unit plan, and it is the run the exported creative records come from.

### v4 detail

- 10 planned, 19 attempts, **8 admitted**, 8 selected, 9 bounded repairs.
- **27 captured responses**, 8 independent review verdicts, all accepted.
- **6 train / 2 sealed-test**, **8 distinct character lineages** (no two share a
  character), and **8/8 are multi-turn** (3–8 supervised character turns each).
- **14,630** supervised labels across all attempts; **3,882** admitted. For scale,
  the entire previously approved export was 806.
- Remaining refusals are teacher non-compliance, not detector bugs:
  `transcript-player-impersonation` 9, `transcript-speaker-alternation` 9,
  `transcript-turn-count-mismatch` 2, `transcript-grading-metadata` 1.

### Independent creative review

A stratified sample of five of the eight admitted conversations was rendered as
plain dialogue (the training surface is JSON, which a style judge cannot assess)
and judged in fresh independent contexts against a nine-criterion creative rubric.
The player's turns were marked as **not** training targets.

**3 pass / 2 fail.** Every passing conversation reported
`writesPlayerActions: false` and `playerTurnsNatural: true`.

The two failures were genuine and different:

1. `dialogueNaturalness: 0` — every character turn was an elaborately balanced
   speech, and the player's matching rhetorical cadence read as scripted support
   rather than conversation.
2. **`playerAgencyPreservation: 0`, `writesPlayerActions: true`** — the character
   asserted an unstated player intention: *"You want to know what I want."* The
   player's uncertainty about what they wanted did not establish that desire.
   **The structural gate did not catch this**, because `want` is not in the
   impersonation verb list. This is a real false negative in the detector, found
   by independent review rather than by the pipeline.

Representative passing evidence, with the character's own voice:

> "Two winters I've practised it at the kettle, and the kettle's very forgiving,
> so that's not saying much for me."

> "I am not asking to be agreed with. I am asking to be believed, and those are
> not the same thing."

### What this establishes, and what it does not

Established: the creative stream can generate diverse, character-driven,
multi-turn roleplay that independent judges rate as good training material, with
the simulated player never supervised. This is the **implemented and evaluated
response to the creative-coverage gap**, not a proposal. Independent creative
quality is **3/5 on a stratified sample**, not a high score but a real one, on a
family that previously could not be evaluated at all.

Not established: that training on it improves a model. This section reports the
calibration yield (v4, 8/10). The **corpus campaign below** is the production
artifact; it is a separate, larger run. And the detector gap above means
structural admission is **not** sufficient evidence of player-agency
preservation; independent review found a case the pipeline admitted.

## Corpus campaign — the first real training corpus

Four independent runs were executed concurrently. The pipeline is deliberately
serial per unit for durable journaling, so throughput came from running separate
frozen plans in parallel rather than from parallelising one run.

| Run | Planned | Attempts | Admitted | Admitted labels | All-attempt labels |
|---|---:|---:|---:|---:|---:|
| `corpus-structured-2026-10-13-v1` | 60 | 84 | **59** | 13,205 | 19,266 |
| `…-v1-shard2` | 60 | 84 | **58** | 12,117 | 17,769 |
| `…-v1-shard3` | 60 | 86 | **57** | 12,928 | — |
| `creative-2026-10-13-v6` | 30 | 56 | **22** | 10,670 | 42,827 |
| **Total** | **210** | **310** | **196** | **48,920** | **98,656** |

Train split: **155 records, 39,435 supervised labels** (21 dev, 20 sealed-test).
For scale, the entire previously approved export was 4 records and 806 labels.

### By family (admitted / planned)

| Family | Admitted | Rate |
|---|---:|---:|
| Boundary recovery | 36 / 36 | 100% |
| Tool selection | 54 / 54 | 100% |
| Grounded narration | 27 / 27 | 100% |
| World generation | 57 / 63 | 90% |
| Creative roleplay | 22 / 30 | 73% |

The structured yield is consistent across independent shards (59/60, 58/60,
57/60), which is evidence it is not a lucky seed.

### Findings from the campaign

1. **World JSON was truncated at the 2048 output budget.** Twelve refusals
   captured `finishReason: max_tokens` with unterminated JSON. The repair loop
   recovered most of them, but each truncation wastes a dispatch. The structured
   runner now requests 4096.
2. **Creative generation is materially more expensive per admitted record.**
   42,827 labels across all attempts against 10,670 admitted: roughly 75% of
   spend goes to refused attempts, because the initial yield is 13/30 and repairs
   are costly on long multi-turn outputs. Not a correctness problem — refusals are
   correct and charged honestly — but it belongs in any scaling plan.
3. **Remaining refusals are real and varied:** world reference-closure (dangling
   references), argument-binding, grounding adjudications, and creative transcript
   contract violations. No false admission was identified by the campaign itself;
   independent approval is the check for that.

### What this is and is not

This is a real corpus, not a calibration. **It has since been exported** under an
independently issued, digest-pinned approval — 155 train records and 39,435
supervised tokens, approval
`2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14`. The export
pins and the approval history are in [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md).
The approval authorizes **export only**; nothing here demonstrates that training
on it improves a model.
