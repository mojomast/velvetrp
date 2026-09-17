# Synthetic player simulation

Status: research and design, nothing implemented. This document proposes a persona-driven
synthetic-play harness that generates error-rich declarations through the existing HTTP
adventure-turn API so the [System One harvest loop](system-one-harvest-loop.md) can accumulate
coverage before the product has real players. Claims are marked **sourced** (with a link) or
**proposed**; proposed numbers are internal design targets, not measurements. Nothing here
enables a lane, writes a fixture, or re-weights a promotion record. External links checked 2026-09-17.

## Why synthetic players

The harvest loop's bottleneck is material, not machinery: the frozen corpora have almost no acted
errors, the [first measured loop pass](system-one-harvest-loop.md#first-measured-loop-pass)
produced 14 proposals from the demo shadow log, and human labelling is the slow path. Synthetic
play manufactures live-shaped states in volume, aimed at what traffic rarely reaches: coverage of
mechanics families and failure modes the live log rarely reaches (unadvertised actions,
two-intent turns, literal readings like "drop my longsword" binding to `unequip`);
natural-language messiness (typos, abbreviations, self-corrections, OOC asides, low-effort turns);
reproducible, auditable sessions (seeded personas, manifests, idempotency keys); and a
pre-registered error mix whose per-turn intent label is a debugging aid, never a verdict.

What they cannot provide:

- **Evidence that real players behave this way.** [Seshadri et al.
  2026](https://aclanthology.org/2026.acl-long.2192/) (*Lost in Simulation*) measured up to a
  9-point success swing from the user-model choice alone, plus systematic over-politeness and
  shifted failure attribution; [Argyle et al. 2023](https://doi.org/10.1017/pan.2023.2) (*Out of
  One, Many*) showed silicon samples track some subpopulations and not others.
- **Population fidelity.** Personas narrow toward stereotyped modes even when each one stays in
  character: [Xiao et al. 2026](https://arxiv.org/abs/2604.24698) (*The Chameleon's Limit*).
- **Record weight.** See [Harvest integration](#harvest-integration-proposed): a synthetic state
  is invented, not observed, so even a human verdict on it is weaker evidence than live traffic.

## What "human-like" means here

A concrete, product-specific checklist (**proposed**). Each behavior exists because it stresses a
documented lane failure mode; none of it is a claim about measured player behaviour. A run that
produces only fluent, cooperative, fully specified turns has failed the harness before any lane
sees it: the failure modes below are the product.

| Behavior | Example | What it stresses |
| --- | --- | --- |
| Multi-clause declarations | "I shoulder the door, and if it gives, I go for the ledger." | L2 picks one candidate from a compound sentence |
| Mixed intentions | "We make camp and I ask Bryn about the mill." | two-intent deferral; multi-family traps |
| Self-corrections | "I take the north road — actually no, the harbor." | last-intent binding, ambiguity |
| Typos and abbreviations | "i try to pry open the gate w/ my crowbar" | literal reading; label robustness |
| OOC / meta questions | "can I still make it back before dark?" | small-talk and question deferral |
| References to earlier events | "like we planned at the inn, I pay the ferryman." | transcript grounding; ambiguous referents |
| Emotional / roleplay framing | "Aster is bleeding out — I'm not losing her." | narration-vs-mechanics separation |
| Short low-effort turns | "rest" / "follow the road" | sparse declarations; low-information matches |
| Unsupported actions | "I drop my longsword." | the live `unequip` literal-reading edge |
| Variable pacing | long roleplay turns alternating with one-word ones | burstiness; threshold stability |
| Confirmation behavior | sometimes approve, sometimes reject | confirmation-path coverage |

## Method survey

**Sourced** findings with an explicit applicability note per method (**proposed**).

| Domain | Method (source) | Finding | Applicability here |
| --- | --- | --- | --- |
| Agent simulation | [Park et al. 2023](https://arxiv.org/abs/2304.03442), *Generative Agents* (UIST) | memory/reflection agents read as believable but fabricate embellishments and inherit formal speech | keep explicit transcript memory; never trust the generator's account of what it did |
| Persona synthesis | [Wang et al. 2024](https://arxiv.org/abs/2406.20094), *PersonaHub* | persona conditioning broadens synthesis at scale; authors flag misuse risk | small internal versioned persona library; personas buy coverage, not population claims |
| User simulation | [Bernard & Balog 2024](https://github.com/iai-group/ictir2024-usersim-objectives), user-simulation objectives | training and evaluation simulators optimize different things; one is not the other | this is an evaluation-coverage simulator and must not be the thing optimized against |
| User simulation | [Yao et al. 2024](https://arxiv.org/abs/2406.12045), *τ-bench* | LLM user simulators with state grading; the user model changes measured success | reuse seeded sessions and state reconciliation; do not reuse its scoring as our label |
| User simulation | [Chopra et al. 2026](https://arxiv.org/abs/2605.12894), *Beyond Cooperative Simulators* | default simulators are cooperative and homogeneous; evolved policies raised blinded human-judged realism from 46.5% to 80.4% | archetypes as structured behavioral policies (patience, disclosure, pacing), not adjectives |
| Failure modes | [Bian et al. 2025](https://arxiv.org/abs/2510.21180), *Utopian Illusion*; [Kamoi et al. 2026](https://arxiv.org/abs/2603.17094), *CoCoEval* | LLM groups overproduce agreement and positivity; simulations underproduce misunderstandings, interruptions, and disagreement, and prompting/SFT control rates unreliably | include disagreeable, bored, impatient, and wrong-goal personas; treat inconsistency rate as a first-class proxy |
| Failure modes | [Luz de Araujo et al. 2025](https://arxiv.org/abs/2512.12775), *Persistent Personas?*; [Yu et al. 2026](https://arxiv.org/abs/2608.12253), *Simulator Collapse* | persona fidelity degrades over long goal-oriented dialogues and models revert to assistant baseline; policies trained against one mode-collapsed simulator fail on unseen simulators and humans | cap session length, re-inject persona every turn, measure drift, and rotate generator models |
| Population bias | [Xiao et al. 2026](https://arxiv.org/abs/2604.24698), *The Chameleon's Limit*; [Heath & Alexander 2026](https://arxiv.org/abs/2607.28550) | persona collapse into stereotyped modes; synthetic distributions have unrealistically low variance | review personas as a population and judge variance and tails, not just means |
| Role-play | [Sycophancy in role-play (ACL 2026)](https://aclanthology.org/2026.acl-long.1421.pdf); [RoleBreak (COLING 2025)](https://aclanthology.org/2025.coling-main.494.pdf) | persona agreeableness predicts sycophancy; role-query conflict causes character hallucination that refusal defenses fail to fix | expect agreeable personas to under-report failure; give personas a bounded knowledge state and a way to stay ignorant instead of refusing |
| Human detection | [Is Human-Like Text Liked by Humans? (ACL 2026)](https://aclanthology.org/2026.acl-long.639.pdf) | experts detected machine text at 87.6% average, via concreteness, cultural nuance, and diversity | short game declarations are a weak detection signal; a Turing-style check on them proves little |
| Human-likeness | [Stylometric footprint study 2026](https://arxiv.org/pdf/2608.27855); [Tarım & Onan 2025](https://arxiv.org/abs/2507.10475) | entropy, lexical diversity, and burstiness are the most stable separators, but no single metric is reliable | compute a checklist of pre-registered signals as red flags, never one humanness gate |
| Player modeling | [Bakkes et al. 2012](https://www.spronck.net/pubs/BakkesEC2011.pdf); [Holmgård et al. 2014](http://julian.togelius.com/Holmgard2014Personas.pdf) | personas and playtrace-trained clones predict human play style comparably; agreement ratios measure imitation | designer-defined archetypes are legitimate without a human corpus; agreement with real players stays unknown |
| Player modeling | [Ingram et al. 2023](https://doi.org/10.1609/aiide.v19i1.27521); [Information 2025](https://doi.org/10.3390/info16040329) | clustering plus behavioral cloning reproduces play styles and navigation at scale | treat the persona taxonomy as provisional until a human corpus can re-derive it |
| Player modeling | [Bartle 1996](https://mud.co.uk/richard/hcds.htm); [SMART 2025](https://arxiv.org/html/2512.12706v1) | player-type motivations; reward-only test agents collapse onto the happy path | the coverage matrix below is the structural half of playtesting |
| Synthetic limits | [Shumailov et al. 2024](https://www.nature.com/articles/s41586-024-07566-y), *Model collapse* (Nature); [Alemohammad et al. 2023](https://arxiv.org/abs/2307.01850), *MAD* | recursive synthetic training erases distribution tails; quality or diversity degrades each generation without fresh real data | never train or promote on synthetic-only evidence; keep synthetic cases beside live ones |
| Synthetic limits | [Gerstgrasser et al. 2024](https://arxiv.org/abs/2410.16713), *Collapse or Thrive?*; [consumer-research review 2024](https://doi.org/10.1002/mar.21982) | collapse is a training-workflow property; silicon samples are promising for pretesting, unsafe as a main study | synthetic volume is bounded by the live corpus it complements; upstream coverage, not downstream proof |

## Harness design (proposed)

### Persona archetypes

Five versioned archetypes; the columns are the persona contract, `knowledgeBoundary` is fixed at
`sheet-and-transcript-only` (never hidden ids, GM state, or candidate digests), and
`patience`/`confirmationPolicy` decide how a failed action or proposed confirmation is handled.

| Persona | Goals | Mechanics bias | Verbosity | Typo/abbrev | Patience | OOC | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Achiever | advance quests, level, gear | quest lifecycle/objective, progression, commerce | plain | low | high | low | always confirms progression |
| Explorer | reach, inspect, discover | travel, SRD checks, unadvertised destinations | florid | low | medium | low | references earlier places |
| Socialiser | talk, relate, ask | small talk, NPC asides, questions | plain | medium | low | high | ignores advertised mechanics |
| Rules-tinkerer | test boundaries | inventory, rest, power, consumables, multi-family | precise | low | high | medium | literal readings, two-intent turns |
| Impatient | finish fast | travel, rest, attacks | terse | high | low | medium | short turns, self-corrections |

### Per-turn generation contract

The generator writes one strict JSON object per turn; the harness validates it, applies the
declared surface noise deterministically in code from the turn seed, and records the contract
beside the transcript. The model chooses content and declares intent; it never asserts what
perturbations were applied.

```jsonc
{
  "runId": "run-20260917-01", "sessionId": "synthetic-player.explorer.7c1f.a",
  "turnIndex": 4, "personaId": "explorer.v1", "seed": "7c1f-0004", "effort": "low",
  "declaration": "i want a closer look at the ferry wreck before the fog comes in",
  "ooc": "can I still make it back before nightfall?",
  "intended": { "family": "exact_actor_travel.select", "failureMode": "ambiguous" },
  "noise": ["lowercase", "abbreviation"],           // applied and verified by the harness
  "references": ["turn-2-ferry-wreck"]              // transcript anchors the turn draws on
}
```

Prompt sketch:

```text
Persona layer: You are role-playing one player in a solo/duo text RPG. You are not the narrator,
the game master, or an assistant. Persona: <archetype>, goals: <goals>. You know only what the
transcript and your character sheet show. State intentions in plain player language; never explain
rules, never propose dice results or mechanics, never mention being a model. Output one strict
JSON turn contract.
Turn layer: Transcript: <completed declarations + latest narrations, oldest first>
Sheet summary: <public labels only>. Target this turn: <family> / <failureMode>, effort
<low|high>. Write the next declaration and optional OOC aside. Do not name hidden ids. Allowed
surface noise: <named perturbations>. Do not resolve outcomes.
```

### Seeded sessions against the turn API

- Run against the real routes in the [API reference](api.md#adventure-turns-and-generation-drafts-m211):
  read the play bootstrap for `expectedRevision`, `POST /api/rpg/v1/adventure-turns/stream`,
  consume SSE, then read the transcript, following the
  [normal gameplay loop](interactive-gameplay-agent-instructions.md#normal-gameplay-loop).
- Idempotency keys derive from the run (`synth.<runId>.<turnIndex>`). No automatic retry on an
  ambiguous failure; reconcile with the turn GET or the exact initial-turn locator, then stop.
  Confirmation is coverage: the persona policy approves, rejects, or stalls exactly as the profile
  says, and the contract records which.
- The harness does not call Jev itself. Shadow decisions are recorded only when the corresponding
  lane is in `shadow`, and the harness never bypasses lane settings, budgets, or fallbacks.
- Use a disposable `VELVET_DATA_DIR` seeded by the Baie-Comeau provider-free skill or a dedicated
  synthetic world; never run against a database holding real play.

### Coverage matrix

Rows are mechanics families (the shadow lane's projected kinds); columns are failure classes;
cells are target declaration counts per generation campaign. All numbers **proposed**.

| Family (tool kind) | direct | ambiguous | multi-family | unsupported | unadvertised | small-talk/OOC | literal-edge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| travel (`exact_actor_travel.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| SRD check (`exact_srd_check.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| inventory (`exact_inventory_action.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| commerce (`exact_vendor_commerce.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| power (`exact_power_use.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| rest (`exact_rest.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| combat consumable (`exact_combat_consumable.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| combat power (`exact_combat_power.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| quest lifecycle (`exact_quest_lifecycle.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| quest objective (`exact_quest_objective.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| progression (`exact_progression_apply.select`) | 4 | 4 | 4 | 4 | 4 | 4 | 4 |

- **308 minimum declarations** per campaign, at least three personas per cell, at least one duo
  session for social and confirmation coverage; fold `no-candidates`, `question`, and
  `hypothetical` into `unsupported`/`small-talk`, keeping at least one no-candidate turn per family.
- Reserve a never-tuned holdout slice (for example 20%), as gate v2 reserves one per lane; a tuned
  slice and the holdout must be disjoint. Track cells as a dashboard, not a score.

### Provenance: the `synthetic-player` session tag

- Synthetic sessions mint resource IDs under a literal prefix,
  `synthetic-player.<personaId>.<seed>.<sessionIndex>` (dots are legal in resource IDs). Every
  lane records `session_id` unchanged, so `system_one_decisions_v1` already carries the tag and
  needs no schema change.
- The tag is deliberately **orthogonal to harvest provenance**. `review-annotated`,
  `agent-review`, and `provider-disagreement` say *who labelled*; the tag says *where the state
  came from*. A synthetic decision can be human-confirmed and still be synthetic.
- Proposed harvest changes: `HarvestProposal` gains `synthetic: boolean` (derived from the
  session id) and proposal identity includes it, so a synthetic case can never alias a live one
  with the same state. The CLI gains `--exclude-synthetic`, `--synthetic-only`, and a summary
  split; the default includes synthetic proposals but marks them.
- The prefix is a convention, not an authentication boundary. The run manifest is the
  authoritative record; a prefixed proposal with no matching manifest entry is treated as live
  until reviewed.

### Reproducibility

Each run writes a manifest that is the only reviewable artifact of the session:

```jsonc
{
  "harnessVersion": "synthetic-play-v1", "personaVersion": "personas-v1", "seed": "7c1f",
  "runId": "run-20260917-01", "startedAt": "2026-09-17T15:00:00Z", "gitCommit": "<sha>",
  "generator": { "provider": "openai-compatible", "model": "<pinned>", "temperature": 0.9 },
  "gameProvider": { "model": "<pinned or fake>" },
  "worldSeed": { "campaign": "baie-comeau", "dataDir": "<disposable>" },
  "sessions": [{ "sessionId": "synthetic-player.explorer.7c1f.a", "turns": 18,
                 "promptDigest": "<sha256>", "contractDigest": "<sha256>" }]
}
```

Seeds drive persona sampling, prompt assembly, and every surface perturbation. Re-running a
manifest against the same pinned generator re-issues the same requests and compares recorded
request/contract digests; provider sampling is not assumed bit-identical, so reproducibility
means *auditable replay*, not deterministic regeneration. Persona, prompt, and contract versions
are pinned per run; changing any of them is a new persona version and invalidates comparisons.

## Human-likeness checks

These are **internal plausibility checks, not evidence of real-player behavior**. They catch runs
that are visibly synthetic before review, and all thresholds are **proposed**. Freeze them before
the first run and do not tune them against a judge; tuned to a judge, they stop measuring.

Checklist before a run is accepted: every persona appears and none dominates by more than 2x; one
duo session, one rejected confirmation, and one abandoned goal are present; no declaration names a
hidden id, digest, revision, or provider detail; no assistant leakage ("As an AI",
apology-for-inability, unprompted rules recital); the intended failure-mode mix is present with
`direct` deliberately a minority; and a human spot-review of 20 sampled turns finds no obvious
template repetition.

Measurable proxies, computed offline from the transcript and contracts (**proposed** targets
catch obvious machine register; they do not certify humanness):

| Proxy | Computation | Provisional target |
| --- | --- | --- |
| Declaration length | words per turn | median 8–18; p90 ≥ 25; ≤ 5 words ≥ 15%; ≥ 30 words 10–30% |
| Burstiness | coefficient of variation of turn lengths | ≥ 0.4 |
| Lexical diversity | distinct-1 / distinct-2 over a 30-turn session | ≥ 0.35 and ≥ 0.75 |
| Repetition | verbatim reuse and near-duplicate cosine share | verbatim ≤ 2; near-duplicates < 10% |
| Surface noise | turns with ≥ 1 applied perturbation; typos per 100 words | ≥ 20%; 2–8 |
| OOC / meta | turns with a non-empty aside | 5–15% |
| Questions | turns that ask rather than declare | 10–20% |
| Mixed intent | turns with two intentions | ≥ 15% where the persona allows it |
| References back | turns linking an earlier event | ≥ 1 per session for referencing personas |
| Affect variability | per-turn sentiment sd; negative/frustrated share | sd > 0; negative ≥ 10% |
| Hard-case share | unsupported + unadvertised + literal-edge among mechanics-facing turns | ≥ 15% |
| Guardrail leakage | assistant phrases, refusals, moralizing | 0 |

A Turing-style A/B check (blind judge, mixed human-typed calibration snippets once available) may
report a detection accuracy, but it cannot show distributional fidelity, calibration against real
play, or predictive validity, and repeated optimization against the judge overfits it.

## Harvest integration (proposed)

```
synthetic harness (tagged sessions, manifests)
  -> shadow lanes record decisions in system_one_decisions_v1 (session_id carries the tag)
  -> harvest CLI: default include-and-mark | --exclude-synthetic | --synthetic-only
  -> proposals carry synthetic: true + source manifest digest; human review is unchanged
  -> --write-fixture writes them flagged synthetic: true; lane evals may merge for coverage
  -> promotion records never re-derive from synthetic-derived labels
```

- **Decisions.** No new table and no schema change: the log already stores `campaignId`,
  `sessionId`, and `turnId`, and stays immutable. The tag and manifest are the only additions.
- **Labels.** Annotation rules do not change. A human confirming a synthetic case still produces
  `review-annotated` (or `agent-review`) provenance; the synthetic flag travels beside it and is
  part of the proposal identity.
- **Record weight: none until a human confirms, and weaker even then,** because (a) the state
  distribution is generated, not observed, so accuracy on it is not an unbiased estimate of live
  accuracy; (b) selection is by coverage target, deliberately over-representing interesting cases;
  (c) generator and lane may share a model family, correlating their failures; (d) synthetic-only
  recursion erodes distribution tails ([Shumailov et al.
  2024](https://www.nature.com/articles/s41586-024-07566-y)). The existing agent-review rule is the
  model: synthetic cases may score in a benchmark, but a promotion record re-derives only from the
  human, non-synthetic measurement.
- **Fixtures.** A synthetic-flagged confirmed fixture is a coverage artifact. The lane evaluation
  may merge it for visibility and must report the synthetic share beside accuracy, mirroring how
  the Director record reports its agent-reviewed share.

## Non-claims and risks

- **Mode collapse.** Distinct personas can still collapse into one mode; measure the population
  (coverage, uniformity, complexity), not only per-persona fidelity.
- **Politeness, positivity, over-coherence.** Simulated players are nicer and more consistent than
  people; prompt-only control of inconsistency is unreliable. Manufacture friction.
- **Refusals and moral bias.** Alignment priors suppress selfish, cruel, and hostile personas —
  exactly the range a narrative RPG needs.
- **Over-competent play.** Generators know affordances the declared character does not; the
  sheet-and-transcript-only boundary is a hard prompt and review rule.
- **Persona leakage and drift.** Styles bleed between personas and decay over long sessions;
  re-inject every turn, cap session length, and check cross-persona phrase overlap.
- **Evaluation overfitting.** A lane tuned on a coverage matrix will score well on it; keep the
  holdout, rotate seeds, and never reuse one generation for tuning and reporting.
- **Single-simulator over-reliance.** One generator is one narrow distribution; rotate between
  campaigns and pin one per run. Diversity of the environment is the point.
- **Cost.** One generator call per turn, plus the game path, plus one shadow-lane call per enabled
  lane. Cap turns per run, use the fake provider for shape validation, never retry paid calls.
- **Trust boundary and provenance spoofing.** Generated declarations are untrusted player input:
  same validation, revisions, idempotency, and reconciliation as any client; no special route;
  prompts never contain secrets or hidden state. The session prefix can be copied, so the manifest
  is what makes a claim auditable; mismatches are treated as live and reviewed.
- **The honest headline.** Synthetic play is a coverage tool. It can make the harvest loop busier
  and the corpora harder; it cannot tell us how real players behave, and it must never be cited as
  if it did.
