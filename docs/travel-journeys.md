# Destination travel and interruptions

In Adventure Table, submit **`Travel to <location name>`**, **`I move to <location name>`**,
or another explicit move/go/walk/head/ride/return declaration. Names are matched
uniquely after folding accents, case, punctuation and spaces: `place lasalle`
matches `Place La Salle`, including a descriptive middle-dot suffix in the
displayed label. Questions, negations and compound declarations remain
in ordinary adventure planning.

The server resolves the shortest legal directed path over existing connections,
with connection-ID ordering breaking ties. Search is bounded to 32 legs and
10,000 edges. Every edge uses the shared travel policy for authority, co-location,
open state, visibility, discovery and faction requirements. Player journeys use
player visibility even when submitted by the installation owner. Active session
combat blocks this lane.

Map offers indirectly reachable destinations and leg counts. These are visible
graph hints; the server validates the actual journey. Closed routes are omitted
from the world HTTP projection.

## Event pacing

`world_route_event_profiles_v1` stores operator-authored route metadata:

| Field | Values |
| --- | --- |
| `environment` | `urban`, `road`, `wilderness`, `water` |
| `risk` | `safe`, `watched`, `dangerous` |
| `chance_percent` | integer 0–100 |

Unprofiled and safe connections consume no random draws. Watched routes get at
most one check across a journey tranche; dangerous routes can be checked before
each leg. **At most one interruption occurs across a journey and its explicit
continuation.** Eligible events depend on environment, injured-party health and
the expedition clock (the long-travel threshold is 480 elapsed minutes, not an
inferred time of day).

The original event pool includes weather, blocked-ground/crowd obstacles,
passing-traveler social encounters and unusual markers. These are durable story
interruptions. They do not initialize tactical combat, consume supplies, heal,
deal damage, award loot or reveal a quest clue. Those effects still require their
own supported commands. Events carrying a prepared encounter pointer are excluded
from this lane until a lifecycle integration can validate and start them.

Production uses the injected server RNG with draws in `[1,101)`. The sidecar
records checked route profiles, situation, trigger/selection draws and event
identity. Replay reads that evidence rather than drawing again. Campaign-authored
probabilities describe game pacing, not measured real-world hazards.

## Stops, continuation and evidence

An interruption occurs **before** the next leg: the actor remains at the last
committed node, including the origin if departure is interrupted. The receipt
retains the requested destination and names the actual stop. Submit
**`Continue journey`** or repeat the destination as a new declaration to resume.
Continuation re-resolves a currently legal path from that stop. A closed or
unreachable remaining route causes no additional movement.

`world_actor_journey_executions_v1` is an immutable append-only sidecar, unique per
original adventure turn. A continuation points to its prior command and shares
the journey identity. Each tranche settles its existing per-leg world commands,
discoveries, revisions, expedition time and final sidecar in one immediate SQLite
transaction. A persistence failure rolls the entire tranche back. Each traversed
edge currently advances the existing abstract expedition clock by **60 minutes**;
this is not a claim about actual Baie-Comeau walking or ferry durations.

Adventure receipt links and narration derivatives resolve the sidecar from their
original root turn. Public `kind: "journey"` receipts contain names, status,
leg count, elapsed time, interruption summary and revision evidence. Raw graph
identities, profiles and dice remain internal. Interrupted narration must ground
the current node and pending destination, and cannot claim arrival at that
destination. Retry/swipe changes narration only.

## Research basis

- **SRD 5.1, p. 84, Time / Movement:** supports summarizing travel and gives the
  example of several uneventful days followed by an ambush interruption.
  Reviewed from the official CC-BY PDF used in [the hydration audit](srd-5.1-hydration.md).
  The event table and probabilities here are original campaign rules, not an SRD
  random-encounter table.
- **[Dungeon World SRD, Undertake a Perilous Journey](https://www.dungeonworldsrd.com/moves/):**
  treats a journey as the whole trip between locations rather than repeated daily
  rolls. This informed sparse checks and the interruption cap; its mechanics and
  prose were not copied into the implementation.

See [Baie-Comeau enrichment](baie-comeau-realism.md) for the demo's reviewed route
profiles and the retired direct-edge workaround.
