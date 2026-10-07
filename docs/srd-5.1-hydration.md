# SRD 5.1 hydration · 2026-10-03

Publication: `srd-5.1:starter@1.7.0+a870b31918ec`, using the existing
`srd-5.1:rules:starter-v1` / `dnd-5e@1.0.0` profile. Earlier publications and
their campaign bindings retain their exact identities.

## Reviewed batch

| Additions | Count | Official PDF pages | Boundary |
| --- | ---: | --- | --- |
| Mundane weapons | 23 | 64–66 | Typed damage, range and properties; lance special rules and complete reach behavior remain descriptive |
| Half plate | 1 | 63–64 | AC 15 + Dexterity capped at +2, stealth disadvantage |
| Equipment packs | 6 | 70 | Aggregate items, without unpacking or invented total weights |
| Arcane and druidic foci | 9 | 66–69 | Gear references, without component substitution automation |
| Holy-symbol variants | 3 | 69 | Amulet, emblem and reliquary |
| Composite ancestry choices | 4 | 4–6 | Hill Dwarf, High Elf, Lightfoot Halfling, Rock Gnome; inherited base traits and static bonuses |
| Spell references | 2 | 146, 191 | Forbiddance and Wall of Thorns have empty effects; no executable wards or terrain |
| **Total** | **48** | | |

Greatsword's existing damage is corrected from 1d6 to **2d6** (p. 66).
Ring Mail's incorrect Strength 13 requirement is removed (p. 64).
Blowgun's flat 1 damage and Net's no-damage attack are not representable by the
current weapon damage-die shape. Fractional prices remain an existing schema
limitation: source costs are described, with zero stored under integer-gold pricing.

Composite ancestry definitions retain the nine base race choices. They are not
four additional base races. High Elf cantrip/language selection, Hill Dwarf HP
growth, Lightfoot hiding exceptions, and Rock Gnome devices remain descriptive.

## Source and tooling

- Official source: https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
- License and modification notice: [`NOTICE.md`](../NOTICE.md).
- The operator review downloaded the 403-page PDF to `/tmp/opencode/SRD_CC_v5.1.pdf`
  and installed `pypdf` in `/tmp/opencode/srd-pdf-tools`; extracted per-page text
  is in `/tmp/opencode/srd-5.1-pages`. These are local review artifacts.
- DeepSeek V4.1 Flash (`deepseek/deepseek-flash`) reviewed equipment facts and
  authored the composite ancestry tranche. Parallel content work uses disjoint
  files; publication and validation run serially.

## Compatible campaign hydration

`scripts/hydrate-srd-reference-campaign.ts` prepares an existing, empty compatible
campaign with the current catalog and four level-one characters exercising the
new ancestry choices. It backs up SQLite, uses repository commands, and records
a replayable report. Run it against a disposable copy first:

```bash
npm exec -- tsx scripts/hydrate-srd-reference-campaign.ts \
  --data-dir /path/to/existing/storage --campaign <campaign-id>
```

The selected demo's older **Bramps Camp** already has an immutable publication
pin. The new **Bramps Camp · SRD 5.1 Expanded** is the hydration target, with an
original three-location expedition setting. Baie-Comeau retains
its Velvet rules and overpowered party; its world enrichment is documented in
[`baie-comeau-realism.md`](baie-comeau-realism.md).

Live demo result: campaign `df637f14-4aa6-4e4a-8b67-3e928c3a291a`, room
`ec7f0794-56a4-430a-8963-133cf984baa0`. Four level-one characters are finalized,
placed at Expedition Hall, and attached to the active room. The catalog has
2,298 definitions, with 1,235 ability/spell references pinned (pinning does not
mean all of them are executable). The rehearsal passed validate-only and replay
without duplicate actors/rooms; the live database passed quick-check and
foreign-key checks, and Baie-Comeau's gameplay snapshot remained identical.

Focused verification ran serially: source hydration, equipment breadth/catalog/
runtime, ancestry/calculator, sixth-level spells, coverage inventory, reviewed
fixture, client API, and hydration CLI tests. Server/client/script typechecks and
the publication digest check passed.

## Findings for the next tranche

The existing catalog has an inherited source/provenance backlog. The old feat
builder labels 39 feats as SRD 5.1, although only **Grappler** is in the PDF.
Examples of older spell entries absent from the PDF include Blade Ward, Friends,
Thorn Whip, Chromatic Orb, Witch Bolt, Arcane Gate and Power Word Heal. These
entries need a separately reviewed correction/publication; their tags do not
prove licensed source coverage. This batch does not expand those entries.

Further verified gaps include ordinary low-CR NPC/animal templates and magic
ammunition. Other source corrections remain, including Mage Hand concentration,
Magic Missile material components, several long-duration spell metadata values,
and subclass acquisition levels. Current catalog counts are therefore not
acceptance criteria for complete SRD conformance.
