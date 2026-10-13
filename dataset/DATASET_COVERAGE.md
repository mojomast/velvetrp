# Dataset coverage and mixing

This document describes what the foundry can generate, how the streams are
separated, and how to mix them. It states measured coverage where it exists and
marks it clearly where it does not.

## 1. Generation families and allocation

`FAMILY_WEIGHTS` in `dataset/src/generate.ts` allocates scheduled scenario seeds:

| Target | Weight | What it trains |
|---|---:|---|
| `world-generation` | 0.28 | Structured JSON world content under a schema and dependency contract |
| `grounded-narration` | 0.22 | Receipt-bound narration of committed outcomes |
| `tool-selection:argument-binding` | 0.18 | Selecting an advertised candidate with exact arguments |
| `boundary-recovery` | 0.14 | In-character recovery at a knowledge/authority boundary |
| `tool-selection:initiation` | 0.12 | Deciding whether to call a tool at all (narration submit, read, abstain) |
| `roleplay-conversation` | 0.06 | Ordinary character roleplay |

The allocation reflects measured stock-model weaknesses, not an optimum. It is
deliberately non-uniform: the structured weaknesses were measured first.

## 2. Two separate prose cohorts

Prose is measured in **two cohorts that are never pooled**:

- `generated-rp` — ordinary character roleplay and authored twins.
- `generated-grounded` — receipt-bound narration, including the narration-submit
  tool subtype.

They are separate because grounded narration must be mechanically exact, which
forces a stiff register. Letting grounded-style numbers stand in for roleplay
coverage would overstate it. A focused campaign that schedules no ordinary RP has
**no new ordinary-RP denominator** rather than an invented one.

## 3. The creative stream

`dataset/src/creativeRoleplay.ts` (protocol:
[`creative/CREATIVE_STREAM_PROTOCOL.md`](creative/CREATIVE_STREAM_PROTOCOL.md))
is the substantive content of the `roleplay-conversation` tranche. It replaces the
legacy three-message scaffold with character-card-conditioned multi-turn
conversations.

Coverage it can generate:

- **Settings (7):** fantasy, science fiction, modern, historical, horror, mystery,
  slice-of-life. Each carries distinct props, social context and idioms.
- **Characters:** procedurally generated names, age bands, occupations,
  backgrounds, motivations, temperament tags, speech registers, relationship
  stances and emotional volatility — not drawn from the eight-name legacy cast.
- **Relationship/temperament:** friendly, adversarial, humorous, cautious,
  emotional, reserved, highly expressive, and conflicting-goal combinations.
- **Arc shapes:** everyday/low-stakes, negotiation between conflicting goals,
  emotional escalation, dramatic turning point. Depth is parameterizable (3–8
  exchanges).
- **Supervision:** every character turn in one example, or one chosen turn with
  the rest as context. The simulated player's turns are **never** supervised.

Diversity and category coverage are reported by `creativeBatchDiversity`,
`creativeCoverageReport` and `selectCreativeMix`.

**What is not claimed:** no student-retention or model-quality measurement follows
from these generators, and **no optimal mixing ratio is asserted in advance**.

## 4. Export categories

Every record carries a category so a bundle can be consumed three ways:

1. **Creative only** — character roleplay rows.
2. **Structured/RPG only** — world generation, tool selection, boundary recovery,
   grounded narration.
3. **Combined multitask** — a configurable mixture.

The purpose of separating them is to make the question *does structured training
degrade roleplay quality?* answerable by controlled comparison rather than
assertion.

## 5. Measured coverage

Coverage numbers come from completed calibration runs and are reported in
[`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md). Read them there rather than
duplicating them here, so there is one source of truth.

Summary of the current position:

| Stream | Functional quality | Prose quality |
|---|---|---|
| World generation | Independently approved (v5) | n/a (structured JSON) |
| Tool selection | Independently approved (v5–v7) | n/a (tool calls) |
| Boundary recovery | Independently approved (v5) | n/a (in-character) |
| Grounded narration | Functionally admitted | **Below the style floor** |
| Creative roleplay | Admitted in calibration | Measured separately |
| Ordinary RP (legacy scaffold) | Admitted | Superseded by the creative stream |

## 6. What is deliberately absent

- **No hidden benchmark content.** The frozen dev and sealed corpora are never
  teacher prompts or SFT targets. The sealed corpus is ids/counts-attested only.
- **No preference pairs by default.** Preference data is published separately and
  only where real chosen/rejected pairs exist with explicit branch masks.
- **No student-retention claim.** The historical raw stock answers needed to
  ground the inherited 4/8 floor were never recovered, so no controlled retention
  comparison is established.
