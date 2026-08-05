# Velvet Mechanics Starter Provenance

- Authored and reviewed: 2026-08-05 by the Velvet clean-room project author and Ralph (`openai/gpt-5.6-sol`).
- Source boundary: project requirements, existing Velvet contracts, and repository architecture only.
- Originality: all names, descriptions, identities, and mechanics in `mechanicsStarterCatalog.ts` were newly written for Velvet. No third-party game rules, catalog, setting, code, data, or prose was consulted, copied, transformed, or bundled.
- Execution boundary: the pack uses only the closed `velvet-starter-v1` integer, dice, reference, cost, recovery, targeting, and typed-effect vocabulary. It contains no path, filename, URL, script, formula, expression language, executable payload, multiclass rule, or system-neutral effects DSL.
- Scope: immutable `1.0.0` remains the compact level-one publication. The new digest-versioned `1.1.0` clean-room publication adds only deterministic levels two and three, one required ability-reference choice, fixed ability/spell grants, bounded focus grants, HP, and proficiency changes. It is not third-party-compatible game content.
- Digest rule: canonical SHA-256 is calculated over the strict parsed manifest and definitions in binary kind/ID order, recursively sorted object keys, with every `digest` and `packVersion` key omitted. The exact immutable version suffix is the first 12 digest characters.
- Both exact versions are computed from their complete strict payloads at build time and exported together; publication never replaces the prior exact version.
- License note: this is an internal authorship/provenance record, not legal advice. Project distribution licensing remains the project owner's decision.
