# Isolated test deploy (shared gateway netns)

These scripts start an isolated VelvetRP test stack:

- `velvetrp-test-gw` — loopback OpenCode Go gateway; owns the network namespace and the published API port.
- `velvetrp-test` — the app container, sharing that namespace (`--network container:velvetrp-test-gw`).
- `velvetrp-test-data` — the app data volume, kept across app restarts and rollbacks.

They are the copies used on the private test host under `~/velvetrp-test`. Keep the live copies in sync with this directory after merging a change.

## Bind address

Published ports stay on loopback (and, when present, a private tailnet address). They must not be published on `0.0.0.0` on the host.

Inside the shared namespace the app has to listen on `HOST=0.0.0.0`. Docker's published-port proxy forwards to the container's interface address, not to `127.0.0.1` in that namespace. Binding the app to `127.0.0.1` makes `/api/health` succeed from inside the namespace and fail through the published port.

This is the one exception to the loopback-only `HOST` guidance in `docs/operations.md`. A normal single-process install still binds `127.0.0.1`.

## Usage

From a checkout of this directory that also has `src/` (the app build context), `app.env`, and `gateway.env` / `gateway/gw.mjs`:

```bash
TAG=<short-sha> ./deploy.sh              # build and replace the app; start the gateway if needed
TAG=<short-sha> SKIP_BUILD=1 ./deploy.sh # reuse an existing velvetrp:test-$TAG image
DRY_RUN=1 TAG=<short-sha> ./deploy.sh    # print the plan, change nothing
./ROLLBACK.sh                            # replace the app with the previous image (ROLLBACK_IMAGE or PREV_TAG)
./ROLLBACK.sh --stop                     # remove the app container only
./ROLLBACK.sh --purge                    # also remove the gateway, volume, and velvetrp:test-* images
```

`deploy.sh` never replaces a running gateway or the data volume. `ROLLBACK.sh` defaults to the same: only the app container moves. `--purge` is the last-resort wipe.
