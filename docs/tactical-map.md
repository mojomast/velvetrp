# Tactical map foundations

Tactical maps are an authoritative persisted vertical spanning shared contracts, deterministic server generation, SQLite state, trusted-local HTTP, client transport, and an accessible campaign-play renderer.

## Authority boundary

- The server owns complete tiles, topology, movement costs, difficult terrain, opacity, tokens, hidden state, legal paths, and reachable cells.
- A client receives only `TacticalMapProjection`: currently visible terrain, opaque `unknown` explored cells, explicitly revealed tokens, and server-computed path/reachability overlays.
- The renderer owns only pan, zoom, cursor, and selection. Selection callbacks are declarations of UI intent, not movement commands or legality decisions.
- Unexplored tiles are omitted. Explored but non-visible tiles deliberately lose terrain and rules fields. Hidden tokens are omitted unless the server explicitly reveals their IDs, and every cell in a token footprint must be visible.
- Reachable cells are intersected with visible cells. A path is omitted in full if any path cell is not visible, preventing overlays from becoming a topology side channel.

## Grid and rules

Maps use zero-based coordinates on a square grid fixed at five feet per cell. Token positions are the top-left cell of rectangular footprints.

The server map module provides:

- Deterministic eight-direction A* with stable tie-breaking.
- No diagonal corner cutting, including all cells occupied by a footprint.
- Destination-cell movement cost, with difficult terrain doubling cost.
- Budgeted Dijkstra reachability using the same movement policy.
- Five-foot Chebyshev distance.
- Corner-inclusive supercover rays, line of sight, and cover classification.

Callers supply occupied cells as a set of `"x,y"` keys when creatures or temporary effects block movement. Path and reachability results must be projected by the server rather than recomputed in the browser.

## Generation

`generateTacticalMap` supports `dungeon`, `cave`, `arena`, and `underwater`. The `underwater` layout is all open water (with rare stone islets) so the durable attack paths can apply the SRD underwater rules from the persisted terrain. Generation is deterministic for kind, seed, width, height, and algorithm version. Every result records the algorithm version, original seed, dimensions, and a SHA-256 hash over canonical generated content.

Changing an algorithm's output requires a new version identifier so saved provenance remains meaningful. Generated maps persist the exact seed, algorithm version, dimensions, canonical tiles, and hash. Every load regenerates and verifies that provenance before projection.

## Persistence and binding

- An active map is bound to exactly one campaign, attached session, and mode (`exploration` or `combat`). Combat maps additionally bind one active encounter. A partial unique index permits only one active map per session/mode while retained replaced maps preserve history.
- Authoritative tiles and provenance are map state. Tokens are separately persisted with actor/combatant bindings and per-token state revisions. The active map has a generation revision and aggregate token revision.
- Exploration cells are persisted per map and actor. Client projections are never persisted as source of truth.
- Preview records bind map, actor, token, destination, exact map/token revisions, combat authority revision, authoritative path, cost, and budget. D&D combat previews additionally persist the exact turn ID. Preview generation uses a consistent transaction. Move commands require that exact preview plus an idempotency key and both expected revisions.
- Immutable move commands preserve request and receipt evidence. Exact idempotent reuse returns the original receipt without moving again; changed reuse conflicts.

## Movement policy

- Exploration allows one explicit movement command of at most 60 feet. The server applies topology, footprint, occupancy, difficult-terrain, and corner-cutting rules and reveals line-of-sight cells within six cells after movement. There is no implicit movement, animation commit, or browser-side legality.
- Combat movement is fail-closed. A preview exists only when the map's encounter is active and the actor-bound token is the current active combatant. Velvet retains derived-speed-minus-round-ledger accounting.
- D&D movement uses only the exact open `combat_turn_economy_v60` allowance. A move atomically spends feet, updates position, advances the combat mutation revision, and persists its receipt without consuming an action or advancing the turn. Map regeneration does not refill that allowance, and stale or previous-turn previews reject. Dash, jumping, and special movement commands remain unsupported.
- D&D off-turn maps remain readable with zero movement. Exploration movement is blocked while the actor participates in active D&D combat, preventing the exploration budget from bypassing combat spending.
- Reachable and path overlays are computed by the server for the controlled actor token. They are filtered through the same role-safe visibility projection.

## HTTP and recovery

Four strict no-store operations provide GM generation, actor projection, movement preview, and movement command. Generation and movement are never automatically retried. A missing or malformed response after issuing either write is ambiguous; clients perform an authoritative GET-only refresh and require a fresh preview before another move.

Repository idempotent move replay returns the retained receipt without spending again, even after turn advance or restart, plus a current snapshot. Lookup remains scoped to the active map; commands on a replaced map are not recovered through the new active-map endpoint. Map-v2 upgrades recognize exact pre-grounding schemas, preserving existing rows without inventing legacy map context. Startup also supports narrowly recognized exact campaign-director predecessors, including the pre-director/pre-grounding combination. Complete startup validation occurs before commit and rolls back the upgrade on failure. All other unknown or partially upgraded schemas reject without repairs; see [Operations](operations.md#data-directory-and-current-schema) for the exact supported shapes.

The current trusted-local routes use fixed `local-owner` authority on loopback. Repository authorization still derives campaign role and actor control. This is not a remote authentication boundary.

## Snapshots and export

Tactical maps are live session/encounter state and are intentionally excluded from campaign timeline checkpoints, recaps, and campaign transfer exports in this integration. Replaced map rows, commands, receipts, exploration, and provenance remain in the local database, but no restoration or portable import semantics are implied. Adding map checkpoint or export support requires a separately versioned public package with hidden topology and principal/token bindings excluded or explicitly re-authorized.

## Accessibility

`TacticalMapCanvas` is dependency-free beyond React and Canvas 2D. The Canvas is visual-only and is paired with a semantic table containing every projected cell and visible occupant. Native table buttons support direct selection. A focusable control group supports arrow-key cursor movement, Enter or Space selection, and plus/minus zoom.

The text equivalent uses exactly the supplied projection and therefore cannot expose information absent from server output.

## Client integration

Campaign play retains `CampaignRouteMap` for topological world travel and separately renders `TacticalMapPanel` for local movement. Selecting a Canvas or table cell declares a destination and requests a preview. Only an exact server preview enables Confirm. Canvas never calculates visibility, reachability, path cost, speed, occupancy, or legality.
