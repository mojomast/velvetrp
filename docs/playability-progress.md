# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.1, after execution-documentation baseline
- Last accepted milestone and commit: execution protocol and plan set, pending coordinator commit
- Next small assignment: define and test the strict campaign-readiness diagnostic contract
- Uncommitted file owners: coordinator owns plan/protocol/docs index/ledger; excluded paths remain untouched
- Blockers and decision required: none; no provider calls authorized or required yet
- Live budget remaining / audit path / uncertain dispatch IDs: USD 2.00, 130 dispatches, 250,000 reserved/settled tokens, 40 minutes; no live dispatches; no audit IDs

## Interface handoffs
- P1 readiness DTO, codes, API, coverage, and expected warnings: not implemented; P1.1 will freeze the DTO and finite issue taxonomy
- P2 fixture version/digest, branch oracle, observations, and live status: blocked on the committed P1 handoff
- P3 inspector DTO/lanes, corpus version, baseline, chosen improvement/gates: blocked on committed P2 observations

## Milestone records
| ID | Status | Commit | Tests actually run | Docs updated | Remaining limit |
| --- | --- | --- | --- | --- | --- |
| Docs-0 | in-progress | | `git status --short`, source reads | plan/protocol index present; ledger being created | full shared live envelope unused |
| P1.1 | pending | | | | full shared live envelope unused |
| P1.2 | pending | | | | full shared live envelope unused |
| P1.3 | pending | | | | full shared live envelope unused |
| P1.4 | pending | | | | full shared live envelope unused |
| P1.5 | pending | | | | full shared live envelope unused |
| P1.6 | pending | | | | full shared live envelope unused |

## Next agent task
Assignment: P1.1 diagnostic contract
Goal: freeze a strict, versioned, provider-free readiness DTO and finite issue taxonomy for owner/GM preparation inspection without changing existing activation or director contracts.
Baseline/predecessor: `9e5f1b7`; Plan 1 contract target and shared execution protocol.
Read first: `packages/contracts/src/campaign-dm-http.ts`, `packages/contracts/src/campaign-room-activation-http.ts`, `packages/contracts/src/campaign-content-generation-http.ts`, `server/src/repo/campaignDmRepo.ts`, `server/src/repo/storyDisclosure.ts`.
Own writes: `packages/contracts/src/campaign-dm-readiness-http.ts` (NEW), its focused contract test (NEW), `packages/contracts/src/index.ts`, `docs/campaign-readiness.md` (NEW), and the relevant `docs/README.md` line only if needed.
Do not edit: server repositories/routes, client files, existing director/activation contracts, excluded paths, or the progress ledger.
Inputs/interfaces: versioned readiness response with campaign/room/timeline identity, unchanged activation result section, DM mode, deterministically ordered bounded issues, inspected/omitted coverage, and manual-review limitations. Issue severities are `blocker|warning|review`; no executable candidate digests.
Deliver: strict schemas, issue-code/remediation table, examples for room obstacle/private artifact/missing binding/waiting evidence/optional disconnected content/partial coverage, and negative tests for unknown fields, invalid references, oversized text/arrays, and incomplete coverage.
Acceptance: contracts reject unknown fields; all caps are enforced; partial coverage cannot be represented as a clean report; existing contracts remain unchanged; exports build.
Validation: `npm run test --workspace @velvet/contracts -- <focused readiness test>`, `npm run typecheck --workspace @velvet/contracts`, `npm run build --workspace @velvet/contracts`.
Constraints: apply_patch for edits; no provider calls, live DB, or commits; preserve unrelated work.
Stop: when the contract tests and contracts build/typecheck pass, or report a concrete blocker.
Return: changed files, exported interfaces, exact commands/results, remaining risks, and the smallest next task.
