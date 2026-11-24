/**
 * Smoke test for `Options.LockTimeout` (issue #29).
 *
 * Proves against a real PostgreSQL that a migration blocked by another
 * session's lock fails within the lock timeout, rolls back, and records
 * nothing, then succeeds once the lock is released.
 *
 * Phases (own temp migrations dir, so run.ts fixtures are untouched):
 *   1. Pre-clean, then apply V1 (table + view) with no lock timeout
 *   2. SHOW lock_timeout inside a migration transaction equals the setting
 *   3. Holder session takes ACCESS EXCLUSIVE on the table; V2 replaces the
 *      view with LockTimeout 2000 → fails in ~2s with SQLSTATE 55P03
 *   4. History has no V2 row
 *   5. Release the lock, rerun → V2 applies
 *   6. Clean
 *
 * Exported as a function so run.ts can invoke it as a phase using its own
 * connection config; returns the number of failed assertions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Skyway, ProviderTransaction } from '../../packages/core/src/index';
import { PostgresProvider } from '../../packages/postgres/src/index';

type PostgresConfig = ConstructorParameters<typeof PostgresProvider>[0];

const LOCK_TIMEOUT_MS = 2000;
/** Generous ceiling: well under RequestTimeout, so only the lock timeout can explain a fast failure. */
const MAX_FAIL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

export async function runLockTimeoutSmoke(dbConfig: PostgresConfig): Promise<number> {
  let failures = 0;
  const check = (condition: boolean, message: string): void => {
    if (condition) {
      console.log(`  ✓ ${message}`);
    } else {
      console.error(`  ✗ ${message}`);
      failures++;
    }
  };

  const lockedConfig: PostgresConfig = {
    ...dbConfig,
    Options: { ...dbConfig.Options, LockTimeout: LOCK_TIMEOUT_MS, RequestTimeout: REQUEST_TIMEOUT_MS },
  };
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyway-lock-smoke-'));
  const makeSkyway = (config: PostgresConfig): Skyway =>
    new Skyway({
      Provider: new PostgresProvider(config),
      Migrations: { Locations: [migrationsDir], DefaultSchema: 'public' },
      TransactionMode: 'per-migration',
    }).OnProgress({ OnLog: (msg) => console.log(`    [LOG] ${msg}`) });

  const withSkyway = async <T>(config: PostgresConfig, fn: (s: Skyway) => Promise<T>): Promise<T> => {
    const skyway = makeSkyway(config);
    try {
      return await fn(skyway);
    } finally {
      await skyway.Close();
    }
  };

  try {
    // ─── 1. Pre-clean, then V1 with no lock timeout ────────────────
    await withSkyway(dbConfig, (s) => s.Clean());
    fs.writeFileSync(
      path.join(migrationsDir, 'V1__lt_base.sql'),
      'CREATE TABLE public.lt_base (id INT);\nCREATE VIEW public.lt_view AS SELECT id, 1 AS v FROM public.lt_base;\n'
    );
    const v1 = await withSkyway(dbConfig, (s) => s.Migrate());
    check(v1.Success && v1.MigrationsApplied === 1, `V1 applied${v1.ErrorMessage ? ` (${v1.ErrorMessage})` : ''}`);

    // ─── 2. The SET persists on the transaction's session ──────────
    {
      const provider = new PostgresProvider(lockedConfig);
      await provider.Connect();
      try {
        const txn = await provider.BeginTransaction();
        const rows = await txn.Query<{ lock_timeout: string }>('SHOW lock_timeout');
        await txn.Rollback();
        check(rows[0]?.lock_timeout === '2s', `lock_timeout = 2s in the transaction (got ${rows[0]?.lock_timeout})`);
      } finally {
        await provider.Disconnect();
      }
    }

    // ─── 3. Blocked V2 fails fast ──────────────────────────────────
    fs.writeFileSync(
      path.join(migrationsDir, 'V2__lt_alter_view.sql'),
      'CREATE OR REPLACE VIEW public.lt_view AS SELECT id, 2 AS v FROM public.lt_base;\n'
    );
    const holder = new PostgresProvider(dbConfig);
    await holder.Connect();
    let holderTxn: ProviderTransaction | null = null;
    try {
      holderTxn = await holder.BeginTransaction();
      // ACCESS EXCLUSIVE blocks the ACCESS SHARE lock the view needs on its table.
      await holderTxn.Execute('LOCK TABLE public.lt_base IN ACCESS EXCLUSIVE MODE');

      const started = Date.now();
      const blocked = await withSkyway(lockedConfig, (s) => s.Migrate());
      const elapsed = Date.now() - started;
      check(!blocked.Success, `Blocked Migrate failed (${blocked.ErrorMessage})`);
      check(
        /55P03|lock timeout/i.test(blocked.ErrorMessage ?? ''),
        'Failure is the lock timeout (55P03), not something else'
      );
      check(
        elapsed >= LOCK_TIMEOUT_MS - 200 && elapsed < MAX_FAIL_MS,
        `Failed after ${elapsed}ms (lock timeout ${LOCK_TIMEOUT_MS}ms, request timeout ${REQUEST_TIMEOUT_MS}ms)`
      );
    } finally {
      if (holderTxn) await holderTxn.Rollback();
      await holder.Disconnect();
    }

    // ─── 4. Nothing recorded for V2 ────────────────────────────────
    {
      const provider = new PostgresProvider(dbConfig);
      await provider.Connect();
      try {
        const rows = await provider.Query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM public.flyway_schema_history WHERE version = '2'`
        );
        check(rows[0]?.n === 0, `History has no V2 row (got ${rows[0]?.n})`);
      } finally {
        await provider.Disconnect();
      }
    }

    // ─── 5. Lock released → rerun succeeds ─────────────────────────
    const rerun = await withSkyway(lockedConfig, (s) => s.Migrate());
    check(rerun.Success && rerun.MigrationsApplied === 1, `Rerun applied V2${rerun.ErrorMessage ? ` (${rerun.ErrorMessage})` : ''}`);

    // ─── 6. Clean ──────────────────────────────────────────────────
    await withSkyway(dbConfig, (s) => s.Clean());
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }

  return failures;
}
