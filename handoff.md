# Handoff
## Completed: M4.6 NPC stat derivation and campaign-content generation
## Next Task: None (M4 roadmap complete)
## Context: v41 is additive. Campaign-content provider calls are bounded and strictly typed outside SQLite. Safe previews omit NPC goals; apply atomically writes approved public content, explicit 10/10/10 NPC baselines, opening prose, and a durable idempotent draft receipt. The historic generation-draft kind CHECK cannot be altered, so the durable envelope uses `content-pack` while the staged/public typed kind is `campaign-content`.
## Files Modified: contracts campaign-content HTTP schemas, v41 migration, campaign content route/service/client binding, focused tests, devplan
