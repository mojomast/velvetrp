# Contributing

## Development Baseline

- Use Node.js 22 and npm workspaces.
- Install from the repository root with `npm install`.
- Keep changes in the owning workspace: `packages/contracts`, `server`, or `client`.
- Treat `packages/contracts` as the shared runtime boundary. Define or update strict Zod contracts before server and client consumers, then build contracts before validating dependents.
- Keep the server on trusted loopback. Do not broaden `HOST`, trust caller identity headers, or describe feature flags as authorization.

## Validation

Run the smallest checks that cover the change from the repository root. Do not run the full suite after every edit; CI runs the complete unit and deterministic E2E gates on every push and pull request.

```bash
npm run typecheck --workspace velvet-mvp-server
npm run test --workspace velvet-mvp-server -- test/repo.test.ts
```

Use the owning workspace typecheck and the affected test file(s) for focused changes. Add related tests when changing a shared contract, route, repository boundary, or current schema. Run `npm test` only for broad or cross-workspace changes, before merging when CI is unavailable, or after focused validation finds a regression.

Use `npm run health` as the final/release gate: typecheck -> build -> `npm test` -> deterministic E2E, exactly once each and fail-fast. See the [canonical unique `/dev/shm` invocation and prerequisites](docs/operations.md#release-health-gate).

Run `npm run test:e2e` for behavior spanning the browser, API, streaming, or persistence boundaries. This suite is deterministic, uses disposable services/data, and makes no paid provider calls.

Live E2E is a different opt-in check:

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

It uses a temporary backup with the configured provider and may incur cost. Do not substitute live E2E for deterministic coverage. Install Chromium once with `npx playwright install chromium`.

## Contracts, Routes, And Persistence

- Prefer additive shared contracts. Do not silently weaken strict schemas or overwrite historical data.
- Keep `currentSchema.sql`, fresh-database creation, exact-schema checks, and repository queries aligned. Development databases are disposable after schema changes.
- Route changes require matching contracts, feature-dependency checks, safe problem responses, authorization/projection tests, client handling where applicable, and updates to `docs/api.md`.
- Retry-sensitive mutations must preserve revisions, idempotency, atomic writes, immutable events/receipts, and authoritative reconciliation after ambiguous delivery.
- Never add arbitrary filesystem paths, SQL, network access, permission changes, or hidden-state exposure to RPG/provider tool surfaces.
- Update `docs/ROADMAP.md`, `devplan.md`, `handoff.md`, and README claims when milestone, schema, operation-count, setup, or security behavior changes.

## Commits

- Keep commits focused and describe the owning area, for example `feat(rpg): ...`, `fix(repo): ...`, or `docs: ...`.
- Do not commit provider keys, `.env`, databases, traces, temporary directories, or unrelated workspace changes.
- Run `git diff --check` before committing and report any intentionally skipped validation.
