# OmniVoice Studio support: proposed design

Status: planning only, based on source review of VelvetRP commit ceb2aa6cf2141d1f097783de3e9990b0e3ee7887 and the installed local OmniVoice deployment. No application feature has been implemented. No user database was opened or migrated. No voices were generated, reference audio uploaded, or changes pushed.

## Product direction

Make Velvet an optionally voiced tabletop: a persistent narrator, recognizably distinct NPCs, player-controlled speech where explicitly authored, and a transcript-first playing surface. Text and authoritative gameplay must work with voice disabled, disconnected, slow, or failed. A voice job is presentation, never a game command.

Recommended defaults: opt-in playback; campaign-wide casting across rooms; one synthesizer worker initially on the current CPU backend; narrator fallback for unattributed legacy prose; independent local listening controls; no automatic player-character dialogue; no voice commands in the first release.

## What the existing project gives us

- React client, Fastify server, SQLite; shared Zod contracts in packages/contracts. The model proposes, repository transactions determine what becomes true, and narration follows committed mechanics.
- CampaignPlayPage.tsx composes the actual CommandCenter.tsx three-pane workspace: context/map, narration/composer, tools/character summary. PlaySurface.tsx also contains shared tool types and drawers; do not implement against the old layout alone.
- CampaignConversation.tsx displays durable adventure turns and live events. CampaignDmChronicle in CampaignDmPanel.tsx is a separate Director history surface. A shared playback coordinator must cover both rather than installing competing players in each component.
- Ordinary roleplay messages have speakerCharacterId. PersonaProfile.voice is descriptive prose, not a synthesizer identity. RPG actors, campaign NPCs, and persona characters are separate identity namespaces.
- server/src/agent/dmNarration.ts already accepts atmosphere, dialogue speaker/text pairs, and an optional question. parseDmScene currently flattens them into one string and validates speakers by public cast name. Preserve structured output and replace name identity with server-issued references.
- Adventure narration uses a validated text tool. Its narration_delta currently contains completed narration, unlike provisional token streaming in the ordinary roleplay path. Never assume the event name means audio can safely start on arbitrary tokens.
- Director settlement is not necessarily public publication: later checks can still block it. Speech must follow guarded publication to dm_public_history, not the raw provider response.
- Narration swipes/retries can retain the root transcript identity while changing selected text. Audio must identify the concrete variant, not just the root turn.
- Schema opening validates exact SQLite objects. New tables need the project's canonical schema and recognized transactional upgrade, not ad hoc CREATE TABLE calls.
- Campaign export is a deliberately limited v1 projection, not a full database backup. Existing transfer does not automatically preserve NPC/persona graphs or narration. Voice portability must explicitly account for this.
- Current HTTP access is trusted-local/local-owner, not authenticated remote multiplayer. Keep application listeners loopback-only by default; connect the remote Velvet backend through the authorized SSH-over-Tailscale tunnel described below, or an explicitly approved restricted tailnet proxy. This does not add remote player authentication.

## Remote builder handoff: reaching this OmniVoice host over Tailscale

The implementing agent and Velvet server run on another machine. OmniVoice runs on **Kimi**, not on the builder's localhost. Use the connection instructions below; do not install a second Studio instance or copy this host's private profile/database directories just to obtain access.

### Verified host state

Inspected on 2026-09-13:

- MagicDNS/FQDN: `kimi.tailec998.ts.net`
- Tailscale IPv4: `100.125.104.79`
- OmniVoice backend on Kimi: `http://127.0.0.1:3900`
- GET `/health` on that local address returned `{"status":"ok","device":"cpu"}`.
- Socket inspection showed OmniVoice bound to `127.0.0.1:3900`, not the Tailscale interface. A direct request to `http://100.125.104.79:3900/health` failed to connect. Do not use that as the remote base URL.
- SSH listens on port 22. Remote SSH credentials, forwarding permissions, and the builder's tailnet access have NOT been verified.
- `tailscale serve status` showed no proxy to port 3900. The existing HTTPS port 10444 serves podcast files through port 3910; it is NOT the OmniVoice API. The host's root HTTPS URL also serves another application.

No listener, firewall, ACL, service, or Tailscale route was changed for this documentation update. Host-local verification does not prove connectivity from the other machine; the builder must run the following checks from the actual backend runtime/container.

### Recommended development connection: SSH forwarding over Tailscale

Prerequisites: the builder machine is connected to the same tailnet (or has an explicitly authorized shared-node path); tailnet grants/ACLs allow SSH to Kimi; and the owner has supplied an authorized SSH login/key with forwarding permission. `mojo` is the local account shown in this plan, not a promise that the remote agent has credentials. Never copy passwords or private keys into the plan.

On the builder machine, confirm identity/connectivity:

    tailscale status
    tailscale ping kimi.tailec998.ts.net

Open the tunnel in a dedicated terminal or supervised process:

    ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:13900:127.0.0.1:3900 mojo@kimi.tailec998.ts.net

Use normal SSH host-key verification; verify an unfamiliar host fingerprint with the owner, and do not disable StrictHostKeyChecking. If MagicDNS is unavailable, `mojo@100.125.104.79` is the inspected tailnet-IP alternative. Do not guess credentials or bypass a forwarding denial. If port 13900 is occupied, choose another unused loopback port and update the base URL consistently.

In another terminal on that same machine:

    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 http://127.0.0.1:13900/health
    curl --fail --silent --show-error --connect-timeout 5 --max-time 30 http://127.0.0.1:13900/openapi.json -o omnivoice-openapi.json

Expected health shape is status `ok`; this host reported device `cpu` when inspected. These are builder instructions, not claimed remotely executed results.

Proposed **server-side** Velvet configuration to implement:

    OMNIVOICE_BASE_URL=http://127.0.0.1:13900

This environment variable is a proposed integration setting, not something the current Velvet code already consumes. Validate it against the configured backend allowlist. The HTTP hop is local loopback at each endpoint; SSH over Tailscale carries the cross-machine traffic. Bind the tunnel to loopback only, never `0.0.0.0`.

If Velvet runs in Docker, a VM, or an agent sandbox, its `127.0.0.1` is not necessarily the host running the tunnel. Prefer running the tunnel in the same network namespace as the Velvet server, or use a deliberately configured private host/sidecar connection. Do not fix a namespace problem by exposing Studio publicly. Test `/health` from the same runtime that will issue synthesis requests.

Keep the tunnel supervised for a deployed integration; a terminal-only tunnel ends with its process. Loss of the tunnel must mark voice unavailable while leaving gameplay usable.

### Optional deployment connection: dedicated tailnet-only HTTPS

This option is NOT configured as of this review. It requires an owner/operator to approve access to the Studio API, inspect current routes/port usage, and restrict the builder/backend identity using tailnet grants/ACLs. Studio includes profile mutation and private reference-audio routes; tailnet membership is not a substitute for campaign authorization. Prefer a narrow authenticated proxy for any users beyond the trusted operator/backend.

For an owner-approved direct Studio proxy, 13900 is a proposed dedicated HTTPS port, not a verified existing endpoint. On Kimi, first inspect:

    tailscale serve status
    ss -ltn '( sport = :13900 )'

If it is available and the access policy is approved, the host operator can add only this mapping (using administrator privileges if required):

    tailscale serve --bg --https=13900 http://127.0.0.1:3900

Then the remote server base URL would be:

    OMNIVOICE_BASE_URL=https://kimi.tailec998.ts.net:13900

Verify from the actual builder/backend runtime:

    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 https://kimi.tailec998.ts.net:13900/health
    curl --fail --silent --show-error --connect-timeout 5 --max-time 30 https://kimi.tailec998.ts.net:13900/openapi.json -o omnivoice-openapi.json

Keep TLS verification enabled. Use the FQDN, not a raw IP HTTPS URL with an invalid certificate. Do not use Tailscale Funnel, reset Serve configuration, reuse the podcast port, or overwrite unrelated routes. Adding this route would expose the Studio application to principals permitted by tailnet policy; it does not create a restricted game-only API by itself. Do not execute this optional setup without the stated access review.

### Cross-machine integration details

- Browser → Velvet server → configured OmniVoice connection. Do not put the Studio URL or raw profile catalog into a browser-facing API, and do not expand Studio CORS to solve server-to-server connectivity.
- Profile IDs belong to the Studio instance on Kimi. Resolve approved game-only profiles remotely, persist logical bindings in Velvet, and report missing profiles instead of silently switching to another instance.
- `X-Audio-Path`, `ref_audio_path`, and `locked_audio_path` are Kimi-local paths, not paths the builder can open. Consume the WAV response bytes from `/generate`, validate them, and cache them on the Velvet host. Do not assume shared storage or construct public file URLs from those headers.
- If creating an approved synthetic profile, submit actual bytes using multipart upload. A path string from another machine is not a file upload. Never bulk-export the existing personal voice library.
- Use short connect/health deadlines, but a separate configurable long inference deadline. Initial recommendation: 300 seconds per short utterance, adjusted after a real latency test; timeout can leave generation running on Kimi. Avoid blind POST retries and coordinate with the shared podcast workload.
- First prove health and OpenAPI access. Then perform an explicitly selected short synthetic-voice synthesis smoke test and verify MIME, decode, duration, profile identity and restart persistence. No remote synthesis test has been performed for this handoff.

### Retrieving this plan on the builder machine

This document is intended to be retrieved from the repository at `docs/omnivoice-support-plan.md`. Update the builder's checkout to the commit containing this plan before implementation. As an alternative, with authorized SSH access the builder can retrieve the host copy without copying secrets:

    scp mojo@kimi.tailec998.ts.net:/home/mojo/.hermes-instances/fresh/workspace/velvetrp/docs/omnivoice-support-plan.md ./omnivoice-support-plan.md

The owner can also transfer this document directly. The companion review reports mentioned below remain host-local; this plan contains the integration decisions and remote connection instructions needed for the handoff.

## OmniVoice adapter and stable-voice authoring

Read-only live GETs for health, OpenAPI and profiles succeeded. API document version is 0.4.0; this is not a model/package version. Existing personal profile contents were not disclosed or selected for this game. Source review used OmniVoice commit b34dcd9e11cfcceb5070622445ccc78cabb4ee49 with unrelated pre-existing modifications left untouched.

Recommended initial adapter: POST /generate consistently, using multipart text, validated profile_id, explicit language, num_step, speed and a documented seed/settings policy. Actual source returns audio/wav and X-Audio-Id, X-Gen-Time, X-Audio-Duration and X-Seed after full synthesis. Keep X-Audio-Path private. Do not rely on OpenAPI's generic JSON success description. This route has no engine selector; do not advertise arbitrary engine switching through it.

A repeated instruction such as “low-pitched British voice” describes casting style, not a stable actor. A fixed seed alone is also not a speaker identity guarantee. Prefer a deliberately approved reference-backed Studio profile, ideally locked, plus a versioned game-side recipe. Synthetic reference samples can be designed and auditioned specifically for the cast; no real person's recording is needed. The later authoring workflow is: design a short synthetic sample, audition/approve, create a game-only profile from that WAV and exact transcript, lock the selected generated sample where appropriate, preserve seed explicitly, and bind it to a stable character ID. Each step must use returned real asset/history IDs and verify the resulting profile; never assume a profile was saved by generating a preview alone.

Important source-backed adapter pitfalls:

- POST /profiles requires both name and uploaded ref_audio; it is not an instruction-only JSON create API.
- /generate prefers locked audio; an unlocked profile with stored instruct can use voice design instead of its uploaded reference. Avoid silently drifting between design and reference modes.
- Missing profile_id currently falls through rather than reliably failing. Velvet must resolve/validate the binding and fail visibly before synthesis.
- Stored profile language is not automatically applied by /generate. Send it explicitly. Personality metadata does not itself control synthesis.
- Locking uses history audio but truncates the copied transcript and can clear the seed if omitted. Use a short, precisely transcribed reference or repair the transcript through the supported update endpoint; verify the seed.
- /v1/audio/speech and /ws/tts have different reference/seed resolution behavior. Do not silently switch routes as a fallback while promising identical character voices.
- Both inspected /generate and /ws/tts finish synthesis before sending audio chunks. A StreamingResponse or WebSocket does not establish low-latency incremental synthesis.
- Studio profiles do not pin model/engine versions. Store that association and profile/reference revision in Velvet, detect external profile edits, and invalidate future render keys.
- /generate persists outputs/history including some narration text. Document retention and deletion in both applications, not just Velvet's cache.

Relevant source: OmniVoice backend/api/routers/generation.py, profiles.py, openai_compat.py, tts_stream.py; backend/core/db.py; backend/services/model_manager.py. Acoustic consistency and latency still require an explicit real synthesis benchmark; neither source inspection nor successful health checks proves them.

## 1. Separate casting, utterances, and playback

Proposed records (names are design suggestions, not existing APIs):

VoiceDefinition: Velvet-owned ID, provider binding, profile identity/revision, engine/model identity, language and bounded baseline settings, display label, verification/missing-profile state. Reference assets and provider paths remain private.

VoiceAssignment: scope + speaker kind + stable speaker ID, VoiceDefinition ID, immutable assignment revision, display-label snapshot, provenance (manual/accepted suggestion). Campaign narrator is an explicit speaker kind/sentinel. Character-library defaults may seed a campaign assignment; they must not overwrite a manually cast campaign NPC later.

Utterance: published source kind/ID/variant/revision, campaign/room/timeline where applicable, sequence, validated speaker reference, exact display text, spoken-text normalization version, assignment revision, audience/source binding. Store the chosen voice revision so historical replay stays stable after recasting.

AudioJob/AudioAsset: unique utterance/render identity, queued/running/ready/failed/cancelled state, bounded attempts, lease/fencing token, duration/format/size, private blob location and generation evidence. ClientPlaybackCursor is a separate local preference, never a campaign mechanic.

Casting rules:

- Key by stable IDs, never display names. Renaming an NPC or encountering two people named Mira must not change or merge their voices.
- Default scope is the campaign across rooms. Decide explicitly whether a future timeline fork inherits or snapshots casting; initial policy is shared casting with historical utterance snapshots.
- Existing library-character choices can be copied as defaults on first use. Campaign overrides remain durable and explicit.
- A missing/deleted OmniVoice profile is visible as unresolved. Offer rebind or an explicit narrator fallback; never silently recast a major NPC.
- Recasting affects future utterances. Historical audio retains its old casting revision; rerender history only on request.
- A disguise, possession or temporary magical effect is a later explicit override, not a permanent mutation inferred from prose.

## 2. Preserve a validated speech script

Refactor Director parsing to return a structured scene plus deterministic rendered text, maintaining the existing safety and mechanics guards. Public cast entries should advertise an opaque server-issued speaker reference mapped to an eligible campaign NPC. The provider chooses only from that list; it cannot discover hidden NPCs by naming them.

Build an ordered sequence of narrator atmosphere, NPC dialogue, and narrator question. Keep committed mechanic summaries distinct from non-authoritative atmosphere and claims. Every utterance should link back to the text source displayed to the player. Spoken normalization can expand abbreviations or apply an approved pronunciation dictionary; it must not rewrite outcomes, omit negation, or invent dialogue.

Initially wrap adventure prose as narrator speech. Later version its narration tool to return validated speaker segments. Ordinary RP can start from persisted message speakerCharacterId, but stage directions and quoted dialogue within a character message remain a separate segmentation problem. Do not pretend regex quotation extraction is reliable attribution.

Only explicitly player-authored speech may use a player-character voice. Do not read a declaration such as “I search the room” as if the character said it aloud by default. Offer a later composer distinction between action and spoken dialogue while retaining explicit submit/confirmation.

Legacy unsplit prose remains playable with the narrator. Do not silently retroactively reinterpret campaign history.

## 3. Make synthesis asynchronous and recoverable

Atomically persist utterances and outbox jobs with publication. Synthesize outside the game transaction and outside the turn HTTP request. Use a dedicated server-side OmniVoice adapter; the browser talks only to Velvet.

Start with one worker, short utterances, ordered playback, and modest lookahead. CPU inference latency must be measured rather than assuming token-speed speech. Keep text visible immediately. Cap pending work; prioritize the active scene over previews or historical rendering. Account for other OmniVoice clients, including scheduled podcast production; a single Velvet worker alone does not guarantee exclusive backend access.

Use leases/fencing and startup recovery. Provider timeouts may mean unknown completion, not guaranteed cancellation. Bound retries, reject late results from expired claims, write to a temporary asset and atomically publish. Do not claim exactly-once external synthesis; guarantee idempotent publication and no replay of gameplay mechanics instead.

Cache by spoken text and normalization revision, voice/profile/assignment revision, engine/model/settings, language, and format. Cache hits still require source authorization. Serve audio through controlled opaque asset IDs with GET/HEAD/range checks, not a public static output folder or provider filename. Support deletion and quota cleanup.

Expose separate audio status/read routes or a separate audio event stream. Existing adventure SSE is a closed union and rejects data after terminal; do not append speech-ready events after turn completion without an explicit transport redesign.

Failure states say “Text ready; voice unavailable/buffering,” not “Turn failed.” Provide Retry audio separately from Retry narration. The latter may change text; the former must not invoke the model or mechanics.

## 4. Improve the playing surface for listening

Add a persistent compact playback strip near the center-pane composer: current speaker portrait/name, current line, buffering/ready state, play/pause, skip line, replay line, stop, speed, volume, and autoplay mode. Keep controls visible as the transcript scrolls. Audio state must not take over the existing authoritative gameplay phase indicator.

Add a Cast & Voices drawer linked from the present-cast widget: narrator and visible NPC assignments, previews, choose/rebind/lock, pronunciation entries and an explanation of scope. Casting is persisted server-side; volume, speed, caption/follow behavior and autoplay preference are local presentation preferences.

Add a listening-focused workbench preset using existing resizable/collapsible panes. Keep map and present cast available, emphasize the currently speaking portrait and caption, and leave the composer reachable. Use a non-modal layout; do not replace the trusted gameplay UI with a cinematic screen that hides confirmations or receipts.

Highlight the current utterance in the transcript without stealing keyboard focus. Respect the existing user-scroll/follow-latest behavior. Offer a jump-to-speaking-line button instead of pulling someone away from older text. Keep subtitles available with sound off and ensure TTS does not double-read the existing aria-live log for screen-reader users.

Distinguish these controls explicitly:

- Stop listening: stops local playback and detaches this playback queue.
- Stop receiving updates: existing transport behavior; does not undo committed state.
- Cancel/confirm gameplay: existing authoritative operation, never triggered by audio finishing or stopping.

On a new declaration, branch/room switch, narration swipe or safety stop, stop or supersede the stale local queue. Audio from a prior authorization/room generation must never start later. Retain historical assets according to source visibility and retention policy rather than deleting history just because listening stopped.

Merge Director and adventure items into one ordered presentation feed eventually, while preserving their distinct source IDs and semantics. Until there is a durable cross-source publication order, do not infer a reliable global sequence merely from UI mount order or equal timestamps. Queue only new, explicitly selected publications; loading history must not autoplay the backlog.

Playback modes: off, click-to-play, new NPC dialogue only, narrator plus NPCs. Gameplay cues can be a separately enabled concise layer, not a voice reading every tool/progress/debug message. Audio completion must not automatically submit a choice or ask the Director to continue.

Mobile: sticky transport, captions and composer; compact expandable cast. Browser audio activation requires a user gesture. Multiple tabs should not all autoplay the same scene; prefer one active listening tab or explicit opt-in per tab.

Later, add push-to-talk transcription into a reviewable composer draft. Microphone capture should pause/duck playback, have obvious recording state and a cancel control, and never auto-submit a risky action based on recognition alone. This is a separate project slice, not required for TTS.

## 5. Persistence, transfer and security boundaries

Add canonical schema definitions, recognized predecessor migration, reopen/rollback tests and build packaging for any new SQL fragment. Settings need revision/idempotency handling rather than stale last-write-wins updates.

Keep voice binding independent of provider-generated or imported paths. Configure a fixed/allowlisted OmniVoice URL server-side; provider output cannot choose URLs, files, engines or arbitrary instructions. Only public/published, role-filtered narration reaches speech generation; never narrate private Director plans, hidden NPC details or diagnostic context.

Export portable casting descriptors and logical identity links only when the corresponding NPC/persona/actor identity can round-trip. Version transfer contracts and update dry-run, limits, remapping and atomic apply together. Until that expanded identity export exists, document limited casting portability instead of claiming a full restore. Audio and reference recordings are excluded by default; imports never automatically trigger synthesis. Rebind missing local profiles explicitly.

Synthetic character voices are the default. Any use of real-person reference recordings needs explicit authorization and clear asset retention/export choices. No voice recordings need to be sent to the narrative LLM.

## Prerequisite workflow fixes to verify

Static review found three integration hazards, not browser-reproduced failures. Add focused regression tests before wiring autoplay:

- CommandCenter conditionally unmounts the tools subtree when the right pane is hidden. That subtree includes Director controllers that own polling and publish/release parent UI locks. Keep controllers and the audio coordinator mounted independently of presentation visibility; collapsing a pane must not release a gameplay lock or interrupt a scene.
- Resume can emit pending tool_proposed events that the client parser permits only for initial streams. Exercise the real server serializer through the real client parser.
- Already-completed replay can emit narration/terminal without the mechanics event required by the client when terminal contains receipts; raced resume also has a first-event mismatch. Verify completed/reconciled replay and ensure audio recovery cannot duplicate speech or game actions.

These findings and exact source ranges are in the companion voice/UI review. They are planning risks to reproduce and fix, not claims of tested exploitability.

## Suggested implementation slices

A. Vertical slice: one saved narrator assignment, completed adventure utterances, durable job/asset records and migration, fake adapter tests, real local adapter, manual Play/Stop/Replay with captions. Text-only mode remains unchanged. A working audio button without durable casting/recovery is not completion.

B. Persistent cast: campaign NPC IDs in Director speaker contracts; preserve and publish structured dialogue; narrator/NPC switching; cast drawer and previews; missing-profile, rename, duplicate-name, restart and recast tests.

C. Listening workflow: shared ordered playback coordinator for Director/adventure, local autoplay settings, buffering/lookahead, interruption and branch handling, active-line/portrait highlighting, responsive listening preset and accessibility.

D. Broader coverage: ordinary roleplay/swipes, explicit player dialogue, gameplay cues, transfer extensions, storage management, optional dictation. Do not defer the minimum security and migration work to this phase.

## Acceptance scenarios

- Assign an NPC a voice, restart both applications, return in a different room: the same durable assignment resolves or an explicit missing-profile state appears.
- Two same-name NPCs have different IDs and remain distinct. A rename does not recast.
- Narrator, NPC A and NPC B play in script order even if synthesis completion order differs.
- Duplicate SSE delivery/reconnect/history reload produces no duplicate autoplay; narration variants never play the old text under a new selection.
- Stop listening changes no receipt, campaign revision or game result. Audio retry changes no game state or narration.
- A slow/down backend leaves the transcript and action workflow usable. Restart recovers jobs without duplicating published assets.
- Hidden/absent speakers and player impersonation fail validation. Private Director text never becomes an audio request or downloadable asset.
- Profile edit/recast invalidates future render keys while existing historical audio remains attributable to its original voice revision.
- Audio assets and range requests obey the source's scope; cache deduplication cannot bypass visibility.
- Database migration and old transfer formats remain compatible; imported unresolved voices do not start synthesis.
- Keyboard, screen reader, mobile autoplay restrictions and multiple tabs do not create inaccessible or unexpected playback.

## Baseline checks actually run

- Clone succeeded; source review anchored to ceb2aa6.
- Local OmniVoice GET /health returned status ok, device cpu. This is availability evidence, not measured speech quality or synthesis latency.
- npm ci --ignore-scripts succeeded using a writable profile-local cache after the default ~/.npm cache was read-only. npm reported 7 dependency vulnerabilities (4 moderate, 3 high); no automatic dependency changes were applied.
- Contracts build passed.
- Focused client tests: CampaignConversation, CampaignDmPanel and campaignWorkbenchPreferences: 18 tests passed across 3 files.
- Focused contracts tests: adventure-turns-http, campaign-dm-http and persona-profile: 11 tests passed across 3 files.
- Client typecheck passed. No full server suite, browser E2E, live gameplay or synthesis benchmark was run. Native install scripts were skipped, so this is not a verified running server installation.

Related read-only reports are saved beside the clone as velvetrp-server-review.md and velvetrp-voice-ui-review.md.
