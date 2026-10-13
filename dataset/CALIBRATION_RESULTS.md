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
