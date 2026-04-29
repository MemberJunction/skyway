# @memberjunction/skyway-postgres

PostgreSQL provider for [Skyway](https://github.com/MemberJunction/skyway), the TypeScript-native Flyway-compatible migration engine.

Wraps the `pg` (node-postgres) driver with PG-native DDL, parameterized history-table queries via `$N` placeholders, and schema cleanup that handles PG-specific object types (views, functions, types, sequences, foreign keys).

## Installation

```bash
npm install @memberjunction/skyway-core @memberjunction/skyway-postgres
```

## Usage

```typescript
import { Skyway } from '@memberjunction/skyway-core';
import { PostgresProvider } from '@memberjunction/skyway-postgres';

const provider = new PostgresProvider({
  Server: 'localhost',
  Port: 5432,
  Database: 'my_app',
  User: 'postgres',
  Password: 'secret',
});

const skyway = new Skyway({
  Provider: provider,
  Migrations: {
    Locations: ['./migrations'],
    DefaultSchema: 'public',
    BaselineOnMigrate: true,
  },
  // Database is optional — falls back to provider.Config.
});

const result = await skyway.Migrate();
console.log(`Applied ${result.MigrationsApplied} migrations`);

await skyway.Close();
```

## Dialect Details

| | PostgreSQL |
|---|---|
| Default port | 5432 |
| Default schema | `public` |
| Driver | `pg` (node-postgres) |
| Identifier quoting | `"double-quotes"` (case-sensitive) |
| Batch separator | None — each script runs as a single batch |
| History table DDL | `VARCHAR`, `TIMESTAMP`, `BOOLEAN`, `NOW()`, `COALESCE()` |
| Parameterization | `$1`, `$2`, ... positional placeholders |

## PostgreSQL-specific behavior

- **Schema cleanup** drops objects in the correct order for PG: foreign keys → views → functions → user-defined types → sequences → tables. `public` is never dropped (matches `dbo` protection on SQL Server).
- **Case sensitivity:** PostgreSQL folds unquoted identifiers to lowercase. The provider quotes identifiers consistently, but callers should use snake_case or explicitly quote mixed-case names in their migrations.
- **Managed services (RDS, Azure Database for PostgreSQL):** the default `rds_superuser` role can't modify `pg_cast` or other system catalogs. Migrations that depend on superuser privileges must be adapted for managed environments.

For full documentation and the `Skyway` class API, see [`@memberjunction/skyway-core`](https://www.npmjs.com/package/@memberjunction/skyway-core).
