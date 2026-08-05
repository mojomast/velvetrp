# Trending roleplay software features - August 2026 status

Non-explicit product/engineering trends adapted for Velvet MVP.

## Implemented

- Feature flags endpoint for future voice/images (`GET /api/features`, env `FEATURE_VOICE`, `FEATURE_IMAGES`).
- Character JSON import/export with server-side re-validation (`/api/characters/import`, `/api/characters/:id/export`).
- Character library with durable profile editing, import/export, session resume, and guarded deletion.
- Memory management API and UI: manual creation, content/kind editing, approval, soft-delete through `forgottenAt`, and restoration.
- Lorebook/world-info API and UI: global or many-character scopes, always-on or keyword-triggered entries, enable/disable, insertion order, and budget-capped prompt inclusion.
- Prompt presets (`default`, `compact`, `immersive`) with session `presetId`; currently only preset temperature is honored, while context budgets come from harness settings. All 20 prompt layers, including default safety guidance and two scene-synthesis layers, are editable; deterministic safeguards remain independent.
- Streaming chat with abort: SSE transport (`/api/sessions/:id/stream`, swipe streaming, `/generation/cancel`) with incremental policy hooks, optional terminal `boundary` replacement events, and disconnect/cancel aborts. See [streaming.md](streaming.md).
- Swipes/regeneration and chat branching: message tree with swipe groups, active-leaf tracking, sibling listing, speaker attribution, and active-branch-only summaries.
- Multi-character sessions: up to 12 participants, primary and target speakers, speaker-labelled history, shared lore selection, per-character memories, and one-turn character continuation.
- Explicitly bounded room automation: 1-6 replies per round, progressive room SSE, and 0-3 client follow-up rounds.
- Authoritative scene state combining highest-priority editable manual canon with a categorized model-synthesized factual snapshot.
- Append-only usage ledger, configurable token pricing, `GET /api/usage`, and a lifetime usage/cost dashboard.

## High-impact trends intentionally deferred

- Full Character Card V2 PNG embedding: start with JSON passthrough, add PNG `tEXt` later.
- Vector/RAG memory: keyword lore + summaries are safer and simpler for MVP.
- Per-provider-type adapters (ollama/llamacpp/koboldcpp native APIs); everything currently speaks openai-compatible.
- Shared server/client types package; coverage gates in CI.
- Unbounded autonomous director loops; implemented room automation remains explicitly bounded, and single-character continuation is one explicit buffered turn.
- Participant changes after session creation.
- TTS/images: feature flags only; keep providers external and optional.

## Policy note

Write paths still call the shared policy interface, but `server/src/policy.ts` is currently an intentionally permissive stub. Safe words and sanitization remain active. The previous restrictive backup implementation is no longer retained in the repository.
