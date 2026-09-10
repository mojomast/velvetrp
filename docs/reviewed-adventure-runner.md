# Reviewed Adventure Runner

`scripts/run-reviewed-adventure.ts` is provider-free unless `--live` is supplied. It requires an existing empty `--target` and writes a mode, manifest-digest, capped-call, sanitized-provider-identity ledger to `--ledger` (no keys, URLs, prompts, responses, or secrets).

```bash
tsx scripts/run-reviewed-adventure.ts --target=/tmp/reviewed-run --ledger=/tmp/reviewed-ledger.json
```

Live use is an explicit, one-call capability probe. It reads only configured provider settings through `getProviderSettings`, requires positive USD-per-million prompt and completion prices, and records a conservative provider-framing reservation before dispatch. Reported usage settles at `max(reserved, reported)`; missing usage settles the full reservation. The ledger records policy version, units, reservations, reported/settled tokens and cost, remaining aggregate envelope, and a deterministic matched human/AI plan that is reviewed but not dispatched.

The aggregate envelope is 130 calls, 250,000 tokens, USD 2, 40 minutes, and concurrency 1. The runner validates the combined matched plan's calls, tokens, cost, and duration, plus the wall-clock deadline, before dispatch. Target/ledger overlap is rejected before any ledger write. Reservation or reported-usage overage is a durable `failed` result; transport uncertainty is the only durable `unknown` result. The runner refuses identity/digest mismatch, duplicate resume, cap or reservation exhaustion, failed preflight, and unknown prior outcomes. It never retries a paid dispatch or changes model. Runtime target and ledger paths must be disposable and ignored.
