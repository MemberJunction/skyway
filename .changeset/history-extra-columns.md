---
"@memberjunction/skyway-core": minor
"@memberjunction/skyway-cli": minor
---

Add `HistoryExtraColumns` to `MigrationConfig`. A Skyway instance can now extend its history table with user-defined columns that either carry a per-row `Value` (bound as a SQL parameter on every insert) or fall through to a `DefaultValue`/NULL. This lets a secondary Skyway instance — for example, one running integration-specific DDL alongside core application migrations — stamp domain context (e.g. `CompanyIntegrationID`) onto every history row so each migration row links back to the context that triggered it. Default behavior is unchanged: core Flyway columns only.

`EnsureExists` reconciles extras onto an **existing** history table rather than only emitting them in the `CREATE TABLE` branch. Previously, enabling `HistoryExtraColumns` against a database Skyway had already migrated left the columns absent while every `Insert*` referenced them, so the run died with a bare `Invalid column name '<Col>'` and applied zero migrations — which is the primary intended use case (tagging migration rows on an existing application database). Missing columns are now added via `ALTER TABLE`; rows written before the column existed keep its `DefaultValue` or NULL.

Two configuration mistakes now fail fast with an actionable message before any DDL runs, instead of surfacing as a raw SQL error mid-run: a `NOT NULL` extra with neither a `Value` nor a `DefaultValue` (every insert would fail), and retrofitting a `NOT NULL` extra without a `DefaultValue` onto a history table that already has rows (SQL Server rejects the `ALTER`).
