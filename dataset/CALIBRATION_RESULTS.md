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
