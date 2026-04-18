# @memberjunction/skyway-core

A TypeScript-native database migration engine for SQL Server, compatible with [Flyway](https://flywaydb.org/) migration files and history tables.

Skyway eliminates the Java dependency required by Flyway while providing the same migration workflow — versioned migrations, baseline support, repeatable migrations, checksum validation, and schema history tracking.

## Installation

```bash
npm install @memberjunction/skyway-core
```

## Quick Start

```typescript
import { Skyway } from '@memberjunction/skyway-core';

const skyway = new Skyway({
  Database: {
    Server: 'localhost',
    Database: 'my_app',
    User: 'sa',
    Password: 'secret',
  },
  Migrations: {
    Locations: ['./migrations'],
    DefaultSchema: 'dbo',
    BaselineOnMigrate: true,
  },
  TransactionMode: 'per-run',
});

const result = await skyway.Migrate();
console.log(`Applied ${result.MigrationsApplied} migrations`);

await skyway.Close();
```

## API

### `Skyway` Class

The main entry point. All methods are async.

| Method | Description |
|--------|-------------|
| `Migrate()` | Apply pending migrations |
| `Info()` | Get migration status for all discovered and applied migrations |
| `Validate()` | Validate checksums of applied migrations against local files |
| `Baseline(version?)` | Record a baseline entry in the history table |
| `Repair()` | Remove failed entries and realign checksums |
| `Clean()` | Drop all objects in the configured schema |
| `CreateDatabase()` | Create the target database |
| `DropDatabase()` | Drop the target database |
| `Close()` | Close the database connection |

### Configuration

```typescript
const skyway = new Skyway({
  Database: {
    Server: 'localhost',       // SQL Server hostname
    Port: 1433,                // Optional, defaults to 1433
    Database: 'my_app',        // Target database
    User: 'sa',                // Database user
    Password: 'secret',        // Database password
    Options: {
      TrustServerCertificate: true,
      RequestTimeout: 60000,
    },
  },
  Migrations: {
    Locations: ['./migrations'],       // Paths to scan for SQL files
    DefaultSchema: 'dbo',              // Schema for history table (default: 'dbo')
    HistoryTable: 'flyway_schema_history', // History table name (default: 'flyway_schema_history')
    BaselineVersion: '202601122300',   // Version for baseline entry
    BaselineOnMigrate: true,           // Auto-baseline empty databases (default: false)
    OutOfOrder: false,                 // Allow out-of-order migrations (default: false)
  },
  Placeholders: {
    'flyway:defaultSchema': 'dbo',     // Substituted in ${flyway:defaultSchema}
    'appVersion': '3.0.0',             // Substituted in ${appVersion}
  },
  TransactionMode: 'per-run',         // 'per-run' (default) or 'per-migration'
  DryRun: false,                       // Log without executing (default: false)
});
```

### Custom history columns

The default history table carries the ten Flyway-compatible columns. When one database needs to track migrations across multiple logical contexts — for example, core application migrations alongside per-tenant or per-integration migrations — use a **second Skyway instance** with its own `HistoryTable` name. Both instances can share a schema without stepping on each other.

Each non-default instance can also declare extra columns that carry domain context on every history row. Skyway creates the columns during `EnsureExists` and, when `Value` is supplied, stamps it (via parameter binding) onto every insert:

```typescript
const integrationSkyway = new Skyway({
  Database: { /* ... */ },
  Migrations: {
    Locations: ['./integration-migrations'],
    DefaultSchema: '__mj',
    HistoryTable: 'IntegrationSchemaHistory',
    HistoryExtraColumns: [
      {
        Name: 'CompanyIntegrationID',
        SqlType: 'UNIQUEIDENTIFIER',
        IsNullable: false,
        Value: companyIntegrationId,   // stamped on every row in this run
      },
      {
        Name: 'Notes',
        SqlType: 'NVARCHAR(400)',
        DefaultValue: "N''",           // no Value — falls through to DEFAULT
      },
    ],
  },
});
```

Rules:
- Extras are **appended** to the Flyway columns; the core ten are never replaced.
- Extras without a `Value` must be nullable or carry a `DefaultValue`.
- `Value` is always bound as a SQL parameter — safe against injection regardless of source.
- Changes to `HistoryExtraColumns` only take effect on a table Skyway creates. Pre-existing history tables are not altered; either drop the table or add the columns manually.

### Progress Callbacks

```typescript
skyway.OnProgress({
  OnMigrationStart: (m) => console.log(`Starting ${m.Version}: ${m.Description}`),
  OnMigrationEnd: (r) => console.log(`${r.Success ? 'OK' : 'FAILED'} (${r.ExecutionTimeMS}ms)`),
  OnLog: (msg) => console.log(msg),
});
```

## Migration File Types

Skyway supports the same three migration types as Flyway:

| Type | Prefix | Behavior |
|------|--------|----------|
| Versioned | `V` | Run once, tracked by version, applied in order |
| Baseline | `B` | Applied only to empty databases (no prior history) |
| Repeatable | `R__` | Re-run whenever their checksum changes |

### Naming Convention

```
V{version}__{description}.sql      V202506130552__Add_Users_Table.sql
B{version}__{description}.sql      B202601122300__v3_Baseline.sql
R__{description}.sql               R__RefreshMetadata.sql
```

## Transaction Safety

Unlike Flyway, Skyway wraps migrations in SQL Server transactions:

| Mode | Behavior on failure |
|------|---------------------|
| `per-run` (default) | All pending migrations roll back — database is unchanged |
| `per-migration` | Only the failed migration rolls back; prior migrations stay committed |

## Flyway Compatibility

- Uses the same `flyway_schema_history` table schema
- CRC32 checksums match Flyway's algorithm
- Same file naming conventions (`V`, `B`, `R__` prefixes)
- Handles `GO` batch separators
- Drop-in replacement — point at existing Flyway migration files

## Also Available

- **[@memberjunction/skyway-cli](https://www.npmjs.com/package/@memberjunction/skyway-cli)** — Standalone CLI tool for running migrations from the command line

## License

MIT
