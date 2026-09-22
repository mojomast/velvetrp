# Supra2-IMG inference setup handoff prompt

Status: paste-ready handoff for an agent on another tailnet machine to self-host the
`SupraLabs/Supra2-IMG` text-to-image service used by the image generation plan
([image-generation-integration.md](image-generation-integration.md)). It is written to be copied
verbatim into that agent's session. The service is private to the Tailscale tailnet, token
authenticated, and matches the phase-1 client contract in
`server/src/provider/imageGeneration.ts` (`POST /generate`, `GET /health`, bounded fields, PNG
base64 results). Return the `SUPRA2 SERVICE REPORT` block from the end of the prompt so the
endpoint can be wired into `VELVET_IMAGES_BASE_URL`/`VELVET_IMAGES_TOKEN` and smoke-tested.

```text
Set up a private text-to-image inference service for the Velvet project on this machine.
It will be reached over the Tailscale tailnet only. Do NOT expose it to the public
internet, do NOT enable Tailscale Funnel, and do not bind a public interface.

GOAL
Serve SupraLabs/Supra2-IMG (104M text-to-image DiT, fixed 256x256) over a small
token-authenticated HTTP API that the Velvet dev box can call.

STEP 1 — Prerequisites
- Python 3.10–3.12, pip, git, curl. NVIDIA GPU strongly preferred (CPU works but is slow).
- Record: GPU model, VRAM, `nvidia-smi` driver/CUDA version, Python version.

STEP 2 — Workspace
mkdir -p ~/supra2-service && cd ~/supra2-service
python3 -m venv .venv && . .venv/bin/activate
pip install --upgrade pip
pip install torch torchvision transformers diffusers sentencepiece tqdm huggingface_hub fastapi uvicorn

STEP 3 — Vendor the model pinned (do not use transformers AutoModel; its config is broken)
COMMIT=10dec6e4b4b5d1c44fd1d7d3fe5e50137333da5b
wget -O inference.py https://huggingface.co/SupraLabs/Supra2-IMG/resolve/$COMMIT/inference.py
wget -O model_final_ema.pt https://huggingface.co/SupraLabs/Supra2-IMG/resolve/$COMMIT/model_final_ema.pt
- Expected checkpoint size: 416651529 bytes (verify with `stat -c %s`).
- Compute `sha256sum model_final_ema.pt` and report it. For reference the Hub
  x-linked etag was e96aa0537e0fd120af82b3a606dd50c90ae079ac7aa97b38a8da4882daeeee48
  (may not equal the sha256).
- If the pinned commit no longer resolves, use the current main commit and report it.

STEP 4 — Smoke-test the original script before writing any server
python inference.py --prompt "a weathered harbor lighthouse at dusk, painterly" \
  --seed 0 --cfg 3.0 --steps 50 --n 1 --out /tmp/supra2-smoke.png
- Report: success/failure, whether CUDA or CPU was used, wall-clock seconds, image size.

STEP 5 — Write server.py (FastAPI + uvicorn) with EXACTLY this contract
- Load the model once at startup (DiT + flan-t5-base + sd-vae-ft-mse), keep it warm,
  serialize generations with a single asyncio lock (one GPU), bound the queue
  (return HTTP 429 beyond ~4 pending).
- Auth: generate TOKEN=$(openssl rand -hex 32). Require header
  `Authorization: Bearer $TOKEN` on /generate. /health may be unauthenticated.
- Endpoints:
  * GET /health -> {"status":"ok","model":"SupraLabs/Supra2-IMG","commit":"<commit>","device":"cuda"|"cpu"}
  * POST /generate
      request: {"prompt": string(1..2000), "seed": int 0..2147483647 = 0,
                "steps": int 10..100 = 50, "guidanceScale": number 1..8 = 3,
                "count": int 1..4 = 1}
      success:  {"images":[{"format":"png","base64":"..."}], "seed": <used seed>, "seconds": <float>}
      failure:  {"error":"<message>"} with 400/429/500; never include the token
- Validate bounds and reject unknown fields. Never log the token; prefer not logging
  full prompts.
- Bind: uvicorn server:app --host 0.0.0.0 --port 8674 (or bind the tailnet IP
  explicitly). Tailscale only; no port forwarding.

STEP 6 — Run persistently
Prefer a systemd user unit (~/.config/systemd/user/supra2.service) with
`Restart=on-failure`, or `nohup`/`screen` if systemd user units are unavailable.
Report how it was started and whether it survives logout/reboot.

STEP 7 — Verify
Local:  curl -s http://127.0.0.1:8674/health
Generate:
curl -s -X POST http://127.0.0.1:8674/generate \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"a brass harbor bell on wet stone, painterly","seed":0,"steps":50,"guidanceScale":3,"count":1}'
Tailnet: IP=$(tailscale ip -4 | head -1); curl -s http://$IP:8674/health

STEP 8 — Report back to the owner with EXACTLY this block filled in:

SUPRA2 SERVICE REPORT
tailnet hostname: <hostname or machine.tailnet.ts.net>
tailnet IPv4: <100.x.y.z>
port: 8674
token: <the openssl rand -hex 32 token>
health response: <raw JSON>
generate response: <base64 length, seed, seconds; do not paste the whole base64>
tailnet reachability: <curl output from the tailnet IP>
model commit: <hash used>
checkpoint sha256: <hash> (<bytes> bytes)
device: <cuda|cpu>; GPU: <model>; VRAM: <GB>
versions: python <x.y.z>, torch <x.y.z>, transformers <x.y.z>, diffusers <x.y.z>
service: <systemd unit name | pid | other>
latency: <seconds per 256x256, 50-step image, cold and warm>
quirks: <anything unusual: warnings, download issues, memory, CUDA issues>

Keep the token private outside this report. If anything fails, report exactly where
and the error output rather than guessing.
```
