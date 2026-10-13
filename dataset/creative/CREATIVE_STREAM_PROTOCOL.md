# Creative Stream Protocol (`creative-stream-v1`)

Status: **module complete and committed (`d2dd8c0`).** As of that commit it was
not wired into `dataset/src/generate.ts`. A separate agent is wiring it now in an
uncommitted change to that file; this document does not track that diff, and
section 13 describes the module-side contract the wiring must satisfy rather than
the current state of `generate.ts`.

Owner file: `dataset/src/creativeRoleplay.ts` (self-contained). Its only runtime
imports are `createHash` from `node:crypto` and `stableStringify` from
`./spec.js`; the `./hfAdapter.js` import is type-only and erased at runtime.

Tests: `dataset/test/creative-roleplay.test.ts` (18/18 passing; verified by
running the file, see section 14).

This document is written to be **accurate to the code that actually ships**. Where
the module and this document disagree, the module is authoritative.

---

## 1. Purpose and hard invariants

The creative stream is a general-purpose VelvetRP character-conversation
generator. It is deliberately different from the legacy `roleplay-conversation`
three-message scaffold:

| | legacy scaffold | creative stream |
| --- | --- | --- |
| shape | one templated user turn + canned prefill + "Go on, then." | full `depth`-exchange two-hander |
| supervision | only the last assistant turn (`lastAssistantIndex` + `selectTargets`) | **every character turn**, or one chosen character turn |
| context | not preserved | the whole conversation is preserved as context |
| stream label | none | `creative-only` |

Invariants that may not be weakened:

1. **A simulated player turn is never supervised, in any mode, depth or
   interleaving.** Enforced at construction (`buildCreativeTrainingExample`
   only ever emits assistant indices taken from `characterMessageIndices`),
   by the reusable gate `assertCreativeExampleInvariants`, and by a regression
   test over a large deterministic batch.
2. **The creative stream must not reuse the legacy cast, place or guild
   anchors.** The eight legacy cast names (`LEGACY_CAST_NAMES`) are hard-blocked
   inside `generateName` and additionally asserted absent. The legacy place and
   guild phrases do not appear anywhere. This guarantee does **not** extend to the
   five legacy object nouns: `"the manifest"` occurs whole inside the
   science-fiction idiom `"on the manifest"`, and `"the ledger"` occurs whole
   inside the mystery pressure `"a name missing from the ledger"`; `"ledger"` also
   recurs as an ordinary object noun (fantasy `"a toll ledger"`, mystery
   `"a ledger of loans"`). The committed reskin test asserts whole-phrase absence
   for names, places and guilds only — its anchor list omits the legacy objects —
   so those two phrases are a known, documented overlap rather than a caught defect.
3. **Fail closed.** A malformed transcript, wrong speaker label, empty turn,
   meta commentary, grading metadata, mechanical-report register, or a character
   turn that impersonates the player is **rejected** with a stable code, never
   repaired. The only forgiving step (inherited from `parseStage`) strips at most
   one surrounding JSON fence; the payload inside is parsed strictly.
4. **Determinism.** Same seed ⇒ byte-identical cards, worlds, plans, lineage and
   example digests. splitmix64 over a SHA-256-derived state; no `Date.now`, no
   `Math.random`.
5. **Lineage split before derivatives.** Splits are assigned to the underlying
   character/world/scenario lineage, so a paraphrase can never cross a split.
6. **No hidden answers.** Cards, worlds, arcs and prompts are teacher-visible
   *input* and contain no expected line, target value, rubric score or answer key.
   The transcript schema has `additionalProperties: false` at both levels.

Errors are typed: `CreativeConfigError` (bad configuration), `CreativeTranscriptError`
(carries `refusals`), `CreativeReviewError` (carries `refusals`),
`CreativeDiversityError` (carries `report`).

---

## 2. Card schema

`createCharacterCard(seed, setting) -> CharacterCard` is a pure function of
`(seed, setting)`. `validateCharacterCard(value) -> string[]` returns problems
and never throws on content. `CARD_KEYS` is the exact key set.

```
CharacterCard {
  schemaVersion: "creative-card-v1"
  cardId: string            // creative-card-<digest[:16]>
  name: string              // generated, legacy-blocked
  apparentAgeBand: "teen" | "early-twenties" | "thirties" | "forties"
                 | "fifties-or-older" | "age-indeterminate"      // APPEARANCE_AGE_BANDS
  role: string              // drawn from the setting profile's occupations; validated non-empty
  background: string        // formative event + present situation + shared detail
  motivation: string        // one framed want
  goal: string              // the same want as a bare verb phrase
  temperament: string[]     // >= 2 distinct tags from TEMPERAMENT_TAGS (validated)
  speech: SpeechRegister {
    vocabulary: string      // drawn from VOCABULARY_BANDS; validated non-empty
    tic: string             // drawn from VERBAL_TICS; validated non-empty
    verbosity: "terse" | "measured" | "expansive"       // VERBOSITIES (validated)
    sentenceHabits: string  // drawn from SENTENCE_HABITS; validated non-empty
    formality: "casual" | "neutral" | "formal"          // FORMALITIES (validated)
  }
  stance: RelationshipStance {
    primary: RelationshipStancePrimary      // RELATIONSHIP_STANCES
    secondary: RelationshipStancePrimary | null
    conflicting: boolean    // true iff secondary is on CONFLICTING_STANCE_AXES[primary]
  }
  emotionalVolatility: "low" | "moderate" | "high"        // EMOTIONAL_VOLATILITIES
  voiceAnchor: string       // one paragraph: how this person sounds
  setting: CreativeSettingId
  digest: string            // sha256Hex(stableStringify(body-without-id/digest))
}
```

`validateCharacterCard` enforces: membership in `APPEARANCE_AGE_BANDS`,
`EMOTIONAL_VOLATILITIES`, `RELATIONSHIP_STANCES` and `CREATIVE_SETTINGS`; a
`temperament` of at least two distinct `TEMPERAMENT_TAGS`; `verbosity` and
`formality` in `VERBOSITIES` / `FORMALITIES`; a boolean `stance.conflicting`; and
**non-empty strings** for `name`, `role`, `background`, `motivation`, `goal`,
`voiceAnchor`, `speech.vocabulary`, `speech.tic` and `speech.sentenceHabits`. The
vocabulary/tic/sentence-habit and occupation *bands* are generation-time draws,
not validation-time checks: a card carrying a non-empty string outside the bank
still validates.

`characterSignature(card)` is the coarse identity signature, formed by joining
`[setting, role, apparentAgeBand, stance.primary, stance.secondary ?? "-",
emotionalVolatility, speech.tic]` with `"|"`; two cards agreeing on it read as the
same person to a batch reviewer.

`generateName(rng, cultureId)` produces given + family/epithet names from
composable onset/nucleus/coda banks and family heads. Twelve name cultures are
shared across settings via `nameCultures`. The legacy cast names
(`LEGACY_CAST_NAMES`) are blocked at name generation.

---

## 3. Setting taxonomy

`CREATIVE_SETTINGS = ["fantasy", "science-fiction", "modern", "historical",
"horror", "mystery", "slice-of-life"]`.

Each `CreativeSettingProfile` (`CREATIVE_SETTING_PROFILES[setting]`) carries its
own `props`, `socialContext`, `idioms`, `occupations`, `institutions`,
`pressures`, `formativeEvents`, `presentSituations`, `localeRoots`,
`localeSuffixes` and `nameCultures`. `creativeSettingTokens(setting)` exposes the
tokens a setting lends its prose, which is how the tests prove a setting changes
**surface text, not a label**. Occupations are setting-specific: a role from one
setting never appears in another setting's profile (verified: no occupation
string occurs in more than one profile).

---

## 4. Worlds, arc shapes and plans

`createCreativeWorld(seed, setting) -> CreativeWorld` derives `locale`,
`institution`, `pressure`, `prop`, `idiom`, `socialContext` from the setting
profile.

`CREATIVE_ARC_SHAPES = ["everyday", "negotiation", "emotional-escalation",
"dramatic-turning-point"]`. Each shape declares exactly four situation classes in
`SITUATION_CLASSES`. Depth is an integer in `[MIN_EXCHANGE_DEPTH, MAX_EXCHANGE_DEPTH] = [3, 8]`.

```
createCreativePlan(input) -> CreativePlan
input: { seed, card?, setting?, shape?, depth?, world?, situationClass? }
```

`CreativePlan` carries `schemaVersion`, `seed` and `category` (`"creative-only"`),
and has `scenario { situationClass, shape, setting }`, `beats` (`opening` at
index 0, `closing` at index depth-1, a `turn` beat at index depth-2 for
`dramatic-turning-point` and `emotional-escalation`, otherwise `escalation`),
`closingBeat`, `situation`, `stakes`, `characterGoal`, `playerIntent`, `digest`
and `planId`. `validateCreativePlan(plan) -> string[]`.

Private helpers `beatRoleFor`, `fillPlaceholders`, `STANCE_ARC`,
`SHAPE_*` tables are not exported.

---

## 5. Transcript contract

`CREATIVE_TRANSCRIPT_SCHEMA` (`creative-transcript-v1`) is the single source of
truth for the teacher prompt and the parser:

```
{ "turns": [ { "speaker": "player"|"character", "text": string }, ... ] }
```

- Top-level keys: exactly `["turns"]`. Turn keys: exactly `["speaker","text"]`.
- The scene is strictly alternating, **player first and character last**.
- `minItems` is `2 * MIN_EXCHANGE_DEPTH`; the parser additionally requires
  exactly `2 * plan.depth` turns.

`checkCreativeTranscript(raw, plan) -> CreativeRefusal[]` performs pure
structural and register validation (an empty array means ACCEPTED).
`parseCreativeTranscript(raw, plan) -> CreativeTranscript` re-runs that check and
throws `CreativeTranscriptError` with every refusal. `CreativeTranscript` carries
`schemaVersion`, `planId`, `turns`, `characterTurns`, `playerTurns`, `digest`.

### Refusal codes (stable, never free text)

Structural: `transcript-not-json`, `transcript-not-object`,
`transcript-unknown-key`, `transcript-missing-turns`,
`transcript-turns-not-array`, `transcript-turn-not-object`,
`transcript-turn-unknown-key`, `transcript-turn-missing-speaker`,
`transcript-turn-missing-text`, `transcript-text-not-string`,
`transcript-unknown-speaker`, `transcript-empty-character-turn`,
`transcript-empty-player-turn`, `transcript-first-speaker-not-player`,
`transcript-last-speaker-not-character`, `transcript-speaker-alternation`,
`transcript-turn-count-mismatch`.

Register/content (character turns): `transcript-player-impersonation`,
`transcript-mechanical-register-leak`. All turns:
`transcript-meta-commentary`, `transcript-grading-metadata`.
Plan: `plan-invalid`. The review contract has its own refusals (section 8):
`review-not-json`, `review-not-object`, `review-unknown-key`,
`review-missing-field`, `review-score-out-of-range`, `review-unknown-verdict`,
`review-rationale-empty`.

### Player-impersonation rule

A character turn may not assert the player's decisions, feelings, speech or
outcome. Two pattern families:

- **HARD** — refused anywhere in the turn. Includes `you decide/choose/agree/…`,
  `you must/have to/…`, `your <body part> <verb>`, `(you …)` parentheticals and
  `*… you …*` stage directions, and **main-clause** reported speech
  (`You said …`). Reported speech is anchored to a clause start or a
  coordinating conjunction, so a subordinated clause such as
  *"Before you say anything…"* is ordinary dialogue and is **allowed**.
- **SOFT** — imperative/declarative action or state claims about the player
  (`You open the door`, `Your face…`, `You feel relieved`), refused **outside a
  question** only. A genuine question (`Did you open it?`) and a wish
  (`Are you all right?`) are allowed.

### Meta / grading / mechanical register

- `META_COMMENTARY_PATTERNS` catch AI self-reference, transcript/answer framing
  (`here's the transcript`, `I have written the scene`), `per the
  beats/card/plan/arc/instructions` and `based on the …`, `let me know if`,
  `please note`, `I hope this helps`, `as requested`,
  `note:/commentary:/feedback:`, prompt field-name echoes (`character card`,
  `voice anchor`, `apparent age band`, `speech register`, `emotional volatility`,
  `situation class`, `conversation plan`, `emotionalVolatility`,
  `apparentAgeBand`), and the meta construction `(the )player <verb>`
  (`wants|needs|will|should|must|decides|feels|says|does|goes|is|has|turn|side`).
  A bare `"the player"` is deliberately **not** refused, because "players" is
  ordinary English.
- Interaction worth knowing: the plan *input* for some shapes contains literal
  `"The player wants …"` / `"The player is …"` sentences inside `situation` and
  `playerIntent`. A teacher that echoes that phrasing verbatim into a turn is
  refused by the `(the )player <verb>` pattern; the prompt instructs the teacher
  never to quote the intention back. This is fail-closed by design, not a
  validator bug.
- `GRADING_METADATA_PATTERNS` catch quoted answer/score keys, `expected answer`,
  `correct answer`, `rubric`, `score:`/`grade:`, and `n/10`.
- `MECHANICAL_REGISTER_PATTERNS` catch `DC <n>`, hit points, initiative order,
  proficiency bonus, stat block, saving throws / attack rolls / ability checks,
  dice (`d20`, `2d6`), `roll a d…`, `narrates:` and named skill checks. Ordinary
  English (`initiative`, `difficulty`, `chance`) is deliberately not in the list.

There is no repair path: a rejected transcript is refused.

---

## 6. Teacher prompt (input only)

`creativeTeacherPrompt(plan) -> { system, user, outputSchema, digest }`. The
system prompt carries the hard rules, the character card, the setting and scene,
the simulated player's intention, and the arc, plus the exact transcript JSON
schema. `user` is the situation plus the instruction to write the conversation.
Nothing in the prompt is an expected line, a rubric score or an answer key.

---

## 7. Target selection and the never-supervise-player property

```
CreativeTargetMode =
  | { kind: "all-character-turns" }
  | { kind: "single-character-turn"; characterTurnIndex: number }

creativeTargetSelection(transcript, mode) -> CreativeTargetSelection
CreativeTargetSelection {
  supervisedCharacterTurnOrdinals: readonly number[]  // 0-based into transcript.characterTurns
  supervisedToolCallIndices: readonly number[]        // always []
}

buildCreativeTrainingExample(plan, transcript, { targetMode?, systemPrompt? })
  -> CreativeTrainingExample
```

Message layout is `[system, player, character, player, character, …]`; player
turns become `user`, character turns become `assistant`. The build records the
**actual** `characterMessageIndices` / `playerMessageIndices` it assigned.

Two distinct shapes, deliberately:

- `creativeTargetSelection` returns a `CreativeTargetSelection`, whose
  `supervisedCharacterTurnOrdinals` index into `transcript.characterTurns` and are
  **not** message indices.
- The built example's `example.targetSelection` is the `./hfAdapter.js`
  `TargetSelection`: its `supervisedAssistantIndices` are **message indices** into
  `example.messages`, and its `supervisedToolCallIndices` is always empty.

**Selection is by character-turn ordinal, never by message-index arithmetic.**
`buildCreativeTrainingExample` resolves each ordinal through its own
`characterMessageIndices`. This is why the property holds for a player-first
transcript (the contract's required shape) and, structurally, for any other
interleaving the format might admit: a supervised index is a member of
`characterMessageIndices` by construction.

`creativeTargetSelection` rejects an out-of-range `characterTurnIndex`. The
built example runs `assertCreativeExampleInvariants` before returning and throws
`CreativeConfigError` if any supervised index is not an assistant/character
message, is a player turn, is duplicated, or carries tool calls.

`assertCreativeExampleInvariants(example) -> string[]` is exported as a reusable
gate.

---

## 8. Independent creative review

`CREATIVE_REVIEW_CRITERIA` (creative-quality only; mechanical/factual
correctness must **not** be added):

```
voiceConsistency, voiceDistinctiveness, dialogueNaturalness, characterAutonomy,
playerAgencyPreservation, pacingAndProportion, emotionalPlausibility,
repetitionControl, nonMechanicalRegister, noMetaCommentary
```

`creativeReviewPrompt(plan, transcript) -> string` shows the reviewer the plan
(input) and the transcript (output); it states that the absence of numbers,
checks, DCs, dice, status effects or receipts is never a defect and their presence
is. `CREATIVE_REVIEW_SCHEMA` (labelled with `CREATIVE_REVIEW_PROMPT_VERSION =
"creative-review-v1"`; there is no separate review-schema version constant)
requires all ten scores in `[0,1]`, a `verdict` in `{accept, accept-with-notes,
revise, reject}` and a non-empty `rationale`; extra keys are refused (reviewer
counts are pipeline-owned). `parseCreativeReview(raw) -> CreativeReview` throws
`CreativeReviewError` carrying `refusals` on any refusal; the review refusal codes
are `review-not-json`, `review-not-object`, `review-unknown-key` (including the
pipeline-owned `reviewerCount`, `model`, `promptVersion`, `pass`, `total` and
`score`), `review-missing-field`, `review-score-out-of-range`,
`review-unknown-verdict` and `review-rationale-empty`. `creativeReviewPrompt` /
review digests are deterministic.

`foldCreativeReviewIntoSpecScores(review)` maps the ten creative scores onto the
existing six `ReviewScores` fields using `min()` (never a mean), so admission's
`REVIEW_FLOORS` apply unchanged:

```
characterization     = min(voiceConsistency, voiceDistinctiveness)
dialogueQuality      = min(dialogueNaturalness, noMetaCommentary, nonMechanicalRegister)
coherence            = min(emotionalPlausibility, pacingAndProportion)
narrativeInitiative  = characterAutonomy
playerAgency         = playerAgencyPreservation
nonRepetitive        = repetitionControl
```

A zero on `playerAgencyPreservation` survives the fold and lands on the
`playerAgency` floor.

---

## 9. Lineage, derivatives and splits

```
creativeLineage(plan) -> LineageGroup {
  characterFamily: creative-character-<sha256(card.digest)[:16]>
  worldFamily:     creative-world-<sha256(world.digest)[:16]>
  scenarioFamily:  creative-scenario-<sha256(stableStringify(scenario))[:16]>
}

creativeSplitForLineage(lineage, delegate?) -> DatasetSplit
```

`creativeSplitForLineage` is byte-compatible with `splitForLineage` in
`generate.ts`: `sha256Hex(stableStringify(lineage))`, first 8 hex digits mod 100,
then `train < 80`, `dev < 90`, else `sealed-test`. Passing `delegate` routes the
decision through the runner's own function and returns immediately.

`createCreativeDerivatives(plan, variants)` returns fresh plans with the **same**
card, world, shape and situation class (so the same lineage and split) and a new
seed; `creativeDerivativeId(plan, variant)` names them. A variant label never
feeds a lineage field.

`assertCreativeLineageDisjoint(assignments)` groups by the **complete lineage
triple**, not per field. A derivative shares all three families exactly, so only a
complete group spanning two splits is a leak; two unrelated plans that happen to
share a single family are not a defect.

---

## 10. Diversity and coverage measurement

`creativeBatchDiversity(cards) -> CreativeDiversityReport` measures `total`,
`distinctNames`, `distinctCards`, `distinctSignatures`, `distinctRoles`,
`largestSignatureBucket`, `signatureShare`, `legacyNameCollisions`, per-setting /
age-band / stance / volatility tallies, `collisionPairCount`, and a deterministic
sample of colliding `{a, b, signature}` pairs capped at `COLLISION_SAMPLE_CAP`
(20).

`assertCreativeBatchDiversity(cards, policy = DEFAULT_CREATIVE_DIVERSITY_POLICY)`
throws `CreativeDiversityError` (carrying the report) when the batch reuses legacy
cast names, has a distinct-signature share below `minDistinctSignatureShare`
(0.7), a largest signature bucket above `maxLargestSignatureBucket` (6), or
byte-identical cards. `DEFAULT_CREATIVE_DIVERSITY_POLICY =
{ maxLargestSignatureBucket: 6, minDistinctSignatureShare: 0.7 }`.

### 10.1 What is measured, and what is not claimed

- `creativeBatchDiversity` reports generator-side **surface** statistics over the
  cards it is handed; `assertCreativeBatchDiversity` promotes four of them into a
  fail-closed gate.
- `creativeCoverageReport(items)` tallies category, split, setting, arc shape and
  stance, counts distinct character / world / scenario lineage families, and
  reports `creativeToStructured` (`creative`, `structured`, `ratio`).
- `selectCreativeMix(items, policy)` maps a configured
  `{ seed, creativeShare, structuredShare }` onto a deterministic selection and
  **reports** `achieved` / `achievedShares` next to the `requestedShares`.
- **Not claimed.** Nothing here measures student retention, learning effect,
  quality or difficulty. No optimal creative:structured mixing ratio is asserted
  or recommended in advance: the ratio is a policy input and the achieved mix is a
  measurement. Diversity counts are satisfied by varied surface text and say
  nothing about quality; quality is a separate, independent judgment (section 8).

---

## 11. Category model and export mixing

```
CREATIVE_STREAM_CATEGORIES = ["creative-only", "structured-only", "multitask"]
CREATIVE_CATEGORY_CREATIVE_ONLY = "creative-only"
isCreativeStreamCategory(value)
creativeCategoryLabel("creative-roleplay" | "structured", { multitask? })
  -> "creative-only" | "structured-only" | "multitask"
```

Every creative training example carries `category: "creative-only"`. The label
belongs in **sidecar provenance**, never inside `messages`.

```
CreativeMixPolicy { seed: string; creativeShare: number; structuredShare: number }  // shares sum to 1
selectCreativeMix(items, policy) -> CreativeMixResult<T>
  { selected, excluded:[{id, reason:"share-cap"|"category-unavailable"}],
    achieved, requestedShares, achievedShares, digest }
```

`selectCreativeMix` orders items deterministically by
`sha256(seed|creative-mix|id)`, allocates by largest single share quota
(`round(total * share)`, capped by each pool), and **reports** what it achieved
rather than asserting a ratio. If either category pool is empty it selects
nothing and marks every item `category-unavailable`. It is input-order
independent. `creativeCoverageReport(items)` measures category, split, setting,
arc shape, stance, distinct family counts and the creative:structured ratio.

---

## 12. Determinism

`createCreativeRng(seed)` is splitmix64 over a SHA-256-derived state, matching
`createRng` in `generate.ts`. All generated artifacts are canonical-JSON hashed
(`stableStringify`), so a seed yields byte-identical output on every platform.
Verified by a two-process run of `createCharacterCardBatch(seed, 200)` +
`createCreativePlans(seed, 200)`: the canonical-JSON batch hashes to the same
SHA-256 both times
(`6bd9794397372e304eb2078e054133208ad3109a56e134a4ba0e8b92dd0c2ae6`). The
committed test file covers in-process determinism (repeated card builds and RNG
streams) rather than the cross-process check, which was run separately.

---

## 13. Intended integration into `dataset/src/generate.ts`

**At commit `d2dd8c0` this module was not wired into `dataset/src/generate.ts`; a
separate agent is wiring it now in an uncommitted change to that file.** This
document does not track that diff. Everything below describes the module-side
contract the wiring must satisfy, using the `generate.ts` names current as of
`GENERATOR_VERSION = "generator-v9"`.

### 13.1 Family registration

- `CREATIVE_FAMILY` is `"roleplay-conversation"`, reusing the existing
  `TrainingFamily`. It already has a weight: `FAMILY_WEIGHTS["roleplay-conversation"] = 0.06`
  (a compact, deliberately non-zero retention tranche). No new family or weight is
  required; the creative stream *is* the substance of that tranche.
- `targetsFor("roleplay-conversation")` already returns `["roleplay-conversation"]`;
  no change needed.

### 13.2 Planning

- `planRun({ seed, units, families, … })` in `generate.ts` allocates units by
  weight and builds `PlannedUnit`s from `ScenarioSpec` + `Realization`. The
  creative stream does **not** read the frozen corpus, so it should be scheduled
  as its own unit source rather than through `scenarioSpec`/`realizeScenario`.
  Concretely, an integrator can produce, per scheduled creative unit:
  1. `const plan = createCreativePlan({ seed: unitSeed, shape?, setting?, depth? })`;
  2. `const prompt = creativeTeacherPrompt(plan)` for the teacher call;
  3. `const transcript = parseCreativeTranscript(teacherRaw, plan)` (fail closed);
  4. `const built = buildCreativeTrainingExample(plan, transcript, { targetMode })`.
- `built.example` is already a `SupervisedExample`
  (`{ family, messages, targetSelection }`) and `built.split` /
  `built.lineage` match `ScenarioSpec`'s fields.

### 13.3 Gating and target capture

- `dispatchGate` (`generate.ts`) switches on `spec.family`; the
  `"roleplay-conversation"` arm calls `gateRoleplay`, which today runs the generic
  `proseGate`. For the creative stream the structural/register gate is
  `parseCreativeTranscript` + `buildCreativeTrainingExample` (both fail closed),
  so an integrator should route creative units through those instead of
  `capturedTargetExample` (which supervises only the last assistant turn via
  `lastAssistantIndex` + `selectTargets`).
- `capturedTargetExample(unit, completion)` is the legacy single-target path;
  the creative stream replaces it with `buildCreativeTrainingExample`, which
  supervises every character turn (or one).
- If a mixed gate path is used, call `assertCreativeExampleInvariants` as a
  final gate on any example built from creative material.

### 13.4 Splits

- `creativeSplitForLineage(lineage, delegate?)` accepts the runner's splitter as
  an optional delegate. `splitForLineage` in `generate.ts` is currently
  module-private (declared without `export`), so the delegate form requires
  exporting it first; without a delegate the module's fallback is byte-identical
  to it (SHA-256 of `stableStringify(lineage)`, first 8 hex digits mod 100, `< 80`
  train, `< 90` dev, else `sealed-test`), so the two agree either way. Do **not**
  re-derive splits from derivative labels.

### 13.5 Review and admission

- The independent creative reviewer is `creativeReviewPrompt(plan, transcript)` →
  `parseCreativeReview(raw)` → `foldCreativeReviewIntoSpecScores(review)`. The
  folded object has the six `ReviewScores` fields admission already binds
  (`REVIEW_FLOORS`).
- `parseReviewScores` in `generate.ts` parses the *legacy* reviewer contract; the
  creative reviewer uses `parseCreativeReview` instead.

### 13.6 Provenance and export

- Put the `creative-only` label (and `planId`/`planDigest`/`transcriptDigest`)
  into sidecar provenance (`Provenance.sourceDigests` / a stream marker), never
  into `messages`. `exportTrainingJsonl` whitelists HF fields and refuses
  unexpected metadata inside messages, so a category key inside a message would
  be rejected by design.
- `selectCreativeMix` / `creativeCoverageReport` operate on labelled items
  (`{ id, category, split, lineage, setting?, arcShape?, stance? }`) to produce a
  deterministic, measured mixed export. They do not modify records.

---

## 14. Test and verification contract

`dataset/test/creative-roleplay.test.ts` (18 tests) covers: card determinism,
strict card validation, batch diversity and fail-closed diversity, setting surface
differentiation, stance/temperament coverage, arc/depth well-formedness, prompt
no-answer contract, the never-supervise-player regression (160 plans × 4 modes),
target selection, full-context preservation, derivative lineage/split guarantees,
the 80/10/10 policy (independently recomputed), fail-closed malformed
transcripts, player-impersonation rejection, meta/grading/mechanical refusal, the
review round-trip, category/mix/coverage measurement, and the legacy-reskin
exclusion (whole-phrase anchors for the eight cast names, six legacy places and
four legacy guilds; the five legacy objects are **not** in the anchor list, see
section 1).

Run it with:

```bash
npx tsc --noEmit -p dataset/tsconfig.json
/home/mojo/.cache/ms-playwright-go/1.57.0/node --import tsx --test --test-concurrency=1 \
  dataset/test/creative-roleplay.test.ts
```
