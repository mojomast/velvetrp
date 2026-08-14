# Handoff

## Current Baseline

- Persistence: schema `v53r1`; populated v46-v52 databases are supported forward-startup inputs, while v45 and earlier are unsupported.
- HTTP: 111 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns migration/configuration guidance, `docs/repo-architecture.md` owns persistence structure, and `docs/ROADMAP.md` owns milestone status.

## Completed

Drift remediation aligned migration policy/tests, current release and API documentation, v49-v53 architecture/status, document ownership, configuration examples/guidance, and deterministic executable drift checks. `drift-remediation-plan.md` contains decisions, research, validation, review dispositions, and completion evidence.

## Next Task

Scope the closed declarative rules IR milestone with exact consumers, contract boundaries, migration impact, and exclusions before implementation. Do not promote live exact-candidate selection, companion grant exercise, remote tenancy, or other later work implicitly.

## Validation

See the completion record in `drift-remediation-plan.md` for focused commands, independent reviews, `git diff --check`, and the canonical `/dev/shm` health gate.
