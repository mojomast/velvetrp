# Measured Qwen3-8B tokenizer bridge

CPU-only HF rendering, tokenizer IDs/offsets and assistant masks, followed by
foundry target-selection masking and the **actual TRL CPU data collator**. Only
tokenizer assets are downloaded. This does not load weights, train, benchmark,
or call a teacher.

## Reproduce from the repository root

The recorded environment used Python 3.13.5 on Linux x86_64.

```bash
python3 -m venv .dataset/tokenizer/venv
.dataset/tokenizer/venv/bin/python -m pip install \
  --extra-index-url https://download.pytorch.org/whl/cpu \
  -r dataset/tokenizer/requirements.lock
.dataset/tokenizer/venv/bin/python dataset/tokenizer/prepare.py \
  --assets .dataset/tokenizer/qwen3-8b
.dataset/tokenizer/venv/bin/python dataset/tokenizer/measure.py \
  --assets .dataset/tokenizer/qwen3-8b --output /tmp/opencode/qwen3-measured-evidence
.dataset/tokenizer/venv/bin/python dataset/tokenizer/test_runtime.py
npm run foundry -- tokenizer-check --python .dataset/tokenizer/venv/bin/python
```

On Windows use the venv's `Scripts\python.exe` and a suitable writable output
directory. The bridge invokes the interpreter directly without shell interpolation.

Compare the reproduced `checksums.json` with `evidence/checksums.json`. The bundle
records Python's version, so different Python versions change its checksum even
if token IDs/labels agree. New evidence must report its actual environment.

To regenerate committed evidence intentionally, use
`--output dataset/tokenizer/evidence` and review the diff. Changing `runtime.py`, `prepare.py`
or `measure.py` invalidates the existing evidence until measurements are rerun.
The loader never fetches assets or evidence automatically.

## Pins

| Component | Measured pin |
|---|---|
| Model | `Qwen/Qwen3-8B` |
| Tokenizer revision | `b968826d9c46dd6066d109eabc6255188de91218` |
| Template source | TRL `63b7c3f547d3e06d0eae72712e36b7b64e9d5a45`, `trl/chat_templates/qwen3_training.jinja` |
| Template SHA-256 | `1d944ff8f268b611abb296cdd24d0f51981eef1c8647ac321c3a0258f61eb6c9` |
| Transformers / TRL | `5.19.0` / `1.15.0` |
| tokenizers / PyTorch / Jinja2 | `0.23.3` / `2.14.1+cpu` / `3.1.6` |
| Thinking / parser | Disabled / Hermes |
| Assistant terminator | `<\|im_end\|>`, special-token ID `151645` |
| Sequence policy | Default 4096; truncation disabled |
| Packing | Disabled; independent padded rows |

The three tokenizer/config files have SHA-256 pins in `prepare.py` and the evidence
asset manifest. Local assets are checked on every runtime startup. Missing assets,
changed bytes, runtime/script drift, and invalid targets refuse. `requirements.lock`
records the full resolved environment; `requirements.txt` lists primary pins.

## Actual measurements

These are provider-free infrastructure fixtures, not teacher-generated data or
model-quality scores:

| Fixture | Total tokens | Supervised tokens |
|---|---:|---:|
| French prose and emoji | 69 | 20 |
| Call-only null content | 227 | 30 |
| Tool round trip | 277 | 48 |
| Consecutive tool results | 318 | 76 |
| Unapproved assistant history | 103 | 11 |
| Unapproved tool-call history | 269 | 10 |
| Mixed prose and tool call | 242 | 45 |
| Quoted/Unicode arguments and value 2220 | 235 | 38 |

Both assistant-to-tool-result prefix probes preserved exact text and token IDs.
Both overlength context/target fixtures refused without truncation. Real batched
TRL collation preserved labels and masked padding with `-100`. Consecutive tool
results coalesced as expected and received no loss.

The upstream assistant mask includes the empty `<think>` scaffold and every
historical assistant turn. The foundry overlay masks the scaffold, unapproved
history and system/user/tool-result context. Approved visible output, tool-call
syntax and the special turn terminator receive loss. Blanket assistant-only loss
is therefore insufficient. Evidence offsets are JavaScript **UTF-16** offsets;
byte-level emoji pieces can overlap in character space and remain distinct tokens.

## Integration

`src/tokenizer.ts` exports:

- `createTokenizerBridge({ python, assetsDir, maxSequenceLength? })`: real
  `TokenizerPort` plus `measure()` returning IDs, final pre-shift labels and spans.
- `loadMeasuredTokenizerEvidence()`: measured Qwen3 profile and exact artifacts.
- `withMeasuredQwen3Template(existingApprovedRegistry)`: adds template evidence,
  preserving independent record/validator/reviewer approvals.

Counts are final labels different from `-100`, never word estimates or probe-table
lookups. Arbitrary conversations/tools/selections run through the pinned local
runtime. Identical requests are cached and returned by copy. Cold requests launch
Python synchronously; `Runtime.measure()` can instead be reused in one process
for batch preprocessing. This initial bridge prioritizes reproducibility.

An explicit `maxSequenceLength` can match the eventual deployment/training policy;
overlength context and targets still refuse. For eventual training, feed the
measured IDs/labels to the pinned TRL collator and use target selections from the
export sidecar. Preference branches need their own selected targets under their
full prompt context. Re-rendering JSONL with blanket assistant-only loss would
train on unapproved history. No training is performed here.

## CLI and live checks

```bash
export FOUNDRY_TOKENIZER_PYTHON="$PWD/.dataset/tokenizer/venv/bin/python"
npm run foundry -- tokenizer-check
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate --units 3
npm run typecheck:foundry
npm exec -- tsx --test --test-concurrency=1 dataset/test/tokenizer.test.ts
```

The live Node test uses `FOUNDRY_TOKENIZER_PYTHON`; without it, CI tests validate
the committed real traces and skip the local interpreter check. `test_runtime.py`
always uses the real installed runtime. `generate` without `--execute` is a
zero-dispatch dry run. Execution still requires a configured run store through
the embedding API and the remaining pilot integration. Provider billing measurement
is optional for the funded RouteTok route; no credit check is implemented here.

Recorded validation: owning typecheck passed; 352 foundry tests passed with the
live bridge enabled (0 skipped); 8 real Python tests passed. Re-running the
measurement script reproduced both artifact checksums byte-for-byte. A configured
three-unit dry run reported `deepseek-v4-flash` / `kimi:k3`, `executed: false`,
zero attempts and zero admissions.
