# Corpus export v1

The first independently approved training corpus. **Export only. No training is
authorized by this approval, and none has been run.**

## Identity

| Item | Value |
|---|---|
| Bundle | `.dataset/exports/corpus-2026-10-13-v1/` |
| Approval | `dataset/frozen/corpus-2026-10-13-v1-approval.json`, SHA-256 `2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14` |
| Candidate | `dataset/frozen/corpus-2026-10-13-v1-candidate.json`, SHA-256 `e478e7a41b11c85d285e9a2a9c4517e2038f176403fa48f53b69391052dd21d7` |
| Validator-source commit | `f3fe6a1f61aba61e071ad1ad4d02ce376c7bf514` |
| Implementation tree | `6dc11aa8937037e0cdb15523b629b56fa50d10a9` (1771 files), digest `e012155601352d7b8f0a35dc89fdf2807e2ad77b7382e1fc8192096c799a08ca` |
| Tokenizer policy | `a691ea3d219fb2faaef1c2694599589b711ed09a44ad10dfa73f40a69a683053` |
| Tokenizer evidence | `0427e6f4ca7647ad6bca540f002b536a689154cfaef8c6c113d44ee5130eb13d` |

## Bundle contents

| File | SHA-256 | Size |
|---|---|---:|
| `training.jsonl` | `83c8ade8b29c9db97c88e42409fd2662c3f8e04d67a2ff429d5e1056cc0fb154` | 676,593 B |
| `provenance.json` | `43daee55c89196c51aab3a4a7b824c64b2cc42be4cb372a773c12a19125bbd7c` | 1,287,066 B |
| `checksums.json` | checksum manifest | 445 B |

- `checksumDigest` **`6f14e9d57d215961b16208437ce278b0402a477049c6f48e6aa561aab198e1f8`**
- `corpusDigest` **`88052112234c603e440387f7a624de3b6ccfed10ddfa1379ac26718cb4ed6f6a`**

**155 records, all `train` split.** No dev or sealed-test row is in the bundle.

| Family | Records |
|---|---:|
| World generation | 46 |
| Tool selection | 39 |
| Boundary recovery | 30 |
| Grounded narration | 21 |
| Creative roleplay | 19 |

The CPU materialisation reproduced **39,435 supervised tokens** exactly, matching
the independent reviewer's offline tokenizer replay of all 155 records.

## How this was approved

An independent GPT-6 Astra xhigh context reviewed four rejected candidates before
approving the fifth. Every rejection was correct and every one concerned
**approval provenance**, never record content:

1. Validator "implementation" pins were gate-result JSON.
2. `production-grounding-predicate` was mapped to the wrong module.
3. The composite digest was computed but never registered, so all 155 records
   failed registry verification; per-validator file lists cannot be complete.
4. The implementation closure extended outside `dataset/src`
   (`server/src/routes/rpg/v1/`, `@velvet/contracts`), which a `dataset/src`
   manifest could not cover.

The resolution pins the inspected commit's **git tree object**: a Merkle root over
every path, mode and blob, complete by construction. The reviewer verified that
mutating any previously omitted helper changes the digest, that tree substitutions
from other commits are rejected even with recomputed digests, and that the whole
approval is protected by the external file pin.

## What the reviewer independently reproduced

4 report digests · 531 source-artifact entries · 450 gate-evidence entries
(567 certificate references) · 198 review-prompt mappings · 155 train records
with matching integrity digests · 155 accepted reviews matched to certificate
scores · 210 disjoint planned lineages · zero exact, content or
transport-normalised duplicates · 19 creative contract replays · 24
grounding/predicate replays · 1,598 journal envelopes · offline tokenizer replay
of all 155 records → **39,435 supervised tokens** · **155/155 registry passes**.

## Reproducing

```bash
# Rebuild the candidate from the durable run stores
npx tsx dataset/scripts/buildCorpusApproval.ts /tmp/candidate.json \
  corpus-structured-2026-10-13-v1 corpus-structured-2026-10-13-v1-shard2 \
  corpus-structured-2026-10-13-v1-shard3 creative-2026-10-13-v6

# Export from the approved artifact (refuses any digest mismatch)
FOUNDRY_TOKENIZER_PYTHON=/path/to/pinned/venv/bin/python \
npx tsx dataset/scripts/exportApprovedBundle.ts \
  dataset/frozen/corpus-2026-10-13-v1-approval.json \
  2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14 \
  .dataset/exports/corpus-2026-10-13-v1 --reload
```

The exporter refuses a wrong approval digest, a candidate that is not marked
export-only, a record that is not admitted or not in the train split, a payload or
certificate that differs, a report digest that does not reproduce, a source tree
that does not match the inspected commit, and any artifact pin that does not
resolve. It has no unguarded export path.

## Limitations

- **No training has been run.** Nothing here demonstrates that training on this
  corpus improves a model. The recommended next step is a small smoke-test LoRA
  against a same-runtime BF16 stock baseline — see
  [`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md).
- The reviewer did not re-grade every output, verify teacher legal rights,
  reproduce provider sampling, replay every deterministic gate across every
  record, or audit installed dependency bytes. The tree pins tracked source, not
  untracked or dirty files.
- 155 records is a real corpus but a small one. It is a defensible first handoff,
  not a production-scale dataset.
- Grounded narration is mechanically sound but fails the prose floor; it is
  included in the structured tranche deliberately and should be excluded from any
  creative or blended arm.
