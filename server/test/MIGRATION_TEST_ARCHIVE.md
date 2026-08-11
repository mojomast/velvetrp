# Migration Test Archive

These tests are intentionally archived during the pre-release supported/tested
window for startup upgrades from v40 or v41 to v42. They preserve historical
migration coverage without running in Vitest. Archive presence does not mean
that startup upgrades from v2 through v39 are supported.

Versioned suites use the `.archived.ts` suffix; reactivate one by restoring its
`.test.ts` suffix. Embedded suites remain in their owning files as
`describe.skip` blocks because those files also contain active coverage.

## Active Coverage Discoverability

The active executable supported-window coverage is in
`migration-support-window.test.ts`; v42-specific migration coverage is in
`migration-v42.test.ts`. Both remain discoverable by the server test command.

## Versioned Inventory

- `migration-v5.archived.ts`
- `migration-v9.archived.ts` through `migration-v16.archived.ts`
- `migration-v19.archived.ts` through `migration-v20.archived.ts`
- `migration-v23.archived.ts` through `migration-v40.archived.ts`

## Cleanup Adaptation

Archive fixtures that create additional temporary directories use
`makeTmpDir()` from `helpers.ts`. The helper registers each directory with the
existing test cleanup registry, so temporary fixture directories are removed
after a reactivated suite runs. This is cleanup-only; archived fixture setup,
assertions, and migration behavior are unchanged.

## Reactivation

1. Confirm the version is in the supported migration window and update that
   policy and its active coverage as needed.
2. Rename the selected `.archived.ts` file to `.test.ts`.
3. For an embedded archive, replace only its `describe.skip` with `describe`.
4. Run the reactivated suite and the server typecheck before enabling it in CI.

The following embedded suites are skipped rather than renamed because they
share their owning test files with active coverage:

- `server/test/branch.test.ts`: `schema v2 to v3 migration`
- `server/test/m4-agent-acceptance.test.ts`: `genuine populated v39 to v40 acceptance`
