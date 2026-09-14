# Agent Validation

Run the smallest validation that covers the change. Do not run the full test suite after every edit.

- Run the affected test file(s) and the owning workspace typecheck for focused changes.
- Run related server tests when shared repository, contract, route, or migration behavior changes.
- Run `npm test` only for broad or cross-workspace changes, before a merge when CI is unavailable, or when focused validation exposes a regression.
- Do not run E2E unless the change crosses browser, HTTP, streaming, persistence, or migration boundaries.
- CI remains the full validation gate: unit tests and deterministic E2E run on every push and pull request.

The full server suite is a checkpoint (wave boundary, pre-merge), never a per-edit step. It runs
files in parallel (`pool: "forks"`, `fileParallelism: true`) and still takes several minutes. While
iterating, prefer explicit affected test files; if you want a broader-but-fast sweep, use the quick
lane (full suite minus the heaviest end-to-end acceptance files). If parallel runs look flaky,
reproduce with `test:server:serial`.

Examples:

```bash
npm run typecheck --workspace velvet-mvp-server
npm run test --workspace velvet-mvp-server -- test/repo.test.ts
npm run test --workspace velvet-mvp-client -- src/App.test.tsx
npm run test:server:quick          # broad sweep minus the slowest end-to-end files
npm run test:server:serial -- test/repo.test.ts   # flake triage: one file, no parallelism
```
