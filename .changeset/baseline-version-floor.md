---
"@memberjunction/skyway-core": patch
---

Treat baseline version as a floor for migration resolution

A baseline migration recorded in `flyway_schema_history` now sets a permanent floor for the resolver. Versioned (`V`-prefixed) migration files at or below the baseline version are reported as `ABOVE_BASELINE` rather than `IGNORED`, `PENDING`, or `MISSING`. This was already the behavior on a fresh database during baselining; now it also applies on subsequent runs against an already-baselined database.

Previously, after a baseline ran, pre-baseline `V` files on disk would either be flagged as `IGNORED` (causing `Migrate()` to abort and `Validate()` to fail) or silently re-run as `PENDING` if they happened to be above `highestApplied`. Both were incorrect — a baseline by definition replaces the migration history below its version.

Additional fixes:
- Baseline-typed history records (`BASELINE`, `SQL_BASELINE`) are no longer reported as `MISSING` when their bootstrap files have been pruned from disk.
- Pre-baseline `SQL` history records are no longer reported as `MISSING` when their files are gone (the baseline subsumes them).
- Stale `B` files on disk that sit below an already-applied baseline are reported as `ABOVE_BASELINE` instead of being silently dropped from the status report.
