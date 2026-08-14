# Migration Test Archive

These tests preserve historical one-step migration behavior without running in
Vitest. Archive presence does not imply current startup support. Schema v53r1
supports populated v46-v52 startup inputs; v45 and earlier are unsupported.

Versioned suites use the `.archived.ts` suffix; reactivate one by restoring its
`.test.ts` suffix. Embedded suites remain in their owning files as
`describe.skip` blocks because those files also contain active coverage.

## Active Coverage Discoverability

`migration-support-window.test.ts` is the active product-support authority. It
runs populated v46-v52 databases through full startup, checks preexisting rows,
fresh/current DDL parity, foreign keys, marker/revision handling, and rejection
without mutation. Active version-specific suites (`migration-v45.test.ts` and
`migration-v47.test.ts` through `migration-v53.test.ts`, except that v49 is
covered by the support matrix and v50 full-startup case) retain focused
historical layout, migration-step, rollback, and tamper evidence. All are
discovered by the existing server test command. The v45 suite validates a
historical fixture only and does not claim current startup support.

## Versioned Inventory

- `migration-v5.archived.ts`
- `migration-v9.archived.ts` through `migration-v16.archived.ts`
- `migration-v19.archived.ts` through `migration-v20.archived.ts`
- `migration-v23.archived.ts` through `migration-v40.archived.ts`
- `migration-v42.archived.ts`
- `migration-v43.archived.ts`
- `migration-v44.archived.ts`
- `migration-v46.archived.ts`

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
