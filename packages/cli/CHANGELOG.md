# @memberjunction/skyway-cli

## 0.6.1

### Patch Changes

- Updated dependencies [75eff77]
  - @memberjunction/skyway-core@0.6.1
  - @memberjunction/skyway-postgres@0.6.1
  - @memberjunction/skyway-sqlserver@0.6.1

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

### Patch Changes

- Updated dependencies [668641e]
  - @memberjunction/skyway-core@0.6.0
  - @memberjunction/skyway-sqlserver@0.6.0
  - @memberjunction/skyway-postgres@0.6.0

## 0.5.3

### Patch Changes

- Updated dependencies [f7c7ae4]
  - @memberjunction/skyway-core@0.5.3

## 0.5.2

### Patch Changes

- 0b0c016: Add README files for npm package pages
- Updated dependencies [0b0c016]
  - @memberjunction/skyway-core@0.5.2

## 0.5.1

### Patch Changes

- 74ff7bd: Initial npm publish with OIDC trusted publishing
- Updated dependencies [74ff7bd]
  - @memberjunction/skyway-core@0.5.1
