---
"@memberjunction/skyway-core": minor
"@memberjunction/skyway-cli": minor
---

Add `HistoryExtraColumns` to `MigrationConfig`. A Skyway instance can now extend its history table with user-defined columns that either carry a per-row `Value` (bound as a SQL parameter on every insert) or fall through to a `DefaultValue`/NULL. This lets a secondary Skyway instance — for example, one running integration-specific DDL alongside core application migrations — stamp domain context (e.g. `CompanyIntegrationID`) onto every history row so each migration row links back to the context that triggered it. Default behavior is unchanged: core Flyway columns only.
