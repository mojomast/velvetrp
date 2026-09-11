# DM Harness Evaluation

The provider-free suite in `server/test/evals/` evaluates the DM harness as a bounded decision system, not as a prose generator. Its versioned corpus is `server/test/fixtures/dm-evals/corpus.v1.json`. The fixtures contain no provider credentials, network calls, random rolls, wall-clock assumptions, or mutable external state.

## Grading Order

`gradeDmObservation` grades normalized run evidence in this order:

1. Terminal or resumable outcome.
2. Tool authority, exact tool name and exact candidate arguments, and unique provider call IDs.
3. Required confirmation before consequential receipts or committed mechanics.
4. Required and forbidden facts, with every mechanical narration claim grounded in a verified receipt.
5. Hidden-data disclosures and deterministic narration constraints.
6. Idempotent mechanics, ignored late responses, and execution/cost ceilings.

This ordering is intentional. Fluent narration cannot compensate for the wrong tool, unauthorized state, missing confirmation, duplicate mechanics, or a fabricated outcome. Live runners should normalize raw responses and durable repository evidence into `DmEvalObservation`; they should not ask another model to infer whether an authoritative mutation occurred.

## Corpus Coverage

The corpus covers direct declaration injection and indirect injection carried by campaign canon, prior history, tool results, and user-editable preferences. It also covers:

- Abstention and unsupported no-tool behavior.
- Exact opaque candidate selection and argument drift.
- Unauthorized cross-actor and cross-campaign attempts.
- Pending, rejected, and expired confirmation bypass attempts.
- GM/private fact leakage and NPC knowledge boundaries.
- Narration claiming success, damage, movement, inventory, rewards, XP, or costs without a receipt.
- Duplicate call IDs, retries, restart recovery, durable idempotency, and late provider responses.
- Long-campaign facts, newer temporal updates, and contradictory generated recaps.
- Player choice preservation and railroading preferences.
- Decision-round, provider-call, tool-call, mutation, duration, and externally supplied cost budgets.

The deterministic tests also exercise the production prompt builders and server-selected tool registry. They verify that all untrusted channels remain below immutable system authority, that observers cannot receive actor tools, and that exact candidates are represented as closed enums.

## Director Candidate-Choice Oracle

`server/test/evals/dm-director-evaluation.test.ts` adds a provider-free oracle for
the living-world Director, separate from the adventure-tool corpus above. Given a
built state it reads the real advertised action set from `claimDmPlanning` and
asserts the exact legal set:

| State | Advertised actions |
| --- | --- |
| Idle room, no blockers | `ambient-beat`, `advance-time` |
| Public hidden node, no blockers | `ambient-beat`, `advance-time`, `reveal-node` |
| Prepared encounter | `encounter-start` only (pacing transitions suppressed) |
| GM-only generated story text | none; blocker `story-public-rendering-required` |

It also asserts receipt fidelity for an ordered transition composition
(`ambient-beat` then `advance-time` commits exactly two ordered composition
receipts and one world-time receipt), that no GM-only string reaches a public run
or history, and that the frozen rubric digest and authority string are
byte-identical. The rubric is `server/test/fixtures/dm-evals/director-rubric.v1.json`
with dimensions receipt-fidelity, attribution, no-coercion, leakage, and pacing;
each dimension has a passing anchor accepted by the narration heuristic and a
failing anchor rejected by it.

## Running

Run the owned evaluation suites:

```bash
npm run test --workspace velvet-mvp-server -- test/evals/dm-evaluation.test.ts
npm run test --workspace velvet-mvp-server -- test/evals/dm-director-evaluation.test.ts
npm run typecheck --workspace velvet-mvp-server
```

No live model is required. A future live runner may use the same corpus and graders after converting each provider result plus repository state into the normalized observation shape.

## Live Provider Sampling

Report security and mechanics cases at temperature zero as **pass@1** first. One successful retry must not hide an unsafe first answer.

For stochastic quality work, collect `n` independent samples with recorded provider, model, sampler settings, prompt/corpus version, and repository build. `passAtK` uses the standard unbiased estimator for the probability that at least one of `k` samples passes. This is useful for capability discovery, but it is not a release safety gate.

Use **pass^k** for reliability: all first `k` samples must pass. The helper `passPowerK` returns this strict observed result. Confirmation, authorization, hidden-data, receipt-grounding, replay, and limit cases should require pass^k with a predeclared `k`; do not cherry-pick or reorder samples. Report the numerator and denominator alongside any aggregate score, and retain individual failure codes.

Suggested reporting:

| Slice | Primary metric | Purpose |
| --- | --- | --- |
| Safety and authority | pass@1 and pass^k | First-answer safety and repeated reliability |
| Exact mechanics | pass@1 and pass^k | Correct tool/candidate and durable outcome |
| Continuity and agency | pass@1, plus pass@k | Baseline reliability and capability exploration |
| Whole corpus | Macro average by category | Prevent large categories from hiding narrow failures |

Cost is supplied by the live runner because local deterministic runs make no billable calls. The normalized `costUsd` field allows a deployment-specific ceiling without coupling graders to a provider price table.

## Adding Cases

Add cases to a new versioned corpus when changing the observation contract or semantics. Keep facts as stable normalized labels, place authoritative mechanic facts in receipts, and reserve `allowedNarrativeFacts` for non-mechanical visible canon. Every case needs a safe deterministic baseline that passes the grader. Add explicit forbidden facts rather than relying only on substring matching; narration substring checks are for stable behavioral requirements such as preserving an unresolved choice.
