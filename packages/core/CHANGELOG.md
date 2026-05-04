# @memberjunction/skyway-core

## 0.6.1

### Patch Changes

- 75eff77: Treat baseline version as a floor for migration resolution

  A baseline migration recorded in `flyway_schema_history` now sets a permanent floor for the resolver. Versioned (`V`-prefixed) migration files at or below the baseline version are reported as `ABOVE_BASELINE` rather than `IGNORED`, `PENDING`, or `MISSING`. This was already the behavior on a fresh database during baselining; now it also applies on subsequent runs against an already-baselined database.

  Previously, after a baseline ran, pre-baseline `V` files on disk would either be flagged as `IGNORED` (causing `Migrate()` to abort and `Validate()` to fail) or silently re-run as `PENDING` if they happened to be above `highestApplied`. Both were incorrect — a baseline by definition replaces the migration history below its version.

  Additional fixes:

  - Baseline-typed history records (`BASELINE`, `SQL_BASELINE`) are no longer reported as `MISSING` when their bootstrap files have been pruned from disk — both by the `Info()` resolver and by `Validate()`'s separate disk-vs-history check.
  - Pre-baseline `SQL` history records are no longer reported as `MISSING` when their files are gone (the baseline subsumes them).
  - Stale `B` files on disk that sit below an already-applied baseline are reported as `ABOVE_BASELINE` instead of being silently dropped from the status report.
  - `Skyway.Validate()` now honors the same baseline floor as the resolver, so a baselined database with old `V` files on disk no longer fails validation.

## 0.6.0

### Minor Changes

- 668641e: Multi-dialect provider support

  Skyway now supports both SQL Server and PostgreSQL through a pluggable
  `DatabaseProvider` interface. The migration engine (scanning, resolving,
  checksums, placeholders, history tracking, transactional batching) is
  dialect-agnostic; each database-specific concern lives in a provider package
  that callers install alongside `skyway-core`.

  ## What's new

  - **`DatabaseProvider` interface** in `skyway-core` — defines connection
    lifecycle, transaction management, history-table operations, script
    splitting, and schema cleanup. Any dialect can be added by implementing
    this interface in its own package.
  - **`@memberjunction/skyway-sqlserver`** — SQL Server provider (mssql/tedious
    driver). Replaces the built-in SQL Server logic that lived in skyway-core
    pre-0.6.
  - **`@memberjunction/skyway-postgres`** — new PostgreSQL provider (pg driver)
    with PG-native DDL, history-table SQL, schema cleanup (FKs, views,
    functions, types, sequences, tables), and parameterized queries via `$N`
    placeholders.
  - **`validateSqlIdentifier()`** utility in `skyway-core` — strict
    `/^[A-Za-z_][A-Za-z_0-9]*$/` whitelist for identifiers that must be
    interpolated (schema/table/db names). Applied at every provider entry
    point that takes an identifier from a caller, so invalid or
    injection-shaped input is rejected before any SQL is built.

  ## Usage

  Install the dialect provider alongside core:

  ```bash
  npm install @memberjunction/skyway-core @memberjunction/skyway-postgres
  ```

  ```typescript
  import { Skyway } from "@memberjunction/skyway-core";
  import { PostgresProvider } from "@memberjunction/skyway-postgres";

  const provider = new PostgresProvider({
    Server: "localhost",
    Database: "my_app",
    User: "postgres",
    Password: "secret",
  });

  const skyway = new Skyway({
    Migrations: { Locations: ["./migrations"], DefaultSchema: "public" },
    Provider: provider,
  });

  await skyway.Migrate();
  ```

  `SkywayConfig.Database` is now optional — when omitted, Skyway falls back to
  the `Provider.Config` the provider was constructed with. Pass `Database`
  explicitly only when you want to override what the provider was configured
  with (rare).

  ## Migration from 0.5.x

  The `Skyway` class API (`Migrate()`, `Info()`, `Validate()`, `Baseline()`,
  `Repair()`, `Clean()`) is unchanged. Existing SQL Server users update to
  0.6.0 by:

  1. Installing `@memberjunction/skyway-sqlserver` alongside `skyway-core`
  2. Passing a `SqlServerProvider` instance via `SkywayConfig.Provider`

  No migration file, history-table, or checksum changes. The SQL Server
  provider matches 0.5.x behavior exactly, including transaction semantics
  and history-table DDL.

  ## Security

  `validateSqlIdentifier()` runs at every public provider entry point that
  interpolates an identifier (schema, database, history-table name). Inputs
  that match the whitelist succeed; anything else throws with a descriptive
  error. Where we can parameterize the value portion of a query (e.g.
  `DB_ID(@dbName)` on SQL Server, `WHERE datname = $1` on PG), we do —
  defense in depth.

## 0.5.3

### Patch Changes

- f7c7ae4: Default database connection encryption to true

  Changed the default value of `Encrypt` from `false` to `true` in `ConnectionManager`. Azure SQL and modern SQL Server deployments require encrypted connections, and the previous default caused migrations to fail with "Server requires encryption" errors. Combined with the existing `TrustServerCertificate: true` default, this works seamlessly for both Azure and local development environments.

## 0.5.2

### Patch Changes

- 0b0c016: Add README files for npm package pages

## 0.5.1

### Patch Changes

- 74ff7bd: Initial npm publish with OIDC trusted publishing
