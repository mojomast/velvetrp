# Generic planning-board template

This dependency-free, manifest-driven board is version 0.5.0. Copy the entire `board` directory into an approved project-local workshop directory before adapting or running it. Never execute it or write state in an installed skill, plugin, package-manager cache, or agent cache.

## Canonical authority

`manifest.example.json` implements the canonical contract directly: an Intent Brief; outcome-based `EPIC-###` records; typed `DEC-###`, `DEC-###-OPT-##`, and `BLOCK-###` IDs; embedded research baseline and `baselineDigest`; `sha256:` digests; exact arrays; and a `manifestDigest` computed with only that member omitted. `state.js` supplies strict JSON parsing and canonicalization. It rejects duplicate object keys before ordinary parsing, non-NFC strings, lone surrogates, floats, unsafe integers, negative zero, unknown fields, bad references/order, and DAG cycles. Published deterministic examples are in `test/canonical-vectors.json`.

GET with no saved file synthesizes an explicitly non-persisted revision `0` in memory and performs no write. The first explicit save is revision `1`; every persisted state includes its self-computed `stateDigest`. A validated ready revision can be passed to `approvedSelectionSnapshot()` for Retrieve/Plan. Review exports are inert `.txt` files marked `REVIEW ONLY - NON-AUTHORITATIVE`; they are never retrieval authority.

## Copy, test, and launch

```bash
mkdir -p "$PROJECT_ROOT/.workshop"
cp -R skills/repository-planning-workshop/templates/board "$PROJECT_ROOT/.workshop/board"
cd "$PROJECT_ROOT/.workshop/board"
cp manifest.example.json manifest.json
npm test
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export REPOWORKSHOP_CAPABILITY="$TOKEN"
export REPOWORKSHOP_MANIFEST="$PWD/manifest.json"
export REPOWORKSHOP_STATE_DIR="$PWD/state"
export REPOWORKSHOP_BIND=127.0.0.1 REPOWORKSHOP_PORT=4173
mkdir -m 700 "$REPOWORKSHOP_STATE_DIR"
npm start
```

Open `http://127.0.0.1:4173/$REPOWORKSHOP_CAPABILITY/` without logging or sharing it. The capability is defense-in-depth, not authentication, authorization, or encryption. Exact RFC1918 LAN binding requires the skill's explicit trust workflow.

On Linux, saves open the approved state directory once with `O_DIRECTORY|O_NOFOLLOW`, verify `/proc/self/fd/<fd>` resolves to that inode, and anchor all reads, temporary/backup paths, renames, cleanup, and fsync through the retained descriptor. The original pathname is checked without following it after publication; replacement is reported while state stays only in the opened original directory. The owner-only state directory must exist before saving. Compatible `/dev/fd` platforms are detected; platforms without a verified equivalent fail closed. For a non-persisted manual loopback board there, set `REPOWORKSHOP_READ_ONLY=1`; GET returns synthesized revision 0 and PUT is rejected. The server's other bounds are single-process protections, **not denial-of-service resistance**.

The UI remains manifest-driven and uses only local assets. One pure readiness module runs unchanged in Node and the browser. Deterministic tests cover pure transitions/helpers and static event wiring, not full DOM wiring. The optional check loads the actual served board in an already installed Chromium/Chrome, including a 320px overflow assertion, and prints an explicit skip when unavailable; it never downloads packages and a skip is not browser coverage.

## Adaptation audit

Replace the synthetic intent, baseline, evidence, epics, decisions, and blockers, then recompute baseline/manifest self-digests through the canonical module. Never weaken validation to accept generated data. Keep exact IDs/order and project metadata (`displayName`, `slug`). Validate the generated manifest before hosting with `node -e 'const fs=require("node:fs"),s=require("./state.js");s.validateManifest(s.parseJsonStrict(fs.readFileSync("manifest.json","utf8")))'`. Audit stale source identity with:

```bash
REPOWORKSHOP_SOURCE_IDENTIFIERS='old-display-name,old-product-slug,old-storage-key' npm test
```

`REPOWORKSHOP_MANIFEST`, `REPOWORKSHOP_STATE_DIR`, `REPOWORKSHOP_BIND`, `REPOWORKSHOP_PORT`, optional exact `REPOWORKSHOP_READ_ONLY=1`, and the required 32–160 character `REPOWORKSHOP_CAPABILITY` configure runtime behavior. Read-only mode must remain on loopback because it is a manual fallback, not persistence or authentication. Stop with `Ctrl-C` in the owning terminal and preserve canonical state before deleting a disposable copy.
