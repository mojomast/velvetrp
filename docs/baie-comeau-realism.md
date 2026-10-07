# Baie-Comeau realism enrichment

The Ninth Current demo (`bc-v1-000001`) now contains **50 locations** after adding
32 reviewed real-world landmarks, **73 historically added directed routes**, 16 lore entries
and seven public Field Journal guides. Research covered landmarks, maps, and
history using municipal, provincial, operator and community sources.

## Geographic model

- **Marquette** is the eastern/original Baie-Comeau centre; **Mingan** is the
  western/former Hauterive centre. Mingan here is a city sector, not the distant
  Mingan community.
- Lac Provencher belongs to La Chasse in Marquette. The real Amédée is a distinct
  river by eastern Mingan; the legacy invented industrial yard is relabeled
  Saint-Georges to avoid confusing them.
- Ordinary travel links are paired directed edges. The pre-existing Pionniers
  to fictional ateliers link receives its missing return edge.
- Urban links distinguish walking, bus/vehicle travel and long trail sections.
  Regional links include Pointe-Lebel airport, Pointe-aux-Outardes, Pessamit,
  Franquelin/Godbout, and Manic-2/Manic-5 via the current route 389 entrance.
- Real ferry terminals model **Baie-Comeau ↔ Matane** and **Godbout ↔ Matane**.
  There is no invented Baie-Comeau ↔ Godbout ferry route. Boarding requires an
  actual available departure, not just a graph edge.
- The unsupported Ti-Basse to Boréal-9 shortcut and two industrial-quay boarding
  links are closed. Saint-Pancrace's roadside lookout does not imply a road to
  the cove below.
- Enrichment v3 closes the two workshops↔Place-La-Salle direct-edge workarounds.
  The general journey engine follows workshops → Pionniers → Place La Salle.
  The current graph retains 97 historical edges, of which 91 are open (one other
  pre-existing closure is also retained).

The graph is a travel simplification, not a coordinate-accurate map. Municipal
2026 transit and 2024 Mingan maps, the Embruns/Pointe-Saint-Gilles trail maps,
and the 2023 route 389 entrance announcement are linked in a published guide.

## History and fiction boundary

Lore distinguishes the earlier Saint-Eugène mill settlement (1899), Baie-Comeau
incorporation (1937), Hauterive's 1950 charter, Saint-Georges/aluminium expansion,
and the 1982 merger. Sainte-Amélie's architecture, frescoes and heritage status
are source-backed. Pessamit is presented through contemporary first-party
community sources, with no invented cultural secrets attributed as history.

Sixteen legacy labels/descriptions explicitly identify fictional workshops,
laboratories, municipal annexes, industrial facilities and anomaly equipment.
Former Jardin des glaciers operations ceased in 2021; a potential later
reopening is not treated as an open attraction. Maison de la faune's tourism
reception/educational use is distinguished from an assumed wildlife museum.

## Sources and operation

Full reviewed content and source URLs are in
[`scripts/recipes/baie-comeau-realism.json`](../scripts/recipes/baie-comeau-realism.json).
Citations are carried into live location descriptions, lore and public guides.

```bash
npm exec -- tsx scripts/enrich-baie-comeau.ts \
  --data-dir /path/to/existing/demo \
  --campaign bc-v1-000001 --room 137f8bb3-c43c-4046-9cfb-88e2f9b8ee84

# Validate accepted content and guide publication after enrichment:
npm exec -- tsx scripts/enrich-baie-comeau.ts \
  --data-dir /path/to/existing/demo \
  --campaign bc-v1-000001 --room 137f8bb3-c43c-4046-9cfb-88e2f9b8ee84 \
  --validate-only
```

The script backs up SQLite, validates bounded contract payloads, applies reviewed
generation waves, publishes guides and checks integrity. Existing accepted
artifacts retain their historical content. Since the repository has no metadata
edit or route-state edit command, a scoped operator transaction annotates live
legacy location metadata, closes the five reviewed retired routes, and installs
73 route-event profiles. Urban walking routes are safe; selected regional roads,
trails and ferry links have campaign-authored 10% watched or 20% dangerous checks.
These probabilities and events are fiction, not factual hazard assessments.

Rehearsal, validate-only and replay completed before live application. All 32 new
landmarks are reachable from the party through open directed routes. SQLite
quick-check is `ok`, with zero foreign-key findings. Party snapshots confirm
unchanged actors, resources, equipment, effects, positions and room participants,
including the four overpowered heroes. The demo retains its Velvet rules binding.

## Demo provider repair

The 2026-10-03 travel failure was caused by the restarted demo inheriting built-in
`gpt-4o-mini` defaults with no API key: the provider failed, no travel tool ran,
and the fallback correctly left the actor unmoved. Camille was at the fictional
workshops, with Place La Salle reachable in two steps via Parc des Pionniers.

At the owner's request, the stored demo provider now uses RouteTok/AgentRouter's
`deepseek-v4-flash` route. `/tmp/opencode/velvet-routetok-loopback.py` relays
`127.0.0.1:18890` to the existing tailnet gateway at `100.72.41.9:8787`; the saved
provider base is `http://127.0.0.1:18890/v1`. This keeps the application's existing
loopback URL/credential behavior. Credentials were configured through the API
and are not included in these docs. Restart the relay with:

```bash
python3 /tmp/opencode/velvet-routetok-loopback.py
```

The API process now includes `FEATURE_SYSTEM_ONE=true`, with Jev enabled as
`jev-latest` and the existing shadow/advisory lane modes retained. Its preflight
passed and resolved to `jev-1.13.0`. The generic gateway function-tool preflight
reported a protocol mismatch, while a direct schema-bound tool call and two
isolated full adventure turns succeeded. An isolated SQLite clone at
`/tmp/opencode/velvet-provider-travel-check` recorded both workshop-to-Pionniers
and Pionniers-to-Place-La-Salle travel receipts, plus Jev advisory decisions.
The first arrival had provider-assisted narration; the second used deterministic
narration after the successful move. A later exact-wording check also succeeded
with `i move to place lasalle` using the temporary direct edge.

The engine-level correction now uses [durable destination journeys](travel-journeys.md)
instead: legal multi-hop paths, situational interruption checks, explicit
`Continue journey`, public stop/arrival receipts, and receipt-grounded narration.
Focused tests cover interrupted travel, restart/replay, whole-tranche rollback,
hidden/closed/faction-blocked routes and narration-only derivatives. Enrichment
v3 rehearsal checks preserve the party and pass SQLite integrity/foreign-key
validation.

The exact-wording v3 live-provider rehearsal recorded journey turn
`a46a9663-4b70-4d4e-9e11-9cb6de2d1bd5`: two real graph legs through Pionniers,
a public completed journey receipt and provider-assisted RouteTok DeepSeek
narration. The demo was then updated to v3 and restarted with Jev enabled.
Live validate-only passed; the update preserved the party's gameplay snapshot,
including Camille's current position at L’Alternative. Browser checks cover
two-leg arrival, interrupted travel, reload and explicit continuation.
