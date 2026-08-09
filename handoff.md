# Handoff
## Completed: Minimal campaign play bootstrap support
## Next Task: M3.7 Campaign Play Shell
## Context: Added a strict role-safe bootstrap contract, one-statement authorization-rooted campaign/session/participant read, and fixed-local GET route gated by campaign and mechanics flags. The read preserves opaque room IDs, uses administration revision, limits actors by owner/GM/player/observer control, and null-masks unavailable resources while treating authorized graph corruption as a redacted 500. No schema migration was added. M2.11 adventure-turn routes now exist, so the stale blocked wording in the older M3.7 plan entry should be reassessed when that full UI task starts.
## Files Modified: packages/contracts/src/campaign-play-http.ts, server/src/repo/campaign/campaignPlayReadRepo.ts, server/src/routes/rpg/v1/campaignPlay.ts, route/repository barrels and orchestration, app/problem normalization, focused contract/repository/route tests
