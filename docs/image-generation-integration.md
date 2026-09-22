# Image generation integration (proposed)

This is a design proposal, not a shipped contract. Today the only image support in the
repository is the disabled `images` discovery flag
(`packages/contracts/src/feature-flags.ts`, `server/src/routes/roleplay/system.ts`,
`client/src/App.tsx`); there is no adapter, route, storage, contract, or UI. The plan below
keeps the feature optional, provider-agnostic, and review-gated, mirroring the two shipped
precedents: the voice sidecar (`server/src/voice/**`) for generated media bytes, and the
System One / Jev lane (`server/src/agent/systemOne*.ts`, `server/src/provider/systemOneCompletion.ts`)
for paid-provider gating, budgets, and promotion evidence.

## Candidate model: SupraLabs/Supra2-IMG

Facts verified 2026-09-22 from the model card and its files:

- **Task**: text-to-image only; no img2img, editing, inpainting, or upscaling paths.
- **Architecture**: custom `SupraDiT` (104.1M parameters, depth 14, AdaLN-Zero, rectified
  flow), frozen `google/flan-t5-base` text encoder and `stabilityai/sd-vae-ft-mse` VAE loaded
  at runtime.
- **Output**: fixed **256x256**. There is no resolution parameter.
- **Checkpoint**: `model_final_ema.pt`, 416,651,529 bytes, an fp32 **pickle** state dict
  (`torch.load(..., weights_only=False)`), no safetensors, no diffusers pipeline, no GGUF.
  `config.json` advertises `transformers`/`auto_map` entries that do not exist in the repo, so
  `AutoModel.from_pretrained(...)` fails; the bundled `inference.py` or the demo Space's `app.py`
  must be used.
- **License**: declared `apache-2.0` in metadata, but **no LICENSE file is shipped**. Commercial
  use is permitted per the declaration; keep a copy of the license statement on file and ask the
  authors to add the file upstream.
- **Hosting**: no Hugging Face Inference Provider serves it. A dedicated Inference Endpoint would
  need a custom container (not vLLM/TGI-compatible). There is an official ZeroGPU demo Space
  (`hugging-apps/supra2-img-demo`) with a callable `/generate` Gradio endpoint, usable for
  prototyping only (shared quota, 15 s GPU cap, no SLA).
- **Hardware**: no published VRAM guidance. Component weights sum to ~1.74 GB fp32, so 4-8 GB of
  VRAM is a plausible working estimate, but this is unverified and no quantization exists.
  Published Endpoint rates: T4 ~$0.50/hr, L4 ~$0.80/hr, A10G ~$1.00/hr.
- **Safety**: no safety checker, no NSFW filter, no watermarking, no usage policy beyond
  Apache-2.0 and the HF terms. Any exposure needs input and output moderation plus provenance
  logging supplied by us.

Honest fit assessment: 256x256 makes it suitable for portraits, tokens, icons, and handout
thumbnails, not full scene art. The integration should therefore be **provider-agnostic**: a
text-to-image HTTP contract with Supra2-IMG as the first, self-hosted adapter, so a larger model
can replace it without touching storage, review, or UI.

## Recommended architecture

### 1. Provider adapter (`server/src/provider/imageGeneration.ts`)

- A bounded, strict request/response contract (`packages/contracts/src/image-generation.ts`):
  `prompt`, `seed`, `steps`, `guidanceScale`, `width`/`height` (validated against the adapter's
  supported set), `count` (bounded), plus a response of asset bytes or a fetchable URL with
  content hash.
- Config read modeled on `readVoiceConfig` (`server/src/voice/omnivoice.ts`): an explicit opt-in
  plus base URL, model identifier, timeout, and max bytes. Suggested proposed keys:
  `VELVET_IMAGES_ENABLED`, `VELVET_IMAGES_BASE_URL`, `VELVET_IMAGES_MODEL`,
  `VELVET_IMAGES_TIMEOUT_MS`, `VELVET_IMAGES_MAX_BYTES` (mirroring the voice naming).
- Host validation reuses the `validateSystemOneBaseUrl` pattern
  (`server/src/provider/providerTransport.ts`): HTTPS or loopback only, no arbitrary hosts.
- No automatic retry on ambiguous outcomes (same rule as campaign generation and voice jobs);
  failures surface as uncertain, not duplicated spend.
- Deterministic fake (`server/src/provider/imageGenerationFake.ts`) returning fixed bytes for
  offline tests, mirroring `systemOneFake.ts`.

### 2. Storage and serving (`server/src/image/**`)

- **Sidecar SQLite per world** (`image/presentation.sqlite`) rather than BLOBs in
  `velvet.sqlite`, copying `server/src/voice/service.ts`: directory 0700, file 0600, bounded
  cache quota, expiry, prune, owner lock.
- Assets are content-addressed (`sha256`), with a request row capturing prompt hash, model,
  seed, steps, byte size, and status. A generation is a job with a dedup key of
  `(artifact identity, prompt hash, model, seed)`.
- Serving route `GET /api/rpg/v1/campaigns/:campaignId/images/:assetId` with a content-type
  allowlist (`image/png`, `image/webp`), `X-Content-Type-Options: nosniff`, private caching,
  byte-range support, and the campaign authorization rules already used for published materials
  (copy `server/src/voice/routes.ts` range handling).

### 3. Attach images to existing artifacts, not a new content system

The product surface already exists as reviewed text artifacts:
`campaign_generation_accepted_artifacts_v52` (`handout`, `scene-prompt`) with GM review and
explicit publication through `POST .../material-publications`
(`server/src/routes/rpg/v1/campaignContentGeneration.ts`,
`server/src/repo/campaignGenerationRepo.ts`). Extend those records with an optional
`assetId`/image reference, plus new campaign-generation sections (`scene-illustrations`,
`character-portraits`) if generated prompts are wanted. Publication stays explicit and
visibility-aware; images must never leak GM-only identities to players.

### 4. Client media rendering

- A small `MediaImage` component with loading, error, and placeholder states, rendered from
  the published-materials projection at the two existing text sites
  (`CampaignContextDrawer.tsx`, `CampaignGeneratorPanel.tsx`).
- No markdown/HTML image support is needed or wanted; keep text escaped as today.
- Provider settings surface alongside the existing provider controls
  (`PromptSettings.tsx`) and remain opt-in.

### 5. Gating, evidence, and budget (Jev rules apply)

- Discovery flag plus explicit opt-in, exactly like voice (`FEATURE_VOICE` vs
  `VELVET_VOICE_ENABLED`). Flags are rollout controls, never security.
- Budget reserve/settle with a per-lane window, modeled on
  `server/src/agent/systemOneBudget.ts`, and usage recorded through `recordUsageEvent`
  (`server/src/repo/messageRepo.ts`).
- New lanes start **off/shadow**; enabling generation in play requires a frozen evaluation
  binding and a passing promotion gate, modeled on `systemOneBinding.ts` /
  `systemOnePromotion.ts`. Curated benchmark evidence cannot authorize production use.
- Generated images are always candidates requiring review; nothing auto-publishes.

## Hosting options

| Option | Fit | Cost |
| --- | --- | --- |
| Self-hosted wrapper service (vendored `inference.py`, pinned commit, hash-verified checkpoint) | **Recommended**: full control, offline testable, no third-party SLA | T4/L4 GPU from ~$0.50-0.80/hr while running |
| HF Inference Endpoint with a custom container | Managed scaling, scale-to-zero possible | Same GPU rates, custom image maintenance |
| Official demo Space `/generate` | Prototyping only | Free, shared quota, no SLA |
| HF Inference Providers | **Not available** for this model | n/a |
| Local CPU/MPS | Technically supported by the script, likely too slow for play | n/a |

Vendoring steps for the self-hosted option: pin commit `10dec6e4`, verify the checkpoint
hash (`e96aa053...`), ship a small FastAPI/Gradio service wrapping
`inference.py --seed 0 --cfg 3.0 --steps 50`, and expose a token-authenticated endpoint the
Velvet adapter can call.

## Risks and open decisions

1. **Art quality/utility**: 256x256 fixed output may not meet production art expectations; decide
   whether images are thumbnails/portraits only, or whether the provider contract should require
   higher-resolution models as a baseline.
2. **Checkpoint trust**: the shipped pickle is an arbitrary-code-execution surface. Prefer the
   third-party safetensors conversion only after verifying hashes, or write our own converter.
3. **Licensing hygiene**: no LICENSE file upstream; record the Apache-2.0 declaration and
   training-data provenance (FLUX-derived synthetic data) in the project notice before shipping.
4. **Moderation**: nothing is provided; decide input/output filtering ownership before any
   player-visible generation.
5. **Where generation runs**: a separate process/container is strongly preferred over in-process
   Python or a GPU dependency in the Node server.
6. **Budget approval**: per the project rule, no paid provider calls without explicit owner
   approval; phases 1-3 below must stay fake/offline.

## Phased plan

1. **Contracts and flags (offline)**: schemas, adapter interface, fake, config parsing, feature
   flag wiring, tests. No network.
2. **Sidecar storage and serving (offline)**: job/dedup model, quota/prune, asset route with
   ranges, tests using the fake adapter.
3. **Artifact attachment and review UI (offline)**: optional image references on accepted
   artifacts, publication rules, client media component, deterministic E2E with the fake.
4. **Self-hosted service (owner-approved)**: wrapper container, pinned model, hash check,
   moderation hooks, budget accounting, then a bounded live canary with an explicit budget.
5. **Evaluation and promotion**: frozen binding, measured quality/cost/latency, per-family
   metrics, and a promotion decision — none of which the current evidence can substitute for.
