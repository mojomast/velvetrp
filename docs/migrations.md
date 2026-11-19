# Database schema migrations

Velvet records its database schema generation in SQLite's `PRAGMA user_version`.
The registry lives in `server/src/repo/db/migrations/index.ts`:

- `BASELINE_SCHEMA_VERSION` is `1`: the schema as published at the first release tag.
- `MIGRATIONS` is the ordered, append-only list of migrations after the baseline.
- `SCHEMA_VERSION` is the baseline plus the number of registered migrations.
- `applyMigrations` validates the list, runs each pending migration in its own
  immediate transaction, and stamps `user_version` as it goes.
- `validateMigrations` rejects gaps, duplicate or out-of-order versions, versions
  at or below the baseline, and empty names.

`PRAGMA user_version` is authoritative. `ensureCurrentSchema` reads it before
touching anything:

- A version newer than `SCHEMA_VERSION` is refused with a schema error, and the
  database is left byte-for-byte unchanged. Run the newer Velvet build, or back
  up and start with an empty data directory.
- An empty database is created from the current schema and stamped with
  `SCHEMA_VERSION` in the same transaction.
- An unstamped (`user_version = 0`) or baseline-era database is handed to the
  legacy exact-predecessor recognizers. Those recognizers only accept schemas
  they recognize exactly; unknown or modified schemas still fail closed. After a
  successful upgrade an unstamped database is stamped with
  `BASELINE_SCHEMA_VERSION`.
- Registered migrations newer than the stamped version then run in order.

## Legacy unstamped development databases

Databases created before versioning have `user_version = 0`. Such a database is
accepted only when the existing exact recognizers map its schema and data onto
the v1 baseline, and is then stamped. This is not a general migration path: a
drifted or unknown development database is unsupported and refused at startup
without modification. Keep its data with `npm run db:export` (see
[Operations](operations.md)) and start with an empty data directory.

## Adding a migration

Append; never edit, reorder, or remove a published entry. A database already
stamped with a version never runs that entry again, so editing it silently
diverges stores.

1. Append one entry to `MIGRATIONS` with `version` equal to the previous entry's
   version plus one (or `BASELINE_SCHEMA_VERSION + 1` for the first migration),
   a non-empty descriptive `name`, and an `up(db)` function.
2. Keep `up` synchronous and safe inside a single immediate transaction. Do not
   set `PRAGMA user_version` yourself; `applyMigrations` owns the stamp.
3. Add a test that upgrades a fixture at every earlier version (at minimum a
   `v<N-1>` fixture) to the new version and verifies the resulting schema and
   data. Existing migration tests must keep passing unchanged.
4. Update this document only if the migration process itself changes.

Once a v2 migration exists, the legacy recognizers must compare against a frozen
v1 inventory rather than the current schema SQL. Otherwise a v1 database would
be upgraded straight to the newest schema without ever running the registered
migrations, and the historical fingerprints would stop describing v1.

## Backups and integrity checks

Unless the database path is `:memory:` or empty, `applyMigrations` writes
`VACUUM INTO` backup beside the database before each pending migration:

```text
<databasePath>.pre-v<version>-<ISO timestamp with ':' and '.' replaced by '-'>.bak
```

Backups stay in the same directory, are ordinary SQLite files, and are never
deleted automatically. Remove them manually once a migration has been verified.

Inside each migration transaction `applyMigrations` checks that `PRAGMA
quick_check` returns `ok` and that `PRAGMA foreign_key_check` returns no rows
before setting `user_version`. Any error rolls back that migration (earlier
migrations stay applied), and the thrown error names the migration name and
version. `ensureCurrentSchema` reports migration failures as schema errors like
any other validation failure.
