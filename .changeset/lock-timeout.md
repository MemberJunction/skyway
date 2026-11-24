---
"@memberjunction/skyway-core": minor
"@memberjunction/skyway-sqlserver": minor
"@memberjunction/skyway-postgres": minor
"@memberjunction/skyway-cli": minor
---

New optional `Database.Options.LockTimeout` (milliseconds), so a migration that can't get a lock fails fast instead of blocking every query on a live database.

- When set, each migration transaction starts with `SET LOCK_TIMEOUT <n>` (SQL Server) or `SET LOCAL lock_timeout = '<n>ms'` (PostgreSQL). A statement that waits longer fails, the migration rolls back, and nothing is recorded in the history table, so a rerun resumes there.
- Unset, behavior is unchanged: no extra statement runs.
- The value must be an integer from 0 to 2147483647; anything else throws before a transaction opens. New `validateLockTimeout` / `LOCK_TIMEOUT_MAX_MS` exports.
- The CLI reads it from the config file (`lockTimeout` or `LockTimeout`).
