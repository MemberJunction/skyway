/**
 * Smoke test for duplicate-version detection.
 *
 * Proves end-to-end against a real SQL Server that two migration files
 * sharing a version are rejected before anything is applied — the bug
 * (seen in the real `mj_duplicate` database) applied both, writing two
 * history rows for one version.
 *
 * Phases (all against a throwaway temp migrations dir, so the main run.ts
 * lifecycle fixtures are untouched):
 *   1. Pre-clean (idempotent re-runs)
 *   2. Migrate with two V202606021200 files → Success: false, 0 applied
 *   3. Query history → zero rows for the duplicate version (no double-apply)
 *   4. Info → throws (hard-fail)
 *   5. Validate → Valid: false with the duplicate error
 *   6. Remove one duplicate → Migrate applies the remaining file (detection
 *      does not over-block a legitimate run)
 *   7. Clean
 *
 * Exported as a function so run.ts can invoke it as a phase using its own
 * connection config; returns the number of failed assertions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Skyway } from '../../packages/core/src/index';
import { SqlServerProvider } from '../../packages/sqlserver/src/index';

type SqlServerConfig = ConstructorParameters<typeof SqlServerProvider>[0];

const DUP_VERSION = '202606021200';

export async function runDuplicateVersionSmoke(dbConfig: SqlServerConfig): Promise<number> {
  let failures = 0;
  const check = (condition: boolean, message: string): void => {
    if (condition) {
      console.log(`  ✓ ${message}`);
    } else {
      console.error(`  ✗ ${message}`);
      failures++;
    }
  };

  // Throwaway dir with two files claiming the same version.
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-dup-smoke-'));
  fs.writeFileSync(path.join(migrationsDir, `V${DUP_VERSION}__First.sql`), 'CREATE TABLE dbo.dup_first (id INT);\n');
  fs.writeFileSync(path.join(migrationsDir, `V${DUP_VERSION}__Second.sql`), 'CREATE TABLE dbo.dup_second (id INT);\n');

  const makeSkyway = (): Skyway =>
    new Skyway({
      Provider: new SqlServerProvider(dbConfig),
      Migrations: { Locations: [migrationsDir], DefaultSchema: 'dbo' },
      TransactionMode: 'per-migration',
    }).OnProgress({ OnLog: (msg) => console.log(`    [LOG] ${msg}`) });

  console.log(`Temp migrations dir: ${migrationsDir} (two files at version ${DUP_VERSION})`);

  try {
    // ─── 1. Idempotent pre-clean ───────────────────────────────────
    {
      const skyway = makeSkyway();
      try {
        const clean = await skyway.Clean();
        console.log(`    pre-clean dropped ${clean.ObjectsDropped} object(s); success=${clean.Success}`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── 2. Migrate must fail fast and apply nothing ───────────────
    console.log('\n  Migrate (duplicate) — expect failure, nothing applied');
    {
      const skyway = makeSkyway();
      try {
        const result = await skyway.Migrate();
        check(!result.Success, `Migrate failed${result.ErrorMessage ? ` (${result.ErrorMessage})` : ''}`);
        check(
          /Found more than one migration with version 202606021200/.test(result.ErrorMessage ?? ''),
          'Error names the duplicate version'
        );
        check(result.MigrationsApplied === 0, `Applied 0 (got ${result.MigrationsApplied})`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── 3. History must hold zero rows for the duplicate version ──
    console.log('\n  Verify history has no rows for the duplicate version');
    {
      const provider = new SqlServerProvider(dbConfig);
      try {
        await provider.Connect();
        const rows = await provider.Query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM dbo.flyway_schema_history WHERE version = '${DUP_VERSION}'`
        );
        check((rows[0]?.n ?? -1) === 0, `0 history rows for version ${DUP_VERSION} (got ${rows[0]?.n})`);
      } finally {
        await provider.Disconnect();
      }
    }

    // ─── 4. Info must hard-fail ────────────────────────────────────
    console.log('\n  Info (duplicate) — expect throw');
    {
      const skyway = makeSkyway();
      try {
        await skyway.Info();
        check(false, 'Info threw on duplicates');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        check(/Found more than one migration with version/.test(msg), `Info threw with the duplicate message (${msg})`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── 5. Validate must report invalid ───────────────────────────
    console.log('\n  Validate (duplicate) — expect invalid');
    {
      const skyway = makeSkyway();
      try {
        const validate = await skyway.Validate();
        check(!validate.Valid, 'Validate reports invalid');
        check(
          validate.Errors.some((e) => /Found more than one migration with version/.test(e)),
          'Validate error names the duplicate'
        );
      } finally {
        await skyway.Close();
      }
    }

    // ─── 6. Resolving the collision lets the run proceed ───────────
    console.log('\n  Remove one duplicate, Migrate — expect single apply');
    fs.rmSync(path.join(migrationsDir, `V${DUP_VERSION}__Second.sql`));
    {
      const skyway = makeSkyway();
      try {
        const result = await skyway.Migrate();
        check(result.Success, `Migrate succeeded${result.ErrorMessage ? ` (${result.ErrorMessage})` : ''}`);
        check(result.MigrationsApplied === 1, `Applied 1 (got ${result.MigrationsApplied})`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── 7. Clean ──────────────────────────────────────────────────
    {
      const skyway = makeSkyway();
      try {
        await skyway.Clean();
      } finally {
        await skyway.Close();
      }
    }
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }

  return failures;
}
