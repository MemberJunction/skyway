# Skyway

A TypeScript-native database migration tool inspired by [Flyway](https://flywaydb.org/), built specifically for SQL Server.

Skyway eliminates the Java dependency required by Flyway while providing the same migration workflow — versioned migrations, baseline support, repeatable migrations, checksum validation, and schema history tracking. It targets SQL Server using the `mssql` (tedious) driver and wraps migrations in transactions for safe, atomic execution.

## Why Skyway?

Flyway is the gold standard for database migrations, but it requires a Java runtime. For TypeScript/JavaScript projects targeting SQL Server, this means maintaining a Java toolchain alongside Node.js just for migrations. Skyway solves this by reimplementing Flyway's core migration engine natively in TypeScript:

- **No Java required** — runs anywhere Node.js runs
- **Flyway-compatible** — uses the same file naming conventions, history table schema, and checksum algorithm
- **Transaction safety** — wraps migrations in SQL Server transactions (DDL is transactional in SQL Server)
- **Dual interface** — use as a library in your application or as a standalone CLI tool
- **Drop-in replacement** — point Skyway at your existing Flyway migration files and it just works

## Usage

### As a Library

```typescript
import { Skyway } from 'skyway';

const skyway = new Skyway({
    database: {
        server: 'localhost',
        database: 'my_app',
        user: 'sa',
        password: 'secret',
    },
    migrations: {
        locations: ['./migrations'],
        defaultSchema: 'dbo',
        baselineOnMigrate: true,
    },
    placeholders: {
        'flyway:defaultSchema': 'dbo',
    },
});

// Apply pending migrations
const result = await skyway.migrate();
console.log(`Applied ${result.migrationsApplied} migrations`);

// Check migration status
const info = await skyway.info();
info.forEach(m => console.log(`${m.version} [${m.state}] ${m.description}`));

// Validate checksums
const validation = await skyway.validate();
if (!validation.valid) {
    console.error('Checksum mismatch detected:', validation.errors);
}
```

### As a CLI

```bash
# Apply pending migrations
skyway migrate --url sql://localhost/my_app --user sa --locations ./migrations

# Show migration status
skyway info

# Validate applied migrations against local files
skyway validate

# Clean database (remove all objects)
skyway clean

# Baseline an existing database
skyway baseline --version 202601122300
```

### Configuration File

Create a `skyway.json` in your project root:

```json
{
    "database": {
        "server": "localhost",
        "port": 1433,
        "database": "my_app",
        "user": "sa",
        "password": "${SQL_PASSWORD}"
    },
    "migrations": {
        "locations": ["./migrations"],
        "defaultSchema": "dbo",
        "historyTable": "flyway_schema_history",
        "baselineOnMigrate": true,
        "baselineVersion": "1"
    },
    "placeholders": {
        "flyway:defaultSchema": "dbo"
    },
    "transactionMode": "per-migration"
}
```

## Migration File Types

Skyway supports the same three migration types as Flyway:

### Versioned Migrations (`V`)

Run once, tracked by version. Applied in version order.

```
V202506130552__Add_Users_Table.sql
V202506140800__Add_Email_Column.sql
```

### Baseline Migrations (`B`)

Applied only to empty databases (no prior migration history). Used to initialize a schema from scratch.

```
B202601122300__v3.0_Baseline.sql
```

### Repeatable Migrations (`R__`)

Run after all versioned migrations whenever their checksum changes. Useful for views, stored procedures, or metadata refresh operations.

```
R__RefreshMetadata.sql
```

## Naming Convention

```
V{version}__{description}.sql
B{version}__{description}.sql
R__{description}.sql
```

- **Version**: Numeric timestamp (`YYYYMMDDHHMM`) or any sortable numeric string
- **Separator**: Double underscore (`__`)
- **Description**: Underscores converted to spaces for display

## Flyway Compatibility

Skyway aims for compatibility with Flyway's behavior and artifacts:

| Feature | Status |
|---------|--------|
| `flyway_schema_history` table | Compatible |
| CRC32 checksums | Compatible |
| Versioned migrations (`V`) | Supported |
| Baseline migrations (`B`) | Supported |
| Repeatable migrations (`R__`) | Supported |
| Placeholder substitution (`${...}`) | Supported |
| GO batch separator handling | Supported |
| Transaction wrapping | Supported (per-migration or per-run) |
| Out-of-order migrations | Configurable |

## Improvements Over Flyway

Skyway isn't just a clone — it fixes two significant pain points with Flyway:

### Smart Placeholder Handling

Flyway treats **every** `${...}` occurrence as a placeholder, which breaks migration files containing JavaScript template literals, embedded code, or other uses of the `${...}` syntax. If your SQL migration inserts a stored procedure body containing `${myVar}`, Flyway will either error out or silently corrupt the value.

Skyway only substitutes **known placeholders**:
- `${flyway:defaultSchema}`, `${flyway:timestamp}`, and other `${flyway:*}` built-in placeholders are always substituted
- User-defined placeholders registered in the `placeholders` config are substituted
- All other `${...}` patterns are **left untouched**

This means migrations containing JavaScript code, JSON templates, or any other `${...}` syntax work correctly without escaping or workarounds.

### Large String Support (No 4000-Character Truncation)

Flyway's JDBC-based execution can truncate or corrupt strings longer than 4000 characters — a known limitation when working with `NVARCHAR(MAX)` columns. This is problematic for migrations that insert large text values (code, HTML, JSON blobs, etc.).

Skyway uses the `mssql` (tedious) driver with explicit `NVARCHAR(MAX)` type declarations, ensuring strings of any length are transmitted to SQL Server intact. No truncation, no corruption, regardless of string size.

## SQL Server Transaction Support

Unlike MySQL or PostgreSQL, SQL Server supports transactional DDL — `CREATE TABLE`, `ALTER TABLE`, and most schema changes can be rolled back within a transaction. Skyway takes advantage of this to provide atomic migration execution: if any statement in a migration fails, the entire migration is rolled back.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
