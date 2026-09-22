# Version-bound Jev promotion

The metrics gate and runtime authority are now separate. Existing promotion records retain
historical metrics and evidence links, but none has evaluatedBindings. They are deliberately
NOT backfilled from today's defaults: doing so would invent an evaluation configuration.
On deployment, active speaker routing and adventure selection therefore record advisory
results and retain the existing provider fallback until reviewed, bound evidence is added.
No new family is enabled by this change, and lane-mode settings are not rewritten.

## Binding contract

An evaluated binding freezes the lane, provider endpoint, requested AND returned model,
question revision, composition revision, candidate strategy, state schema revision, exact
action family, effective action/review thresholds, and calibration coefficients. A missing
response model, incomplete binding, mismatch, or failed metrics gate denies active use.
Speaker routing uses its effective threshold override, not merely the stored default.
Adventure checks, rests, combat consumables and combat powers all use the same check with
the selected exact family. Repository validation and confirmation remain mandatory.

SYSTEM_ONE_EXECUTION_CONTRACTS in server/src/agent/systemOneBinding.ts declares the current
active contract. These are explicit semantic revisions, NOT automatic source hashes.
Maintainers MUST bump the relevant revision when changing question builders, composition,
state projection or candidate selection semantics (including caps/filtering). Code review
must enforce that rule; an unversioned source edit cannot be detected by this mechanism.
The active adventure contract names the legacy family-round-robin strategy. Shadow lexical
selection must be evaluated with a distinct candidateStrategy override; its evidence cannot
approve that active legacy contract, or vice versa. Future active wiring must pass its actual
contract. Only the currently actionable speaker/adventure lanes have contract constructors.

## Producing a real approval

Capture systemOneEvaluationBinding alongside an evaluation's immutable inputs, model
metadata, metrics, dataset/version, and evidence artifact. This helper only constructs data;
it does not approve anything. Existing benchmark scripts are NOT yet wired to emit bindings.
That integration and a new evaluated artifact are required before production approval.
Do not reconstruct the binding later from mutable settings or current contract constants.
If multiple response models or action families occur, report separately and evaluate every
binding being approved; aggregate lane accuracy alone cannot establish family coverage.

After review, store literal evaluatedBindings on the corresponding promotion record together
with the metrics and evidence they describe. Do not call the current-contract constructor
inside a production record: an approval must stay frozen when runtime code changes. If the
bindings have different metrics, do not combine them into this single-metrics record; use
separate evaluation-record support before promoting them. No wildcards are supported.

A provider silently changing weights behind an unchanged reported model identifier is outside
this binding's detection capability; prefer pinned model identifiers and periodic evaluation.
No secret, pricing, timestamp, or player-state data is included in bindings. Exact endpoint
comparison is intentionally conservative (even URL spelling changes require review).

## Tests and recovery

Execution tests explicitly install synthetic bindings through a test-only fixture and restore
historical records afterward. Those values are not production evidence. Regression coverage
checks stale model/questions/composition/shortlist/state/thresholds/calibration/family bindings,
missing metadata, failed metrics, effective routing overrides and actual fallback paths.

To recover from a mismatch, leave the lane shadow/off or use the existing provider fallback
while evaluating the new contract. Do not bypass the binding check or relabel old evidence.
There is no database migration, deployment, settings mutation, or paid API call in this change.
