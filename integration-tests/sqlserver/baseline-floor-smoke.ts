/**
 * Smoke test for the baseline-version-floor fix.
 *
 * Proves end-to-end against a real SQL Server that:
 *  - A baseline row in flyway_schema_history acts as a floor.
 *  - Pre-baseline V files on disk are reported as ABOVE_BASELINE,
 *    not IGNORED, not PENDING, not MISSING.
 *  - Validate() returns Valid: true (the bug made this Valid: false).
 *  - Migrate() returns Success: true with 0 applied (the bug aborted
 *    the run with "Detected resolved migration not applied to database").
 *
 * Phases:
 *   1. Clean any prior state (idempotent re-runs)
 *   2. Skyway.Baseline at version 202601010000
 *   3. Drop a V202301010000__pre_baseline.sql into a temp migrations dir
 *   4. Skyway.Info  → assert pre-baseline V is ABOVE_BASELINE
 *   5. Skyway.Validate → assert Valid: true
 *   6. Skyway.Migrate → assert Success: true, MigrationsApplied === 0
 *   7. Add a NEW post-baseline V file → assert it actually applies
 *   8. Skyway.Clean → drops everything in the schema
 *
 * Reads credentials from env vars (set them when invoking):
 *   SMOKE_HOST, SMOKE_PORT, SMOKE_DATABASE, SMOKE_USER, SMOKE_PASSWORD
 *
 * Exits 0 on success, 1 on any assertion failure or thrown exception.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Skyway } from '../../packages/core/src/index';
import { SqlServerProvider } from '../../packages/sqlserver/src/index';

const DB_CONFIG = {
  Dialect: 'sqlserver' as const,
  Server: process.env.SMOKE_HOST ?? 'localhost',
  Port: Number(process.env.SMOKE_PORT ?? 1433),
  Database: process.env.SMOKE_DATABASE ?? 'skyway_smoke_test',
  User: process.env.SMOKE_USER ?? 'sa',
  Password: process.env.SMOKE_PASSWORD ?? '',
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

// Use a unique temp dir per run so re-runs don't collide.
const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-smoke-'));

function writeMigration(filename: string, sql: string): void {
  fs.writeFileSync(path.join(migrationsDir, filename), sql);
}

function removeMigration(filename: string): void {
  const full = path.join(migrationsDir, filename);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

function makeSkyway(): Skyway {
  // Construct a fresh Skyway each phase. Each instance owns its own pool,
  // and Close()ing between phases mirrors how a CLI invocation would behave —
  // ensures we're testing fresh-connection behavior, not in-memory state.
  return new Skyway({
    Provider: new SqlServerProvider(DB_CONFIG),
    Migrations: {
      Locations: [migrationsDir],
      DefaultSchema: 'dbo',
    },
    TransactionMode: 'per-migration',
  }).OnProgress({
    OnLog: (msg) => console.log(`    [LOG] ${msg}`),
  });
}

async function main() {
  console.log('=== Skyway Baseline-Floor Smoke Test ===');
  console.log(`Target: ${DB_CONFIG.User}@${DB_CONFIG.Server}:${DB_CONFIG.Port}/${DB_CONFIG.Database}`);
  console.log(`Temp migrations dir: ${migrationsDir}\n`);

  if (!DB_CONFIG.Password) {
    console.error('SMOKE_PASSWORD env var is required');
    process.exit(1);
  }

  try {
    // ─── Phase 1 — Idempotent cleanup ──────────────────────────────
    console.log('--- 1. Pre-clean (idempotent) ---');
    {
      const skyway = makeSkyway();
      try {
        const clean = await skyway.Clean();
        console.log(`    pre-clean dropped ${clean.ObjectsDropped} object(s); success=${clean.Success}`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 2 — Seed a baseline row in history ──────────────────
    console.log('\n--- 2. Baseline at 202601010000 ---');
    {
      const skyway = makeSkyway();
      try {
        const baseline = await skyway.Baseline('202601010000');
        check(baseline.Success, `Baseline succeeded${baseline.ErrorMessage ? ` (${baseline.ErrorMessage})` : ''}`);
        check(baseline.BaselineVersion === '202601010000', `BaselineVersion = '202601010000' (got '${baseline.BaselineVersion}')`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 3 — Drop a pre-baseline V file on disk ──────────────
    console.log('\n--- 3. Add V202301010000__pre_baseline.sql to disk ---');
    writeMigration(
      'V202301010000__pre_baseline.sql',
      // Intentional gibberish: if the resolver mistakenly tries to RUN this,
      // SQL Server will reject it loudly. The bug we're proving the absence
      // of would have classified this as PENDING and tried to execute it.
      'CREATE TABLE pre_baseline_should_never_run (id INT NOT NULL, ' +
      'CONSTRAINT cannot_be_two_pks PRIMARY KEY (id), ' +
      'CONSTRAINT also_cannot_be_two_pks PRIMARY KEY (id));\n',
    );
    console.log('    written.');

    // ─── Phase 4 — Info reports ABOVE_BASELINE ─────────────────────
    console.log('\n--- 4. Info — pre-baseline V should be ABOVE_BASELINE ---');
    {
      const skyway = makeSkyway();
      try {
        const info = await skyway.Info();
        for (const s of info) console.log(`    ${s.Version ?? '(R)'} | ${s.Type} | ${s.State} | ${s.Description}`);
        const preBaseline = info.find((s) => s.Version === '202301010000');
        check(preBaseline !== undefined, 'pre-baseline V appears in Info() report');
        check(preBaseline?.State === 'ABOVE_BASELINE', `pre-baseline V state is ABOVE_BASELINE (got '${preBaseline?.State}')`);
        check(info.every((s) => s.State !== 'IGNORED'), 'no entry has State=IGNORED');
        check(info.every((s) => s.State !== 'PENDING' || s.Version !== '202301010000'), 'pre-baseline V is NOT PENDING');
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 5 — Validate returns Valid: true ────────────────────
    console.log('\n--- 5. Validate — should be Valid: true ---');
    {
      const skyway = makeSkyway();
      try {
        const validate = await skyway.Validate();
        check(validate.Valid, `Validate.Valid = true (errors: ${validate.Errors.join('; ')})`);
        check(validate.Errors.length === 0, `Validate.Errors empty (got ${validate.Errors.length})`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 6 — Migrate is a no-op (does NOT abort) ─────────────
    console.log('\n--- 6. Migrate — should succeed with 0 applied (NOT abort) ---');
    {
      const skyway = makeSkyway();
      try {
        const migrate = await skyway.Migrate();
        check(migrate.Success, `Migrate.Success = true (error: ${migrate.ErrorMessage ?? '<none>'})`);
        check(migrate.MigrationsApplied === 0, `Migrate.MigrationsApplied = 0 (got ${migrate.MigrationsApplied})`);
        // The bug's specific failure signature
        check(
          (migrate.ErrorMessage ?? '').indexOf('Detected resolved migration not applied') === -1,
          'no "Detected resolved migration not applied" abort message',
        );
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 7 — Add a NEW post-baseline V; it should actually run ─
    console.log('\n--- 7. Add V202601020000 above floor → should apply ---');
    writeMigration(
      'V202601020000__post_baseline.sql',
      'CREATE TABLE post_baseline_smoke (id INT NOT NULL PRIMARY KEY);\n',
    );
    {
      const skyway = makeSkyway();
      try {
        const migrate = await skyway.Migrate();
        check(migrate.Success, `Migrate.Success = true${migrate.ErrorMessage ? ` (${migrate.ErrorMessage})` : ''}`);
        check(migrate.MigrationsApplied === 1, `Applied 1 migration (got ${migrate.MigrationsApplied})`);
        check(migrate.CurrentVersion === '202601020000', `CurrentVersion = '202601020000' (got '${migrate.CurrentVersion}')`);

        // And Info should still show the pre-baseline V as ABOVE_BASELINE
        const info = await skyway.Info();
        const pre = info.find((s) => s.Version === '202301010000');
        check(pre?.State === 'ABOVE_BASELINE', `pre-baseline V remains ABOVE_BASELINE after migrate (got '${pre?.State}')`);
        const post = info.find((s) => s.Version === '202601020000');
        check(post?.State === 'APPLIED', `post-baseline V is APPLIED (got '${post?.State}')`);
      } finally {
        await skyway.Close();
      }
    }

    // ─── Phase 8 — Clean ───────────────────────────────────────────
    console.log('\n--- 8. Clean — drop everything ---');
    {
      const skyway = makeSkyway();
      try {
        const clean = await skyway.Clean();
        check(clean.Success, `Clean succeeded${clean.ErrorMessage ? ` (${clean.ErrorMessage})` : ''}`);
        check(clean.ObjectsDropped > 0, `Clean dropped objects (got ${clean.ObjectsDropped})`);
        for (const obj of clean.DroppedObjects) console.log(`      - ${obj}`);
      } finally {
        await skyway.Close();
      }
    }

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
    // Best-effort temp dir cleanup
    try {
      removeMigration('V202301010000__pre_baseline.sql');
      removeMigration('V202601020000__post_baseline.sql');
      fs.rmdirSync(migrationsDir);
    } catch {
      // ignore
    }
  }
}

main();
