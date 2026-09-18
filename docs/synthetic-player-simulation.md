# Synthetic player simulation

Status: design plus the implemented v1 harness (`scripts/synthetic-player-harness.ts`) and the
advertisement-guided v2/v2.1 generation controls (menu union, direct-cell weighting, advertised
and acted coverage accounting, human-likeness report), with a measured SRD 5.1 batch and combat
batch. Remaining proposals are marked **in progress** where they are not yet built. Claims are
marked **sourced** (with a link) or **proposed**; proposed numbers are internal design targets,
not measurements. Nothing here enables a lane, writes a fixture, or re-weights a promotion
record. External links checked 2026-09-17; audit measured 2026-09-18.

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

## Measured coverage audit (2026-09-18)

The first five batches (22 runs, 98 requested turns, 94 with a recorded L2 decision) were audited
against what the server **actually advertised** to the lane — `system_one_decisions_v1.request_json`,
`state.candidates[]`, the cap-limited union the lane reasons over — rather than what the harness
targeted. The result changes the generation strategy.

| Family | Targeted | Family advertised | Lane picked that family |
| --- | ---: | ---: | ---: |
| commerce | 17 | **0** | 0 |
| rest | 12 | 2 | 1 |
| travel | 10 | **0** | 0 |
| power | 10 | 9 | 1 |
| progression | 9 | **0** | 0 |
| combat power | 9 | **0** | 0 |
| combat consumable | 8 | **0** | 0 |
| SRD check | 8 | 8 | 2 |
| quest lifecycle | 7 | 7 | 2 |
| quest objective | 6 | 2 | 0 |
| inventory | 2 | 2 | 0 |
| **Total** | **98** | **30 of 94** | **6** |

The lane deferred on **88 of 94** turns. The design's coverage matrix recorded 52 of 77 cells as
non-zero, but that counter counts a *declared target*, not an advertised or acted state, so it
overstates family coverage. Two root causes, both measured:

1. **World capability gap.** The demo world the batches ran against (`.velvet/emberwake-reach-run2`)
   has **0 locations, 0 connections, 0 shop definitions, 0 travel destinations, 0 NPCs** — travel
   and commerce are anatomically impossible there; no declaration can advertise them. The seeded
   Baie-Comeau worlds carry 17 locations, 22 connections, 13 NPCs, 1 shop definition and 1 travel
   destination, and are the right coverage substrate.
2. **Target-blind generation.** The generator saw persona, transcript and sheet, but never the
   advertised menu, so a turn aimed at a family the current state does not offer is a guaranteed
   deferral. Only 30 of 94 targeted turns even had the family advertised; the remaining 64 spent a
   coverage slot on a state the world could not produce.

**Measured world capability (probes, 2026-09-18).** Family coverage is a property of the world,
not just the harness:

| World | Advertised families observed | Structures / notes |
| --- | --- | --- |
| `.velvet/emberwake-reach-run2` (canary) | SRD check, power, quest lifecycle, inventory, quest objective (partial), rest (conditional on spent resources) | 0 locations, 0 connections, 0 shops, 0 travel destinations, 0 NPCs — travel and commerce are impossible here |
| `.velvet/synth-baie-comeau-2` (fresh seed, current schema) | travel, inventory, quest lifecycle, quest objective | 17 locations, 23 connections, 13 NPCs, 1 shop, 2 encounters; `velvet:mechanics-starter` content, so no SRD check or power families; rest did **not** advertise at health 11/12 |
| `.velvet/synth-srd-1` (reviewed SRD adventure, current schema) | SRD check (24 rows from one check-flavored declaration), travel, inventory, power, quest lifecycle, quest objective, rest (once the actor is wounded and has a hit die) | 3 locations, 2 connections, 1 NPC, SRD fighter with hit dice; goblin encounter available but not started; `srd-5.1:starter` pinned |
| `.velvet/synth-srd-2` (reviewed SRD adventure, active goblin encounter) | combat power (the combat menu narrows to combat families while the encounter is active) | same reviewed world with the goblin ambush **active**; materialized with a 2020 clock so live writes stay monotonic — the fixture's default 2036 clock makes every post-materialization write fail the encounter immutability guard |

The worlds are complementary and the primary/secondary split follows the user's SRD 5.1 focus:
`.velvet/synth-srd-1` is the primary synthetic arm (SRD checks, powers, rest, inventory, quests,
travel, plus the goblin encounter for combat families), while `.velvet/synth-baie-comeau-2`
supplies the platform-mechanics minority (travel, commerce, quest lifecycle, quest objective) that
the SRD world cannot. Combat families still need an encounter-active state in either world.

## Generation strategy v2: advertisement-guided play (in progress)

The fix is to close the loop between what the world offers and what the generator writes, and to
account for coverage honestly. The v1 harness already reads the bootstrap, follows the normal
gameplay loop, and tags sessions; v2 adds:

1. **World capability matrix.** Before a batch, classify each family for the run's world as
   `advertisable`, `conditional`, or `impossible` from world content (locations, connections, shop
   bindings, travel destinations, NPC presence, encounter support). Family-coverage turns are spent
   only on `advertisable` families; `impossible` families are exercised solely as deliberate
   off-menu probes, and the capability matrix is pinned in the run manifest. The manifest also
   carries the campaign's declared **content profile** (`srd-5.1`, `velvet-starter`, …), so every
   corpus and evaluation result can name the rules content that produced it.
2. **Advertisement reading.** After each submitted turn, the harness reads that turn's lane decision
   (read-only SQLite at the run's `VELVET_DATA_DIR`) and records the advertised kinds and
   player-facing labels, the lane band, and the selected kind. This is scheduler feedback; the
   persona generator receives only the labels — the same menu a player reads in narration — never
   candidate ids, digests, or revisions.
3. **Probe, align, verify.** When the advertised menu is unknown (first turn, or after state
   changed), the planned declaration is the probe. Otherwise the generator is told the advertised
   labels and must write a natural declaration that clearly invokes one of them — except for cells
   whose failure mode is deliberately off-menu (`unsupported`, `unadvertised`, some `ambiguous`),
   which must avoid them. Verification happens after the turn: advertised family set, band, pick.
4. **Acted coverage accounting.** Manifests carry four matrices — planned (cells reserved),
   declared (turns executed), advertised (the turn's family was on the menu), acted (the lane picked
   a row of that family). A menu cell counts as covered only when acted; off-menu modes count on
   declared intent. The summary prints advertised and acted shares, so a batch's yield is visible
   without re-deriving it from the decision log.
5. **Re-targeting.** When the next planned cell's family is not advertised but a remaining cell's
   family is, the scheduler swaps to the reachable cell and records the swap in the manifest, so a
   session fills real coverage instead of deferring on repeat.
6. **Deliberate off-target share.** A pre-registered fraction (proposed 20%) of turns stays aimed
   off-menu even when the family is advertised; those negatives are the tail the gate needs and are
   never counted as family coverage.
7. **World rotation.** One world per run, pinned; campaigns used for a family's coverage must list
   that family as advertisable in their capability row, and the corpus records which world each case
   came from. The lane's home canary world stays the integration target; coverage batches run on
   capable worlds.

Proposed yield targets for a menu-cell batch: advertised share ≥ 0.7, acted share ≥ 0.5 (the rest
honest deferrals worth reviewing), off-menu share 15–25%. These are design targets, not
measurements; the first v2 batch exists to replace them with numbers.

### First measured v2 batch (2026-09-18)

Three personas (explorer, rules-tinkerer, achiever) × 4 turns, run against `.velvet/synth-srd-1`
("The Last Harbor Light", `srd-5.1:starter`), with the advertisement reader, re-targeting and
prompt alignment all live:

| Measure | v1 (22 runs) | first v2 batch (3 runs) |
| --- | ---: | ---: |
| Turns with a decision | 94 | 12 |
| Targeted family advertised | 30 (32%) | **10 (83%)** |
| Lane band `act` | 6 (6%) | **5 (42%)** |
| Picked the target family | 6 (6%) | **4 (33%)** |
| Target swaps | — | 6 |

The swaps moved six unreachable cells (commerce ×3, combat consumable, power, quest objective)
onto families the world actually advertised (quest lifecycle ×2, quest objective ×2, inventory,
power); no swap consumed a turn on a guaranteed deferral. Acts landed on power, quest lifecycle,
quest objective ×2 and travel. The advertised menus across all turns were travel, SRD check,
inventory, power, quest lifecycle and quest objective — six families in a 12-turn session, versus
four in the entire v1 run. The one lane-origin SRD check execution in the world was the manual
probe; batch acts landed on families that are advisory by design (the active orchestrator commits
checks and rests only).

Two tuning notes from the run, both expected but worth recording: `srd-check` is
declaration-driven (a check-flavored declaration advertised 24 check rows, the batch's generic
declarations fewer), so a future scheduler pass should keep the recent union of advertised
families rather than only the previous turn's; and the weighted matrix spends only about one in
seven menu cells on `direct`, which gated the acted count more than the lane did — `direct` cells
should be weighted up when the goal is harvest volume rather than matrix balance.

### v2.1 generation controls and the first combat batch (2026-09-18)

The two tuning notes above are implemented, plus the diversity signal the SRD reviewer flagged:

- **Recent-menu union** (`--menu-window`, default 3): re-target reachability uses the deduped union
  of the last N advertised menus; the generator prompt still sees only the latest snapshot's
  labels, so options stay current. `--menu-window 1` reproduces the previous behavior exactly.
- **Direct-cell weighting** (`--direct-weight`, default 1, floor 0.1): multiplies the scheduler
  weight of `direct` cells for harvest volume. The RNG draw sequence is unchanged at 1.
- **Human-likeness report**: every manifest now computes the proxies in
  [Human-likeness checks](#human-likeness-checks) — word-count median/p90/low/long shares,
  burstiness, distinct-1/2, near-duplicate share (max trigram Jaccard ≥ 0.7 against earlier
  turns), verbatim reuse, and OOC/question/noise/mixed-intent/off-menu shares — and prints them in
  the run summary. The reviewer's near-duplicate `tally my pack` / `waystone sword-forms` motifs
  now have a measured signal instead of a note.
- **First combat batch.** Two runs × 4 turns against `.velvet/synth-srd-2` with the goblin ambush
  active: run a advertised 4/4 and acted 2/4, both matching the only advertised combat power
  (`Second Wind`, signals 0.96 and 0.78); run b produced no L2 battery at all (rest declarations
  and one rejected combat declaration) and the harness reported 0/4 honestly rather than
  attributing coverage. Three turns aborted (`decision-rejected`, `awaiting-confirmation`) as game
  outcomes, not harness failures. The two combat-power acts were confirmed by review and merged
  with the new harvest CLI `--merge-fixture` flag (corpus 94; 93 agent-reviewed + 1 human).
  Human-likeness on the small batch: near-duplicate share 0, distinct-1 0.67–0.68, burstiness
  0.27–0.37.

### v2.2 realism controls, focus targeting, and the SRD combat gap (2026-09-18)

- **Persona word budgets** (`WORD_BUDGET_BY_VERBOSITY`): terse 4–12, plain 8–20, precise 10–24,
  florid 14–35 words, injected as one prompt line. A historical audit had measured a median
  declaration of 77 words against the design target of 8–18; the first batches after the change
  reported medians of 14–22 words with no long-form collapse.
- **Motif-level repetition**: the human-likeness report gains `topRepeatedPhrases` (lowercased
  4-gram shingles appearing in ≥2 turns, stopwords filtered, ranked and capped) and
  `repeatedPhraseTurns`. The trigger-granularity check had measured 0.00 near-duplicate share even
  where a human reviewer saw repeated *themes*; the new signal caught `"take a short rest" x2` in
  its first batch.
- **Focus targeting** (`--focus-family` + `--focus-mode`): forces the first turn of each run onto
  one exact coverage cell (for example `combat-consumable/direct`), recording the same
  `plannedTarget`/`targetSwaps` evidence as an advertisement-driven swap.
- **SRD combat gap found and open.** The reviewed world's goblin wins initiative (12 vs 7). When an
  enemy is the current combatant, `buildPlans.ts` intentionally returns no caller legal actions
  ("enemy turns are intentionally not caller-planned in D&D"), and the adventure-turn path never
  invokes `executeCombatEnemyTurn` (it is referenced only by the combat routes and repo). The
  deterministic audience fallback then spends three failed attempts and writes
  `terminalState:"failed"` on the player's turn; the direct enemy-turn route rejects with
  `RPG_ENEMY_TURN_CONFLICT`, and `end-commands` rejects while the enemy is current, so the encounter
  wedges (`.velvet/synth-srd-2` was in exactly this state). **Fixed and gated:** the deterministic
  fallback now detects an enemy-owned D&D turn and invokes `repository.executeCombatEnemyTurn` (the
  authoritative server-authored lane) instead of writing a failed terminal, with a focused
  regression test (`server/test/reviewed-adventure-enemy-turn.test.ts`) and the server quick lane
  green (286 files, 2921 passed). Remaining, recorded uncertainties: the live encounter also needed
  a data repair because world surgery had desynced actor health from the combatant's hit points, and
  the fallback resolves the enemy turn without re-running the player's declaration against the
  advanced state (a larger stream-flow change). The misleading clock-order message on
  `POST /encounters/:id/start-commands` remains open polish.
- **Second combat gap (open): lane composition is inconsistent in combat.** Post-fix live
  verification confirmed the enemy turn now commits (fighter HP 12→6 with the health mirror
  synchronized, combat receipts advanced), so the wedge is gone. But a follow-up batch and manual
  probes in the route-created fight recorded **zero** `adventure-selection` decisions on both
  enemy-owned and player-owned turns (only `memory-reranking`), while the fixture-created first
  fight had composed `exact_combat_power.select` acts under the same server settings and lane
  modes. Combat-family lane coverage is therefore inconsistent and needs a composition-path
  investigation before combat corpora can be harvested; the world and run manifests
  (`.velvet/synth-srd-2`, `/tmp/opencode/synth-srd2-batch5`) are kept as evidence.

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

- Synthetic runs mint a literal tag, `synthetic-player.<personaId>.<seed>.<sessionIndex>`
  (dots are legal in resource IDs). As implemented, the tag appears in the harness's generated
  contracts and run manifests; it is **not** written to `system_one_decisions_v1`, because the
  turn API takes the real room session id and the decision log stores that unchanged. The
  manifest plus the run's `dataDir` are therefore the authoritative synthetic record: the manifest
  lists every turn id the run submitted, and a decision is synthetic when its turn id appears in a
  manifest. This is what the harvest tooling should join on, not a session-id prefix.
- The tag is deliberately **orthogonal to harvest provenance**. `review-annotated`,
  `agent-review`, and `provider-disagreement` say *who labelled*; the manifest says *where the
  state came from*. A synthetic decision can be human-confirmed and still be synthetic.
- Proposed harvest changes: `HarvestProposal` gains `synthetic: boolean` (derived by matching the
  decision's turn id against the manifests for the same `dataDir`/campaign) and proposal identity
  includes it, so a synthetic case can never alias a live one with the same state. The CLI gains
  `--exclude-synthetic`, `--synthetic-only`, and a summary split; the default includes synthetic
  proposals but marks them.
- A world used only for synthetic play (its own `VELVET_DATA_DIR`, recorded in every manifest) is
  synthetic by construction even before the manifest join; the join remains what makes a claim
  auditable.

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
synthetic harness (run tags in contracts + manifests)
  -> shadow lanes record decisions in system_one_decisions_v1 (real room session id; turn ids join to manifests)
  -> harvest CLI: default include-and-mark | --exclude-synthetic | --synthetic-only
  -> proposals carry synthetic: true + source manifest digest; human review is unchanged
  -> --write-fixture writes them flagged synthetic: true; lane evals may merge for coverage
  -> promotion records never re-derive from synthetic-derived labels
```

- **Decisions.** No new table and no schema change: the log already stores `campaignId`,
  `sessionId`, and `turnId`, and stays immutable. The manifest (which records every submitted turn
  id, plus the run's `dataDir`) is the only addition the synthetic flag needs; the session id in
  the log stays the real room id and is not the synthetic marker.
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
