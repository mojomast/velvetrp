# Harness Wars: The Shattered Concord

## Campaign Identity

- Campaign ID: `c1ac03bf-0525-4509-958a-020fdb130ef2`
- Lifecycle: published
- Rules: `srd-5.1:rules:starter-v1`
- Content: `srd-5.1:starter@1.3.0+e58091f23117`
- Opening location: The Whisper Relay
- Generation model: `deepseek/deepseek-v4-flash`
- Accepted canon: 84 artifacts from 19 applied drafts
- Visibility: 78 public artifacts and 6 GM-only artifacts
- Player-facing deliveries: none published
- Player characters and rooms: none created

SQLite integrity is `ok` and the database has no foreign-key violations.

## Campaign Premise

The Veridian Concord and Obsidian Court once maintained a fragile agreement over
word-oracles and the harnesses used to interpret them. That peace is collapsing.
The Whisper Blight now corrupts instructions, memories, and testimony as it spreads
from the Echo Vault. New harness-wielders must determine whether the corruption is
an accident, sabotage, or a consequence of the institutions built to contain it.
They can restore the Concord, replace it, or allow the Harness Wars to begin.

The campaign opens at the Whisper Relay. A courier arrives with a sealed plea for
help while the relay itself begins returning contradictory memories.

## World

The six-location region is connected by seven directed routes.

- **The Whisper Relay:** A frontier network outpost, workshop, and last safe haven.
  It is the authoritative campaign opening.
- **Veridia, the Archive-City:** Neutral treaty city built around floating archives
  and the Hymnal of the Spheres.
- **The Veridian Enclave:** Public forums and open word-oracles watched by rival
  agents.
- **The Obsidian Sanctum:** A black-crystal underground court where dangerous
  oracles and memories are sealed.
- **The Iron Standard Arena:** The Benchmark Guild's coliseum for legally binding
  harness trials.
- **The Echo Vault:** A corrupted memory archive leaking mutually incompatible
  versions of historical events.

Routes connect the Relay to Veridia, the Enclave, and the Sanctum; Veridia to the
Arena and Vault; the rival enclaves to each other; and the Arena to the Vault.

## Factions

- **Veridian Concord:** Advocates open access to oracle knowledge but is divided
  between unrestricted disclosure and safer curation.
- **Obsidian Court:** Protects stability through controlled memory and is divided
  over destruction, sealing, and selective release.
- **Iron Standard Guild:** Controls benchmark trials and legal recognition while
  resisting pressure to bias evaluations.
- **Echo Archive:** Preserves contradictory records because context changes meaning;
  its custodians disagree over political neutrality.
- **Unbound Harness Circle:** Independent harness users split among isolationists,
  activists, mercenaries, and principled noncombatants.

## Characters

- **Elsa Vorn:** Welcoming Relay host and opening patron who values free choice.
- **Kira Molt:** Inventive harness artisan willing to work across faction lines.
- **Darius Fen:** Charismatic Concord radical who treats total transparency as a
  moral imperative.
- **Selene Void:** Obsidian guardian who regards uncontrolled revelation as a civic
  threat.
- **Mira Althanne:** Archivist haunted by mutually incompatible memories.
- **Gorim Steelmark:** Benchmark adjudicator trying to keep trials legitimate.
- **Holden Wisp:** Blight-exposed former oracle-reader who speaks contradictory
  truths.
- **Lyra Thorne:** Conflicted Court enforcer questioning the wisdom of permanent
  seals.

The NPCs have public descriptions but their persisted private-goal fields are empty.
Their generated placement intents remain pending until a campaign room exists.

## Story Arcs

1. **The Whisper Blight Investigation:** Follow contradictory relay evidence from
   the frontier to the Echo Vault and Veridian Enclave.
2. **The Whisper Trial:** Survive rhetorical, memory, and combat evaluations while
   discovering that benchmark results are being manipulated.
3. **The Fractured Accord:** Expose or exploit sabotage within both rival powers and
   decide whether peace should be restored or replaced.

The story graph contains seven nodes and six relationships. Its opening chain runs
from the call for aid through the Vault approach to the Enclave council. Its war
component branches from the Whisper Trial through Coalition betrayal and the Echo
Vault toward Court sabotage. The two components are thematically connected but lack
one explicit persisted relationship edge.

## Quests And Clues

Five quests provide 15 objectives and five custom rewards:

- Investigate the Whisper Relay disturbance.
- Negotiate at the Veridian Enclave.
- Recover evidence from the Echo Vault.
- Repair and test a harness at the Iron Standard Arena.
- Infiltrate the Obsidian Sanctum and realign its central ward.

Eight public clues include a courier's plea, corrupted memory fragment, torn treaty
page, manipulated harness log, Vault glyph, Concord memo, and Court dispatch. Some
politically sensitive documents are currently public and should be reviewed before
delivery to players.

## Encounters And Creatures

Six accepted encounter plans cover a benchmark trial, corrupted Vault expedition,
negotiation under sabotage, Whisper Relay defense, a nonlethal oracle confrontation,
and a separate harmonic noncombat resolution. These are plans, not instantiated
combat encounters.

Four GM-only creature concepts are bound to exact starter templates:

- Context Echo to Bandit
- Instruction Wisp to Goblin
- Benchmark Mimic to Wolf
- Archive Sentinel to Training Dummy

These bindings are executable proxies rather than close fictional matches. The
accepted encounter plans do not yet reference the monster concepts or NPC cast.

## Lore, Items, And Table Material

Six lore entries define the Shattered Concord, oracle creation myths, harness vows,
benchmark law, context-archive customs, and competing explanations of the Blight.
The archive customs and true Blight analysis are GM-only.

Four quest items exist: Concord Seal, Context Shard, Harness Tuning Key, and Benchmark
Writ. Three are intentionally inert. The Context Shard is catalog-bound to a light
crossbow, which is mechanically valid but editorially weak and should be revised in
a future additive pass.

Three handouts and five scene prompts are accepted but unpublished. They include the
Concord primer, benchmark summons, damaged archive transcript, Relay arrival, patron
meeting, trial, corrupted archive, and rival-faction choice.

## Suggested Opening Session

This is a synthesis from accepted canon, not one persisted artifact.

1. Introduce Elsa and Kira at the Whisper Relay.
2. Deliver the courier's plea as the inciting clue.
3. Let players inspect the unstable relay and interview three witnesses.
4. Reveal the damaged harness log or memory echo.
5. Escalate into the Relay Defense encounter, with a noncombat repair route.
6. End with three political paths: Veridia, the open Enclave, or the sealed Sanctum.

## Hydration Improvements

- Provider JSON schemas now include only requested section fields and normalize to
  the full local contract after strict provider validation.
- The frontend wizard supports a five-stage reviewed hydration mode with one call at
  a time, explicit application, reload recovery, and named accepted context.
- `scripts/hydrate-campaign.ts` provides resumable API-only hydration from a recipe.
- The CLI writes an atomic ledger, uses deterministic idempotency keys, reconciles
  failures, stops on uncertain outcomes, and never prints provider credentials.
- After two confirmed failures, requested counts are split recursively. A five-item
  request becomes two- and three-item children. Unit failures become durable deficits.
- Sparse successful drafts are applied once and followed by additive fill jobs.
- Recipe `expandFrom` selectors use actual public keys from prior applied jobs,
  including split/fill descendants. GM-only keys are excluded.
- Same-campaign generation/application defaults to serial execution because every
  applied draft advances the content revision and stales sibling drafts.

## Concurrency Findings

A paid disposable probe made 20 small handout requests over two waves per width.

| Width | Structurally staged | Exact requested-key adherence |
|---:|---:|---:|
| 1 | 2/2 | 0/2 |
| 2 | 4/4 | 1/4 |
| 3 | 5/6 | 2/6 |
| 4 | 8/8 | 3/8 |

Width four achieved 8/8 structural staging in this small observation, but this is
not enough evidence to call it reliable. Overall exact-key instruction adherence was
6/20, showing a model-quality issue independent of concurrency. Production hydration
for one campaign therefore defaults to concurrency one. Wider same-campaign staging
requires explicit authorization because serialized application can force paid stale
regeneration.

## Remaining Editorial Work

- Connect the two story components with an additive relationship.
- Move secret NPC facts out of public descriptions and add private goals.
- Link encounters to the accepted cast and creature concepts.
- Replace weak mechanical proxy bindings or leave those concepts inert.
- Add discoveries, hazards, hooks, and lore relationship links.
- Review politically sensitive clues before player publication.
- Create player characters and a room before activation.
