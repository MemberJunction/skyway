# @memberjunction/skyway-sqlserver

SQL Server provider for [Skyway](https://github.com/MemberJunction/skyway), the TypeScript-native Flyway-compatible migration engine.

Wraps the `mssql` (tedious) driver to provide connection management, transactions, history-table operations, and schema cleanup.

## Installation

```bash
npm install @memberjunction/skyway-core @memberjunction/skyway-sqlserver
```

## Usage

```typescript
import { Skyway } from '@memberjunction/skyway-core';
import { SqlServerProvider } from '@memberjunction/skyway-sqlserver';

const provider = new SqlServerProvider({
  Server: 'localhost',
  Port: 1433,
  Database: 'my_app',
  User: 'sa',
  Password: 'secret',
});

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
  Provider: provider,
});

const result = await skyway.Migrate();
console.log(`Applied ${result.MigrationsApplied} migrations`);

await skyway.Close();
```

## Dialect Details

| | SQL Server |
|---|---|
| Default port | 1433 |
| Default schema | `dbo` |
| Driver | `mssql` (tedious) |
| Identifier quoting | `[brackets]` |
| Batch separator | `GO` |
| History table DDL | `NVARCHAR`, `DATETIME`, `BIT`, `GETDATE()`, `ISNULL()` |

For full documentation, configuration options, and the `Skyway` class API, see [`@memberjunction/skyway-core`](https://www.npmjs.com/package/@memberjunction/skyway-core).
