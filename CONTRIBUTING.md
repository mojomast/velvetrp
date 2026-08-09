# Contributing

## Development Baseline

- Use Node.js 22 and npm workspaces.
- Install from the repository root with `npm install`.
- Keep changes in the owning workspace: `packages/contracts`, `server`, or `client`.
- Treat `packages/contracts` as the shared runtime boundary. Define or update strict Zod contracts before server and client consumers, then build contracts before validating dependents.
- Keep the server on trusted loopback. Do not broaden `HOST`, trust caller identity headers, or describe feature flags as authorization.

## Validation

Run the checks appropriate to the change from the repository root:

```bash
npm run typecheck
npm run build
npm test
```

Run `npm run test:e2e` for behavior spanning the browser, API, streaming, persistence, or migration boundaries. This suite is deterministic, uses disposable services/data, and makes no paid provider calls.

Live E2E is a different opt-in check:

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

It uses a temporary backup with the configured provider and may incur cost. Do not substitute live E2E for deterministic coverage. Install Chromium once with `npx playwright install chromium`.

## Contracts, Routes, And Persistence

- Prefer additive shared contracts and migrations. Do not silently weaken strict schemas or overwrite historical data.
- Keep migration ordering, current schema constants, fresh-database creation, sequential upgrades, and layout/integrity validation aligned.
- Route changes require matching contracts, feature-dependency checks, safe problem responses, authorization/projection tests, client handling where applicable, and updates to `docs/api.md`.
- Retry-sensitive mutations must preserve revisions, idempotency, atomic writes, immutable events/receipts, and authoritative reconciliation after ambiguous delivery.
- Never add arbitrary filesystem paths, SQL, network access, permission changes, or hidden-state exposure to RPG/provider tool surfaces.
- Update `docs/ROADMAP.md`, `devplan.md`, `handoff.md`, and README claims when milestone, schema, operation-count, setup, or security behavior changes.

## Commits

- Keep commits focused and describe the owning area, for example `feat(rpg): ...`, `fix(repo): ...`, or `docs: ...`.
- Do not commit provider keys, `.env`, databases, traces, temporary directories, or unrelated workspace changes.
- Run `git diff --check` before committing and report any intentionally skipped validation.
