# Integration tests

Real-DB end-to-end tests for both providers. Each test runs the full Skyway lifecycle against a live database (Migrate → Info → Validate → re-run no-op → Repair → Clean) and asserts behavior at every step.

These complement (rather than replace) the in-memory smoke tests in `packages/postgres/src/__tests__/` and `packages/sqlserver/src/__tests__/`. Smoke tests verify input validation and dialect contract; integration tests verify the actual SQL operations work end-to-end against real database engines.

## Layout

```
integration-tests/
├── postgres/
│   ├── migrations/
│   │   ├── V001__create_widgets.sql
│   │   └── V002__add_categories.sql
│   └── run.ts
├── sqlserver/
│   ├── migrations/
│   │   ├── V001__create_widgets.sql
│   │   └── V002__add_categories.sql      # exercises GO batch separators
│   └── run.ts
└── README.md
```

## Running locally

The runners read connection details from env vars; defaults work with most local docker/dev setups:

```bash
# PostgreSQL
SKYWAY_PG_HOST=localhost \
SKYWAY_PG_DATABASE=skyway_integration \
SKYWAY_PG_USER=postgres \
SKYWAY_PG_PASSWORD=postgres \
  npm run test:integration:pg

# SQL Server
SKYWAY_MSSQL_HOST=localhost \
SKYWAY_MSSQL_DATABASE=skyway_integration \
SKYWAY_MSSQL_USER=sa \
SKYWAY_MSSQL_PASSWORD='Skyway_Test_Password123!' \
  npm run test:integration:mssql
```

The target database must already exist — the runners do NOT create it (they assume you provisioned it via the CI service container or a one-off `psql` / `sqlcmd` call). They DO clean up afterward via `Skyway.Clean()`.

## CI

`.github/workflows/integration.yml` runs both on every PR push, with Postgres and SQL Server service containers. See that file for the wiring.

## Why standalone Node scripts (not vitest)?

These are intentionally NOT vitest tests:
- vitest's parallelism + isolated test files map poorly to single-DB integration setup
- Plain Node scripts produce trivially-readable CI failure output
- Each runner exits 0/1 cleanly — easy for the workflow to gate on

The unit-level tests in each provider package (`packages/*/src/__tests__/`) stay under vitest where its concurrency model is a fit.
