# @memberjunction/skyway-cli

Command-line interface for [Skyway](https://github.com/MemberJunction/skyway) — a TypeScript-native Flyway-compatible database migration tool for SQL Server.

## Installation

```bash
npm install -g @memberjunction/skyway-cli
```

Or as a project dependency:

```bash
npm install @memberjunction/skyway-cli
```

## Usage

```bash
# Apply pending migrations
skyway migrate --server localhost --database my_app --user sa --password secret --locations ./migrations

# Show migration status
skyway info

# Validate applied migrations against local files
skyway validate

# Baseline an existing database at a version
skyway baseline --baseline-version 202601122300

# Repair history table (remove failed entries, realign checksums)
skyway repair

# Clean database (drop all objects in the schema)
skyway clean

# Create or drop the database
skyway create-db
skyway drop-db

# Dry-run mode (show what would be applied without executing)
skyway migrate --dry-run

# Quiet mode (suppress per-migration output)
skyway migrate --quiet
```

## Commands

| Command | Description |
|---------|-------------|
| `skyway migrate` | Apply pending migrations |
| `skyway info` | Show migration status |
| `skyway validate` | Validate applied migration checksums |
| `skyway clean` | Drop all objects in the configured schema |
| `skyway baseline` | Baseline the database at a version |
| `skyway repair` | Remove failed entries and realign checksums |
| `skyway create-db` | Create the target database |
| `skyway drop-db` | Drop the target database |

## Flags

| Flag | Description |
|------|-------------|
| `-s, --server <host>` | SQL Server hostname |
| `-p, --port <port>` | SQL Server port |
| `-d, --database <name>` | Database name |
| `-u, --user <user>` | Database user |
| `-P, --password <pass>` | Database password |
| `-l, --locations <paths>` | Migration locations (comma-separated) |
| `--schema <schema>` | Default schema name |
| `--table <table>` | History table name |
| `--baseline-version <ver>` | Baseline version |
| `--baseline-on-migrate` | Auto-baseline on empty database |
| `--transaction-mode <mode>` | `per-run` (default) or `per-migration` |
| `--dry-run` | Show pending migrations without executing |
| `-q, --quiet` | Suppress per-migration output |
| `--config <path>` | Path to config file |
| `--placeholder <key=value>` | Set a placeholder (repeatable) |

## Configuration File

Create a `skyway.json` in your project root instead of passing flags:

```json
{
  "Database": {
    "Server": "localhost",
    "Port": 1433,
    "Database": "my_app",
    "User": "sa",
    "Password": "${SQL_PASSWORD}"
  },
  "Migrations": {
    "Locations": ["./migrations"],
    "DefaultSchema": "dbo",
    "HistoryTable": "flyway_schema_history",
    "BaselineOnMigrate": true
  },
  "Placeholders": {
    "flyway:defaultSchema": "dbo"
  },
  "TransactionMode": "per-migration"
}
```

Environment variables in `${...}` syntax are expanded. A `.env` file is also loaded automatically if present.

## Also Available

- **[@memberjunction/skyway-core](https://www.npmjs.com/package/@memberjunction/skyway-core)** — Use Skyway as a library in your TypeScript/JavaScript application

## License

MIT
