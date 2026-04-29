/**
 * SqlServerProvider integration test — exercises the full Skyway lifecycle
 * against a real SQL Server instance.
 *
 * Phases:
 *   1. Migrate (apply 2 fresh migrations including GO batch separators)
 *   2. Info (status report shows both as SUCCESS)
 *   3. Validate (checksums match)
 *   4. Re-run Migrate (no-op)
 *   5. Repair (clean state)
 *   6. Clean (drops all objects + history table)
 *
 * Reads connection details from env vars so the same script runs in CI
 * (with a service container) or locally:
 *
 *   SKYWAY_MSSQL_HOST=localhost
 *   SKYWAY_MSSQL_PORT=1433
 *   SKYWAY_MSSQL_DATABASE=skyway_integration
 *   SKYWAY_MSSQL_USER=sa
 *   SKYWAY_MSSQL_PASSWORD=Skyway_Test_Password123!
 *
 * Exits 0 on success, 1 on any assertion failure or thrown exception.
 *
 * NOTE: This script doesn't run under vitest — it's a standalone Node entry
 * point invoked by the integration CI workflow. Same rationale as the PG
 * integration runner.
 */

import { Skyway } from '../../packages/core/src/index';
import { SqlServerProvider } from '../../packages/sqlserver/src/index';

const DB_CONFIG = {
  Dialect: 'sqlserver' as const,
  Server: process.env.SKYWAY_MSSQL_HOST ?? 'localhost',
  Port: Number(process.env.SKYWAY_MSSQL_PORT ?? 1433),
  Database: process.env.SKYWAY_MSSQL_DATABASE ?? 'skyway_integration',
  User: process.env.SKYWAY_MSSQL_USER ?? 'sa',
  Password: process.env.SKYWAY_MSSQL_PASSWORD ?? 'Skyway_Test_Password123!',
  Options: {
    Encrypt: false,
    TrustServerCertificate: true,
  },
};

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

async function main() {
  console.log('=== Skyway SQL Server Integration Test ===');
  console.log(`Target: ${DB_CONFIG.User}@${DB_CONFIG.Server}:${DB_CONFIG.Port}/${DB_CONFIG.Database}\n`);

  const provider = new SqlServerProvider(DB_CONFIG);

  const skyway = new Skyway({
    Provider: provider,
    Migrations: {
      Locations: ['./integration-tests/sqlserver/migrations'],
      DefaultSchema: 'dbo',
    },
    TransactionMode: 'per-migration',
  });

  skyway.OnProgress({
    OnLog: (msg) => console.log(`    [LOG] ${msg}`),
    OnMigrationStart: (m) => console.log(`    [START] ${m.Version} — ${m.Description}`),
    OnMigrationEnd: (r) => console.log(`    [${r.Success ? 'OK' : 'FAIL'}] ${r.Migration.Description} (${r.ExecutionTimeMS}ms)`),
  });

  try {
    // Phase 1 — fresh migrate (V002 has GO separators — verifies sql-splitter)
    console.log('\n--- 1. Migrate (fresh) ---');
    const migrate = await skyway.Migrate();
    check(migrate.Success, `Migrate succeeded${migrate.ErrorMessage ? ` (${migrate.ErrorMessage})` : ''}`);
    check(migrate.MigrationsApplied === 2, `Applied 2 migrations (got ${migrate.MigrationsApplied})`);
    check(migrate.CurrentVersion === '002', `CurrentVersion = '002' (got '${migrate.CurrentVersion}')`);

    // Phase 2 — Info
    console.log('\n--- 2. Info ---');
    const info = await skyway.Info();
    for (const s of info) console.log(`    ${s.Version ?? '(R)'} | ${s.State} | ${s.Description}`);
    check(info.length === 2, `Info reports 2 entries (got ${info.length})`);
    check(info.every((s) => s.State === 'APPLIED'), 'All entries APPLIED');

    // Phase 3 — Validate
    console.log('\n--- 3. Validate ---');
    const validate = await skyway.Validate();
    check(validate.Valid, `Validate succeeded${validate.Errors.length ? ` (${validate.Errors.join('; ')})` : ''}`);
    check(validate.Errors.length === 0, 'No validation errors');

    // Phase 4 — Re-run is a no-op
    console.log('\n--- 4. Re-run Migrate (expect no-op) ---');
    const rerun = await skyway.Migrate();
    check(rerun.Success, 'Re-run Migrate succeeded');
    check(rerun.MigrationsApplied === 0, `Applied 0 (got ${rerun.MigrationsApplied})`);

    // Phase 5 — Repair on a clean DB
    console.log('\n--- 5. Repair ---');
    const repair = await skyway.Repair();
    check(repair.Success, 'Repair succeeded');
    check(repair.FailedEntriesRemoved === 0, 'No failed entries to remove');
    check(repair.ChecksumsRealigned === 0, 'No checksums to realign');

    // Phase 6 — Clean drops everything
    console.log('\n--- 6. Clean ---');
    const clean = await skyway.Clean();
    check(clean.Success, `Clean succeeded${clean.ErrorMessage ? ` (${clean.ErrorMessage})` : ''}`);
    check(clean.ObjectsDropped > 0, `Clean dropped objects (got ${clean.ObjectsDropped})`);
    for (const obj of clean.DroppedObjects) console.log(`      - ${obj}`);

    if (failures > 0) {
      console.log(`\n=== FAILED — ${failures} assertion(s) failed ===`);
      process.exit(1);
    }
    console.log('\n=== ALL ASSERTIONS PASSED ===');
  } catch (err) {
    console.error('\n=== TEST CRASHED ===');
    console.error(err);
    process.exit(1);
  } finally {
    await skyway.Close();
  }
}

main();
