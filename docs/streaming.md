# Streaming (SSE) transport


## Endpoints

- `POST /api/sessions/:id/stream` - body `{ content, generationId?, speakerCharacterId? }`. Streams a reply from the selected participant for a new user turn.
- `POST /api/sessions/:id/messages/:mid/swipe/stream` - body `{ generationId?, speakerCharacterId? }`. Streams a swipe regeneration; it inherits the source reply's speaker by default.
- `POST /api/sessions/:id/generation/cancel` — body `{ generationId? }`. Aborts the in-flight generation for the session (404 when none matches).
- Buffered endpoints (`/messages`, `/swipe`, `/branch`, `/continue`) remain available. Character continuation has no streaming variant.
- Model-directed room turns support progressive SSE on `POST /api/sessions/:id/room-turn` when the request sends `Accept: text/event-stream`.
- **Give room another turn** uses the same progressive transport on `POST /api/sessions/:id/room-continue` without creating a user message.

## Gates

Before the SSE stream opens, the route returns plain HTTP errors: `404` unknown session, `400` missing content, invalid participant, or invalid swipe target, and `409` session stopped or generation already in flight. Once streaming starts, failures are delivered as SSE events.

## Event protocol

Each event is `event: <name>\ndata: <json>\n\n`. Comments (`: heartbeat`) are sent every 15s (override with `VELVET_SSE_HEARTBEAT_MS`).

Turn stream order: `user_message` → `state` → `delta`* → `done` | `boundary` | `aborted` | `error`. Swipe streams omit `user_message` (no new user message is persisted) and start at `state`. There is no streaming variant of `/branch`; branch turns are buffered only.

- `user_message` — `{ message, generationId }`; the persisted user message (reconcile optimistic client messages against it).
- `state` — `{ session, state }`; reflects the setup→active consent transition.
- `delta` — `{ seq, text }`; provider tokens, `seq` starting at 0. Deltas are policy-checked **incrementally** against the accumulated text: as soon as the accumulated output trips `checkAssistantOutput`, the provider request is aborted and no further deltas are emitted, so raw violating text is never streamed through.
- `done` - `{ reply, providerError, preset, loreTriggered, session?, state?, messages?, swipeIndex?, swipeGroupId?, siblings? }`. Character replies include `speakerCharacterId`. `reply` is persisted after the final `checkAssistantOutput` call.
- `boundary` - same payload as `done` plus `violations`. If the configured policy reports a violation, this terminal replacement event tells clients to discard streamed text and show `reply`. The current permissive policy stub does not produce boundary events.
- `error` — `{ error, violations? }`. Pre-generation policy violations arrive here (nothing persisted), as do unexpected stream failures.


Room streams use `user_message` → `state` → `room_reply`+ → `room_done`; continuation streams omit `user_message`. `room_reply` is emitted after each character reply is persisted and includes `{ reply, index, total }`, allowing the client to render one bubble before the next generation finishes. After the final reply, the server updates synthesized scene state before emitting `room_done`, which contains the complete result and message branch. A room round is bounded to routing, selected replies, and one synthesis request. JSON remains the default when `Accept: text/event-stream` is absent.

## Disconnects and cancellation

- For token and swipe streams, client disconnect aborts the provider request and persists no character reply; the per-session generation lock is released.
- The cancel endpoint applies to token and swipe streams, aborts their provider request, and emits `aborted` on the still-open stream.
- Room SSE has no token-stream cancellation controller. If its client disconnects, the already-started bounded room round continues server-side through its configured reply and synthesis limits.

## Client behavior

`api.streamMessage` / `api.streamSwipe` parse the SSE stream with a fetch `ReadableStream` reader (`createSseParser` handles split chunks, multi-line data, and heartbeat comments) and return a handle with `generationId`, `done`, and `cancel()`. The chat UI labels the live bubble with the selected speaker, replaces it with the attributed persisted reply, reconciles the optimistic user message, and exposes a generation cancel button distinct from session Stop. Regeneration is shown only when the latest character reply has a hydrated user-message parent.

## E2E Validation

The deterministic Playwright suite validates `Content-Type`, event ordering (`user_message`, `state`, one or more `delta`, then `done`), non-empty assembled output, selected `speakerCharacterId`, and reply persistence through a subsequent session read. The opt-in live suite repeats those checks against the configured provider with reasoning disabled and a temporary 96-token cap, then validates a two-speaker room turn, SSE room continuation, synthesized context, and growth in `GET /api/usage` including `character_reply` and `scene_synthesis`. Assertions intentionally avoid exact model text.
