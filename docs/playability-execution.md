# Playability execution protocol

Status: execution instructions for planned work, not delivered product behavior.
Research baseline: pushed commit `9e5f1b7`. Recheck HEAD and relevant code before
execution; preserve unrelated changes and the two excluded local paths below.

## Ordered program

1. [Campaign readiness](plan-1-campaign-readiness.md): diagnose preparation without
   changing activation or making a false solvability claim.
2. [Complete reviewed adventure](plan-2-reviewed-adventure.md): prove supported
   human/AI paths and produce source-bound gameplay observations.
3. [Measured memory improvements](plan-3-memory-evaluation.md): inspect actual
   dispatch evidence, evaluate recall, and ship one justified runtime improvement.

Do not execute these plans in parallel. Parallelism is normally within a milestone,
with explicit non-overlapping file ownership. The sole cross-milestone exception is
P3.1/P3.2, which have independent contracts/corpus outputs; the coordinator alone
edits their shared index/progress ledger and commits the outputs separately.
Later plans consume committed handoffs;
they must not redefine predecessor semantics to make tests pass.

## Small-context operating procedure

The coordinating agent manages scope, dependencies, review, commits, and the
progress ledger. Subagents implement or research one bounded assignment at a time.
Do not delegate all three plans to a single agent, or keep every source file in the
coordinator's context.

At startup read `AGENTS.md`, `git status --short`, this protocol, and the current
plan. Verify the active milestone in `docs/playability-progress.md`. If absent,
create that file from the template below and add it to `docs/README.md`. Treat
existing completion records as claims to verify against commits, not instructions
to repeat paid requests.

For each milestone:

1. Read its predecessor handoff and the listed owning files. Confirm paths and APIs
   in current code; names described as proposed may not exist yet.
2. Record acceptance criteria and exact write ownership using full repository-relative
   paths, expanding any contextual shorthand in the plan. Split an assignment that
   spans more than one independently testable behavior into smaller tasks.
3. Launch an implementation subagent with the task template. Use an explore agent
   first only if a specific interface remains unknown. Do not repeat broad research.
4. Independent work may run together, but shared contracts must freeze before
   consumers. One integration owner controls barrels, facade, route registration,
   package scripts, and parent UI wiring. Count actual task calls before claiming
   multiple parallel agents.
5. Obtain a non-empty result with files, interfaces, tests, and blockers. If a result
   is empty, resume that task once for its summary rather than starting a duplicate.
6. Review the diff and run the smallest integrated validation. Use a separate
   reviewer for authorization, migrations, paid dispatch/recovery, or source trust.
   Give the reviewer changed paths and concrete threat cases, not the whole project.
7. Fix confirmed findings, update current docs and the ledger, then commit only
   intended milestone files. Record the commit ID immediately afterward.
8. Release old implementation context. Continue from the ledger and the next small
   task. Do not re-run a completed milestone or paid probe after compaction/restart.

If a lower-context coordinator approaches its context limit, stop at a safe boundary,
write the exact next task and commands/results, and resume from files. Never leave
an uncertain paid request represented merely as "retry later".

## Subagent task template

```text
Assignment: <plan/milestone and one concrete task>
Goal: <observable behavior, not broad product aspiration>
Baseline/predecessor: <commit and handoff section>
Read first: <3-6 exact repository paths and relevant contract names>
Own writes: <explicit paths; new files labeled NEW>
Do not edit: <neighbor ownership/shared integration files>
Inputs/interfaces: <frozen signatures, DTOs, issue codes, fixture manifest>
Deliver: <small implementation/test/doc artifacts>
Acceptance: <3-7 exact assertions, including relevant negative/security cases>
Validation: <affected test command and owning typecheck>
Constraints: preserve existing work; apply_patch for manual edits; no live DB
mutation; no provider calls unless this task has an explicit budget grant;
no commits or pushes by the subagent; no weakening tests or claiming mock output
proves model quality.
Stop: when these criteria pass, or report a concrete blocker without guessing.
Return: completed work, changed files/exported interfaces, exact commands/results,
remaining risks, and the smallest next task. Always return non-empty text.
```

## Progress ledger template

Create `docs/playability-progress.md` on execution, not a separate agent memory
service. Keep its current-state section under approximately 150 lines; append terse
milestone records rather than entire logs or transcripts.

```markdown
# Playability progress

## Current checkpoint
- Baseline commit:
- Active plan/milestone:
- Last accepted milestone and commit:
- Next small assignment:
- Uncommitted file owners:
- Blockers and decision required:
- Live budget remaining / audit path / uncertain dispatch IDs:

## Interface handoffs
- P1 readiness DTO, codes, API, coverage, and expected warnings:
- P2 fixture version/digest, branch oracle, observations, and live status:
- P3 inspector DTO/lanes, corpus version, baseline, chosen improvement/gates:

## Milestone records
| ID | Status | Commit | Tests actually run | Docs updated | Remaining limit |
| --- | --- | --- | --- | --- | --- |
| P1.1 | pending | | | | |

## Next agent task
<Complete task template for exactly one assignment>
```

Use `pending`, `in-progress`, `blocked`, or `accepted`; acceptance requires executed
tests and review. Record optional live evaluation separately as passed, failed,
stopped, or deferred. Deferred live quality is not a deterministic product failure,
but it is never evidence of provider quality.

## Authority and scope invariants

- Use the same configured provider/harness infrastructure. Do not add another vendor,
  rewrite orchestration, or enable a new framework merely because research mentions it.
- Commands, receipts, domain revisions, visibility, and safety remain authoritative.
  Proposals, declarations, preparation, recaps, and generated prose retain their
  distinct labels. No model-selected arbitrary patches, fabricated successes, or
  hidden player choices.
- Keep private GM planning out of player context/history and diagnostics. HTTP
  `local-owner` remains trusted-local, not authenticated remote multiplayer.
- Preserve idempotency, stale-response fencing, exact recovery, and paid uncertainty.
  Inspectors/readiness GETs must not call mutating work/recovery helpers.
- Do not modify existing user campaigns or live storage for test setup. Use unique
  disposable directories; refuse nonempty/incompatible targets rather than repair.
- Do not touch or commit `.opencode/skills/seed-test-campaign/` or
  `server/test/two-player-gameplay-api.test.ts` unless separately authorized.
- Unknown/partial schemas remain unchanged and rejected. Any necessary migration
  needs exact predecessor recognition, validation before commit, rollback tests,
  and complete production SQL build assets. Never solve upgrade problems by deleting
  the user's database or ignoring unknown objects.
- If code reveals a missing prerequisite, record a short evidence-backed plan
  amendment before editing. Ask the user for a decision when it changes authority,
  introduces paid infrastructure, exceeds budget, or substantially expands scope.

## Configured API test envelope

The user has allowed testing with the configured API. This authorizes bounded test
calls, not unrestricted campaign generation, live campaign mutations, silent model
substitution, or secret-bearing exports. No live calls are required for Plan 1.

Build/run provider-free fixtures first. Before any live dispatch, record the exact
planned test, selected saved profile/model, capability requirements, setting digest,
empty target, and remaining shared budget. Read settings without logging credentials,
headers, arbitrary editable text, or whole provider objects. A fresh default profile
is not proof of using the configured saved profile.

Default conservative ceiling for the entire three-plan execution, including all
pilots, capability probes, and optional Plan 3 comparisons:

| Resource | Maximum |
| --- | --- |
| Estimated total cost | USD 2.00, using explicitly available configured rates |
| Actual outbound provider dispatches | 130 total |
| Reserved/settled aggregate tokens | 250,000 total |
| Live wall time | 40 minutes total |
| Concurrency | One provider dispatch at a time |
| Automatic paid retries, repairs, or fallback models | Zero |

These are ceilings, not spending targets or predicted prices. Existing stricter
per-turn/per-phase guards always win. Preserve the director's 256-token planning
cap; use at most 768 completion tokens elsewhere in this evaluation unless an
existing stricter setting applies. Start with a small pilot of at most four
dispatches, including any paid probe, before a full matched path.

Derive the full path's call/token reservation from the deterministic runner. Do
not start a pair that cannot fit its remaining reservation. Plan 2 has priority;
Plan 3 live experiments use only the remainder. If a useful experiment needs more,
stop and ask rather than raising limits or silently reducing coverage.

Both prompt and completion prices must be known before a priced live run. Missing
prices mean cost unavailable, not free. Pause live testing and ask for an explicit
pricing or alternative-budget decision; continue deterministic work. Costs computed
from rates are estimates, not a claim about the provider's bill.

Count requests at the completion/transport boundary across every lane. The existing
provider preflight can issue two requests and must count. Before dispatch calculate
a conservative prompt reservation from actual serialized messages, tool schemas,
and provider-added framing using the existing runtime accounting convention; add
the enforced completion ceiling. Fake-provider reported usage is never an estimate
of a live request. Store rates, units, and accounting-policy version with the audit.

For this experiment-wide envelope, count each dispatched request as at least its
full reservation: charge `max(reserved, trustworthy reported)` separately for tokens
and estimated cost. Do not replenish the experiment envelope when actual usage is
lower. Successful responses with missing, malformed, or inconsistent usage retain
their full reservation just like uncertain responses. Preserve both measured and
reserved figures without calling reservations an actual bill. An over-reservation
report must be recorded and stop further paid work, not be capped down or discarded.
Test all these cases provider-free. Refuse the next call when any ceiling would be
exceeded. Save the audit before dispatch so restart cannot replenish budgets or
repeat a probe accidentally.

Stop paid work immediately on unknown outcome, secret disclosure, duplicate
mechanics, unsafe authority change, or exhausted budget. Reconcile existing IDs
without new paid calls. Known failures are also not automatically retried; any new
attempt is explicit, independently recorded, and inside the remaining budget.

Use isolated copies of required configuration in process, not cloned user databases.
Runtime audits must be ignored, permission-restricted, and sanitized before any
report is committed. Never commit raw prompts, unrestricted traces/transcripts,
database files, API keys, or private campaign content.

## Validation and documentation

Read `AGENTS.md` first. Run affected tests and owning workspace typecheck for each
assignment. Contract/route/repository/migration changes need related server tests.
Browser/HTTP/streaming/persistence changes need focused deterministic E2E.

Use actual existing scripts, for example:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts -- test/<affected>.test.ts
npm run typecheck --workspace @velvet/contracts
npm run test --workspace velvet-mvp-server -- test/<affected>.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run test --workspace velvet-mvp-client -- src/<affected>.test.tsx
npm run typecheck --workspace velvet-mvp-client
npx playwright test e2e/tests/<affected>.spec.ts
npm run typecheck:e2e
npm run test --workspace velvet-mvp-server -- test/documentation-drift.test.ts
```

After changing shared contracts, rebuild `@velvet/contracts` before downstream
server/client tests, typechecks, or E2E: package imports resolve built `dist` exports.
Contract tests and `--noEmit` typechecks alone do not refresh those exports.

Placeholders are instructions to substitute the real milestone path, not commands
to execute literally. Avoid simultaneous heavy suites on this host; resource
contention previously caused timeouts. Rerun only affected timeout cases alone,
report both results, and do not increase test deadlines to conceal a regression.
CI remains the full gate; do not run `npm test` after every small change. At plan
completion run the owning integrated checks, `npm run typecheck`, and production
build when schema/assets/runtime packaging changed.

At every milestone update its implementation guide and `docs/playability-progress.md`.
Update `docs/api.md` and strict operation inventories/counts for actual added routes;
use explicit static registration. New guides belong in `docs/README.md`. Update
`docs/ROADMAP.md`, `devplan.md`, and `handoff.md` at plan completion, preserving
historical results as historical. Plans never override executable contracts.

Some older docs still describe memory as uncommitted after `11e0107`; before the
first implementation commit reconcile that status with pushed `9e5f1b7`, without
claiming new test runs. Keep local validation, CI, and live-model quality distinct.

## Milestone commits

The coordinator, not subagents, commits after each accepted milestone. For a
milestone split into two buildable integration steps, separate commits are allowed
and should be recorded. Do not commit known broken or unrelated work.

Before committing inspect `git status`, `git diff`, `git log --oneline -10`, and the
staged diff. Stage explicit intended files, scan new scripts/reports for secrets,
run `git diff --cached --check`, and use the existing `feat`, `fix`, `test`, or
`docs` style. Record the commit ID in the next ledger update; do not amend just to
insert a commit's own hash. Never reset unrelated changes, skip hooks, force-push,
or amend without explicit permission. If hooks fail, fix and make a new commit.

Do not push unless the user explicitly requests it for this execution. The trigger
below authorizes milestone commits, not an implicit publication policy.

## Execution trigger

Use this prompt verbatim, or paste it into an agent running in this repository:

```text
Execute Velvet's three playability plans back to back, in order:
1. docs/plan-1-campaign-readiness.md
2. docs/plan-2-reviewed-adventure.md
3. docs/plan-3-memory-evaluation.md

First read AGENTS.md and docs/playability-execution.md. Follow that protocol,
including its live API budget, authority/visibility rules, validation gates,
subagent task template, documentation ownership, and milestone commit policy.
The researched baseline is 9e5f1b7; inspect current HEAD/status and preserve
unrelated changes. Do not include .opencode/skills/seed-test-campaign/ or
server/test/two-player-gameplay-api.test.ts in commits.

Act as coordinator. Use implementation and review subagents for small bounded
tasks, with exact file ownership and non-overlapping parallel assignments only
where dependencies permit. Do not delegate an entire plan to one agent. Freeze
contracts before consumers and keep one owner for shared integration files.
Give every subagent the relevant milestone, predecessor interfaces, acceptance
criteria, exact validation commands, and required non-empty handoff summary.

Create or resume docs/playability-progress.md as the durable execution ledger.
Work from one milestone and its predecessor summary at a time. Update the ledger
after each task and before context compaction; include the exact next assignment,
completed commits, actual test results, blockers, and remaining live budget.
Do not repeat completed milestones or uncertain paid requests after restarting.

Implement, test, independently review sensitive boundaries, update documentation,
and commit each accepted milestone with explicit file staging. Finish and commit
each plan's handoff before starting the next. Update API inventories and docs
indexes when needed; update ROADMAP, devplan, and handoff at plan completion.
Do not weaken safety, authority, fixtures, or evaluation holdouts to get a pass.

You may test through the project's configured provider API within the shared
protocol's explicit ceilings, using new isolated storage and the existing provider
transport. Start provider-free. Never log credentials, mutate existing user
campaigns, add a hidden provider, or automatically retry an uncertain paid call.
If pricing/configuration prevents a safe live run, record live testing deferred,
ask for the missing decision, and continue provider-free work where possible.

Continue until all three plans' required deterministic gates pass or a concrete
blocker requires the user. Plan 3 must deliver the inspector, evaluations, and a
measured runtime improvement, not merely choose a framework. Report milestone
commit IDs, validations, live usage/status, and remaining limitations. Do not
push unless separately requested.
```
