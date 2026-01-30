/**
 * Integration test: Run Skyway migrations against MJ migration files
 * and compare the resulting database with MJ_3_3_PERFECT.
 */

import { Skyway } from './packages/core/src';

async function main() {
  const TEST_DB = 'MJ_3_3_NEW';

  const skyway = new Skyway({
    Database: {
      Server: 'sql-claude',
      Port: 1433,
      Database: TEST_DB,
      User: 'sa',
      Password: 'Claude2Sql99',
      Options: {
        TrustServerCertificate: true,
        RequestTimeout: 600_000, // 10 min for baseline
      },
    },
    Migrations: {
      Locations: ['/workspace/MJ/migrations'],
      DefaultSchema: '__mj',
      HistoryTable: 'flyway_schema_history',
      BaselineVersion: '202601122300',
      BaselineOnMigrate: true,
    },
    Placeholders: {},
    TransactionMode: 'per-migration',
  });

  skyway.OnProgress({
    OnMigrationStart: (m) => {
      const label = m.Version ? `v${m.Version}` : '(repeatable)';
      process.stdout.write(`  Migrating to ${label}: ${m.Description}...`);
    },
    OnMigrationEnd: (r) => {
      if (r.Success) {
        console.log(` OK (${r.ExecutionTimeMS}ms)`);
      } else {
        console.log(` FAILED`);
        console.log(`    ${r.Error?.message}`);
      }
    },
    OnLog: (msg) => console.log(`  ${msg}`),
  });

  try {
    // Step 1: Drop and recreate test database
    console.log('\n=== Step 1: Create fresh database ===');
    await skyway.DropDatabase();
    await skyway.CreateDatabase();

    // Step 2: Run migrations
    console.log('\n=== Step 2: Run migrations ===');
    const result = await skyway.Migrate();

    console.log(`\n=== Result ===`);
    console.log(`  Migrations applied: ${result.MigrationsApplied}`);
    console.log(`  Success: ${result.Success}`);
    console.log(`  Total time: ${result.TotalExecutionTimeMS}ms`);
    if (result.CurrentVersion) {
      console.log(`  Current version: ${result.CurrentVersion}`);
    }
    if (result.ErrorMessage) {
      console.log(`  Error: ${result.ErrorMessage}`);
    }
  } catch (err) {
    console.error('Fatal error:', err);
  } finally {
    await skyway.Close();
  }
}

main();
