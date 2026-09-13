# Optional OmniVoice support

Status: implemented opt-in core, not the full future voice roadmap. Text, game commands, receipts and narration publication remain authoritative. Voice is a presentation sidecar and cannot advance or retry mechanics. No game-schema migration, ruleset or content-catalog change is required.

## What works

- Campaign-wide persistent narrator/NPC casting keyed by stable IDs, never names. Duplicate names stay separate; renaming does not change an assignment.
- One shared voice surface in the campaign play workspace: Cast & Voices, source picker, explicit Play, Pause/Resume, Stop listening, Replay, and exact captions. History never autoplays. Refresh voices discovers newly published sources.
- Guarded public Director narration and the selected completed adventure transcript variant. Private proposals/provider responses, declarations, player-character speech and arbitrary client text are not accepted as speech sources.
- Legacy prose defaults to narrator. The optional line-speaker editor explicitly attributes server-generated caption chunks to narrator or currently present NPC IDs. It does not infer speakers from names or quotations. This is presentation attribution by the trusted operator, not a claim that the model emitted structured dialogue.
- Versioned casting and script edits with optimistic revision checks. Script GET also returns an opaque source-version digest; saves require both that digest and the attribution revision, rejecting changed publication with 409. Source text/completion revision, speaker assignment revision and complete voice recipe are snapshotted in render identities. Changed text/swipes cannot authorize an old asset as current text. Existing completed jobs retain their original voice recipe until cache expiry; a future play after recasting creates a new render.
- Configured server-to-server OmniVoice adapter, synthetic design or explicitly approved locked profiles, bounded work, failure isolation, WAV byte streaming with HEAD/single-range support, and restart-safe presentation storage.

## Honest streaming semantics

The inspected Studio POST `/generate` synthesizes a whole utterance before returning WAV chunks. This is NOT token-real-time speech synthesis. Velvet splits exact published text into at most 32 short utterances (each at most 240 UTF-16 code units; total source at most 7,680). It synthesizes sequentially and serves each ready WAV immediately through same-origin audio endpoints. The browser uses an audio element, not a downloaded MP3 or a full-scene concatenation step.

There is one exclusively owned worker per sidecar, at most eight pending jobs, and one-utterance lookahead: requesting an available WAV permits the next utterance to synthesize. Merely polling does not synthesize the remainder. Browser pause can leave that one lookahead underway. Node streams response bytes with transport backpressure. No assumption is made that other Studio applications share this queue.

Idle pending jobs cancel after 60 seconds without status/audio activity. The browser polls with a finite budget. The configurable inference deadline defaults to 300 seconds per utterance; network cancellation cannot guarantee that Studio stops its CPU/GPU work. No automatic synthesis POST retries occur. Only after acquiring exclusive ownership, startup cancels unknown pending jobs rather than replaying uncertain external effects. Worker selection and persistence failures are contained; broken storage disables this voice instance until restart, without automatic retry loops or unhandled promise rejections. Explicit Replay can request audio again without touching game mechanics. Stopped completed audio remains cached for replay.

## Server configuration (disabled by default)

Set these in the **Velvet server environment**, not in browser/Vite public configuration:

```sh
FEATURE_RPG_CAMPAIGN=true
FEATURE_RPG_MECHANICS=true
VELVET_VOICE_ENABLED=true
OMNIVOICE_BASE_URL=http://127.0.0.1:13900
VELVET_VOICE_TIMEOUT_MS=300000
VELVET_VOICE_DEFINITIONS='[{"id":"narrator-warm","label":"Warm synthetic narrator","language":"en","seed":4271,"instruct":"male, middle-aged, moderate pitch, british accent","revision":"v1","model":"operator-installed-omnivoice"}]'
```

The URL is fixed by the operator; requests cannot supply URLs, credentials, engines, files, reference recordings, instructions, text, or raw profile IDs. HTTP/HTTPS root origins only, no embedded credentials/query/fragment. Redirects are rejected. Set a truthful model/version label and increment `revision` when changing an installed model or recipe. The adapter does not switch or install backend models. Restart Velvet to apply configuration changes. Invalid optional configuration disables voice without blocking text play.

The development Vite proxy may rewrite Host. If so, explicitly allow its browser origin in the server environment:

```sh
VELVET_VOICE_ALLOWED_ORIGINS=http://localhost:5173
```

Use the actual origin (including port); multiple trusted browser origins are comma-separated. No wildcard. In production prefer a same-origin reverse proxy preserving Host. This check is CSRF defense, not user authentication, and does not add CORS access to Studio. Cross-site browser requests remain denied.

Only `VELVET_VOICE_ENABLED=true` enables voice. Unset it or set it to `false` and restart to return to the unchanged text-only surface. There is no database access or backend call from the disabled voice route.

### Synthetic recipes and stable character voices

Studio's inspected model accepts restricted instruction tags, not arbitrary descriptions. For example `female, young adult, moderate pitch, american accent` or the configuration above. Supported tags depend on the installed model; an unsupported recipe fails audio only. A fixed design instruction/seed is reproducible configuration, **not a guarantee of identical speaker acoustics across different text**.

For recognizable recurring characters, use an operator-approved game-only **locked reference profile**. Synthetic reference clips can be designed and auditioned in Studio; creating/locking profiles is deliberately outside Velvet's browser API. Do not use a real person's recordings without authorization. Never bulk-list or import a personal profile library.

A profile definition substitutes `profileId` and `profileDigest` for `instruct`, retaining the other fields. Obtain the digest for one explicitly approved profile with:

```sh
OMNIVOICE_BASE_URL=http://127.0.0.1:13900 \
OMNIVOICE_APPROVED_PROFILE_ID=approved-profile-id \
node_modules/.bin/tsx scripts/inspect-omnivoice-profile.ts
```

This read-only helper prints the approved ID and metadata digest, not reference paths or transcripts. Store the digest in operator configuration. Before every synthesis the adapter GETs only this configured profile and verifies its identity, locked state and digest; missing/edited profiles fail closed rather than falling through to Studio's default voice. The digest covers profile reference-path metadata, transcript, instructions, language, seed and lock state. It cannot detect someone replacing reference-file bytes in place while leaving metadata unchanged. Operators must revision/reapprove such changes and pin the actual backend/model separately. Historical already-cached audio is not regenerated merely because a profile changes.

## External backend deployment: optional SSH/Tailscale

Studio need not be installed on the Velvet host. Keep Studio loopback-only on the machine where its operator already runs it. Do not expose its broad profile/file API just to add game voice.

With an authorized SSH account, verified host key and permitted forwarding, open a loopback-only tunnel from the Velvet server host:

```sh
ssh -N -T -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:13900:127.0.0.1:3900 voice-operator@voice-host.example
```

`voice-host.example` and `voice-operator` are placeholders. They can be an operator-supplied private DNS/Tailscale name and account. Do not disable host-key checks, guess credentials, copy private profile directories, or bind the forwarding port to `0.0.0.0`. Tailscale is optional transport; use its ACLs/grants to permit only authorized SSH access. This integration does not run `tailscale serve`, Funnel, alter listeners, or change Studio CORS.

From the same network namespace as the Velvet server:

```sh
curl --fail --connect-timeout 5 --max-time 15 http://127.0.0.1:13900/health
```

Set `OMNIVOICE_BASE_URL` to that forwarded URL. Supervise the SSH tunnel for deployments. Containers/VMs have their own localhost: run the tunnel alongside the server or use a deliberately restricted private connection. Do not solve namespace issues by exposing Studio publicly. An existing authenticated private HTTPS gateway may be used only if the operator has reviewed its API exposure and access policy; TLS verification stays enabled.

## Storage, authorization and operations

Voice data lives in `voice/presentation.sqlite` beneath `VELVET_DATA_DIR`. It has its own versioned schema and private file permissions; canonical game tables are never extended. A companion `presentation.sqlite.owner.sqlite` connection holds an exclusive SQLite lock before schema initialization or recovery. A second owner fails closed without cancelling the first owner’s work. The lock is released by the operating system on process death; graceful close retains it until any outstanding provider promise settles. Use a local filesystem with working SQLite locks; do not delete/replace the sidecar or its lock file while running, create hard-link aliases, or share the directory over an unsupported network filesystem. Game publication remains the source of truth: sidecar records are created only after a read validates committed public narration, then source authorization is repeated before generation, before asset publication and for every job/audio read. There is no cross-database atomic publication claim and no speech outbox inserted into game transactions.

The API follows Velvet's current trusted-local `local-owner` adapter and additionally requires owner/GM campaign membership. Request headers never select a principal. This is not remotely authenticated multiplayer; keep Velvet behind its existing trusted-local/private access boundary. Audio is not a public static folder. Do not expose the server to untrusted network users.

Limits: 8 MiB per WAV, validated PCM/float RIFF WAV, at most 120 seconds per utterance; 128 MiB retained audio payload, at most 128 cached jobs, 24-hour terminal-job retention. Eviction reserves capacity for incoming bytes/jobs, removes oldest eligible terminal entries, and never deletes pending segments to admit new work. Pending work cannot bypass the payload quota. SQLite may retain free pages/WAL space until checkpoint/vacuum; the payload quota is not a filesystem quota. Casting and script mappings are durable, not evicted with audio. Deleting the sidecar while Velvet is stopped removes all local voice mapping/cache; losing voice data cannot alter gameplay. Back up the sidecar and operator definitions alongside the matching game database if desired, with normal private-backup controls. A campaign transfer/export does not currently contain casting, scripts or audio; imports never trigger speech generation.

Studio itself persists generation outputs/history and some source text. Clearing Velvet's audio does NOT erase Studio history. Retention/deletion must be managed in both systems. The smoke helper writes its explicitly requested synthetic sample to a local operator-selected path, but normal gameplay only streams browser audio.

## Verification commands

```sh
npm run test --workspace velvet-mvp-server -- test/voice.test.ts test/voice-hardening.test.ts test/voice-adapter.test.ts test/voice-sources.test.ts test/voice-routes.test.ts
npm run test --workspace velvet-mvp-client -- src/voice
npm run typecheck --workspace velvet-mvp-server
npm run typecheck --workspace velvet-mvp-client
npm run typecheck:e2e
npm exec -- tsc --noEmit --project ./scripts/tsconfig.voice.json
node_modules/.bin/playwright test --config playwright.voice.config.ts
```

The dedicated browser E2E creates disposable game/voice DBs and a deterministic HTTP WAV backend, drives the real play workspace and audio element, verifies sequential requests, controls and persistence across server restart, and checks unchanged campaign revision. It does not call a real model.

An explicit short **synthetic-only** real backend smoke, never selecting a saved personal profile:

```sh
OMNIVOICE_BASE_URL=http://127.0.0.1:13900 \
VELVET_VOICE_SMOKE_OUTPUT=/tmp/velvet-synthetic-smoke.wav \
node_modules/.bin/tsx scripts/smoke-omnivoice.ts
```

Initial implementation verification: real backend returned a valid 67,724-byte mono PCM WAV at 24 kHz, duration 1.41 seconds, generation request elapsed 6.844 seconds. This is one availability/format/latency sample, not an acoustic-consistency benchmark. The first synthetic instruction failed because Studio requires supported tags; the corrected smoke uses them. No Studio installation, service exposure or personal profile was changed.

## Explicitly deferred

Automatic structured Director/NPC dialogue identity contracts, library-character defaults, ordinary RP/swipe voice integration, player-authored spoken dialogue, reference profile authoring/locking UI, pronunciation dictionaries, cross-source autoplay/global ordering, per-tab leadership, portrait highlighting, audio portability, distributed multi-worker scheduling and microphone transcription. The core uses explicit click-to-play and manual chunk attribution instead of pretending these are implemented. Existing unrelated gameplay/transport risks from earlier planning are not silently fixed in this voice change.
