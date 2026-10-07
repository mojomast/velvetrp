# The Sintermark · A Commons of Fire

An original, provider-free D&D 5.1 sandbox for two exceptionally powerful heroes.
The reviewed world is in `scripts/recipes/sintermark-world.json`; the operator
entry point is `scripts/hydrate-sintermark-campaign.ts`.

## A world worth interfering with

The Longfire is a slowly burning underground carbon seam beneath a cold highland
plateau. Its heat sustains glassworks, ceramic pipes, communal kitchens and
chemosynthetic farms. People steer the seam with ventilation, jack their houses
as the burned ground settles, and argue over whose heat and drinking water count
most. The fire is now turning across the established draught lines.

The five districts are the Slake, Sillworks, Warm Verge, Cisterns and Chimneys.
The six factions have material interests and competing remedies: vent regulation,
industrial consolidation, rescue crews' working conditions, clean water, verge
sovereignty and cultivated thermal ecology. The party can investigate, rescue,
negotiate, fight, or attempt engineering solutions. Authored faction pressures
are scenario guidance, not an automatic faction-turn simulator.

The pointcrawl has return routes and cross-district loops. Public maps and lead
sheets are published in the campaign; private motives, unrevealed story nodes and
GM scenes retain their private visibility. Quests have runnable journal
objectives as well as descriptive concepts. Three encounter scenarios are
accepted, with one salamander encounter prepared for the room. An exploration
grid is grounded to Slake-Head with both heroes placed on walkable cells.

## Two heroes

**Tessel Venn** is a high-elf wizard and former draught surveyor. Tessel treats
every official assertion as a measurement to be checked and carries guilt over
work that once made the Register's figures look reassuring.

**Orra Staple** is a hill-dwarf Life cleric and union rescue forewoman. Her faith
is expressed through maintenance and mutual aid. She can carry people out of a
collapsing gallery, but taking responsibility for everyone also makes compromise
hard for her.

Both use the pinned `srd-5.1:rules:starter-v1` profile and `dnd-5e@1.0.0`
mechanics. Supported progression reaches level 3. Their boosted ability
scores (primary scores 20), 1,000 health, 100 focus and abundant first-/second-level spell slots are
explicit GM overrides. They are deliberately a play sandbox, rather than
balanced SRD character builds.

Working toys include normal profiled weapons, armor, shields, ammunition and
healing potions. Tessel's supported spells include Fire Bolt, Ray of Frost,
Magic Missile, False Life and Shield; Orra has Bless, Cure Wounds and Healing
Word. Availability depends on the execution lane: cantrip attacks, temporary HP,
reactions and healing potions have combat-specific requirements. The published
party guide describes those requirements. Carried magic-item references do not
acquire executable charges or passive bonuses merely by being in inventory.

## Begin playing

Live table: [Open The Sintermark](http://100.72.41.9:18895/#/campaign/9dd02c23-94cc-4e5b-9767-6ee3a887edb5/play/5fa030f1-052e-490e-a82b-c68e5da2bdb6).

The verified world contains 26 public locations, 64 directed routes (60 open
and four closed; one open shortcut is reputation-gated), six factions,
15 NPCs, five runnable quests, three encounter scenarios, 36 lore/rumor entries,
and nine published materials. Two funded shops support commerce. The stored
provider is RouteTok `deepseek-v4-flash`, with Jev enabled in shadow lanes.

At Slake-Head, the paving shifts beneath a leaning bell-post. Workers are carried
up from the galleries, a courier brings contradictory vent readings, and the
wardens and rescue crews disagree about sealing the street.

Three immediate choices:

- Help Orra and the crews stabilize the rescue.
- Have Tessel compare the readings at Gasward Post.
- Hear the Register and the union before choosing a remedy.

Use a single destination declaration such as **“I move to Gasward Post”** for
travel. Indirect destinations resolve over legal connections. If a journey
stops for an event, **“Continue journey”** submits a fresh continuation. Journey
events are durable story interruptions; they do not by themselves apply damage,
grant treasure, or start tactical combat. The route cost is the engine's
abstract 60 minutes per edge.

## Populate and inspect

```bash
npm exec -- tsx scripts/hydrate-sintermark-campaign.ts
npm exec -- tsx scripts/hydrate-sintermark-campaign.ts --validate-only
```

The default target is `.velvet/sintermark-game`. Use `--data-dir` for another
new directory. An existing partial or unrelated world is refused. Hydration uses
reviewed static content, repository commands and zero LLM generation calls.
The report in the target directory records the created campaign, room and actor
IDs without provider credentials.

The catalog is installed before generation and character creation. World content
is accepted in bounded waves; public materials are explicitly published. Wallet
funding and route-event metadata use narrowly scoped isolated-store authoring
seams where normal authoring commands are absent.

### Verification (2026-10-03)

- Hydration CLI typecheck and the two focused integration tests pass. Tests run
  serially; they cover restart identity, protection of unrelated storage, graph
  reachability, private-material withholding, opening map binding and a real
  Magic Missile settlement with replay-safe slot spending.
- The live store passes SQLite integrity and foreign-key checks. Both heroes
  remain at Slake-Head with full resources and no active combat.
- Headless browser checks open the table, indirect-destination route map,
  exploration grid and character sheet, including prepared spells and equipment.
- An isolated copy completed the two-leg trip to Cold Kiln and returned
  provider-assisted dialogue from Old Kest about the competing vent charts.
  Travel narration used the deterministic fallback in that rehearsal.
- Live Jev preflight succeeds and resolves `jev-latest` to `jev-1.13.0`.

## Research basis

- Justin Alexander, [Don't Prep Plots](https://thealexandrian.net/wordpress/4147/roleplaying-games/dont-prep-plots): prepare circumstances and actors' resources rather than mandatory scene sequences.
- Justin Alexander, [Three Clue Rule](https://thealexandrian.net/wordpress/1118/roleplaying-games/three-clue-rule): redundant leads and multiple approaches keep investigations from depending on one check.
- Justin Alexander, [Node-Based Scenario Design](https://thealexandrian.net/wordpress/7949/roleplaying-games/node-based-scenario-design-part-1-the-plotted-approach): connected revelations support different investigation orders.
- [Blades in the Dark faction game](https://bladesinthedark.com/faction-game): inspiration for competing agendas and pressures; this campaign still uses D&D mechanics.
- Wizards of the Coast, [SRD 5.1](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf), CC BY 4.0: rules and catalog references. Attribution is recorded in `NOTICE.md`.
