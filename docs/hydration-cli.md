# Autonomous campaign hydration CLI

`scripts/hydrate-campaign.ts` turns a reviewed JSON recipe into applied campaign-generation candidates. It uses only Velvet's HTTP API and never receives, stores, or prints a provider API key.

## Usage

Start the server with campaign generation enabled and provider settings already configured, then run:

```bash
npm run hydrate:campaign -- \
  --recipe scripts/recipes/harness-wars.json \
  --api-base http://127.0.0.1:3000 \
  --campaign-id CAMPAIGN_ID \
  --require-provider
```

Create and explicitly configure a campaign instead:

```bash
npm run hydrate:campaign -- \
  --recipe scripts/recipes/harness-wars.json \
  --api-base http://127.0.0.1:3000 \
  --create-campaign "Harness Wars" \
  --starter srd-5.1
```

Use `--starter original`, `--starter mechanics`, or `--starter srd-5.1` only when that mutation is intended. `--provider-model MODEL` additionally requires the public configured model to match. The default ledger is `.hydration/<recipe-digest>.json`; use `--ledger PATH` to choose another location. `--dry-run` validates the recipe and DAG without HTTP calls or ledger writes.

Generation and application are serial by default because every same-campaign draft snapshots the current content revision. This is the safe and cost-efficient production mode. Wider staging must explicitly accept possible paid replacement calls:

```bash
npm run hydrate:campaign -- \
  --recipe scripts/recipes/harness-wars.json \
  --api-base http://127.0.0.1:3000 \
  --campaign-id CAMPAIGN_ID \
  --concurrency 3 \
  --allow-stale-regeneration
```

The CLI prints a warning whenever concurrency exceeds 1. `--allow-stale-regeneration` may also be supplied with serial operation to authorize replacement after an external campaign mutation stales a paid draft. In live probes, transport staging completed 19/20 calls overall and width 4 completed 8/8 observed calls, but that sample does not prove width 4 reliable. Exact requested-key adherence was only 6/20 (30%). Same-campaign hydration therefore defaults to width 1 because applying one staged draft advances the campaign revision and can stale siblings.

## Recipe

A recipe has ordered DAG stages. Every job supplies the exact generation `sections`, prose direction, and `desiredCounts` keyed by provider preview field (`locations`, `storyNodes`, `questItems`, and so on). Counts must belong to a requested section. Optional job values are `tone`, `exclusions`, static `expandArtifactKeys`, dynamic `expandFrom`, `revisionFeedback`, and `minCount`.

`expandFrom` selects actual accepted outputs from earlier jobs instead of predicting provider keys:

```json
"expandFrom": [
  { "jobId": "guild-factions", "fields": ["factions"], "limit": 2 },
  { "jobId": "summit-foundation", "fields": ["locations"] }
]
```

Each source job must belong to an earlier dependency-reachable stage, and each selected field must be a valid preview field requested by that source job. Duplicate source selectors, forward or unrelated references, and invalid fields are rejected. Static keys plus explicitly allocated selector limits cannot exceed 16; resolution also caps the final deduplicated exact key list at 16.

After a candidate is applied or authoritatively proven applied, the ledger records its accepted public artifact keys by preview field. GM-only outputs are never eligible for `expandFrom`. A dependent job resolves its exact expansion list only after each selected source root and all split/fill descendants are complete. Resolution follows recipe job order, selector field order, descendant order, and preview output order, then persists the exact list before dispatch. Split, fill, and stale-regeneration children inherit that frozen list, so resume does not reinterpret prior outputs.

The reusable `scripts/recipes/harness-wars.json` recipe demonstrates a serial dependency chain and dynamic context from generated factions through final scenes. Its deliberately small jobs include one-unit quest-item and encounter requests because live requested-key adherence was unreliable.

## Guarantees and stop conditions

- Generation and application are serial by default (`--concurrency 1`). Applications remain serialized at every width.
- `--concurrency` above 1 is rejected unless `--allow-stale-regeneration` explicitly accepts that successfully paid sibling drafts can become stale and require another paid call.
- A dependency unlocks only after all of its successful candidates and additive descendants are applied.
- Dynamic expansion uses only persisted public keys from completed dependency roots and all of their split/fill descendants. The resolved maximum-16 list is durable across retries and resume.
- The ledger is written before dispatch/apply and atomically replaced after an `fsync`. Resume reconciles authoritative API state and does not reapply or redispatch completed work.
- Idempotency keys are deterministic. A paid retry keeps the same key and includes the API's exact confirmed failed attempt acknowledgement.
- Two confirmed failed paid attempts split desired counts in half. Odd single-section counts are deterministic (for example, 5 encounters becomes children requesting 2 and 3). Children preserve sections and prompts and receive deterministic new keys. Splitting recurses to `minCount`.
- A unit that still has two confirmed failures at `minCount` is recorded as a durable deficit. The run completes with a deficit count instead of retrying or looping forever.
- Sparse successful output is applied once, then missing counts become deterministic additive fill work. It is never treated as a failed paid call.
- Concurrent provider calls may stage against one content revision. The apply lane serializes them. A candidate proven stale by HTTP 409 stops as resumable `stale` work unless `--allow-stale-regeneration` explicitly authorizes fresh additive replacement under a new key.
- Network loss, a running/missing/uncertain reconciliation result, or an apply that cannot be proven committed stops the run as `uncertain`. Outcome-uncertain work is never retried automatically.
- A changed recipe, including changed `expandFrom` selectors, API base, or campaign is rejected for an existing ledger. Select a new ledger path for a deliberately different run.

Campaign creation and starter setup are intentionally not auto-retried if their response is lost. Inspect authoritative campaign state before starting again with explicit flags and an appropriate ledger.
