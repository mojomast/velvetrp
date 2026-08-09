# Streaming (SSE) transport

Velvet has three separate SSE families. They share SSE framing, but not durability, cancellation, heartbeat, terminal, or recovery behavior. Do not apply one family's client assumptions to another.

All successful streams use `Content-Type: text/event-stream; charset=utf-8`, `Connection: keep-alive`, and `X-Accel-Buffering: no`. Data events are framed as `event: <name>\ndata: <json>\n\n`. Heartbeats, where supported, are SSE comments (`: heartbeat`) and carry no application state.

## Family summary

| Family | Routes | Cache policy | Heartbeat | Disconnect behavior | Recovery authority |
| --- | --- | --- | --- | --- | --- |
| Legacy token/swipe | `POST /api/sessions/:id/stream`; `POST /api/sessions/:id/messages/:mid/swipe/stream` | `no-cache, no-transform` | Yes | Aborts the process-local provider generation | Session/message reads; no durable stream operation record |
| Room | `POST /api/sessions/:id/room-turn`; `POST /api/sessions/:id/room-continue` with `Accept: text/event-stream` | `no-cache, no-transform` | No | The bounded round continues and persists replies | Session/message reads and persisted `room_reply` messages |
| Durable M2.11 adventure | `POST /api/rpg/v1/adventure-turns/stream` | `private, no-store, no-transform` | Yes | Delivery stops; durable orchestration continues | `X-Adventure-Turn-Id`, turn GET, and initial-key reconciliation |

## Legacy token and swipe streams

### Routes and admission

- `POST /api/sessions/:id/stream` accepts `{ content, generationId?, speakerCharacterId? }`.
- `POST /api/sessions/:id/messages/:mid/swipe/stream` accepts `{ generationId?, speakerCharacterId? }`.
- `POST /api/sessions/:id/generation/cancel` accepts `{ generationId? }` and cancels only a matching active token/swipe generation. It returns 404 when none matches.
- Buffered `/messages`, `/swipe`, `/branch`, and `/continue` routes remain separate. Branch and character continuation have no streaming variant.

Unknown sessions and invalid input fail as ordinary HTTP responses before SSE opens, except a user-message policy rejection after route validation opens SSE and sends `error`. A stopped session or an existing per-session generation lock returns HTTP 409.

### Events and persistence

A new turn emits:

```text
user_message -> state -> delta* -> done | boundary | aborted | error
```

A swipe emits:

```text
state -> delta* -> done | boundary | aborted | error
```

| Event | Payload and semantics |
| --- | --- |
| `user_message` | `{ message, generationId }`. The user message is already persisted. Reconcile any optimistic message to this identity. |
| `state` | `{ session, state }`, including a completed setup-to-active transition. |
| `delta` | `{ seq, text }`; `seq` starts at 0. Policy is checked against accumulated output before each delta is emitted. |
| `done` | `{ reply, providerError, preset, loreTriggered, session?, state?, messages?, swipeIndex?, swipeGroupId?, siblings? }`. The character reply is persisted before this event. |
| `boundary` | The completed payload plus `{ generationId, violations }`. The safe replacement `reply` is persisted; discard all preceding deltas. |
| `aborted` | `{ generationId }`. No character reply is persisted by the aborted generation. |
| `error` | `{ error, violations? }`. No successful reply can be inferred. |

`done`, `boundary`, `aborted`, and `error` are alternatives in the normal open-stream path, but this family does not provide a durable terminal-delivery guarantee. The stream can disappear before a terminal frame.

Provider failures during generation normally produce a safe persisted fallback and `done` with `providerError: true`; failures outside that handled provider lane can emit `error`. Swipe streams create no user message. New-turn streams persist the user message before provider work, so cancellation or disconnect can leave that user message without a character child.

The server sends heartbeats every `Number(VELVET_SSE_HEARTBEAT_MS ?? 15000)` milliseconds. This legacy path passes the converted value directly to the timer; configure a positive finite integer. Unlike the durable adventure path, it has no explicit fallback for malformed, non-finite, or non-positive values.

Client disconnect, explicit generation cancellation, session stop, or session deletion aborts the active provider request. The per-session lock is process-local and is released when generation exits. `generationId` selects cancellation; it is not a persisted idempotency or reconciliation key. After lost delivery, read `GET /api/sessions/:id` or its messages and inspect persisted parent/child identities before allowing another user action.

## Room streams

`POST /api/sessions/:id/room-turn` and `POST /api/sessions/:id/room-continue` return JSON by default. They use SSE only when `Accept` contains `text/event-stream`.

A room turn emits:

```text
user_message -> state -> room_reply+ -> room_done
```

A continuation emits:

```text
state -> room_reply+ -> room_done
```

| Event | Payload and semantics |
| --- | --- |
| `user_message` | `{ message }`; emitted after the room-turn user message is persisted. |
| `state` | `{ session, state }`; emitted before character generation. |
| `room_reply` | `{ reply, index, total }`; emitted only after that attributed character message is persisted. `index` is zero-based. |
| `room_done` | The complete JSON result, including the ordered replies, selected speaker IDs, routing source, provider/lore summary, final session/state, and active message branch. It is the success terminal and reconciliation snapshot. |

Room SSE has no heartbeat, token deltas, `generationId`, generation-cancel controller, `aborted`, `boundary`, or explicit `error` event. `room_done` is emitted only after all selected replies and the scene-summary/synthesis update attempt complete. If a failure or process exit prevents `room_done`, earlier `room_reply` messages may already be durable.

A client disconnect does not cancel the round. Server-side work continues through the already selected bounded replies and one synthesis attempt; each reply is committed separately. Session stop/delete and `/generation/cancel` do not provide an active room-stream abort controller. Reconcile a missing `room_done` by reading the session/messages. Never infer that the whole round rolled back.

## Durable M2.11 adventure streams

This family requires `FEATURE_RPG_CAMPAIGN=true` and `FEATURE_RPG_MECHANICS=true`. Its complete HTTP schemas and problem semantics are normative in [Adventure turns and generation drafts (M2.11)](api.md#adventure-turns-and-generation-drafts-m211).

### Requests and identity

`POST /api/rpg/v1/adventure-turns/stream` accepts exactly one of:

- Initial: `{ campaignId, sessionId, actorId, declaration, expectedRevision, idempotencyKey }`.
- Narration derivative: `{ variant: "narration-retry" | "narration-swipe", campaignId, sessionId, actorId, priorTurnId, expectedRevision, idempotencyKey }`.
- Resume: `{ resumeToken }`.

The durable turn is created or recovered before SSE framing. Every successful stream therefore sets `X-Adventure-Turn-Id` before the first body frame. Preserve this header even if parsing later fails. Narration derivatives create a new durable narration-only turn, reuse the prior declaration and receipts, and never rerun mechanics.

Every data event has an envelope whose event name equals `type` and whose exact top-level order is `{ type, sequence, timestamp, payload }`. `sequence` starts at 0 per connection; it is not a durable cross-connection cursor. `timestamp` is canonical UTC.

| Event | Exact payload | Semantics |
| --- | --- | --- |
| `turn_started` | `{ turn }` | Initial and narration-derivative connections only; never replayed by resume. |
| `agent_status` | `{ status }`, with `planning`, `awaiting-confirmation`, `pending-mechanics`, or `narrating` | Emits transitions reached on this connection and may repeat. |
| `tool_proposed` | `{ proposal }` | Once per durable proposal on an initial stream; not replayed by resume. |
| `confirmation_required` | `{ proposalIds, expiresAt }` | Durable human decision is required; followed by terminal `aborted` for this connection. |
| `mechanics_committed` | `{ receipts }` | One or more durable proposal-linked receipts exist. |
| `narration_delta` | `{ text }` | Nonempty persisted or deterministic fallback narration. It is not legacy provider-token sequencing. |
| `choice` | `{ choiceId, label }` | Reserved validated, non-executable choice vocabulary; the current fallback lane emits none. |
| `terminal` | `{ outcome, turn, narrationStatus, receipts }`, where outcome is `done`, `aborted`, or `error` | At most one terminal is emitted while the response is writable. A disconnect or stream-construction failure can yield none. |

Conditional events are not guaranteed. A no-tool fallback normally emits `turn_started`, planning/narrating statuses, `narration_delta`, and terminal `done`. Pending confirmation emits `confirmation_required` and terminal `aborted`. On resume, any tool call lacking a linked mechanics receipt applies the `pending-mechanics` path, including a rejected call, and normally ends that connection with terminal `aborted`; M2.11 does not execute the bounded tool bridge. Resume does not replay `turn_started` or `tool_proposed` and may first reconcile a crash-visible recoverable receipt link without rerunning its command.

The server sends `: heartbeat` every `VELVET_SSE_HEARTBEAT_MS`, default 15,000 ms. This path explicitly falls back to 15,000 ms when the configured value is non-finite or non-positive.

Disconnect affects delivery only. It neither rolls back nor cancels deterministic durable orchestration. Turns, decisions, narration, and receipt links survive process restart. A terminal frame, including terminal `error`, is a projection of durable state, but no terminal is guaranteed after disconnect or stream-construction failure; use the authoritative read when delivery is lost or malformed.

### Reconciliation

1. If `X-Adventure-Turn-Id` is known, call `GET /api/rpg/v1/adventure-turns/:turnId` with browser cache disabled. The response is authoritative and may contain a `resumeToken`.
2. If an initial request may have committed but no turn header was received, call `GET /api/rpg/v1/adventure-turns/reconcile-initial` with exactly `campaignId`, `sessionId`, `actorId`, and `idempotencyKey`.
3. A non-null locator result is the full authoritative turn response. `{ result: null }` is race-ambiguous with an in-flight request and does not authorize an automatic POST retry.
4. Confirmation POST and turn GET can expose the same opaque `resumeToken` for a resumable decided batch. Send it only in the resume JSON body. Never put it in a URL or log it.
5. A disconnect, malformed/missing terminal, unexpected 500, or lost write response is commit-ambiguous. Reconcile first and never automatically repeat the write.

The turn GET is `Cache-Control: no-store`; the initial-key locator is `private, no-store`. The stream is `private, no-store, no-transform`.

## Client and test coverage

The legacy client parser accepts split chunks, multiline data, CRLF/LF framing, and comments. The adventure parser additionally validates envelope schemas, sequence, event ordering, header/cache requirements, and terminal presence. UI delivery cancellation for adventures cancels only client reading; it does not cancel the durable turn.

`npm run test:e2e` uses a fake provider and disposable data to verify deterministic streaming and persisted results. `VELVET_E2E_LIVE=1 npm run test:e2e:live` is opt-in and exercises the configured provider from a temporary SQLite database, cloned from the selected source only when that source database exists. See [Operations](operations.md#testing) and [Provider configuration](provider-configuration.md#live-provider-tests).
