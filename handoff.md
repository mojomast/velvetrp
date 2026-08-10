# Handoff
## Completed: M4 final gate and migration-test stabilization
## Next Task: None (M4 roadmap complete)
## Context: Historical v41 DDL remains untouched. The server suite is serialized because test files mutate process-wide `VELVET_DATA_DIR`; historical fixture rewinds now remove v41/v42 artifacts before lowering the schema marker. Every historical migration expectation targets schema version 42. Run tests with a unique `TMPDIR` under `/dev/shm` while `/tmp` is full. Deterministic E2E has six known baseline failures at 8851e5d (four finalize status mismatches, attached-room back button, and storyline 400); current main matches exactly.
## Files Modified: server Vitest configuration and migration tests/helpers; handoff
