# Plan 2: Complete reviewed adventure

Status: planned, not implemented. Researched against `9e5f1b7`.

Prerequisite: [Plan 1](plan-1-campaign-readiness.md) accepted and committed.
Follow [the shared execution protocol](playability-execution.md). Deliver factual
playthrough evidence to [Plan 3](plan-3-memory-evaluation.md).

## Outcome

Prove a small reviewed adventure through opening, decisions, consequences, and
finale in human-review and AI-delegated modes. Test matched branches from separate
fresh campaigns. Then use the configured provider for a bounded quality check,
without replacing deterministic state assertions with a model's judgment.

"Prepared completely," "one path completed," and "live run stopped" are different
results. A fluent ending is not evidence of quest completion or reward settlement.

## Research decisions

- [Playwright best practices](https://playwright.dev/docs/best-practices) support
  isolated data, user-facing locators, web-first assertions, and controlled external
  dependencies. Use fake providers for deterministic integration, real providers
  only in the separately budgeted lane.
- [Ink runtime integration](https://github.com/inkle/ink/blob/master/Documentation/RunningYourInk.md)
  illustrates explicit content/choice phases, save/load, and branch visitation.
  Borrow a branch manifest and replay oracle; do not add Ink as a dependency.
- The [AI-DM research](ai-dungeon-master.md#research-and-evidence) supports separate
  planning, verified execution, and narration. Report live quality observationally;
  one successful run is not a reliability estimate.

## Scope and hard truths

Human mode still calls the provider when Open/Continue requests assistance, then
requires approval. AI mode delegates only the existing seven director actions.
Neither mode authorizes the runner to invent a player's decision.

Supported closure has separate evidence: final objective complete, quest complete,
finale node resolved, intended reward claim persisted, and explicit owner campaign
completion. The final administrative action is not an AI-director capability.

Do not fabricate these missing capabilities:

- Active-combat retreat is not a supported dedicated action. Test withdrawal before
  activation; list in-combat escape as deferred unless separately approved scope.
- A successful social check is not a durable negotiated agreement or NPC promise.
- Quest claims persist a claim, not arbitrary wallet/inventory/XP settlement. Use
  a custom acknowledgment reward; assert actual economy effects separately through
  supported combat rewards.
- Encounter concepts are not rosters. Use exact pinned definitions.
- Finale narrative, director scene prose, quest status, and campaign lifecycle have
  distinct owners. Never loosen narration validation to manufacture closure.

## Proposed fixture

Use the fictional **The Last Harbor Light**, authored and reviewed provider-free:
one actor, one pinned supported ruleset/catalog, three public locations, one present
keeper NPC, three connected story nodes, one public clue, an objective-driven quest,
one optional exact-catalog encounter, and a custom acknowledgment reward.

Separate private sentinel preparation from spoiler-safe public text. Do not seed
pre-earned progress, resolved scenes, successful rolls, claimed rewards, or restored
beacon assertions. Stage reviewed generated material and apply it through normal
commands; resolve keys to returned server IDs. Use normal setup/placement commands.

Reuse patterns, not shortcuts, from:

- `server/test/fixtures/dmCampaign.ts`
- `server/test/rpg-generated-campaign-journey.test.ts`
- `server/test/campaign-dm-generated.test.ts`
- `server/test/campaign-dm-binding-evidence.test.ts`
- `server/test/adventure-quest-progression-action.test.ts`
- `e2e/tests/campaign-dm.spec.ts` and `campaign-memory.spec.ts`

Existing fixtures sometimes use direct SQL or manually finish narration. Those are
not acceptable shortcuts for proving the complete production journey. The existing
large seed skill and its local files remain untouched.

## Branch manifest and oracles

Each step records stable step ID, prerequisites, explicit player/DM action,
expected candidate family, allowed mutations, required receipt/state assertions,
forbidden assertions, and stop condition. Never choose "the first candidate".

| Step | Required evidence |
| --- | --- |
| Open and converse | Activated room, public opening, durable player exchange; no implied acceptance, check, travel, or NPC agreement |
| Negotiation | Explicit exact check and roll receipt; success/failure remains correctly classified |
| Failure alternative | Deterministic failed check; no success-based resolution; player chooses a still-supported alternate approach |
| Accept task and inspect clue | Explicit quest lifecycle receipt; eligible separate clue discovery; clue is not an inventory item |
| Resolve first scene | Completed objective receipt and matching pre-authored binding; fresh evidence after reveal, consumed once |
| Safe route | Exact player-authorized travel; no encounter or combat-reward entitlement |
| Risky route | Exact reviewed encounter starts; player chooses legal actions/end-turn; director resolves only its eligible enemy turn |
| Settle combat | Terminal encounter completion; reward availability, then explicit recipient claim and actual balance change |
| Finale | Final objective/quest complete, bound finale resolved, custom reward claimed; no inferred currency/item/standing changes |
| Owner close and reload | Explicit administration completion receipt; persisted state and zero extra dispatch on reread |

Primary branches: negotiation-success/safe route, negotiation-failure/alternate
route, combat victory. Execute each in both modes. Add pre-activation withdrawal
and targeted fault variants, not every combinatorial branch combination.

Pre-author objective bindings for the ordinary AI path. A later check-turn binding
requiring GM intervention must be labeled as such, not hidden inside a supposedly
DM-less playthrough. The test manifest defines opening/finale IDs; readiness must
not infer them from titles. Plan 1 may legitimately retain optional/private warnings.

## Milestones

Each milestone ends with tested docs, a short handoff, review, and a commit.

### P2.1: Reviewed fixture and branch specification

Own: new `server/test/fixtures/reviewedAdventure.ts`,
`server/test/reviewed-adventure-fixture.test.ts`, and new
`docs/reviewed-adventure.md` (index it).

Deliver: manifest/version/digest, reviewed text, real key-to-resource mapping,
normal activation and binding setup, golden branch definitions, and expected
readiness issues. Inspect only disposable fixture storage. Existing nonempty
targets must cause refusal; do not repair, replace, or silently reuse them.

Gate: strict initial-state assertions, zero provider dispatch, pinned roster,
separate private/public content, no pre-earned outcomes. Independent reviewer
checks player agency, alternatives, disclosure, and every proposed mechanic.
Run fixture test/server typecheck. Commit: `test(rpg): prepare reviewed harbor adventure`.

### P2.2: Production HTTP journey

Own: new `server/test/reviewed-adventure-journey.test.ts` and narrow fixture helpers.

Deliver: all three primary branches in both modes through real HTTP/SSE with fake
completions and deterministic rolls. Assert original player turns actually occur.
Normalize identities for comparison; compare final state and receipt semantics,
not identical IDs or prose. Bound combat rounds and total steps; hold on unexpected
candidates rather than making success more likely by editing state.

Gate: explicit finale tuple, failed attempts not promoted, zero secret leakage,
correct unclaimed/claimed rewards, director holds on player turns, no evidence reuse.
Run journey tests and owning typecheck. If a real product blocker occurs, open a
single-file-owner fix task under P2.F below before continuing this milestone.
Commit: `test(rpg): prove human and AI adventure completion`.

### P2.3: Interruptions and supported withdrawal

Own: new `server/test/reviewed-adventure-recovery.test.ts` and required fixture hooks.

Deliver: deferred fake planning/narration for takeover before/after commit, rejected
approval, stale/wrong/failed/used evidence, lost committed response, expired unknown
dispatch, and withdrawal before encounter activation.

Gate: no state or public text from fenced work; committed receipts retained exactly
once; recovery issues no new provider call; no forced combat end labeled retreat.
Use explicit barriers, not race-prone sleeps. Run affected recovery tests/typecheck.
Commit: `test(rpg): cover adventure interruption boundaries`.

### P2.4: Full browser path per mode

Own: new `e2e/tests/reviewed-adventure.spec.ts` and E2E-only fixture adapter.

Deliver: one complete path per mode using the normal table, explicit declarations,
Continue, approvals, travel, claims, and owning close control where available.
Missing UI is a named P2.F blocker, not a hidden administrative HTTP shortcut that
is reported as browser coverage. Keep the separate HTTP closure proof intact.

Gate: desktop full loop, mobile critical controls/overflow, map/draft retention,
read-only reload, exact dispatch counts, source/receipt-linked assertions. Run this
E2E file and E2E typecheck. Commit: `test(e2e): finish reviewed adventure at the table`.

### P2.F: Small evidence-triggered product fix

Use only when P2.1-P2.4 exposes a concrete supported-workflow blocker. Before edits,
record expected behavior, failing fixture, owning contract/repository/UI, and
files. Assign one implementer and one reviewer. Preserve authority and no-retry
rules. Test the regression and owning typecheck, update docs, make a separate
`fix(rpg): ...` commit, then rerun the blocked milestone.

Do not silently expand into active-combat retreat, new social state, generalized
reward settlement, or broad autonomous tools. Those require amended scope.

### P2.5: Opt-in configured-provider runner

Own: new `scripts/run-reviewed-adventure.ts`,
`scripts/test/run-reviewed-adventure.test.ts`, and runner documentation.
One integration owner updates root scripts/typecheck configuration if needed.

Deliver: provider-free default; explicit live flag, configuration source, empty
target, manifest digest, and run-wide ledger. Reuse the configured
`getProviderSettings`/`completeWithProvider` transport. Capture only required
settings in process, not an entire live database or credential-bearing export.

Budget every actual dispatch across planning, narration, and capability probes.
Use the shared live envelope; derive branch cost/call estimates from deterministic
execution before live opt-in. Test missing settings/pricing, cap exhaustion,
configuration mismatch, duplicate resume, failed preflight, and unknown outcomes
without a network. Never automatically rerun a paid branch or switch models.

Gate: all guards test provider-free; bounded allowlisted settings/metrics export;
same provider/profile identity across compared modes. The existing
`playwright.live.config.ts` legacy chat test is not this runner. Run runner tests
and scripts typecheck. Commit: `feat(eval): add bounded configured-provider adventure runner`.

### P2.6: Playtest report and Plan 3 corpus

Run a small configured-provider pilot, then a matched path only if remaining
budget and capability permit. Human-mode automation may approve only manifest
choices; label it a scripted review path, not human quality judgment. Do not block
on unavailable live credentials: record live validation deferred and proceed with
deterministic evidence, never claim live quality passed.

Own: `docs/reviewed-adventure.md`, sanitized run-report template, and new
`server/test/fixtures/playability-observations.ts` for source/oracle definitions.
Runtime audit files belong in a unique ignored directory; never commit a raw DB,
provider request, GM secret, key, or unrestricted transcript.

Deliver: first-attempt results, normalized branch state, intervention/approval
counts, readiness findings, dispatch certainty, reserved/reported usage, latency,
estimated cost, and identified failures. Quality rubric: factual consistency,
agency, continuity, meaningful choices, NPC portrayal, and ending clarity. Automated
mechanics checks are not a substitute for human quality review; mark that review
pending if no human evaluates it.

Gate: all deterministic required branches pass, each live stop is honestly labeled,
no unresolved critical correctness finding, and Plan 3 receives source-bound cases.
Commit: `docs(eval): record reviewed adventure evidence`.

## Shared observation handoff

The committed observation fixture contains stable scenario/step IDs, mode/branch,
source construction instructions, expected source kind/authority, audience and
timeline policy, supported fact, forbidden inference, and failure category.
Run-local IDs map separately to turn/run/claim/command/revision references.

Required recall probes: attempted versus fulfilled action, failed negotiation and
successful alternative, old keeper statement, clue reveal timing, unclaimed versus
claimed reward, past versus current location, and post-finale callback. Include
independent negative cases; do not build expected answers from retrieved output.

Classify failures as preparation, retrieval eligibility/ranking/hydration/packing,
context assembly, model reading/prose, or orchestration. Missing encounter mechanics
and private public-rendering blockers are not memory failures. This handoff is the
input to Plan 3, not permission to rewrite canon to improve benchmark scores.
