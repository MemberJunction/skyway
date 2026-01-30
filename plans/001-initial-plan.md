# Skyway - Plan 001: Initial Architecture & Implementation Plan

## Overview

Skyway is a TypeScript-native Flyway clone targeting SQL Server (via the `mssql`/tedious driver). It replicates the core Flyway migration workflow — versioned migrations, baseline support, repeatable migrations, schema history tracking, and checksum validation — entirely in TypeScript, with no Java dependency.

Skyway is exposed as both a **programmatic library** (`import { Skyway } from 'skyway'`) and a **CLI tool** (`npx skyway migrate`).

## Validation Strategy

We validate Skyway against a "golden" reference database created by the real Flyway (via `@memberjunction/cli`). The MemberJunction project (`MemberJunction/MJ`) has ~418 SQL migration files across v2/ and v3/ folders, including a 137K-line baseline migration, repeatable migrations, and Flyway placeholder variables. This is our test corpus.

### Validation Workflow

1. **Create reference DB** (`MJ_3_3_PERFECT`): Run `mj migrate` using the real Flyway wrapper against a fresh database.
2. **Create test DB** (e.g., `MJ_SKYWAY_TEST_001`): Run Skyway against a fresh database using the same migration files.
3. **Compare**: Diff the two databases schema-by-schema (tables, columns, indexes, constraints, views, stored procedures, triggers, extended properties) and row-by-row on the Flyway history table.

---

## Core Concepts

### Migration Types

Skyway must support the three Flyway migration types:

| Type | Prefix | Example | Behavior |
|------|--------|---------|----------|
| **Versioned** | `V` | `V202506130552__v2.49.x_Description.sql` | Runs once, tracked by version |
| **Baseline** | `B` | `B202601122300__v3.0_Baseline.sql` | Runs only on empty DBs (no prior history) |
| **Repeatable** | `R__` | `R__RefreshMetadata.sql` | Runs after all versioned migrations if checksum changed |

### File Naming Convention

```
V{YYYYMMDDHHMM}__{description}.sql     # Versioned
B{YYYYMMDDHHMM}__{description}.sql     # Baseline
R__{description}.sql                     # Repeatable
```

- Timestamp is the version number (not a semantic version — Flyway treats it as a plain sortable string)
- Double underscore `__` separates version from description
- Files are sorted by version (timestamp) in ascending order

### Flyway History Table (`flyway_schema_history`)

Skyway must create and manage the same schema history table Flyway uses:

```sql
CREATE TABLE [${schema}].[flyway_schema_history] (
    [installed_rank]  INT           NOT NULL,
    [version]         NVARCHAR(50)  NULL,
    [description]     NVARCHAR(200) NOT NULL,
    [type]            NVARCHAR(20)  NOT NULL,    -- 'SQL', 'BASELINE', 'JDBC_CALLBACK'
    [script]          NVARCHAR(1000) NOT NULL,
    [checksum]        INT           NULL,
    [installed_by]    NVARCHAR(100) NOT NULL,
    [installed_on]    DATETIME      NOT NULL DEFAULT GETDATE(),
    [execution_time]  INT           NOT NULL,    -- milliseconds
    [success]         BIT           NOT NULL,
    CONSTRAINT [flyway_schema_history_pk] PRIMARY KEY ([installed_rank])
);

CREATE INDEX [flyway_schema_history_s_idx]
    ON [${schema}].[flyway_schema_history] ([success]);
```

### Checksum Algorithm

Flyway uses CRC32 of the **normalized** migration file contents. Normalization rules:
- Read file as UTF-8
- Normalize line endings to `\n` (strip `\r`)
- Flyway uses Java's `CRC32` which produces a signed 32-bit integer

We must replicate this exactly so checksums match the reference database.

### Placeholder Substitution

Flyway supports placeholder variables in migration SQL. The MJ project uses:

| Placeholder | Purpose |
|-------------|---------|
| `${flyway:defaultSchema}` | Replaced with the configured default schema (e.g., `__mj`) |
| `${flyway:timestamp}` | Replaced with current timestamp (forces repeatable migration re-execution) |

Skyway must support configurable placeholders with the same `${name}` syntax.

---

## Architecture

### Package Structure

```
skyway/
├── src/
│   ├── index.ts                  # Public API exports
│   ├── cli.ts                    # CLI entry point
│   ├── core/
│   │   ├── skyway.ts             # Main orchestrator class
│   │   ├── config.ts             # Configuration types and defaults
│   │   └── errors.ts             # Custom error types
│   ├── migration/
│   │   ├── scanner.ts            # Discovers and parses migration files from disk
│   │   ├── parser.ts             # Parses filenames into migration metadata
│   │   ├── checksum.ts           # CRC32 checksum computation (Flyway-compatible)
│   │   ├── resolver.ts           # Determines which migrations need to run
│   │   └── types.ts              # Migration type definitions
│   ├── executor/
│   │   ├── executor.ts           # Runs migrations with transaction wrapping
│   │   ├── sql-splitter.ts       # Splits SQL on GO statements (batch separator)
│   │   └── placeholder.ts        # Variable substitution engine
│   ├── history/
│   │   ├── history-table.ts      # Creates/queries flyway_schema_history
│   │   └── types.ts              # History record types
│   └── db/
│       ├── connection.ts         # mssql connection pool management
│       └── types.ts              # Database connection config types
├── bin/
│   └── skyway.ts                 # CLI binary entry point
├── plans/
├── tests/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── README.md
```

### Key Design Decisions

#### 1. Transaction Wrapping

Every migration run is wrapped in a transaction. If any migration in the batch fails, the entire run rolls back.

**Important caveat for SQL Server**: DDL statements (CREATE TABLE, ALTER TABLE, etc.) ARE transactional in SQL Server, unlike MySQL/PostgreSQL. This is actually an advantage — we get full rollback support for schema changes.

**However**: Certain statements cannot run inside transactions:
- `CREATE DATABASE` / `DROP DATABASE`
- `ALTER DATABASE`
- `CREATE FULLTEXT CATALOG`/`INDEX`

For these, we need to detect and execute them outside the transaction boundary, or run them in a separate batch. The MJ migrations don't use these (the database already exists), so for v1 we can keep it simple.

**Transaction strategy options:**

- **Option A: Single transaction for entire run** — All migrations in one transaction. Maximum safety but long-held locks.
- **Option B: Transaction per migration** — Each migration file runs in its own transaction. Recommended Flyway behavior. If migration 5 of 10 fails, migrations 1-4 are committed, 5 is rolled back.
- **Recommended: Option B** (per-migration transactions), matching Flyway's default behavior, with a config option to use Option A.

#### 2. GO Statement Handling

SQL Server uses `GO` as a batch separator. It is NOT a SQL statement — it's a directive to the client to split the script into separate batches and execute them sequentially.

Rules:
- `GO` must be on its own line (optionally with whitespace)
- `GO` can have a count: `GO 5` (execute previous batch 5 times)
- `GO` inside string literals or comments should NOT be treated as a separator
- Each batch between GO statements is sent to SQL Server as a separate `sql.query()` call
- All batches within a single migration still run inside the same transaction

#### 3. SQL Parsing (Minimal)

We do NOT need a full SQL parser. We only need:
- GO statement splitting (line-based, context-aware for strings/comments)
- Placeholder substitution (simple string replacement)
- No need to understand the SQL semantics

#### 4. mssql Driver Configuration

```typescript
import sql from 'mssql';

const config: sql.config = {
    server: 'sql-claude',
    port: 1433,
    user: 'sa',
    password: 'Claude2Sql99',
    database: 'target_db',
    options: {
        encrypt: false,              // Local dev
        trustServerCertificate: true,
        enableArithAbort: true,
    },
    pool: {
        max: 1,  // Migrations should be single-connection
        min: 1,
    },
    requestTimeout: 300000,  // 5 min for large migrations like baseline
};
```

---

## Implementation Phases

### Phase 1: Foundation

**Goal**: Run a single SQL migration file against SQL Server and record it in the history table.

1. Set up TypeScript project (package.json, tsconfig.json, build pipeline)
2. Implement `db/connection.ts` — mssql connection pool
3. Implement `history/history-table.ts` — create and query `flyway_schema_history`
4. Implement `migration/parser.ts` — parse migration filenames
5. Implement `migration/checksum.ts` — CRC32 checksum matching Flyway
6. Implement `executor/sql-splitter.ts` — split SQL on `GO` statements
7. Implement `executor/placeholder.ts` — `${flyway:defaultSchema}` substitution
8. Implement `executor/executor.ts` — execute batches with transaction wrapping
9. Basic integration test: run 1 migration, verify history table entry

### Phase 2: Full Migration Workflow

**Goal**: Scan a directory, resolve pending migrations, execute them in order.

1. Implement `migration/scanner.ts` — recursive directory scan for `.sql` files
2. Implement `migration/resolver.ts` — diff discovered vs. applied, determine pending
3. Implement `core/skyway.ts` — orchestrate scan → resolve → execute
4. Support baseline migrations (`B` prefix, `baselineOnMigrate` behavior)
5. Support repeatable migrations (`R__` prefix, checksum-based re-execution)
6. Handle the `installed_rank` sequence correctly
7. Full integration test: run all MJ v3 migrations (baseline + v3 versioned + repeatable)

### Phase 3: CLI

**Goal**: `npx skyway migrate` works from the command line.

1. Implement `cli.ts` with command parsing (use `commander` or similar)
2. Commands: `migrate`, `info`, `validate`, `clean`, `baseline`
3. Config file support (`skyway.json` or `skyway.toml`)
4. Environment variable support for sensitive values
5. Console output formatting (migration status table, progress)

### Phase 4: Validation Against Reference

**Goal**: Skyway produces an identical database to real Flyway.

1. Create `MJ_3_3_PERFECT` using `mj migrate`
2. Create `MJ_SKYWAY_TEST` using Skyway
3. Build comparison script:
   - Compare all tables (names, columns, types, nullability, defaults, constraints)
   - Compare all indexes
   - Compare all views (definition text)
   - Compare all stored procedures (definition text)
   - Compare all triggers
   - Compare all extended properties
   - Compare `flyway_schema_history` rows (versions, checksums, types, descriptions)
4. Iterate until 100% match

### Phase 5: Library API Polish

**Goal**: Clean public API for programmatic use.

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
        baselineVersion: '1',
        baselineOnMigrate: true,
    },
    placeholders: {
        'flyway:defaultSchema': '__mj',
    },
    transactionMode: 'per-migration', // or 'per-run'
});

// Run pending migrations
const result = await skyway.migrate();
console.log(`Applied ${result.migrationsApplied} migrations`);

// Get migration status
const info = await skyway.info();
info.forEach(m => console.log(`${m.version} ${m.state} ${m.description}`));

// Validate applied migrations
const validation = await skyway.validate();

// Clean database (dangerous!)
await skyway.clean();
```

---

## Technical Challenges & Mitigations

### 1. Checksum Compatibility

**Challenge**: Must produce identical CRC32 values to Java's `java.util.zip.CRC32`.

**Mitigation**: Java CRC32 uses the standard IEEE CRC32 polynomial. Node's `zlib.crc32()` (Node 20+) or the `crc-32` npm package should produce identical results. We'll validate by comparing checksums against the reference database's `flyway_schema_history`.

### 2. Large Migration Files

**Challenge**: The v3.0 baseline is 137K lines / 23MB.

**Mitigation**: Stream-read the file, split on GO in a streaming fashion, execute batches sequentially. The `mssql` driver handles large queries fine — the bottleneck is SQL Server execution time, not Node memory.

### 3. GO Statement Edge Cases

**Challenge**: GO inside string literals, comments, or as part of identifiers (e.g., column named `category_go`).

**Mitigation**: Use a line-based parser: `GO` is only a batch separator when it appears as the only non-whitespace content on a line (optionally followed by a count). This matches `sqlcmd` behavior and avoids false positives.

### 4. Placeholder Syntax Conflicts

**Challenge**: `${...}` syntax could conflict with SQL dollar-quoting or other constructs.

**Mitigation**: Only substitute known placeholders. Unknown `${...}` patterns are left as-is (or optionally error, matching Flyway's behavior).

### 5. Transaction + GO Interaction

**Challenge**: Each GO-separated batch is a separate `sql.query()` call, but they must all participate in the same transaction.

**Mitigation**: Use `new sql.Transaction(pool)` and execute all batches within `transaction.request().batch()` calls. SQL Server transactions span batches when using the same connection/transaction.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `mssql` | SQL Server driver (tedious under the hood) |
| `commander` | CLI argument parsing |
| `crc-32` | CRC32 checksum (Flyway-compatible), or use Node's built-in `zlib.crc32` |
| `glob` / `fast-glob` | File discovery for migration scanning |
| `chalk` | CLI colored output |
| `typescript` | Build toolchain |
| `vitest` or `jest` | Testing |

---

## Configuration Schema

```typescript
interface SkywayConfig {
    // Database connection
    database: {
        server: string;
        port?: number;           // default: 1433
        user: string;
        password: string;
        database: string;
        options?: {
            encrypt?: boolean;
            trustServerCertificate?: boolean;
        };
    };

    // Migration settings
    migrations: {
        locations: string[];           // Filesystem paths to scan
        defaultSchema?: string;        // default: 'dbo'
        historyTable?: string;         // default: 'flyway_schema_history'
        baselineVersion?: string;      // Version string for baseline
        baselineOnMigrate?: boolean;   // default: false
        outOfOrder?: boolean;          // Allow out-of-order migrations, default: false
    };

    // Placeholder substitution
    placeholders?: Record<string, string>;

    // Execution
    transactionMode?: 'per-migration' | 'per-run';  // default: 'per-migration'
    requestTimeout?: number;           // ms, default: 300000
}
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `skyway migrate` | Apply pending migrations |
| `skyway info` | Show migration status (applied, pending, failed) |
| `skyway validate` | Verify applied migrations match local files (checksums) |
| `skyway clean` | Drop all objects in configured schemas (destructive) |
| `skyway baseline` | Mark existing database as baselined at a version |
| `skyway repair` | Fix history table (remove failed entries, realign checksums) |

---

## Success Criteria

1. Skyway can run all MJ migrations (v3 baseline + v3 versioned + repeatable) and produce a database identical to the one created by real Flyway.
2. `flyway_schema_history` table contents match (versions, checksums, descriptions, types, success flags).
3. All schema objects match (tables, columns, indexes, constraints, views, procs, triggers, extended properties).
4. Transaction rollback works: a failing migration rolls back cleanly and the history table reflects the failure.
5. The library API is clean, well-typed, and usable programmatically.
6. The CLI provides clear output showing migration progress and status.
