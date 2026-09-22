# Supra2 service deployment

Deployment runbook for the private Supra2-IMG text-to-image service on the Velvet inference
host. Target hardware is an AMD Ryzen AI MAX+ 395 ("Strix Halo") with unified memory, and the
service is reachable only from the Tailscale tailnet. The Velvet side that consumes it is
described in [Scene image integration](scene-image-integration.md); the original design
rationale is [Image generation integration (proposed)](image-generation-integration.md); the
historical handoff prompt that first stood the service up is
[Supra2-IMG inference setup prompt](supra2-inference-setup-prompt.md).

The API section below matches the current service implementation, and the Velvet adapter
(`server/src/provider/supra2ImageService.ts`) is built to it. Where this runbook and the older
setup prompt disagree, follow this runbook: the setup prompt describes a superseded
bearer-token/base64 contract (see [Changes from the original handoff](#changes-from-the-original-handoff)).

## Non-negotiables

- **Tailnet only.** Bind loopback or the tailnet interface, expose through `tailscale serve`
  (private), and never enable Funnel, port forwarding, or a public listener. There is no
  authentication token in the current contract; the tailnet identity is the boundary.
- **One shared lane.** The worker serializes generations and returns `429` when its queue
  bound is reached. All Studio users share it.
- **`/api/cancel` cancels every queued job for every user.** It is an operator tool, not a
  per-job cancel. Never wire it to a player action or an automatic recovery path.
- **No moderation exists.** The model has no safety checker, NSFW filter, or watermark. Restrict
  who can reach the host and do not put unmoderated output in front of players unreviewed.
- **Fixed 256×256.** There is no resolution parameter. Portraits, tokens, props, and
  thumbnails fit; full scene art does not.
- **The checkpoint is a pickle.** Treat it as executable content: pin the commit, verify size
  and hash, and never load an unverified file.

## Prerequisites and OS guidance

### Hardware, firmware, and memory

- Integrated Radeon 8060S (RDNA 3.5, `gfx1151`). The XDNA2 NPU cannot run this model — do not
  install Ryzen AI / ONNX NPU tooling for it.
- Set the UMA Frame Buffer / Variable Graphics Memory carve-out to at least 8 GB (16 GB+ is
  comfortable). The weights are roughly 1.8 GB fp32; the carve-out only has to hold weights
  plus activations.
- Optional GTT tuning for larger models: add `amdgpu.gttsize=65536 ttm.pages_limit=16777216`
  to the kernel command line so the iGPU can map more system RAM as GTT. It is **not required**
  at this model size; skip it unless you are experimenting with larger checkpoints.
- Record total unified RAM, carve-out size, and kernel version in the deployment notes.

### Operating system and ROCm

Native Linux (Ubuntu 24.04+ or similar) is the supported ROCm path and is preferred. On
Windows, WSL2 with ROCm is a fallback; verify the iGPU is actually visible inside WSL2. If
ROCm cannot see the iGPU, the script supports CPU and the service works with the CPU device —
report and expect the measured latency from the timings section, but note the captured
deployment currently reports CPU.

Verify the stack before installing the model:

```bash
rocminfo | grep -m1 gfx
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0), torch.version.hip)"
```

ROCm masquerades as CUDA inside PyTorch, so `torch.cuda.is_available()` is the check. Use a
ROCm build that includes `gfx1151` (ROCm 6.4+, 7.x, or a TheRock nightly). If the runtime
rejects the architecture, export `HSA_OVERRIDE_GFX_VERSION=11.0.0` for the service process and
record that you did.

### Python environment

Python 3.10–3.12 with `pip`, `git`, and `curl`; keep everything in a virtual environment.
Install ROCm PyTorch wheels only — PyPI `torch` on AMD is a CUDA build:

```bash
mkdir -p ~/supra2-service && cd ~/supra2-service
python3 -m venv .venv && . .venv/bin/activate
pip install --upgrade pip
# Match the index to the installed ROCm (example: rocm7.0).
pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm7.0
pip install transformers diffusers sentencepiece tqdm huggingface_hub
```

## Pinned model fetch

Fetch the exact commit. Do **not** use `transformers` `AutoModel` for this repository: its
`config.json` advertises `transformers`/`auto_map` entries that do not exist, so
`from_pretrained` fails. Use the vendored `inference.py` (or the demo Space's `app.py`).

```bash
COMMIT=10dec6e4b4b5d1c44fd1d7d3fe5e50137333da5b
wget -O inference.py "https://huggingface.co/SupraLabs/Supra2-IMG/resolve/$COMMIT/inference.py"
wget -O model_final_ema.pt "https://huggingface.co/SupraLabs/Supra2-IMG/resolve/$COMMIT/model_final_ema.pt"
stat -c %s model_final_ema.pt   # expected: 416651529
sha256sum model_final_ema.pt    # record it in the deployment notes
```

The Hub x-linked etag for the checkpoint was `e96aa0537e0fd120af82b3a606dd50c90ae079ac7aa97b38a8da4882daeeee48`;
it is not guaranteed to equal the computed `sha256`. Record whichever hash the file actually
has, and re-verify the size and hash any time it is re-fetched. If the pinned commit no longer
resolves, fetch the current main commit, record it, and update this runbook's pin before
deploying.

Model facts, verified from the model card on 2026-09-22:

| Property | Value |
| --- | --- |
| Architecture | `SupraDiT`, 104.1M parameters, depth 14, AdaLN-Zero, rectified flow |
| Text encoder | `google/flan-t5-base`, frozen, loaded at runtime |
| VAE | `stabilityai/sd-vae-ft-mse`, loaded at runtime |
| Output | fixed 256×256, no resolution parameter |
| Checkpoint | `model_final_ema.pt`, 416,651,529 bytes, fp32 pickle state dict (`torch.load(..., weights_only=False)`) |
| License | `apache-2.0` declared in metadata; **no LICENSE file ships upstream** |

## The service API

The Velvet adapter speaks the exact contract below: strict JSON bodies, an `Origin` guard on
mutations, `202` acceptances with job polling, PNG downloads over `/images/...`, and a
service-wide cancel. Protocol responses are parsed strictly; extra fields are tolerated, but
responses that violate the schema are rejected rather than guessed at.

The captured deployment identifies itself as a Python HTTP server (Python 3.11.16 in the
captured headers) with `cache-control: no-store` and `x-content-type-options: nosniff`, and a
restricted `frame-ancestors` content-security policy. The framework does not matter to Velvet;
the contract below does.

### `GET /health`

Liveness only. It does not prove authorization, and it does not prove the model is loaded.

```json
{ "ok": true, "release": "c30e50eb66b7f34ceb7da1d679a391c392e9d5fe102696496c2ad4a6345d2922" }
```

`ok` must be a boolean and `release` a string. Velvet treats `ok: false` as unhealthy. Keep
`release` tied to the deployed service build so the Velvet side can report which revision it
is talking to; the value is also useful when debugging a protocol mismatch.

### `GET /api/status`

Full worker and queue status. The history is **shared across every caller** and is
deliberately not a source of truth for job ownership; the Velvet adapter only trusts jobs whose
IDs it submitted.

```json
{
  "busy": false,
  "device": "CPU",
  "mode": "Warm worker; unloads after 10 minutes idle",
  "worker": { "loaded": false, "threads": 16, "idle_unload_seconds": 600 },
  "jobs": [
    {
      "prompt": "a small red sailboat on a turquoise sea, watercolor",
      "seed": 42,
      "steps": 20,
      "cfg": 3,
      "id": "ac660e9bf34c48bdb4a17191a68e5f36",
      "batch": "a7444571eb544cc59df14964a544f687",
      "status": "done",
      "created": 1790083031.2671328,
      "started": 1790083031.2678325,
      "seconds": 2.47,
      "image": "/images/ac660e9bf34c48bdb4a17191a68e5f36.png",
      "warm": true,
      "threads": 16,
      "generation_seconds": 2.465,
      "prompt_cache_hit": true,
      "prompt_encode_seconds": 0.000009
    }
  ]
}
```

- `busy` is a boolean; `device` and `mode` are strings; `worker` carries `loaded` (boolean),
  `threads` (integer), and `idle_unload_seconds` (number).
- Each job has `id`, `batch` (a string or a number), `prompt`, `seed` (0–2147483647), `steps`
  (1–100), `cfg` (1–10), `status`, and `created` (a Unix timestamp in seconds). `started` and
  `seconds` appear once the job starts, and `image` appears once it succeeds.
- `status` is one of `queued`, `running`, `done`, `failed`, `cancelled`. `done`, `failed`, and
  `cancelled` are terminal. A failed or cancelled job has no image.
- The extra fields (`warm`, `threads`, `generation_seconds`, `prompt_cache_hit`,
  `prompt_encode_seconds`) are informational; at least one deployment reports them. Velvet
  ignores unknown fields.
- History is bounded to 256 retained entries. The Velvet adapter accepts up to 512 while
  parsing a snapshot, but downloads must happen promptly after `done` because older entries
  are evicted.

### `POST /api/generate`

Request:

```json
{ "prompt": "a weathered harbor lighthouse at dusk, painterly", "seed": 0, "steps": 10, "cfg": 3 }
```

- `prompt`: string, 1–1000 characters after trimming (the Velvet adapter enforces 1000).
- `seed`: integer 0–2147483647, default 0.
- `steps`: integer 1–100, default 50. Scene-image settings narrow the usable range to 10–100.
- `cfg`: number 1–10, default 3. Scene-image settings narrow the usable range to 1–8.

Success is exactly **HTTP 202 Accepted** with a small JSON acceptance, not the image:

```json
{ "id": "a1e559ad7f0747bdaaa218eb374f3862", "batch": "5fe41a3c728c48f285bb15af398d6bc1" }
```

`batch` may be a string or a number; the adapter normalizes it. A `202` means queued, not
finished: poll `/api/status` with the returned `id` until it is terminal. Any status other
than `202` (or a retried `429`) is an HTTP error; `3xx` redirects are refused as transport
failures.

### `POST /api/batch`

Request:

```json
{ "prompt": "a weathered harbor lighthouse at dusk, painterly", "count": 2, "steps": [10, 20], "guidance": [3] }
```

- `count`: integer 1–32, default 1.
- `steps`: array of 1–8 integers, each 1–100, default `[50]`.
- `guidance`: array of 1–8 numbers, each 1–10, default `[3]`.
- `count × steps.length × guidance.length` must not exceed **128 images**.

Success is `202` with the batch acceptance:

```json
{ "id": "5fe41a3c728c48f285bb15af398d6bc1", "batch": "5fe41a3c728c48f285bb15af398d6bc1", "ids": ["a1e559ad7f0747bdaaa218eb374f3862"] }
```

`ids` holds 1–128 non-empty job IDs. Velvet's scene-batch planner reuses the same seeds across
the steps/guidance grid so a batch isolates the sampler change rather than the seed.

### `POST /api/cancel`

Cancels **all queued work for every Studio user**. Body is `{}`. It is not a per-job cancel
and Velvet never exposes it to players. Use it only to clear a stuck shared lane. A successful
call returns any 2xx; the adapter expects that and never inspects the body.

### `GET /images/<file>.png`

Downloads a completed image. The path must stay on the configured service origin and be a
conservative `/images/...` PNG path; Velvet rejects percent-encoding, queries, fragments,
backslashes, control bytes, and traversal. The response must be `image/png` (an absent content
type is tolerated), must begin with the PNG magic bytes, and must fit
`VELVET_SCENE_IMAGES_MAX_BYTES`. Redirects are refused.

### `Origin` guard, `429`, and body limits

- **Origin**: mutations (`/api/generate`, `/api/batch`, `/api/cancel`) require the service's own
  origin in the `Origin` header. Velvet sends `VELVET_SCENE_IMAGES_ORIGIN`, defaulting to the
  base URL origin. It is a request guard, not authentication; treat the service as unauthenticated
  and rely on the tailnet boundary.
- **429 busy**: the single GPU lane returns `429` when its pending bound is reached (the
  handoff specification used roughly four pending submissions). Velvet retries with bounded
  exponential backoff plus jitter (three attempts by default, 500 ms base, 4 s ceiling) and
  captures `retry-after`; after the bound it surfaces a busy error instead of queuing
  indefinitely. Status polling also backs off on `429`.
- **Body limits**: Velvet's adapter accepts health responses up to 32 KiB, status responses up
  to 1 MiB, and submission acceptances up to 64 KiB. Oversized bodies are rejected rather than
  truncated.

### Changes from the original handoff

The setup prompt described an earlier contract: a bearer token on `/generate`, a synchronous
`200` with base64 images, `guidanceScale`/`count`, and `400/429/500` errors. The current
service uses the tailnet identity plus the `Origin` guard, `202` acceptances with
`/api/status` polling, separate `/api/batch` and `/api/cancel` endpoints, and `/images/...`
downloads. Velvet's adapter is built to the current contract, so a service that still
implements only the old one will fail schema checks. The historical document is retained
because it explains the hardware bring-up and pinning steps; do not treat its wire format as
current.

## Tailscale exposure and authorization

- Bind the listener to loopback or the tailnet address, then expose it with private
  `tailscale serve` (never Funnel). Do not forward a public port, and do not bind `0.0.0.0`
  on a machine with a public interface.
- The tailnet identity reported for the Velvet server must be the authorized login —
  currently `mojomasta@gmail.com`. Identity comes from Tailscale's identity-aware proxy; it is
  **not** an application secret and must never be forged. Do not set `Tailscale-User-Login`
  (or any equivalent identity header) from application code, curl scripts, or the Velvet
  adapter; the adapter deliberately sends no identity or credential header.
- Verify from a second tailnet machine that `/health` answers and that a non-authorized
  identity is refused. Confirm the service is not reachable from the public internet.
- Keep the proxy's content-security `frame-ancestors` restricted to the Studio origins; do not
  widen it to `*`.

## Running persistently

Run the service under a supervisor so it restarts after failures and survives logout:

- Preferred: a systemd unit (user unit plus `loginctl enable-linger`, or a system unit) with
  `Restart=on-failure`. Record the unit name in the deployment notes.
- Fallback: `nohup`/`screen`/`tmux` if systemd user units are unavailable, and record how the
  process is kept alive.

Worker behavior to configure and verify:

- **Warm worker**: the model loads lazily on the first generation and stays resident. The
  captured deployment reports the mode `"Warm worker; unloads after 10 minutes idle"` and
  `idle_unload_seconds: 600`, with `worker.loaded` flipping to `true` after the first
  generation. The first request after an unload pays the model load; subsequent requests do
  not.
- **Threads**: the captured deployment reports `worker.threads: 16`. Treat the thread budget as
  a host setting — choose it deliberately, leave headroom for the compositor and ROCm queues,
  and read it back from `/api/status` after a restart.
- **Output**: 256×256 PNG, no resolution parameter.
- **History**: bounded to 256 completed entries. The service is a queue and short-lived cache,
  not the archive; Velvet downloads promptly and stores images durably per world.

## Verification

Run all commands on the inference host first, then repeat the health check from another tailnet
machine.

### Health and status

```bash
curl -sS http://127.0.0.1:8674/health
# {"ok": true, "release": "..."}

curl -sS http://127.0.0.1:8674/api/status
# busy/device/mode/worker plus the bounded job history
```

After an idle period, expect `worker.loaded: false`; after the first generation it should be
`true` until the idle unload fires.

### Tiny generation

```bash
curl -sS -X POST http://127.0.0.1:8674/api/generate \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:8674' \
  -d '{"prompt":"a brass harbor bell on wet stone, painterly","seed":0,"steps":10,"cfg":3}'
# 202 {"id":"...","batch":"..."}

curl -sS http://127.0.0.1:8674/api/status -H 'Accept: application/json'
# find the id; expect status done and image "/images/<id>.png"

curl -sS -o /tmp/supra2-check.png -H 'Accept: image/png' \
  "http://127.0.0.1:8674/images/<id>.png"
file /tmp/supra2-check.png    # PNG image data, 256 x 256
```

Then repeat `/health` from another tailnet machine using the machine's tailnet address, and
confirm it is not reachable from outside the tailnet.

### Expected timings as historical context

The table below is a summary of a `/api/status` snapshot captured on 2026-09-22 from the
current deployment, which reported `device: "CPU"`. These numbers are historical observations,
not an SLA, and not a benchmark of the ROCm path. Re-measure on your host and record the
result.

| Steps | Warm median (range) | Samples |
| --- | --- | --- |
| 10 | 1.5 s (1.2–1.8) | 31 |
| 20 | 2.4 s (2.3–3.0) | 31 |
| 30 | 3.3 s (2.4–4.1) | 39 |
| 40 | 4.3 s (4.1–4.4) | 16 |
| 100 | 9.5 s (9.4–11.9) | 6 |

Cold starts in the same snapshot reported about 7–8 seconds wall clock while the warm
generation itself was still only 1.3–2.5 seconds, i.e. the extra time was worker load.
Repeated prompts can hit the service's prompt-encoding cache (the snapshot reports
`prompt_cache_hit: true` with near-zero `prompt_encode_seconds`); that is a service detail, not
something Velvet depends on.

## Upgrade and pinning policy

- Pin the model commit (`10dec6e4b4b5d1c44fd1d7d3fe5e50137333da5b` as of this writing) and the
  checkpoint size and SHA-256 in the deployment notes. Never auto-update on restart and never
  fetch `main` unattended.
- On an intentional upgrade: fetch the new commit, recompute `stat -c %s` and `sha256sum`,
  restart, verify `/health` (`release` changed) and `/api/status` (`device`, `worker.threads`,
  `idle_unload_seconds`), re-run a tiny generation, and re-measure timings before pointing
  Velvet at it.
- Record the surrounding versions too: Python, `torch`, `transformers`, `diffusers`, ROCm, and
  kernel. The service should keep `release` tied to its own build so a protocol mismatch is
  visible without reading logs.
- Keep the service private across upgrades: a new deployment does not change the tailnet-only
  rule.

## License and attribution note

The model metadata declares `apache-2.0`, but **no LICENSE file is shipped in the upstream
repository**. Commercial use is permitted by the declaration; keep a copy of that statement,
the model card reference, and this attribution note with the deployment, and ask the authors to
add the missing file upstream. Do not relicense the weights.

Two practical consequences:

- The checkpoint is an fp32 pickle loaded with `weights_only=False`. It is an arbitrary-code
  execution surface; keep it pinned and hash-verified, and prefer a verified safetensors
  conversion if one is ever produced rather than trusting an arbitrary repack.
- The model ships no moderation. Any player-visible use needs review and a policy decision on
  input/output filtering supplied by us; the private tailnet deployment is a reachability
  control, not content moderation.

## Related documents

- [Scene image integration](scene-image-integration.md) - the Velvet-side operator and
  developer guide.
- [Image generation integration (proposed)](image-generation-integration.md) - model facts,
  hosting options, and the phased plan.
- [Supra2-IMG inference setup prompt](supra2-inference-setup-prompt.md) - the historical
  bring-up handoff and report template.
- [Operations](operations.md#environment) - Velvet environment setup and the
  `VELVET_SCENE_IMAGES_*` keys.
