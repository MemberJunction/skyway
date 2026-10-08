---
"@memberjunction/skyway-core": minor
"@memberjunction/skyway-postgres": minor
---

Migrations can opt out of the transaction with a Flyway-style script config file, so PostgreSQL `CREATE INDEX CONCURRENTLY` (and other statements that refuse to run in a transaction) work under Skyway.

- A migration with a sibling `<file>.sql.conf` containing `executeInTransaction=false` runs outside a transaction. Other keys are ignored, so files written for Flyway load unchanged. New `ResolvedMigration.ExecuteInTransaction`, plus the `ParseScriptConfig` / `LoadScriptConfig` exports.
- `per-migration` mode runs it without a transaction. `per-run` mode commits the migrations before it, runs it on its own, and continues the rest in a new transaction. Migrations without a `.conf` behave exactly as before.
- New optional `DatabaseProvider.SplitStatements`. The PostgreSQL provider implements it (`SplitPostgresStatements`), so a non-transactional script is sent one statement at a time: PostgreSQL runs a multi-statement query string as one implicit transaction. It splits on top-level `;`, respecting quotes, `E''` strings, dollar quoting and comments.
- A failing non-transactional migration cannot be rolled back. It is not recorded in the history table, and the run stops.
