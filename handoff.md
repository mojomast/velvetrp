# Handoff
## Completed: Normalize initial adventure-turn reconciliation problem instances
## Next Task: M3.7 Campaign Play Shell
## Context: The fixed `/api/rpg/v1/adventure-turns/reconcile-initial` route now precedes dynamic turn matching in route registration and all problem normalization paths. Malformed query, internal failure, unsupported method, and query-redaction coverage confirms every structured problem uses the static safe instance. No API docs or unrelated implementation were changed.
## Files Modified: server/src/http/problem.ts, server/src/app.ts, server/src/routes/rpg/v1/adventureTurns.ts, server/test/problem.test.ts, server/test/rpg-adventure-turn-route.test.ts, devplan.md, handoff.md
